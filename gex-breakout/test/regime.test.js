import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRegime } from "../src/regime.js";

test("classifyRegime: prior-day ADX at/above threshold is TREND", () => {
  const r = classifyRegime({ trendDayOk: true });
  assert.equal(r.baseRegime, "TREND");
  assert.equal(r.regime, "TREND");
});

test("classifyRegime: prior-day ADX below threshold is RANGE", () => {
  const r = classifyRegime({ trendDayOk: false });
  assert.equal(r.baseRegime, "RANGE");
  assert.equal(r.regime, "RANGE");
});
