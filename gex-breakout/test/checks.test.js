import { test } from "node:test";
import assert from "node:assert/strict";
import { timeCheck } from "../src/checks.js";

test("timeCheck: before the cutoff passes, at/after fails", () => {
  const cutoff = { h: 15, m: 55 };
  assert.equal(timeCheck(new Date(2026, 6, 24, 15, 54), cutoff), true);
  assert.equal(timeCheck(new Date(2026, 6, 24, 15, 55), cutoff), false);
  assert.equal(timeCheck(new Date(2026, 6, 24, 16, 0), cutoff), false);
});
