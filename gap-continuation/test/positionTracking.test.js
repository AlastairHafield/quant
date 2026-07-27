import { test } from "node:test";
import assert from "node:assert/strict";
import { barExcursion, updateMfeMae, computeRealizedPnl } from "../src/positionTracking.js";

test("barExcursion: long — favorable is how far high ran above entry, adverse is how far low ran below", () => {
  const r = barExcursion(5500, "long", { high: 5510, low: 5495 });
  assert.equal(r.favorable, 10);
  assert.equal(r.adverse, 5);
});

test("updateMfeMae: tracks the running maximum across bars, never decreasing", () => {
  let state = { mfe: 0, mae: 0 };
  state = updateMfeMae(state, 5500, "long", { high: 5505, low: 5498 });
  assert.deepEqual(state, { mfe: 5, mae: 2 });
  state = updateMfeMae(state, 5500, "long", { high: 5503, low: 5490 });
  assert.deepEqual(state, { mfe: 5, mae: 10 });
});

test("computeRealizedPnl: long profits when exit is above entry, short profits when exit is below entry", () => {
  assert.equal(computeRealizedPnl(5500, 5510, "long", 5, 1), 50); // 10pts * $5 * 1
  assert.equal(computeRealizedPnl(5500, 5490, "long", 5, 1), -50);
});
