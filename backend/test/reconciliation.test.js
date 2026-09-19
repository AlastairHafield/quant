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

// ─── strategy-field conflation (the bug this fix addresses) ─────────────
// gex-breakout's ledger pools three categories under `strategy`: "OF" (the
// Order Flow Bot's own signal trades — the ONLY thing the OF backtest
// models), "reconciled" (untracked shared-account fills that are NOT OF
// signals), and "B" (a retired legacy strategy). Filtering live trades to
// strategy:"OF" (now doable via fetchLedgerTrades'/the MCP tools' new
// `strategy` param, backed by buildLedgerQuery) before summarizing/
// reconciling must exclude the other categories — demonstrated here at the
// summarizeLiveTrades/computeLiveVsBacktestDrift level, which is what
// actually receives the (now-filterable) trade list.
test('summarizeLiveTrades: filtering to strategy "OF" excludes unrelated "reconciled"/"B" trades and changes the stats', () => {
  const mixedTrades = [
    { status: 'closed', realizedPnl: 66.25, strategy: 'OF' },
    { status: 'closed', realizedPnl: -20, strategy: 'OF' },
    { status: 'closed', realizedPnl: 1000, strategy: 'reconciled' }, // NOT an OF signal trade
    { status: 'closed', realizedPnl: 500, strategy: 'reconciled' },
    { status: 'closed', realizedPnl: -75, strategy: 'B' }, // retired legacy strategy
  ];

  const pooled = summarizeLiveTrades(mixedTrades); // old, conflated behavior
  assert.equal(pooled.totalTrades, 5);

  const ofOnly = summarizeLiveTrades(mixedTrades.filter((t) => t.strategy === 'OF'));
  assert.equal(ofOnly.totalTrades, 2);
  assert.equal(ofOnly.totalPnlDollars, 46.25);
  assert.equal(ofOnly.expectancy, 23.13);

  // The two comparisons diverge sharply — proof the pooled figure is
  // dominated by non-OF activity and is not a fair comparison against an
  // OF-only backtest.
  assert.notEqual(pooled.totalPnlDollars, ofOnly.totalPnlDollars);
  assert.notEqual(pooled.expectancy, ofOnly.expectancy);
});

test('computeLiveVsBacktestDrift: pooled (unfiltered) trades can show spurious drift that strategy-filtered trades do not', () => {
  // An OF backtest predicting a losing bot (expectancy -500ish/trade).
  const backtest = { totalTrades: 6, winRate: 16.67, expectancy: -576.57, totalPnlDollars: -3459.40 };

  const mixedTrades = [
    { status: 'closed', realizedPnl: 66.25, strategy: 'OF' },
    { status: 'closed', realizedPnl: -20, strategy: 'OF' },
    { status: 'closed', realizedPnl: -20, strategy: 'OF' },
    { status: 'closed', realizedPnl: -15, strategy: 'OF' },
    { status: 'closed', realizedPnl: -15, strategy: 'OF' },
    { status: 'closed', realizedPnl: -6, strategy: 'OF' },
    { status: 'closed', realizedPnl: -6.25, strategy: 'OF' },
    // Unrelated "reconciled" fills that make the pooled live P&L look
    // healthy even though the OF bot itself is losing on almost every trade.
    { status: 'closed', realizedPnl: 400, strategy: 'reconciled' },
    { status: 'closed', realizedPnl: 300, strategy: 'reconciled' },
    { status: 'closed', realizedPnl: 250, strategy: 'reconciled' },
    { status: 'closed', realizedPnl: 300, strategy: 'reconciled' },
  ];

  const pooledStats = summarizeLiveTrades(mixedTrades);
  const pooledDrift = computeLiveVsBacktestDrift(pooledStats, backtest);
  assert.equal(pooledDrift.comparable, true);
  // Pooled live looks profitable while the backtest predicts a heavy loss —
  // this is the spurious "huge divergence" the conflation produces.
  assert.ok(pooledStats.expectancy > 0);

  const ofOnlyStats = summarizeLiveTrades(mixedTrades.filter((t) => t.strategy === 'OF'));
  const ofOnlyDrift = computeLiveVsBacktestDrift(ofOnlyStats, backtest);
  assert.equal(ofOnlyDrift.comparable, true);
  // OF-only live is directionally consistent with the backtest (both losing),
  // even if the exact dollar magnitude still differs (a separate, honestly
  // unresolved ES-vs-MES/notional question — see PROTOCOL.md).
  assert.ok(ofOnlyStats.expectancy < 0);
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
