import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRegime, isFlipBreak } from "../src/regime.js";

test("classifyRegime: negative net GEX is NEG_GAMMA away from the flip", () => {
  const r = classifyRegime({ netGex: -5e9, price: 5600, flipPointEs: 5500, nearFlipPts: 10 });
  assert.equal(r.baseRegime, "NEG_GAMMA");
  assert.equal(r.nearFlip, false);
  assert.equal(r.regime, "NEG_GAMMA");
});

test("classifyRegime: positive net GEX is POS_GAMMA away from the flip", () => {
  const r = classifyRegime({ netGex: 3e9, price: 5450, flipPointEs: 5500, nearFlipPts: 10 });
  assert.equal(r.baseRegime, "POS_GAMMA");
  assert.equal(r.regime, "POS_GAMMA");
});

test("classifyRegime: within nearFlipPts of the flip overrides to NEAR_FLIP regardless of sign", () => {
  const neg = classifyRegime({ netGex: -1e9, price: 5505, flipPointEs: 5500, nearFlipPts: 10 });
  assert.equal(neg.baseRegime, "NEG_GAMMA");
  assert.equal(neg.nearFlip, true);
  assert.equal(neg.regime, "NEAR_FLIP");

  const pos = classifyRegime({ netGex: 1e9, price: 5495, flipPointEs: 5500, nearFlipPts: 10 });
  assert.equal(pos.nearFlip, true);
  assert.equal(pos.regime, "NEAR_FLIP");
});

test("classifyRegime: exactly at the nearFlipPts boundary is not near-flip (strict <)", () => {
  const r = classifyRegime({ netGex: -1e9, price: 5510, flipPointEs: 5500, nearFlipPts: 10 });
  assert.equal(r.nearFlip, false);
});

test("classifyRegime: null flip point never triggers NEAR_FLIP", () => {
  const r = classifyRegime({ netGex: -1e9, price: 5500, flipPointEs: null, nearFlipPts: 10 });
  assert.equal(r.nearFlip, false);
});

test("isFlipBreak detects a close crossing the flip in either direction", () => {
  assert.equal(isFlipBreak(5498, 5502, 5500), true); // crossed up through flip
  assert.equal(isFlipBreak(5502, 5498, 5500), true); // crossed down through flip
  assert.equal(isFlipBreak(5495, 5497, 5500), false); // stayed below
  assert.equal(isFlipBreak(5502, 5501, 5500), false); // stayed above
});

test("isFlipBreak is false when there is no flip point", () => {
  assert.equal(isFlipBreak(5498, 5502, null), false);
});
