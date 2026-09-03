import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  round, stdDev, dowOf, dataCoverage, sizeTrades, metricSet, groupMetrics, computeBacktestMetrics,
} from '../src/engine/backtestMetrics.js';

test('round: rounds to 4 decimal places, including negative-zero cleanup', () => {
  assert.equal(round(1.23456789), 1.2346);
  assert.equal(round(-0.00001), -0);
});

test('stdDev: population standard deviation', () => {
  assert.equal(round(stdDev([2, -1, 3, -2])), 2.0616);
  assert.equal(stdDev([5, 5, 5]), 0);
});

test('dowOf: reads the weekday from a date-only string as UTC midnight, not local time', () => {
  assert.equal(dowOf('2026-07-27'), 'M'); // Monday
  assert.equal(dowOf('2026-07-28'), 'T'); // Tuesday
});

test('dataCoverage: exact match when every requested date has data', () => {
  const bars = [{ date: '2026-01-01' }, { date: '2026-01-10' }];
  assert.deepEqual(dataCoverage(bars, '2026-01-01', '2026-01-10'), {
    dataFrom: '2026-01-01', dataTo: '2026-01-10', coverageNote: null,
  });
});

test('dataCoverage: flags a gap of more than 7 days between requested and actual start', () => {
  const bars = [{ date: '2026-01-10' }, { date: '2026-01-15' }];
  const result = dataCoverage(bars, '2026-01-01', '2026-01-15');
  assert.equal(result.dataFrom, '2026-01-10');
  assert.match(result.coverageNote, /Data only from 2026-01-10/);
});

test('dataCoverage: no bars in range at all', () => {
  assert.deepEqual(dataCoverage([], '2026-01-01', '2026-01-15'), {
    dataFrom: null, dataTo: null, coverageNote: 'No bars inside the requested range.',
  });
});

test('sizeTrades: RISK mode compounds equity across trades by default', () => {
  const sized = sizeTrades(
    [
      { entry_price: 100, stop_price: 99, return_pct: 2 },
      { entry_price: 100, stop_price: 99, return_pct: 2 },
    ],
    { accountSize: 100000 }
  );
  // trade 1: shares = (100000*0.005)/1 = 500; pnl = 500*100*0.02 = 1000
  assert.equal(sized[0].pnl_dollars, 1000);
  // trade 2: equity now 101000; shares = (101000*0.005)/1 = 505; pnl = 505*100*0.02 = 1010
  assert.equal(sized[1].pnl_dollars, 1010);
});

test('sizeTrades: compound=false resets to accountSize every trade', () => {
  const sized = sizeTrades(
    [
      { entry_price: 100, stop_price: 99, return_pct: 2 },
      { entry_price: 100, stop_price: 99, return_pct: 2 },
    ],
    { accountSize: 100000, compound: false }
  );
  assert.equal(sized[0].pnl_dollars, 1000);
  assert.equal(sized[1].pnl_dollars, 1000);
});

test('sizeTrades: NOTIONAL mode ignores the stop distance entirely', () => {
  const sized = sizeTrades(
    [{ entry_price: 100, stop_price: 99, return_pct: 5 }],
    { sizingMode: 'NOTIONAL', positionPct: 0.10, accountSize: 100000 }
  );
  assert.equal(sized[0].pnl_dollars, 500); // 100000 * 0.10 * 0.05
});

test('sizeTrades: maxLeverage caps notional exposure from an unrealistically tight stop', () => {
  const sized = sizeTrades(
    [{ entry_price: 100, stop_price: 99.99, return_pct: 1 }],
    { accountSize: 100000, maxLeverage: 1 }
  );
  // Uncapped RISK sizing would ask for (100000*0.005)/0.01 = 50000 shares
  // (5,000,000 notional) — maxLeverage:1 caps notional to 1x equity = 100000,
  // i.e. 1000 shares, so pnl = 1000*100*0.01 = 1000, not 50000*100*0.01=50000.
  assert.equal(sized[0].pnl_dollars, 1000);
});

test('metricSet: empty trades returns an all-zero shape, not a crash', () => {
  assert.deepEqual(metricSet([], 100000), {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgTradeReturnPct: 0, totalReturnPct: 0,
    totalPnlDollars: 0, sharpe: 0, profitFactor: 0, expectancy: 0, avgWinPct: 0, avgLossPct: 0,
    maxDrawdownPct: 0, targetHits: 0, stopHits: 0, timeExits: 0, eodExits: 0,
    exitNowHits: 0, partialHits: 0,
  });
});

