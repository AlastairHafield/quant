import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegimeMap } from '../src/engine/marketData.js';

test('buildRegimeMap: keys off the PRIOR day, never today (no lookahead)', () => {
  const dailyBars = [
    { date: '2026-01-01', close: 100 },
    { date: '2026-01-02', close: 102 },
    { date: '2026-01-03', close: 104 },
  ];
  const vixBars = [
    { date: '2026-01-01', close: 15 },
    { date: '2026-01-02', close: 16 },
  ];
  const regime = buildRegimeMap(dailyBars, vixBars);

  // No entry for the very first day — there's no "prior day" for it.
  assert.equal(regime['2026-01-01'], undefined);
  // 2026-01-02's regime reflects 2026-01-01's close/VIX, not its own.
  assert.equal(regime['2026-01-02'].prevClose, 100);
  assert.equal(regime['2026-01-02'].vix, 15);
  assert.equal(regime['2026-01-03'].prevClose, 102);
  assert.equal(regime['2026-01-03'].vix, 16);
});

test('buildRegimeMap: not enough history for SMA20/50 leaves trend FLAT rather than guessing', () => {
  const dailyBars = [
    { date: '2026-01-01', close: 100 },
    { date: '2026-01-02', close: 102 },
    { date: '2026-01-03', close: 104 },
  ];
  const regime = buildRegimeMap(dailyBars, []);
  assert.equal(regime['2026-01-03'].trend, 'FLAT');
  assert.equal(regime['2026-01-03'].adx, null);
  assert.equal(regime['2026-01-03'].vix, null); // no VIX data supplied
});

test('buildRegimeMap: a sustained uptrend (close > sma20 > sma50) classifies as UP once there is enough history', () => {
  const dailyBars = Array.from({ length: 60 }, (_, i) => ({
    date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    close: 100 + i,
    high: 100 + i + 1,
    low: 100 + i - 1,
  }));
  const regime = buildRegimeMap(dailyBars, []);
  const lastKey = dailyBars[dailyBars.length - 1].date;
  assert.equal(regime[lastKey].trend, 'UP');
  assert.ok(regime[lastKey].adx > 0);
});

test('buildRegimeMap: a sustained downtrend classifies as DOWN', () => {
  const dailyBars = Array.from({ length: 60 }, (_, i) => ({
    date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    close: 200 - i,
    high: 200 - i + 1,
    low: 200 - i - 1,
  }));
  const regime = buildRegimeMap(dailyBars, []);
  const lastKey = dailyBars[dailyBars.length - 1].date;
  assert.equal(regime[lastKey].trend, 'DOWN');
});
