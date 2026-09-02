import { test } from "node:test";
import assert from "node:assert/strict";
import { clampToMaxContracts, MAX_CONTRACTS_PER_ORDER } from "../protectedLimits.js";

test("clampToMaxContracts: leaves a size under the ceiling untouched", () => {
  assert.equal(clampToMaxContracts(2), 2);
  assert.equal(clampToMaxContracts(0), 0);
});

test("clampToMaxContracts: clamps down to the ceiling, never up", () => {
  assert.equal(clampToMaxContracts(MAX_CONTRACTS_PER_ORDER), MAX_CONTRACTS_PER_ORDER);
  assert.equal(clampToMaxContracts(MAX_CONTRACTS_PER_ORDER + 1), MAX_CONTRACTS_PER_ORDER);
  assert.equal(clampToMaxContracts(9999), MAX_CONTRACTS_PER_ORDER);
});

test("clampToMaxContracts: reproduces the 2026-07-28 incident shape — a bad ladder computing 30 contracts gets clamped", () => {
  assert.equal(clampToMaxContracts(30), MAX_CONTRACTS_PER_ORDER);
});

test("clampToMaxContracts: never goes negative, and non-numeric input fails safe to 0", () => {
  assert.equal(clampToMaxContracts(-5), 0);
  assert.equal(clampToMaxContracts(NaN), 0);
  assert.equal(clampToMaxContracts(undefined), 0);
  assert.equal(clampToMaxContracts(null), 0);
});