test('metricSet: computes win rate, PnL, Sharpe, profit factor, and drawdown from sized trades', () => {
  const trades = [
    { return_pct: 2, pnl_dollars: 1000, exit_result: 'TARGET' },
    { return_pct: -1, pnl_dollars: -500, exit_result: 'STOP' },
    { return_pct: 3, pnl_dollars: 1500, exit_result: 'TARGET' },
    { return_pct: -2, pnl_dollars: -1000, exit_result: 'EOD' },
  ];
  const m = metricSet(trades, 100000);
  assert.equal(m.totalTrades, 4);
  assert.equal(m.wins, 2);
  assert.equal(m.losses, 2);
  assert.equal(m.winRate, 50);
  assert.equal(m.totalPnlDollars, 1000);
  assert.equal(m.profitFactor, 1.6667); // grossWin 2500 / grossLoss 1500
  assert.equal(m.expectancy, 250); // 1000 / 4
  assert.equal(m.targetHits, 2);
  assert.equal(m.stopHits, 1);
  assert.equal(m.eodExits, 1);
  assert.ok(m.sharpe > 0); // positive average return, positive Sharpe
});

test('metricSet: counts orderFlowBacktest.js-specific exit outcomes so the breakdown sums to totalTrades', () => {
  const trades = [
    { return_pct: 1, pnl_dollars: 100, exit_result: 'EXIT_NOW' },
    { return_pct: 1, pnl_dollars: 100, exit_result: 'PARTIAL_TREATED_AS_FULL' },
    { return_pct: 1, pnl_dollars: 100, exit_result: 'STOP' },
  ];
  const m = metricSet(trades, 100000);
  assert.equal(m.exitNowHits, 1);
  assert.equal(m.partialHits, 1);
  assert.equal(m.targetHits + m.stopHits + m.timeExits + m.eodExits + m.exitNowHits + m.partialHits, m.totalTrades);
});

test('groupMetrics: buckets by an arbitrary key function and sorts keys', () => {
  const trades = [
    { return_pct: 1, pnl_dollars: 100, exit_result: 'TARGET' },
    { return_pct: 2, pnl_dollars: 200, exit_result: 'STOP' },
    { return_pct: -1, pnl_dollars: -100, exit_result: 'TARGET' },
  ];
  const groups = groupMetrics(trades, t => t.exit_result);
  assert.deepEqual(Object.keys(groups), ['STOP', 'TARGET']); // sorted
  assert.equal(groups.TARGET.trades, 2);
  assert.equal(groups.TARGET.winRate, 50);
  assert.equal(groups.TARGET.totalPnl, 0); // 100 + -100
  assert.equal(groups.STOP.trades, 1);
});

test('computeBacktestMetrics: splits IS/OOS at the configured fraction and re-sizes each bucket independently', () => {
  const raw = [
    { trade_date: '2026-01-01', entry_price: 100, stop_price: 99, return_pct: 1, exit_result: 'TARGET' },
    { trade_date: '2026-01-02', entry_price: 100, stop_price: 99, return_pct: 2, exit_result: 'STOP' },
    { trade_date: '2026-01-03', entry_price: 100, stop_price: 99, return_pct: -1, exit_result: 'TARGET' },
    { trade_date: '2026-01-06', entry_price: 100, stop_price: 99, return_pct: 3, exit_result: 'EOD' },
    { trade_date: '2026-01-07', entry_price: 100, stop_price: 99, return_pct: -2, exit_result: 'STOP' },
  ];
  const sized = sizeTrades(raw, { accountSize: 100000 });
  const dates = raw.map(t => t.trade_date);
  const metrics = computeBacktestMetrics(sized, dates, { accountSize: 100000 });

  // 70% of 5 dates -> splitIdx 3 -> splitDate is the 4th date (index 3)
  assert.equal(metrics.splitDate, '2026-01-06');
  assert.equal(metrics.full.totalTrades, 5);
  assert.equal(metrics.is.totalTrades, 3); // dates before splitDate
  assert.equal(metrics.oos.totalTrades, 2); // splitDate onward
  assert.equal(metrics.is.wins, 2);
  assert.equal(metrics.oos.wins, 1);

  // byDow/byExit are always present alongside any engine-specific groupings.
  assert.ok(metrics.byDow);
  assert.ok(metrics.byExit);
  assert.equal(metrics.byExit.TARGET.trades, 2);
  assert.equal(metrics.byExit.STOP.trades, 2);
  assert.equal(metrics.byExit.EOD.trades, 1);
});

test('computeBacktestMetrics: passes through engine-specific extraGroupings unchanged', () => {
  const raw = [
    { trade_date: '2026-01-01', entry_price: 100, stop_price: 99, return_pct: 1, exit_result: 'TARGET', signal: 'LONG' },
    { trade_date: '2026-01-02', entry_price: 100, stop_price: 99, return_pct: -1, exit_result: 'STOP', signal: 'SHORT' },
  ];
  const sized = sizeTrades(raw, { accountSize: 100000 });
  const metrics = computeBacktestMetrics(sized, ['2026-01-01', '2026-01-02'], { accountSize: 100000 }, {
    bySignal: t => t.signal,
  });
  assert.deepEqual(Object.keys(metrics.bySignal).sort(), ['LONG', 'SHORT']);
});
