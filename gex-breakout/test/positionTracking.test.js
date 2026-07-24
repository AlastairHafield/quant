import { test } from "node:test";
import assert from "node:assert/strict";
import {
  barExcursion,
  updateMfeMae,
  computeRealizedPnl,
  computeExitNowValueSaved,
  computeTightenTrailValueSaved,
  computeTakePartialValueGained,
  clampStopDistance,
} from "../src/positionTracking.js";

test("barExcursion: long — favorable is how far high ran above entry, adverse is how far low ran below", () => {
  const r = barExcursion(5500, "long", { high: 5510, low: 5495 });
  assert.equal(r.favorable, 10);
  assert.equal(r.adverse, 5);
});

test("barExcursion: short — favorable is how far low ran below entry, adverse is how far high ran above", () => {
  const r = barExcursion(5500, "short", { high: 5508, low: 5485 });
  assert.equal(r.favorable, 15);
  assert.equal(r.adverse, 8);
});

test("updateMfeMae: tracks the running maximum across bars, never decreasing", () => {
  let state = { mfe: 0, mae: 0 };
  state = updateMfeMae(state, 5500, "long", { high: 5505, low: 5498 });
  assert.deepEqual(state, { mfe: 5, mae: 2 });

  state = updateMfeMae(state, 5500, "long", { high: 5503, low: 5490 }); // smaller favorable, bigger adverse
  assert.deepEqual(state, { mfe: 5, mae: 10 }); // mfe stays at prior max, mae grows

  state = updateMfeMae(state, 5500, "long", { high: 5520, low: 5495 }); // new favorable high
  assert.deepEqual(state, { mfe: 20, mae: 10 });
});

test("computeRealizedPnl: long profits when exit is above entry, short profits when exit is below entry", () => {
  assert.equal(computeRealizedPnl(5500, 5510, "long", 5, 2), 100); // 10pts * $5 * 2
  assert.equal(computeRealizedPnl(5500, 5490, "long", 5, 2), -100);
  assert.equal(computeRealizedPnl(5500, 5490, "short", 5, 2), 100);
  assert.equal(computeRealizedPnl(5500, 5510, "short", 5, 2), -100);
});

test("computeExitNowValueSaved: risk capital no longer exposed between the actual exit and the original stop", () => {
  assert.equal(computeExitNowValueSaved(5495, 5490, 5, 2), 50); // 5pts * $5 * 2
  assert.equal(computeExitNowValueSaved(5490, 5495, 5, 2), 50); // order-independent, always positive
});

test("computeTightenTrailValueSaved: reduction in max possible loss from moving the stop closer", () => {
  assert.equal(computeTightenTrailValueSaved(5490, 5495, 5, 2), 50); // 5pts * $5 * 2
});

test("computeTakePartialValueGained: locked-in profit on the reduced portion, direction-aware", () => {
  assert.equal(computeTakePartialValueGained(5500, 5510, "long", 5, 1), 50); // 10pts * $5 * 1
  assert.equal(computeTakePartialValueGained(5500, 5490, "short", 5, 1), 50);
});

test("clampStopDistance: leaves a stop alone when it's already far enough from the current price", () => {
  assert.equal(clampStopDistance(5495, 5500, "long", 1), 5495); // 5pts away, min is 1pt
  assert.equal(clampStopDistance(5505, 5500, "short", 1), 5505);
});

test("clampStopDistance: pushes a too-close long stop further below the current price", () => {
  assert.equal(clampStopDistance(5499.75, 5500, "long", 1), 5499); // 0.25pt away -> clamped to exactly 1pt
});

test("clampStopDistance: pushes a too-close short stop further above the current price", () => {
  assert.equal(clampStopDistance(5500.25, 5500, "short", 1), 5501);
});
