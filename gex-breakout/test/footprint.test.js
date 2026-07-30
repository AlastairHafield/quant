import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFootprintZones, detectBigTrade, detectTrappedParticipants } from "../src/footprint.js";

const zoneCfg = { bucketSizePts: 1, imbalanceRatio: 3, minStackedLevels: 3 };

test("buildFootprintZones finds a stacked buy zone followed by a stacked sell zone", () => {
  const bar = [
    { price: 100, buyVolume: 20, sellVolume: 1 },
    { price: 101, buyVolume: 15, sellVolume: 1 },
    { price: 102, buyVolume: 18, sellVolume: 2 },
    { price: 103, buyVolume: 2, sellVolume: 2 }, // neither side clears the ratio — breaks the run
    { price: 104, buyVolume: 1, sellVolume: 10 },
    { price: 105, buyVolume: 1, sellVolume: 12 },
    { price: 106, buyVolume: 2, sellVolume: 9 },
  ];
  const zones = buildFootprintZones([bar], zoneCfg);
  assert.deepEqual(zones, [
    { side: "buy", low: 100, high: 102, buyVolume: 53, sellVolume: 4 },
    { side: "sell", low: 104, high: 106, buyVolume: 4, sellVolume: 31 },
  ]);
});

test("buildFootprintZones requires at least minStackedLevels consecutive levels", () => {
  const bar = [
    { price: 100, buyVolume: 20, sellVolume: 1 },
    { price: 101, buyVolume: 15, sellVolume: 1 },
    { price: 102, buyVolume: 1, sellVolume: 1 }, // breaks the run after only 2 levels
  ];
  assert.deepEqual(buildFootprintZones([bar], zoneCfg), []);
});

test("buildFootprintZones merges volume across multiple footprint bars before finding zones", () => {
  const bar1 = [
    { price: 100, buyVolume: 10, sellVolume: 1 },
    { price: 101, buyVolume: 8, sellVolume: 1 },
    { price: 102, buyVolume: 9, sellVolume: 1 },
  ];
  const bar2 = [
    { price: 100, buyVolume: 10, sellVolume: 0 },
    { price: 101, buyVolume: 7, sellVolume: 0 },
    { price: 102, buyVolume: 9, sellVolume: 1 },
  ];
  const zones = buildFootprintZones([bar1, bar2], zoneCfg);
  assert.deepEqual(zones, [{ side: "buy", low: 100, high: 102, buyVolume: 53, sellVolume: 4 }]);
});

test("buildFootprintZones re-buckets to a coarser bucketSizePts than the raw trade prices", () => {
  const bar = [
    { price: 100, buyVolume: 10, sellVolume: 1 },
    { price: 100.4, buyVolume: 8, sellVolume: 1 }, // same 1pt bucket as 100
    { price: 101, buyVolume: 9, sellVolume: 1 },
    { price: 102, buyVolume: 12, sellVolume: 1 },
  ];
  const zones = buildFootprintZones([bar], { ...zoneCfg, bucketSizePts: 1 });
  assert.deepEqual(zones, [{ side: "buy", low: 100, high: 102, buyVolume: 39, sellVolume: 4 }]);
});

test("detectBigTrade flags a trade at or above the size threshold", () => {
  assert.equal(detectBigTrade({ volume: 50 }, { bigTradeSizeThreshold: 50 }), true);
  assert.equal(detectBigTrade({ volume: 49 }, { bigTradeSizeThreshold: 50 }), false);
});

test("detectTrappedParticipants: a big buy that fails to push price higher and reverses is a short trigger", () => {
  const bigTrade = { price: 100, type: 0 }; // buy aggressor
  const bars = [
    { high: 99.8, low: 98, close: 99 },
    { high: 99.5, low: 97.5, close: 98 },
    { high: 99, low: 96, close: 97 }, // current bar, closed back below the big trade's price
  ];
  assert.deepEqual(detectTrappedParticipants(bars, 2, bigTrade, { reversalLookbackBars: 3 }), {
    direction: "short",
    trappedPrice: 100,
  });
});

test("detectTrappedParticipants: a big sell that fails to push price lower and reverses is a long trigger", () => {
  const bigTrade = { price: 100, type: 1 }; // sell aggressor
  const bars = [
    { high: 103, low: 100.5, close: 102 },
    { high: 102, low: 100.2, close: 101.5 },
    { high: 101.5, low: 100.8, close: 101 }, // current bar, closed back above the big trade's price
  ];
  assert.deepEqual(detectTrappedParticipants(bars, 2, bigTrade, { reversalLookbackBars: 3 }), {
    direction: "long",
    trappedPrice: 100,
  });
});

test("detectTrappedParticipants: no signal if price already pushed past the big trade's price first", () => {
  const bigTrade = { price: 100, type: 0 }; // buy aggressor
  const bars = [
    { high: 102, low: 99, close: 101 }, // price DID continue above 100 at some point
    { high: 100.5, low: 98, close: 99 },
    { high: 99, low: 97, close: 97 }, // then reverses — but too late, already continued
  ];
  assert.equal(detectTrappedParticipants(bars, 2, bigTrade, { reversalLookbackBars: 3 }), null);
});

test("detectTrappedParticipants: no signal if price hasn't reversed yet", () => {
  const bigTrade = { price: 100, type: 0 };
  const bars = [{ high: 101, low: 99.5, close: 101 }];
  assert.equal(detectTrappedParticipants(bars, 0, bigTrade, { reversalLookbackBars: 3 }), null);
});

test("detectTrappedParticipants: null with no big trade", () => {
  const bars = [{ high: 101, low: 99, close: 100 }];
  assert.equal(detectTrappedParticipants(bars, 0, null, { reversalLookbackBars: 3 }), null);
});
