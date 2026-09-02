import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalCDF, inverseNormalCDF, deflatedSharpe, regimeRobustnessCheck, monteCarloDrawdown,
  buildAnchoredFolds, runWalkForward,
} from '../src/engine/robustness.js';

// ─── Normal distribution helpers ─────────────────────────────────────────────

test('normalCDF: matches well-known reference quantiles', () => {
  assert.ok(Math.abs(normalCDF(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCDF(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCDF(-1.96) - 0.025) < 1e-3);
});

test('inverseNormalCDF: matches well-known reference quantiles (inverse of normalCDF)', () => {
  assert.ok(Math.abs(inverseNormalCDF(0.5) - 0) < 1e-6);
  assert.ok(Math.abs(inverseNormalCDF(0.975) - 1.95996) < 1e-3);
  assert.ok(Math.abs(inverseNormalCDF(0.95) - 1.64485) < 1e-3);
});

test('inverseNormalCDF: is the inverse of normalCDF across the whole range', () => {
  for (const z of [-2.5, -1, -0.1, 0.1, 1, 2.5]) {
    assert.ok(Math.abs(inverseNormalCDF(normalCDF(z)) - z) < 1e-4);
  }
});

// ─── Deflated Sharpe ──────────────────────────────────────────────────────────

test('deflatedSharpe: a single trial (N=1) applies no haircut at all', () => {
  const returns = [1, 1.2, 0.8, 1.5, -0.5, 1, 1.1, 0.9, 1.3, -0.2];
  const result = deflatedSharpe(returns, 1);
  assert.equal(result.benchmarkSharpe, 0);
  assert.equal(result.deflatedSharpe, result.observedSharpe);
  assert.equal(result.probabilitySkillNotLuck, null);
});

test('deflatedSharpe: many trials haircut the observed Sharpe and lower confidence it is real skill', () => {
  const returns = [1, 1.2, 0.8, 1.5, -0.5, 1, 1.1, 0.9, 1.3, -0.2];
  const n1 = deflatedSharpe(returns, 1);
  const n100 = deflatedSharpe(returns, 100);
  assert.equal(n1.observedSharpe, n100.observedSharpe); // same underlying data
  assert.ok(n100.benchmarkSharpe > 0);
  assert.ok(n100.deflatedSharpe < n1.deflatedSharpe); // haircut shrinks it
  assert.ok(n100.probabilitySkillNotLuck < 100);
});

test('deflatedSharpe: more trials produce a bigger haircut than fewer trials', () => {
  const returns = [1, 1.2, 0.8, 1.5, -0.5, 1, 1.1, 0.9, 1.3, -0.2];
  const n10 = deflatedSharpe(returns, 10);
  const n1000 = deflatedSharpe(returns, 1000);
  assert.ok(n1000.benchmarkSharpe > n10.benchmarkSharpe);
  assert.ok(n1000.deflatedSharpe < n10.deflatedSharpe);
});

test('deflatedSharpe: fewer than 2 returns is handled without crashing', () => {
  assert.equal(deflatedSharpe([], 10).observedSharpe, 0);
  assert.equal(deflatedSharpe([1], 10).observedSharpe, 0);
});

// ─── Regime-robustness gate ───────────────────────────────────────────────────

test('regimeRobustnessCheck: fails when all positive PnL is concentrated in one bucket', () => {
  const trades = [
    ...Array.from({ length: 15 }, () => ({ return_pct: 1, pnl_dollars: 100, regime_trend: 'UP' })),
    ...Array.from({ length: 15 }, () => ({ return_pct: -0.5, pnl_dollars: -50, regime_trend: 'DOWN' })),
  ];
  const result = regimeRobustnessCheck(trades, t => t.regime_trend);
  assert.equal(result.bucketsWithEnoughData, 2);
  assert.equal(result.positiveBuckets, 1);
  assert.equal(result.concentrated, true);
  assert.equal(result.pass, false);
});

test('regimeRobustnessCheck: passes when the edge holds up across multiple buckets', () => {
  const trades = [
    ...Array.from({ length: 15 }, () => ({ return_pct: 1, pnl_dollars: 100, regime_trend: 'UP' })),
    ...Array.from({ length: 15 }, () => ({ return_pct: 1, pnl_dollars: 100, regime_trend: 'DOWN' })),
    ...Array.from({ length: 15 }, () => ({ return_pct: 1, pnl_dollars: 100, regime_trend: 'FLAT' })),
  ];
  const result = regimeRobustnessCheck(trades, t => t.regime_trend);
  assert.equal(result.bucketsWithEnoughData, 3);
  assert.equal(result.positiveBuckets, 3);
  assert.equal(result.concentrated, false);
  assert.equal(result.pass, true);
});

test('regimeRobustnessCheck: a bucket below minTradesPerBucket does not count toward the gate', () => {
  const trades = [
    ...Array.from({ length: 15 }, () => ({ return_pct: 1, pnl_dollars: 100, regime_trend: 'UP' })),
    ...Array.from({ length: 3 }, () => ({ return_pct: 1, pnl_dollars: 100, regime_trend: 'RARE' })), // below default minTradesPerBucket=10
  ];
  const result = regimeRobustnessCheck(trades, t => t.regime_trend);
  assert.equal(result.totalBuckets, 2);
  assert.equal(result.bucketsWithEnoughData, 1); // RARE excluded
  assert.equal(result.pass, false); // needs minPositiveBuckets=2 eligible buckets
});

// ─── Monte Carlo drawdown ─────────────────────────────────────────────────────

test('monteCarloDrawdown: deterministic given the same seed', () => {
  const sized = Array.from({ length: 50 }, (_, i) => ({ pnl_dollars: i % 3 === 0 ? -200 : 100 }));
  const a = monteCarloDrawdown(sized, 10000, { iterations: 200, seed: 42 });
  const b = monteCarloDrawdown(sized, 10000, { iterations: 200, seed: 42 });
  assert.deepEqual(a, b);
});

test('monteCarloDrawdown: a different seed can move the estimate (not hardcoded to one path)', () => {
  const sized = Array.from({ length: 50 }, (_, i) => ({ pnl_dollars: i % 3 === 0 ? -200 : 100 }));
  const a = monteCarloDrawdown(sized, 10000, { iterations: 200, seed: 1 });
  const b = monteCarloDrawdown(sized, 10000, { iterations: 200, seed: 2 });
  // Not asserting they differ (resampling could coincidentally match), just that both are sane.
  for (const r of [a, b]) {
    assert.ok(r.medianMaxDrawdownPct >= 0);
    assert.ok(r.p95MaxDrawdownPct >= r.medianMaxDrawdownPct);
    assert.ok(r.worstMaxDrawdownPct >= r.p95MaxDrawdownPct);
  }
});

test('monteCarloDrawdown: a strategy that only ever loses hits the ruin threshold every time', () => {
  const sized = Array.from({ length: 20 }, () => ({ pnl_dollars: -1000 }));
  const result = monteCarloDrawdown(sized, 10000, { iterations: 100, ruinThresholdPct: 50 });
  assert.equal(result.probabilityOfRuinPct, 100);
});

test('monteCarloDrawdown: a strategy that only ever wins never draws down or ruins', () => {
  const sized = Array.from({ length: 20 }, () => ({ pnl_dollars: 100 }));
  const result = monteCarloDrawdown(sized, 10000, { iterations: 100 });
  assert.equal(result.medianMaxDrawdownPct, 0);
  assert.equal(result.probabilityOfRuinPct, 0);
});

test('monteCarloDrawdown: empty trades returns null rather than crashing', () => {
  assert.equal(monteCarloDrawdown([], 10000), null);
});

// ─── Anchored walk-forward folds ──────────────────────────────────────────────

test('buildAnchoredFolds: each fold\'s IS window always starts at date zero and grows', () => {
  const dates = Array.from({ length: 20 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
  const folds = buildAnchoredFolds(dates, 4);
  assert.equal(folds.length, 4);
  for (const f of folds) assert.equal(f.isStart, dates[0]);
  // Each fold's OOS starts right after the previous fold's IS end grows.
  assert.equal(folds[0].isEnd < folds[1].isEnd, true);
  assert.equal(folds[3].oosEnd, dates[dates.length - 1]); // last fold's OOS reaches the end
});

test('buildAnchoredFolds: returns empty with too little history for the requested fold count', () => {
  assert.deepEqual(buildAnchoredFolds(['2026-01-01', '2026-01-02'], 4), []);
});

// ─── Walk-forward runner ──────────────────────────────────────────────────────

// A tiny synthetic coreFn: "trades" one fixed-size trade per bar-date in range,
// with a return that depends on the combo's `bias` param and the date's
// position (even/odd) — engineered so one bias value wins on even dates and
// the other wins on odd dates, giving a deterministic, checkable fold winner.
function makeSyntheticCoreFn() {
  return (bars, regimeMap, params) => {
    const trades = bars
      .filter(b => b.date >= params.dateFrom && b.date <= params.dateTo)
      .map((b, i) => {
        const isEven = i % 2 === 0;
        const good = (params.bias === 'even') === isEven;
        return {
          trade_date: b.date, entry_price: 100, stop_price: 99,
          return_pct: good ? 2 : -1, exit_result: 'TARGET',
        };
      });
    return { trades, tradedDays: trades.length, filteredDays: 0, params };
  };
}

function syntheticBars(n) {
  return Array.from({ length: n }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}` }));
}

test('runWalkForward: errors on an empty grid', () => {
  const result = runWalkForward({
    coreFn: makeSyntheticCoreFn(), bars: syntheticBars(20), regimeMap: {},
    baseParams: {}, grid: {}, dateFrom: '2026-01-01', dateTo: '2026-01-20',
  });
  assert.ok(result.error);
});

test('runWalkForward: errors when the grid is too large', () => {
  const hugeGrid = { bias: Array.from({ length: 501 }, (_, i) => `v${i}`) };
  const result = runWalkForward({
    coreFn: makeSyntheticCoreFn(), bars: syntheticBars(20), regimeMap: {},
    baseParams: {}, grid: hugeGrid, dateFrom: '2026-01-01', dateTo: '2026-01-20',
  });
  assert.ok(result.error);
});

test('runWalkForward: errors when there is not enough history for the requested folds', () => {
  const result = runWalkForward({
    coreFn: makeSyntheticCoreFn(), bars: syntheticBars(3), regimeMap: {},
    baseParams: {}, grid: { bias: ['even', 'odd'] }, dateFrom: '2026-01-01', dateTo: '2026-01-03', numFolds: 4,
  });
  assert.ok(result.error);
});

test('runWalkForward: runs each combo once, evaluates per-fold IS/OOS, and reports aggregate OOS + parameter stability', () => {
  const result = runWalkForward({
    coreFn: makeSyntheticCoreFn(),
    bars: syntheticBars(40),
    regimeMap: {},
    baseParams: { accountSize: 100000 },
    grid: { bias: ['even', 'odd'] },
    dateFrom: '2026-01-01',
    dateTo: syntheticBars(40)[39].date,
    numFolds: 4,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.comboCount, 2);
  assert.equal(result.numFolds, 4);
  assert.equal(result.folds.length, 4);
  for (const fold of result.folds) {
    assert.ok(fold.selectedCombo, 'every fold should find a combo with enough IS trades to select from');
    assert.ok(['even', 'odd'].includes(fold.selectedCombo.bias));
    assert.ok(fold.isMetrics.totalTrades > 0);
  }
  assert.ok(result.aggregateOos.totalTrades > 0);
  assert.equal(typeof result.parameterStability.distinctCombosSelected, 'number');
  assert.equal(typeof result.parameterStability.unstable, 'boolean');
});
