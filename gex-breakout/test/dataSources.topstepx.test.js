import { test } from "node:test";
import assert from "node:assert/strict";
import { minuteBucketStart, TradeBarAggregator } from "../src/dataSources/topstepx.js";

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
