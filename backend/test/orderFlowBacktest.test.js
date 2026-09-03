import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { orderFlowBacktestCore, OF_BACKTEST_DEFAULTS } from '../src/engine/orderFlowBacktest.js';

// ─── Synthetic bar builder ─────────────────────────────────────────────────
// Builds one trading day designed to fire exactly one "path_of_least_resistance"
// long entry near the end of the day, via evaluateOrderFlowBot's real logic
// (not reimplemented — see orderFlowBacktest.js's header comment):
//   - bars 0..35: flat/boring baseline (heavy, balanced volume) so no other
//     trigger (failed_auction, zone absorption) fires first.
//   - bars 36..39: a clean 4-bar upward push on LIGHT volume with agreeing
//     cumulative delta — exactly describePathOfLeastResistance's signature.
//   - bar 40: one extra bar so the entry (taken at bar 39) isn't opened on the
//     day's final bar and has something to be exit-managed against.
function nyTimeSeries(startH, startM, count) {
  const out = [];
  let h = startH, m = startM;
  for (let i = 0; i < count; i++) {
    out.push(h * 100 + m);
    m += 1;
    if (m >= 60) { m = 0; h += 1; }
  }
  return out;
}

function buildTrendDay(date, { tamperLastBar = false } = {}) {
  const times = nyTimeSeries(9, 30, 41);
  const bars = [];
  for (let i = 0; i < 35; i++) {
    bars.push({ date, ny_time: times[i], open: 5000, high: 5000.5, low: 4999.5, close: 5000, buyVolume: 50, sellVolume: 50 });
  }
  // The bar immediately before the push closes ABOVE the push's own first
  // close — this breaks describePathOfLeastResistance's "clean progress"
  // check for every 4-bar window that mixes baseline with push bars, so only
  // the window made up ENTIRELY of push bars (ending at bar 39) can match.
  // Without this, a window straddling the baseline/push boundary matches one
  // bar early (empirically confirmed — the whole point of writing this test
  // was to pin the exact bar the real live logic fires on, not approximate it).
  bars.push({ date, ny_time: times[35], open: 5000, high: 5002, low: 4999.5, close: 5001.5, buyVolume: 50, sellVolume: 50 });
  const pushCloses = [5001, 5002, 5003, 5004];
  for (let i = 0; i < 4; i++) {
    bars.push({
      date, ny_time: times[36 + i],
      open: pushCloses[i] - 1, high: pushCloses[i] + 0.5, low: pushCloses[i] - 1.5, close: pushCloses[i],
      buyVolume: 25, sellVolume: 5, // light total volume (30/bar vs. baseline's 100/bar), delta agrees with the up-move
    });
  }
  // The final bar: exit-management only, never itself eligible for a new entry.
  const lastClose = tamperLastBar ? 4000 : 5004;
  bars.push({ date, ny_time: times[40], open: 5004, high: Math.max(5004, lastClose), low: Math.min(5004, lastClose), close: lastClose, buyVolume: 10, sellVolume: 10 });
  return bars;
}

