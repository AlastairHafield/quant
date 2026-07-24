import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minuteBucketStart,
  TradeBarAggregator,
  tickSizeFor,
  directionToSide,
  priceDistanceToTicks,
  signedPriceOffsetTicks,
  buildBracketOrderRequest,
  selectAccount,
  ORDER_SIDE,
  ORDER_TYPE,
} from "../src/dataSources/topstepx.js";

test("minuteBucketStart: truncates seconds/ms, same minute maps to the same bucket", () => {
  const a = minuteBucketStart("2026-07-24T14:05:12.345Z");
  const b = minuteBucketStart("2026-07-24T14:05:59.999Z");
  const c = minuteBucketStart("2026-07-24T14:06:00.000Z");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("TradeBarAggregator: builds OHLC and buy/sell volume within a single minute", () => {
  const bars = [];
  const agg = new TradeBarAggregator((bar) => bars.push(bar));

  agg.onTrade({ price: 5500, volume: 10, timestamp: "2026-07-24T14:05:00Z", type: 0 }); // buy
  agg.onTrade({ price: 5502, volume: 5, timestamp: "2026-07-24T14:05:20Z", type: 0 }); // buy
  agg.onTrade({ price: 5498, volume: 8, timestamp: "2026-07-24T14:05:40Z", type: 1 }); // sell

  assert.equal(bars.length, 0); // nothing flushed yet, still the same minute
  agg.flush();
  assert.deepEqual(bars, [{ high: 5502, low: 5498, close: 5498, buyVolume: 15, sellVolume: 8 }]);
});

test("TradeBarAggregator: flushes automatically when a trade crosses into the next minute", () => {
  const bars = [];
  const agg = new TradeBarAggregator((bar) => bars.push(bar));

  agg.onTrade({ price: 5500, volume: 10, timestamp: "2026-07-24T14:05:10Z", type: 0 });
  agg.onTrade({ price: 5505, volume: 4, timestamp: "2026-07-24T14:05:50Z", type: 1 });
  agg.onTrade({ price: 5510, volume: 6, timestamp: "2026-07-24T14:06:05Z", type: 0 }); // next minute

  assert.equal(bars.length, 1);
  assert.deepEqual(bars[0], { high: 5505, low: 5500, close: 5505, buyVolume: 10, sellVolume: 4 });

  agg.flush();
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[1], { high: 5510, low: 5510, close: 5510, buyVolume: 6, sellVolume: 0 });
});

test("TradeBarAggregator: flush() on an empty aggregator is a no-op", () => {
  const bars = [];
  const agg = new TradeBarAggregator((bar) => bars.push(bar));
  agg.flush();
  assert.equal(bars.length, 0);
});

test("tickSizeFor: known instruments resolve, unknown ones throw", () => {
  assert.equal(tickSizeFor("ES"), 0.25);
  assert.equal(tickSizeFor("MES"), 0.25);
  assert.throws(() => tickSizeFor("NQ"));
});

test("directionToSide: long is Buy(0), short is Sell(1)", () => {
  assert.equal(directionToSide("long"), ORDER_SIDE.BUY);
  assert.equal(directionToSide("short"), ORDER_SIDE.SELL);
});

test("priceDistanceToTicks: converts a price distance to a whole tick count", () => {
  assert.equal(priceDistanceToTicks(3, 0.25), 12);
  assert.equal(priceDistanceToTicks(-3, 0.25), 12); // direction-agnostic, always positive ticks
  assert.equal(priceDistanceToTicks(0.1, 0.25), 0); // rounds to nearest tick
});

test("signedPriceOffsetTicks: positive above the reference price, negative below — live-verified as what the bracket API actually wants", () => {
  assert.equal(signedPriceOffsetTicks(7460, 7463, 0.25), 12);
  assert.equal(signedPriceOffsetTicks(7460, 7457, 0.25), -12);
  assert.equal(signedPriceOffsetTicks(7460, 7460, 0.25), 0);
});

test("buildBracketOrderRequest: long order — stop ticks negative (below entry), target ticks positive (above)", () => {
  const req = buildBracketOrderRequest({
    accountId: 536,
    contractId: "CON.F.US.EP.U26",
    direction: "long",
    size: 4,
    entryPrice: 7460,
    stopPrice: 7457,
    targetPrice: 7466,
    tickSize: 0.25,
    customTag: "gex-A-long-123",
  });
  assert.equal(req.accountId, 536);
  assert.equal(req.contractId, "CON.F.US.EP.U26");
  assert.equal(req.type, ORDER_TYPE.MARKET);
  assert.equal(req.side, ORDER_SIDE.BUY);
  assert.equal(req.size, 4);
  assert.equal(req.customTag, "gex-A-long-123");
  assert.deepEqual(req.stopLossBracket, { ticks: -12, type: ORDER_TYPE.STOP }); // 3pts below entry
  assert.deepEqual(req.takeProfitBracket, { ticks: 24, type: ORDER_TYPE.LIMIT }); // 6pts above entry
});

test("buildBracketOrderRequest: short order — stop ticks positive (above entry), target ticks negative (below)", () => {
  const req = buildBracketOrderRequest({
    accountId: 536,
    contractId: "CON.F.US.EP.U26",
    direction: "short",
    size: 2,
    entryPrice: 7460,
    stopPrice: 7463,
    targetPrice: 7454,
    tickSize: 0.25,
    customTag: "gex-B-short-124",
  });
  assert.equal(req.side, ORDER_SIDE.SELL);
  assert.deepEqual(req.stopLossBracket, { ticks: 12, type: ORDER_TYPE.STOP }); // 3pts above entry
  assert.deepEqual(req.takeProfitBracket, { ticks: -24, type: ORDER_TYPE.LIMIT }); // 6pts below entry
});

const accounts = [
  { id: 1, name: "PRACTICEACCOUNT1", balance: 150000, canTrade: true, isVisible: true },
  { id: 2, name: "COMBINE_50K_2", balance: 50000, canTrade: false, isVisible: true },
];

test("selectAccount: the single tradable account is chosen automatically", () => {
  assert.equal(selectAccount(accounts).id, 1);
});

test("selectAccount: a nameHint disambiguates among multiple tradable accounts", () => {
  const multi = [...accounts, { id: 3, name: "PRACTICEACCOUNT2", balance: 150000, canTrade: true, isVisible: true }];
  assert.equal(selectAccount(multi, "ACCOUNT2").id, 3);
});

test("selectAccount: throws with the candidate list when multiple tradable accounts exist and no hint disambiguates", () => {
  const multi = [...accounts, { id: 3, name: "PRACTICEACCOUNT2", balance: 150000, canTrade: true, isVisible: true }];
  assert.throws(() => selectAccount(multi), /PRACTICEACCOUNT1.*PRACTICEACCOUNT2|PRACTICEACCOUNT2.*PRACTICEACCOUNT1/);
});

test("selectAccount: throws when no account is tradable", () => {
  assert.throws(() => selectAccount([{ id: 2, name: "X", canTrade: false }]));
});
