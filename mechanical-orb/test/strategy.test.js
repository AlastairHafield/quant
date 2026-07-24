import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minutesOf,
  orbWindowBounds,
  isWithinOrbWindow,
  updateOrbRange,
  checkTrigger,
  computeStop,
  shouldFlattenNow,
  evaluateEntry,
} from "../src/strategy.js";
import { CONFIG } from "../src/config.js";

test("minutesOf / orbWindowBounds / isWithinOrbWindow", () => {
  assert.equal(minutesOf(new Date(2026, 6, 24, 9, 30)), 570);
  const bounds = orbWindowBounds({ sessionOpenET: { h: 9, m: 30 }, orWindowMin: 15 });
  assert.deepEqual(bounds, { startMin: 570, endMin: 585 });
  assert.equal(isWithinOrbWindow(new Date(2026, 6, 24, 9, 44), bounds), true);
  assert.equal(isWithinOrbWindow(new Date(2026, 6, 24, 9, 45), bounds), false);
});

test("updateOrbRange: expands high/low, never retreats", () => {
  let range = { orbHigh: null, orbLow: null };
  range = updateOrbRange(range, { high: 5510, low: 5505 });
  range = updateOrbRange(range, { high: 5515, low: 5508 });
  assert.deepEqual(range, { orbHigh: 5515, orbLow: 5505 });
});

test("checkTrigger: long fires on a close beyond the OR high; short/other directions never trigger", () => {
  assert.equal(checkTrigger(5516, 5515, 0, "long"), "long");
  assert.equal(checkTrigger(5515, 5515, 0, "long"), null); // needs to close strictly beyond
  assert.equal(checkTrigger(5490, 5515, 0, "long"), null); // OR-low breaks are ignored, LONG-only
  assert.equal(checkTrigger(5516, 5515, 0, "short"), null); // strategy is pinned to long
});

test("computeStop: stop distance is 1.5x the OR range, below entry", () => {
  const { stopPrice, stopDistance } = computeStop({ entryPrice: 5520, orbHigh: 5515, orbLow: 5510, fracOfOrRange: 1.5 });
  assert.equal(stopDistance, 7.5); // 1.5 * (5515-5510)
  assert.equal(stopPrice, 5512.5);
});

test("shouldFlattenNow: true at/after the configured flatten time", () => {
  const cfg = { flattenAtET: { h: 15, m: 55 } };
  assert.equal(shouldFlattenNow(new Date(2026, 6, 24, 15, 54), cfg), false);
  assert.equal(shouldFlattenNow(new Date(2026, 6, 24, 15, 55), cfg), true);
});

function baseCtx(overrides = {}) {
  return {
    bar: { close: 5522 },
    orbHigh: 5520,
    orbLow: 5510,
    nowET: new Date(2026, 6, 24, 9, 50),
    adxOk: true,
    config: CONFIG,
    dayState: { tradedToday: false },
    ...overrides,
  };
}

test("evaluateEntry: no signal when price is inside the OR", () => {
  assert.equal(evaluateEntry(baseCtx({ bar: { close: 5515 } })), null);
});

test("evaluateEntry: vetoes when already traded today", () => {
  const result = evaluateEntry(baseCtx({ dayState: { tradedToday: true } }));
  assert.equal(result.veto, "already_traded_today");
});

test("evaluateEntry: vetoes past the entry cutoff", () => {
  const result = evaluateEntry(baseCtx({ nowET: new Date(2026, 6, 24, 12, 1) }));
  assert.equal(result.veto, "past_entry_cutoff");
});

test("evaluateEntry: vetoes when prior-day ADX is below threshold", () => {
  const result = evaluateEntry(baseCtx({ adxOk: false }));
  assert.equal(result.veto, "adx_below_threshold");
});

test("evaluateEntry: produces a full long signal on a clean breakout", () => {
  const result = evaluateEntry(baseCtx());
  assert.equal(result.veto, null);
  assert.equal(result.direction, "long");
  assert.equal(result.entryPrice, 5522);
  assert.equal(result.stopPrice, 5507); // 5522 - 1.5*(5520-5510)
});
