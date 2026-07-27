import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minutesOf,
  isAtOrAfterSessionOpen,
  shouldFlattenNow,
  priorRthCloseFromHistoricalBars,
  evaluateEntry,
} from "../src/strategy.js";

const CONFIG = {
  sessionOpenET: { h: 9, m: 30 },
  flattenAtET: { h: 15, m: 55 },
  gapMinPct: 0.5,
  stopParam: 0.5,
  targetParam: 1.0,
};

test("minutesOf: converts a Date to minutes-since-midnight", () => {
  assert.equal(minutesOf(new Date(2026, 6, 27, 9, 30)), 570);
  assert.equal(minutesOf(new Date(2026, 6, 27, 0, 0)), 0);
});

test("isAtOrAfterSessionOpen: false before 9:30, true at/after", () => {
  assert.equal(isAtOrAfterSessionOpen(new Date(2026, 6, 27, 9, 29), CONFIG), false);
  assert.equal(isAtOrAfterSessionOpen(new Date(2026, 6, 27, 9, 30), CONFIG), true);
  assert.equal(isAtOrAfterSessionOpen(new Date(2026, 6, 27, 10, 0), CONFIG), true);
});

test("shouldFlattenNow: false before 15:55, true at/after", () => {
  assert.equal(shouldFlattenNow(new Date(2026, 6, 27, 15, 54), CONFIG), false);
  assert.equal(shouldFlattenNow(new Date(2026, 6, 27, 15, 55), CONFIG), true);
});

// A fixed, real toET stand-in (bars already carry a plain local Date via
// `new Date(timestamp)` — production's toET does ET conversion, tests just
// need something deterministic).
const toETIdentity = (d) => d;

function bar(ts, close, high = close, low = close) {
  return { timestamp: ts, close, high, low };
}

test("priorRthCloseFromHistoricalBars: finds the last RTH bar's close on a normal weekday", () => {
  const bars = [
    bar("2026-07-23T13:00:00", 100), // Thu, RTH
    bar("2026-07-23T20:00:00", 105), // Thu, after RTH (16:00+) — excluded
    bar("2026-07-24T09:31:00", 110), // Fri (today, if today=Fri) — excluded by todayKey
  ];
  const todayKey = new Date("2026-07-24T09:31:00").toDateString();
  const result = priorRthCloseFromHistoricalBars(bars, todayKey, toETIdentity);
  assert.equal(result, 100);
});

test("priorRthCloseFromHistoricalBars: skips a weekend with no RTH bars, finds Friday's close for a Monday", () => {
  const bars = [
    bar("2026-07-24T13:00:00", 200), // Friday RTH
    bar("2026-07-24T15:59:00", 202), // Friday RTH, later — should win (last bar)
    // no Saturday/Sunday bars at all — Globex is closed
    bar("2026-07-27T09:31:00", 205), // Monday (today) — excluded
  ];
  const todayKey = new Date("2026-07-27T09:31:00").toDateString();
  const result = priorRthCloseFromHistoricalBars(bars, todayKey, toETIdentity);
  assert.equal(result, 202);
});

test("priorRthCloseFromHistoricalBars: null when no RTH bars exist in the lookback at all", () => {
  const bars = [bar("2026-07-24T20:00:00", 100)]; // only an after-hours bar
  const result = priorRthCloseFromHistoricalBars(bars, "some-other-day", toETIdentity);
  assert.equal(result, null);
});

test("evaluateEntry: vetoes when there's no prior close yet", () => {
  const result = evaluateEntry({ bar: { open: 100, close: 100.5 }, priorClose: null, adxOk: true, config: CONFIG });
  assert.equal(result.veto, "no_prior_close");
});

test("evaluateEntry: vetoes when prior-day ADX is below threshold", () => {
  const result = evaluateEntry({ bar: { open: 101, close: 101.2 }, priorClose: 100, adxOk: false, config: CONFIG });
  assert.equal(result.veto, "adx_below_threshold");
});

test("evaluateEntry: vetoes when the gap is smaller than gapMinPct", () => {
  // 100 -> 100.3 is a 0.3% gap, below the 0.5% threshold
  const result = evaluateEntry({ bar: { open: 100.3, close: 100.4 }, priorClose: 100, adxOk: true, config: CONFIG });
  assert.equal(result.veto, "gap_too_small");
  assert.ok(Math.abs(result.gapPct - 0.3) < 1e-9);
});

test("evaluateEntry: gap UP produces a LONG signal (continuation, not fade)", () => {
  // 100 -> 101 is a 1% gap up
  const result = evaluateEntry({ bar: { open: 101, close: 101.1 }, priorClose: 100, adxOk: true, config: CONFIG });
  assert.equal(result.veto, null);
  assert.equal(result.direction, "long");
  assert.equal(result.entryPrice, 101.1); // fills at the bar's CLOSE, not its open
  // gapSize = 1 (open 101 - priorClose 100), stopDistance = 0.5 * 1 = 0.5
  assert.equal(result.stopPrice, 101.1 - 0.5);
  // targetDistance = 1.0 * stopDistance = 0.5 (1:1 R:R)
  assert.equal(result.targetPrice, 101.1 + 0.5);
});

test("evaluateEntry: gap DOWN produces a SHORT signal, stop above / target below entry", () => {
  // 100 -> 99 is a 1% gap down
  const result = evaluateEntry({ bar: { open: 99, close: 98.9 }, priorClose: 100, adxOk: true, config: CONFIG });
  assert.equal(result.direction, "short");
  assert.equal(result.entryPrice, 98.9);
  assert.equal(result.stopPrice, 98.9 + 0.5);
  assert.equal(result.targetPrice, 98.9 - 0.5);
});

test("evaluateEntry: gapPct sign matches direction (positive for up-gaps, negative for down-gaps)", () => {
  const up = evaluateEntry({ bar: { open: 101, close: 101 }, priorClose: 100, adxOk: true, config: CONFIG });
  const down = evaluateEntry({ bar: { open: 99, close: 99 }, priorClose: 100, adxOk: true, config: CONFIG });
  assert.ok(up.gapPct > 0);
  assert.ok(down.gapPct < 0);
});
