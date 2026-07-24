import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBasis, toEsLevel, toEsLevels, isBasisStale } from "../src/basis.js";

test("computeBasis is ES minus SPX cash", () => {
  assert.equal(computeBasis(5510.25, 5502.0), 8.25);
  assert.equal(computeBasis(5490.0, 5502.0), -12.0);
});

test("toEsLevel shifts an SPX-terms level by the basis", () => {
  assert.equal(toEsLevel(5500, 8.25), 5508.25);
  assert.equal(toEsLevel(null, 8.25), null);
});

test("toEsLevels shifts a whole level list, preserving other fields", () => {
  const levels = [
    { type: "FLIP", price: 5500 },
    { type: "GEX_WALL", price: 5525, wallType: "POS_WALL" },
  ];
  const shifted = toEsLevels(levels, 8.25);
  assert.equal(shifted[0].price, 5508.25);
  assert.equal(shifted[1].price, 5533.25);
  assert.equal(shifted[1].wallType, "POS_WALL");
});

test("isBasisStale flags basis older than the configured max age", () => {
  const asOf = new Date("2026-07-24T14:00:00Z");
  const fresh = new Date("2026-07-24T14:05:00Z");
  const stale = new Date("2026-07-24T14:11:00Z");
  assert.equal(isBasisStale(asOf, fresh, 10), false);
  assert.equal(isBasisStale(asOf, stale, 10), true);
});
