import { test } from "node:test";
import assert from "node:assert/strict";
import { withCumDelta } from "../src/orderFlow.js";
import {
  checkFailedBreakout,
  checkDivergenceAfterEntry,
  regimeFlipToPosGamma,
  evaluateExit,
} from "../src/exitRules.js";
import { CONFIG } from "../src/config.js";

test("checkFailedBreakout: long position closing back below the level by more than the threshold", () => {
  assert.equal(
    checkFailedBreakout({ direction: "long", currentClose: 5497.5, brokenLevel: 5500, failedBreakoutPts: 2 }),
    true
  );
  assert.equal(
    checkFailedBreakout({ direction: "long", currentClose: 5498.5, brokenLevel: 5500, failedBreakoutPts: 2 }),
    false
  );
});

test("checkFailedBreakout: short position closing back above the level by more than the threshold", () => {
  assert.equal(
    checkFailedBreakout({ direction: "short", currentClose: 5502.5, brokenLevel: 5500, failedBreakoutPts: 2 }),
    true
  );
});

function quietBars(n) {
  return withCumDelta(
    Array.from({ length: n }, () => ({
      high: 5500.1,
      low: 5499.9,
      close: 5500,
      buyVolume: 55,
      sellVolume: 45,
    }))
  );
}

test("checkDivergenceAfterEntry: fires within the window when price extends but cum_delta doesn't", () => {
  const bars = quietBars(5).concat(
    withCumDelta([
      { high: 5501, low: 5500, close: 5501, buyVolume: 80, sellVolume: 60 }, // entry bar, index 5
      { high: 5502, low: 5501, close: 5502, buyVolume: 90, sellVolume: 70 }, // index 6, new high, cumDelta still rising
      { high: 5503, low: 5502, close: 5503, buyVolume: 40, sellVolume: 60 }, // index 7, new high but cumDelta drops
    ]).map((b, i) => ({ ...b, cumDelta: b.cumDelta + quietBars(5)[4].cumDelta }))
  );
  const result = checkDivergenceAfterEntry({
    bars,
    entryIndex: 5,
    currentIndex: 7,
    divergenceLookbackBars: 3,
    withinBars: 5,
  });
  assert.equal(result, true);
});

test("checkDivergenceAfterEntry: does not fire once outside the withinBars window of entry", () => {
  const bars = quietBars(10);
  const result = checkDivergenceAfterEntry({
    bars,
    entryIndex: 0,
    currentIndex: 6,
    divergenceLookbackBars: 3,
    withinBars: 5,
  });
  assert.equal(result, false);
});

test("regimeFlipToPosGamma: fires only on a fresh flip into POS_GAMMA while in open space", () => {
  assert.equal(
    regimeFlipToPosGamma({ prevRegimeBase: "NEG_GAMMA", currentRegimeBase: "POS_GAMMA", inOpenSpace: true }),
    true
  );
  assert.equal(
    regimeFlipToPosGamma({ prevRegimeBase: "POS_GAMMA", currentRegimeBase: "POS_GAMMA", inOpenSpace: true }),
    false // already was POS_GAMMA, not a fresh flip
  );
  assert.equal(
    regimeFlipToPosGamma({ prevRegimeBase: "NEG_GAMMA", currentRegimeBase: "POS_GAMMA", inOpenSpace: false }),
    false // not in open space
  );
});

function baseExitCtx(overrides = {}) {
  return {
    direction: "long",
    currentBar: { close: 5510 },
    brokenLevel: 5500,
    entryIndex: 0,
    currentIndex: 20,
    bars: quietBars(21),
    inOpenSpace: true,
    prevRegimeBase: "NEG_GAMMA",
    currentRegimeBase: "NEG_GAMMA",
    touchWindow: null,
    priorBars: [],
    levelPriceForAbsorption: null,
    config: CONFIG,
    ...overrides,
  };
}

test("evaluateExit: HOLD when nothing is wrong", () => {
  assert.deepEqual(evaluateExit(baseExitCtx()), { action: "HOLD" });
});

test("evaluateExit: EXIT_NOW on a failed breakout, checked first", () => {
  const result = evaluateExit(baseExitCtx({ currentBar: { close: 5497 } }));
  assert.equal(result.action, "EXIT_NOW");
  assert.equal(result.reason, "failed_breakout");
});

test("evaluateExit: TAKE_PARTIAL on absorption against the position en route to target", () => {
  const priorBars = Array.from({ length: 20 }, () => ({ volume: 100 }));
  const touchWindow = [
    { high: 5521, low: 5519.5, volume: 200 },
    { high: 5521.5, low: 5520, volume: 220 },
    { high: 5521, low: 5520, volume: 210 },
  ];
  const result = evaluateExit(
    baseExitCtx({ touchWindow, priorBars, levelPriceForAbsorption: 5520 })
  );
  assert.equal(result.action, "TAKE_PARTIAL");
  assert.equal(result.reason, "absorption_at_level");
});

test("evaluateExit: TIGHTEN_TRAIL when regime flips to POS_GAMMA in open space", () => {
  const result = evaluateExit(baseExitCtx({ currentRegimeBase: "POS_GAMMA" }));
  assert.equal(result.action, "TIGHTEN_TRAIL");
  assert.equal(result.reason, "regime_flipped_to_pos_gamma");
});
