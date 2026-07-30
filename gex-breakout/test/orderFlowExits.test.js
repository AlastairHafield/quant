import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateOrderFlowExit, nearestZonePriceFor } from "../src/orderFlowExits.js";

const config = {
  exit: { divergenceWithinBarsOfEntry: 5 },
  orderFlow: {
    divergenceLookbackBars: 3,
    absorption: { volMultiple: 1.5, maxAdvancePts: 2, avgLookbackBars: 20 },
  },
};

function priceBar({ high, low, close, cumDelta }) {
  return { high, low, close, cumDelta };
}

test("evaluateOrderFlowExit: EXIT_NOW on a delta divergence shortly after entry", () => {
  const bars = [
    priceBar({ high: 100, low: 99, close: 100, cumDelta: 50 }),
    priceBar({ high: 101, low: 100, close: 101, cumDelta: 80 }),
    priceBar({ high: 102, low: 101, close: 102, cumDelta: 60 }), // new price high, cumDelta fell back
  ];
  const result = evaluateOrderFlowExit({
    direction: "long",
    entryIndex: 0,
    currentIndex: 2,
    bars,
    touchWindow: null,
    priorBars: [],
    levelPriceForAbsorption: null,
    isTrendDay: false,
    nearestZonePrice: null,
    config,
  });
  assert.deepEqual(result, { action: "EXIT_NOW", reason: "delta_divergence_after_entry" });
});

test("evaluateOrderFlowExit: divergence outside the post-entry window is ignored", () => {
  const bars = [
    priceBar({ high: 100, low: 99, close: 100, cumDelta: 50 }),
    priceBar({ high: 101, low: 100, close: 101, cumDelta: 80 }),
    priceBar({ high: 102, low: 101, close: 102, cumDelta: 60 }),
  ];
  const result = evaluateOrderFlowExit({
    direction: "long",
    entryIndex: 0,
    currentIndex: 2,
    bars,
    touchWindow: null,
    priorBars: [],
    levelPriceForAbsorption: null,
    isTrendDay: false,
    nearestZonePrice: null,
    config: { ...config, exit: { divergenceWithinBarsOfEntry: 1 } }, // 2-0=2 > 1
  });
  assert.equal(result.action, "HOLD");
});

test("evaluateOrderFlowExit: TAKE_PARTIAL on absorption at the reference level", () => {
  const priorBars = Array.from({ length: 20 }, () => ({ volume: 100 }));
  const touchWindow = [
    { high: 5501, low: 5499.5, volume: 200 },
    { high: 5501.5, low: 5500, volume: 220 },
    { high: 5501, low: 5500, volume: 210 },
  ];
  const bars = [priceBar({ high: 5500, low: 5499, close: 5500, cumDelta: 10 })];
  const result = evaluateOrderFlowExit({
    direction: "long",
    entryIndex: 0,
    currentIndex: 0,
    bars,
    touchWindow,
    priorBars,
    levelPriceForAbsorption: 5500,
    isTrendDay: false,
    nearestZonePrice: null,
    config,
  });
  assert.deepEqual(result, { action: "TAKE_PARTIAL", reason: "absorption_at_target" });
});

test("evaluateOrderFlowExit: TIGHTEN_TO_PRICE trails behind the nearest zone on a trend day", () => {
  const bars = [priceBar({ high: 5500, low: 5499, close: 5500, cumDelta: 10 })];
  const result = evaluateOrderFlowExit({
    direction: "long",
    entryIndex: 0,
    currentIndex: 0,
    bars,
    touchWindow: null,
    priorBars: [],
    levelPriceForAbsorption: null,
    isTrendDay: true,
    nearestZonePrice: 5490,
    config,
  });
  assert.deepEqual(result, { action: "TIGHTEN_TO_PRICE", reason: "trail_behind_nearest_zone", price: 5490 });
});

test("evaluateOrderFlowExit: no trailing on a mean-reversion (non-trend) day even with a zone price given", () => {
  const bars = [priceBar({ high: 5500, low: 5499, close: 5500, cumDelta: 10 })];
  const result = evaluateOrderFlowExit({
    direction: "long",
    entryIndex: 0,
    currentIndex: 0,
    bars,
    touchWindow: null,
    priorBars: [],
    levelPriceForAbsorption: null,
    isTrendDay: false,
    nearestZonePrice: 5490,
    config,
  });
  assert.equal(result.action, "HOLD");
});

test("evaluateOrderFlowExit: HOLD when nothing triggers", () => {
  const bars = [priceBar({ high: 5500, low: 5499, close: 5500, cumDelta: 10 })];
  const result = evaluateOrderFlowExit({
    direction: "long",
    entryIndex: 0,
    currentIndex: 0,
    bars,
    touchWindow: null,
    priorBars: [],
    levelPriceForAbsorption: null,
    isTrendDay: false,
    nearestZonePrice: null,
    config,
  });
  assert.deepEqual(result, { action: "HOLD" });
});

test("evaluateOrderFlowExit: divergence takes priority over absorption when both would trigger", () => {
  const priorBars = Array.from({ length: 20 }, () => ({ volume: 100 }));
  const touchWindow = [
    { high: 5501, low: 5499.5, volume: 200 },
    { high: 5501.5, low: 5500, volume: 220 },
    { high: 5501, low: 5500, volume: 210 },
  ];
  const bars = [
    priceBar({ high: 100, low: 99, close: 100, cumDelta: 50 }),
    priceBar({ high: 101, low: 100, close: 101, cumDelta: 80 }),
    priceBar({ high: 102, low: 101, close: 102, cumDelta: 60 }),
  ];
  const result = evaluateOrderFlowExit({
    direction: "long",
    entryIndex: 0,
    currentIndex: 2,
    bars,
    touchWindow,
    priorBars,
    levelPriceForAbsorption: 5500,
    isTrendDay: true,
    nearestZonePrice: 5490,
    config,
  });
  assert.equal(result.action, "EXIT_NOW");
});

test("nearestZonePriceFor: long picks the nearest zone high below current price", () => {
  const zones = [{ low: 90, high: 95 }, { low: 80, high: 85 }, { low: 70, high: 75 }];
  assert.equal(nearestZonePriceFor(zones, "long", 100), 95);
});

test("nearestZonePriceFor: short picks the nearest zone low above current price", () => {
  const zones = [{ low: 105, high: 110 }, { low: 115, high: 120 }];
  assert.equal(nearestZonePriceFor(zones, "short", 100), 105);
});

test("nearestZonePriceFor: excludes zones on the wrong side of price", () => {
  const zones = [{ low: 90, high: 95 }]; // below price, not eligible for a short
  assert.equal(nearestZonePriceFor(zones, "short", 100), null);
});

test("nearestZonePriceFor: null with no zones", () => {
  assert.equal(nearestZonePriceFor([], "long", 100), null);
});
