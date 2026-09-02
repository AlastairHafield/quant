import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDailyPnl, isDailyLossCapBreached, ladderStartingEquityPlausible } from "../accountRisk.js";

test("computeDailyPnl: balance minus day-start balance", () => {
  assert.equal(computeDailyPnl(49000, 50000), -1000);
  assert.equal(computeDailyPnl(50500, 50000), 500);
});

test("computeDailyPnl: null inputs (not yet known) return null, not a bogus number", () => {
  assert.equal(computeDailyPnl(null, 50000), null);
  assert.equal(computeDailyPnl(50000, null), null);
});

test("isDailyLossCapBreached: trips at or beyond the cap, not before", () => {
  assert.equal(isDailyLossCapBreached(-999, 1000), false);
  assert.equal(isDailyLossCapBreached(-1000, 1000), true);
  assert.equal(isDailyLossCapBreached(-1500, 1000), true);
  assert.equal(isDailyLossCapBreached(500, 1000), false);
});

test("isDailyLossCapBreached: never trips when cap or pnl is unknown", () => {
  assert.equal(isDailyLossCapBreached(null, 1000), false);
  assert.equal(isDailyLossCapBreached(-5000, null), false);
});

test("ladderStartingEquityPlausible: real growth within maxGrowthRatio passes", () => {
  assert.equal(ladderStartingEquityPlausible(50000, 60000), true);
  assert.equal(ladderStartingEquityPlausible(50000, 149999), true);
});

test("ladderStartingEquityPlausible: a drawdown (below startingEquity) is never flagged by this check", () => {
  assert.equal(ladderStartingEquityPlausible(50000, 10000), true);
});

test("ladderStartingEquityPlausible: reproduces the 2026-07-28 incident shape", () => {
  // startingEquity left at $2,000 against a real ~$49,587 balance — the
  // ladder read that as ~25x organic growth, which this must flag as false.
  assert.equal(ladderStartingEquityPlausible(2000, 49587), false);
});

test("ladderStartingEquityPlausible: unknown inputs don't block (fail open, can't check)", () => {
  assert.equal(ladderStartingEquityPlausible(null, 49587), true);
  assert.equal(ladderStartingEquityPlausible(2000, null), true);
});
