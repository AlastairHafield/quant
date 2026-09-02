import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLiveTrades, computeLiveVsBacktestDrift } from '../src/engine/reconciliation.js';

test('summarizeLiveTrades: excludes open trades and matches computeBacktestMetrics field names', () => {
  const trades = [
    { status: 'closed', realizedPnl: 100 },
    { status: 'closed', realizedPnl: -50 },
    { status: 'open', realizedPnl: null },
  ];
  const stats = summarizeLiveTrades(trades);
  assert.equal(stats.totalTrades, 2);
  assert.equal(stats.winRate, 50);
  assert.equal(stats.expectancy, 25); // (100-50)/2
  assert.equal(stats.totalPnlDollars, 50);
});

test('summarizeLiveTrades: no closed trades returns a zeroed shape, not NaN', () => {
  assert.deepEqual(summarizeLiveTrades([]), { totalTrades: 0, winRate: 0, expectancy: 0, totalPnlDollars: 0 });
});

test('computeLiveVsBacktestDrift: not comparable with too few live trades', () => {
  const live = { totalTrades: 3, winRate: 50, expectancy: 100, totalPnlDollars: 300 };
  const backtest = { totalTrades: 200, winRate: 55, expectancy: 90 };
  const result = computeLiveVsBacktestDrift(live, backtest);
  assert.equal(result.comparable, false);
});

test('computeLiveVsBacktestDrift: not comparable with no backtest trades', () => {
  const live = { totalTrades: 20, winRate: 50, expectancy: 100 };
  const result = computeLiveVsBacktestDrift(live, { totalTrades: 0 });
  assert.equal(result.comparable, false);
});

test('computeLiveVsBacktestDrift: within tolerance reports no drift', () => {
  const live = { totalTrades: 20, winRate: 52, expectancy: 95, totalPnlDollars: 1900 };
  const backtest = { totalTrades: 200, winRate: 55, expectancy: 100 };
  const result = computeLiveVsBacktestDrift(live, backtest);
  assert.equal(result.comparable, true);
  assert.equal(result.drift, false);
  assert.equal(result.winRateDeltaPts, -3);
  assert.deepEqual(result.driftReasons, []);
});

test('computeLiveVsBacktestDrift: a large win-rate gap flags drift', () => {
  const live = { totalTrades: 20, winRate: 20, expectancy: 100 };
  const backtest = { totalTrades: 200, winRate: 55, expectancy: 100 };
  const result = computeLiveVsBacktestDrift(live, backtest);
  assert.equal(result.drift, true);
  assert.ok(result.driftReasons.some((r) => r.includes('win rate')));
});

test('computeLiveVsBacktestDrift: a large expectancy gap flags drift even with matching win rate', () => {
  const live = { totalTrades: 20, winRate: 55, expectancy: 10 };
  const backtest = { totalTrades: 200, winRate: 55, expectancy: 100 };
  const result = computeLiveVsBacktestDrift(live, backtest);
  assert.equal(result.drift, true);
  assert.ok(result.driftReasons.some((r) => r.includes('expectancy')));
});

test('computeLiveVsBacktestDrift: custom tolerances are respected', () => {
  const live = { totalTrades: 20, winRate: 45, expectancy: 100 };
  const backtest = { totalTrades: 200, winRate: 55, expectancy: 100 };
  // Default winRatePts=15 would not flag a 10pt gap; a tighter tolerance should.
  const loose = computeLiveVsBacktestDrift(live, backtest);
  const tight = computeLiveVsBacktestDrift(live, backtest, { winRatePts: 5 });
  assert.equal(loose.drift, false);
  assert.equal(tight.drift, true);
});
