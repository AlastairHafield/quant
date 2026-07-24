import { test } from "node:test";
import assert from "node:assert/strict";
import { barExcursion, updateMfeMae } from "../src/positionTracking.js";

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