describe('orderFlowBacktestCore', () => {
  test('refuses to run on bars missing real buy/sell volume', () => {
    const bars = [{ date: '2026-06-01', ny_time: 1000, open: 1, high: 1, low: 1, close: 1 }];
    const result = orderFlowBacktestCore(bars, {}, { dateFrom: '2026-06-01', dateTo: '2026-06-01' });
    assert.match(result.error, /buyVolume\/sellVolume/);
  });

  test('refuses to run when only ONE side of a bar\'s volume is missing (partial write/gap), not just when both are', () => {
    // A bar with buyVolume present but sellVolume missing must still be
    // rejected here — letting it through would fall to the `?? 0` fallback
    // a few lines later and fabricate a zero sell-volume bar, exactly the
    // "no one traded" fabricated signal this engine must never produce.
    const bars = [{ date: '2026-06-01', ny_time: 1000, open: 1, high: 1, low: 1, close: 1, buyVolume: 12, sellVolume: null }];
    const result = orderFlowBacktestCore(bars, {}, { dateFrom: '2026-06-01', dateTo: '2026-06-01' });
    assert.match(result.error, /buyVolume\/sellVolume/);
  });

  test('fires a path-of-least-resistance long via the real live orderFlowBot logic', () => {
    const date = '2026-06-01';
    const bars = buildTrendDay(date);
    const regimeMap = { [date]: { adx: 30 } }; // >= adxThreshold(25) => TREND day
    const result = orderFlowBacktestCore(bars, regimeMap, { dateFrom: date, dateTo: date });

    assert.equal(result.error, undefined);
    assert.equal(result.trades.length, 1);
    const t = result.trades[0];
    assert.equal(t.signal, 'LONG');
    assert.equal(t.trigger, 'path_of_least_resistance');
    assert.equal(t.regime_trend, 'TREND');
    assert.equal(t.entry_price, 5004);
    // TREND-day target is the far placeholder (no fixed TP; see module header) —
    // never the value-area contrarian target a RANGE day would use.
    assert.ok(t.target_price > t.entry_price + 100);
  });

  test('never opens a position on the last bar of a day (nothing left to manage an exit)', () => {
    // A day that ends exactly on the trigger bar — same setup as above, minus
    // the trailing 41st bar — must produce zero trades, not a leaked position.
    const date = '2026-06-01';
    const bars = buildTrendDay(date).slice(0, 40);
    const regimeMap = { [date]: { adx: 30 } };
    const result = orderFlowBacktestCore(bars, regimeMap, { dateFrom: date, dateTo: date });
    assert.equal(result.trades.length, 0);
  });

  test('day filters (dowMask) exclude a day entirely, independent of any trigger', () => {
    const date = '2026-06-01'; // a Monday
    const bars = buildTrendDay(date);
    const regimeMap = { [date]: { adx: 30 } };
    const result = orderFlowBacktestCore(bars, regimeMap, { dateFrom: date, dateTo: date, dowMask: 'TWRF' }); // no Monday
    assert.equal(result.trades.length, 0);
    assert.equal(result.filteredDays, 1);
    assert.equal(result.tradedDays, 0);
  });

  // ─── Anti-repainting regression ─────────────────────────────────────────
  // The user's explicit mandate: a DOM/volume-profile backtest must never let
  // a later bar change an earlier decision. This asserts it directly rather
  // than only by code inspection — mutating ONLY the day's final bar (bar 40,
  // which bar 39's entry decision has no legitimate way to see yet) must not
  // change anything about the entry itself. Only the trade's eventual exit
  // (which legitimately depends on later bars — that's not lookahead, that's
  // how a live open position actually gets managed) is allowed to differ.
  test('a later bar can never change an earlier entry decision (no repainting)', () => {
    const date = '2026-06-01';
    const regimeMap = { [date]: { adx: 30 } };
    const params = { dateFrom: date, dateTo: date };

    const normal = orderFlowBacktestCore(buildTrendDay(date, { tamperLastBar: false }), regimeMap, params);
    const tampered = orderFlowBacktestCore(buildTrendDay(date, { tamperLastBar: true }), regimeMap, params);

    assert.equal(normal.trades.length, 1);
    assert.equal(tampered.trades.length, 1);
    const a = normal.trades[0], b = tampered.trades[0];

    // Entry-time facts must be byte-identical between the two runs.
    for (const field of ['signal', 'trigger', 'entry_price', 'stop_price', 'target_price', 'entry_time', 'regime_trend']) {
      assert.equal(a[field], b[field], `${field} changed when only a future bar was mutated — this is repainting`);
    }
    // The exit is legitimately allowed to differ — bar 40's close changed and
    // that's the bar this trade gets flattened on.
    assert.notEqual(a.exit_price, b.exit_price);
  });
});

describe('OF_BACKTEST_DEFAULTS', () => {
  test('entryCutoffET and flattenAtET agree by default (no post-flatten entry window)', () => {
    assert.ok(OF_BACKTEST_DEFAULTS.entryCutoffET <= OF_BACKTEST_DEFAULTS.flattenAtET);
  });
});
