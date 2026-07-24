import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minuteBucketStart,
  TradeBarAggregator,
  tickSizeFor,
  directionToSide,
  priceDistanceToTicks,
  signedPriceOffsetTicks,
  buildStopOnlyOrderRequest,
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

test("TradeBarAggregator: builds OHLC and buy/sell volume, flushing on minute boundary", () => {
  const bars = [];
  const agg = new TradeBarAggregator((bar) => bars.push(bar));
  agg.onTrade({ price: 5500, volume: 10, timestamp: "2026-07-24T14:05:10Z", type: 0 });
  agg.onTrade({ price: 5502, volume: 4, timestamp: "2026-07-24T14:06:05Z", type: 1 });
  assert.equal(bars.length, 1);
  assert.deepEqual(bars[0], { high: 5500, low: 5500, close: 5500, buyVolume: 10, sellVolume: 0 });
});

test("tickSizeFor: MES resolves, unknown instruments throw", () => {
  assert.equal(tickSizeFor("MES"), 0.25);
  assert.throws(() => tickSizeFor("NQ"));
});

test("directionToSide: long is Buy(0), short is Sell(1)", () => {
  assert.equal(directionToSide("long"), ORDER_SIDE.BUY);
  assert.equal(directionToSide("short"), ORDER_SIDE.SELL);
});

test("priceDistanceToTicks: converts a price distance to a whole tick count", () => {
  assert.equal(priceDistanceToTicks(3, 0.25), 12);
});

test("signedPriceOffsetTicks: positive above the reference price, negative below", () => {
  assert.equal(signedPriceOffsetTicks(7462, 7465, 0.25), 12);
  assert.equal(signedPriceOffsetTicks(7462, 7459, 0.25), -12);
});

test("buildStopOnlyOrderRequest: long order carries a stop bracket only, no take-profit", () => {
  const req = buildStopOnlyOrderRequest({
    accountId: 25804787,
    contractId: "CON.F.US.MES.U26",
    direction: "long",
    size: 1,
    entryPrice: 7462,
    stopPrice: 7459,
    tickSize: 0.25,
    customTag: "morb-long-1",
  });
  assert.equal(req.type, ORDER_TYPE.MARKET);
  assert.equal(req.side, ORDER_SIDE.BUY);
  assert.equal(req.size, 1);
  assert.deepEqual(req.stopLossBracket, { ticks: -12, type: ORDER_TYPE.STOP }); // 3pts below entry
  assert.equal("takeProfitBracket" in req, false);
});

const accounts = [
  { id: 1, name: "PRAC-V2-416538-98727790", balance: 150000, canTrade: true },
  { id: 2, name: "50KTC-V2-416538-12832221", balance: 47950, canTrade: true },
];

test("selectAccount: a nameHint disambiguates among multiple tradable accounts", () => {
  assert.equal(selectAccount(accounts, "PRAC").id, 1);
});

test("selectAccount: throws rather than guess when multiple tradable accounts exist with no hint", () => {
  assert.throws(() => selectAccount(accounts), /PRAC.*50KTC|50KTC.*PRAC/);
});
