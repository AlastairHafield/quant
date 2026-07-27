import { test } from "node:test";
import assert from "node:assert/strict";
import { adx, latestAdx, priorDayAdxOk } from "../src/adx.js";

test("adx: returns an all-null array when there aren't enough bars (< 2x period)", () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ high: 100 + i, low: 99 + i, close: 99.5 + i }));
  const result = adx(bars, 14);
  assert.equal(result.length, 20);
  assert.ok(result.every((v) => v === null));
});

function trendingBars(n) {
  return Array.from({ length: n }, (_, i) => ({
    high: 100 + i * 2,
    low: 100 + i * 2 - 1,
    close: 100 + i * 2 - 0.5,
  }));
}

function choppyBars(n) {
  return Array.from({ length: n }, (_, i) => {
    const base = i % 2 === 0 ? 101 : 99;
    return { high: base + 1, low: base - 1, close: base };
  });
}

test("adx: a clean, steady uptrend produces a high ADX reading", () => {
  const bars = trendingBars(40);
  const value = latestAdx(bars, 14);
  assert.ok(value != null && value > 25, `expected strong-trend ADX > 25, got ${value}`);
});

test("adx: a choppy back-and-forth series produces a low ADX reading", () => {
  const bars = choppyBars(40);
  const value = latestAdx(bars, 14);
  assert.ok(value != null && value < 25, `expected choppy ADX < 25, got ${value}`);
});

test("priorDayAdxOk: ok=true when the trending series clears the threshold", () => {
  const result = priorDayAdxOk(trendingBars(40), { adxPeriod: 14, adxThreshold: 25 });
  assert.equal(result.ok, true);
  assert.ok(result.adx > 25);
});

test("priorDayAdxOk: ok=false when the choppy series doesn't clear the threshold", () => {
  const result = priorDayAdxOk(choppyBars(40), { adxPeriod: 14, adxThreshold: 25 });
  assert.equal(result.ok, false);
});

test("priorDayAdxOk: ok=false (not thrown) when there isn't enough history", () => {
  const result = priorDayAdxOk(trendingBars(10), { adxPeriod: 14, adxThreshold: 25 });
  assert.equal(result.adx, null);
  assert.equal(result.ok, false);
});
