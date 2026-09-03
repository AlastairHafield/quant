import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLiveTrades, computeLiveVsBacktestDrift, groupTradesByDay, buildShadowDayReports } from '../src/engine/reconciliation.js';

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

test('groupTradesByDay: buckets closed trades by the calendar date in closedAt, sorted chronologically', () => {
  const trades = [
    { status: 'closed', realizedPnl: 10, closedAt: '2026-03-05T14:00:00Z' },
    { status: 'closed', realizedPnl: -5, closedAt: '2026-03-01T14:00:00Z' },
    { status: 'closed', realizedPnl: 20, closedAt: '2026-03-01T20:00:00Z' }, // same day as above
    { status: 'open', realizedPnl: null, closedAt: null },
    { status: 'closed', realizedPnl: 5, closedAt: null }, // no closedAt — excluded
  ];
  const groups = groupTradesByDay(trades);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].dayKey, '2026-03-01');
  assert.equal(groups[0].trades.length, 2);
  assert.equal(groups[1].dayKey, '2026-03-05');
  assert.equal(groups[1].trades.length, 1);
});

test('groupTradesByDay: dayKey sorts correctly even when it would NOT as a toDateString() string', () => {
  // The trap this deliberately avoids: "Wed Jul 22 2026" > "Tue Jul 28 2026"
  // lexicographically despite being earlier — see tradeJournalMongo.js.
  const trades = [
    { status: 'closed', realizedPnl: 1, closedAt: '2026-07-28T12:00:00Z' },
    { status: 'closed', realizedPnl: 1, closedAt: '2026-07-22T12:00:00Z' },
  ];
  const groups = groupTradesByDay(trades);
  assert.deepEqual(groups.map((g) => g.dayKey), ['2026-07-22', '2026-07-28']);
});

test('buildShadowDayReports: makes each day CUMULATIVE, so a low-frequency strategy eventually becomes comparable', () => {
  const backtest = { totalTrades: 500, winRate: 55, expectancy: 100 };
  // Only 1-2 trades per day — no single day would ever reach the default
  // minLiveTrades:5 on its own. 3 wins of 300 + 2 losses of -200 = avg 100
  // expectancy at a 60% win rate — matching the backtest's 100/55 closely
  // enough to stay within default tolerances (15pts / 50% relative).
  const dailyGroups = [
    { dayKey: '2026-01-01', trades: [{ status: 'closed', realizedPnl: 300 }] },
    { dayKey: '2026-01-02', trades: [{ status: 'closed', realizedPnl: -200 }] },
    { dayKey: '2026-01-05', trades: [{ status: 'closed', realizedPnl: 300 }] },
    { dayKey: '2026-01-06', trades: [{ status: 'closed', realizedPnl: -200 }] },
    { dayKey: '2026-01-07', trades: [{ status: 'closed', realizedPnl: 300 }] },
  ];
  const reports = buildShadowDayReports(dailyGroups, backtest);
  assert.equal(reports.length, 5);
  // Early days: not yet comparable (fewer than 5 cumulative trades).
  assert.equal(reports[0].drift.comparable, false);
  assert.equal(reports[3].cumulativeLiveTrades, 4);
  assert.equal(reports[3].drift.comparable, false);
  // By day 5, cumulative trade count clears the threshold and becomes comparable.
  assert.equal(reports[4].cumulativeLiveTrades, 5);
  assert.equal(reports[4].drift.comparable, true);
  assert.equal(reports[4].drift.drift, false); // 100 expectancy / 60% win rate both within tolerance of the 100/55 backtest
});

test('buildShadowDayReports: a real, sustained drift is still caught cumulatively', () => {
  const backtest = { totalTrades: 500, winRate: 55, expectancy: 100 };
  const dailyGroups = [
    { dayKey: '2026-01-01', trades: [{ status: 'closed', realizedPnl: -50 }] },
    { dayKey: '2026-01-02', trades: [{ status: 'closed', realizedPnl: -60 }] },
    { dayKey: '2026-01-05', trades: [{ status: 'closed', realizedPnl: -55 }] },
    { dayKey: '2026-01-06', trades: [{ status: 'closed', realizedPnl: -45 }] },
    { dayKey: '2026-01-07', trades: [{ status: 'closed', realizedPnl: -50 }] },
  ];
  const reports = buildShadowDayReports(dailyGroups, backtest);
  assert.equal(reports[4].drift.comparable, true);
  assert.equal(reports[4].drift.drift, true);
});
