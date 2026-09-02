import { parseISO } from 'date-fns';

// Shared sizing/metrics for backtest engines (originally lived in orbBacktest.js;
// extracted once a second engine — gapFillBacktest.js — needed the exact same
// IS/OOS split, Sharpe/PF/drawdown computation, and position sizing). Every
// engine's trades array is expected to share this minimal shape:
//   { trade_date, entry_price, stop_price, return_pct, exit_result, ... }
// pnl_dollars is added by sizeTrades; sample (IS/OOS) is added by computeBacktestMetrics.

export const DEFAULT_ACCOUNT = 100_000;
export const IS_SPLIT = 0.70; // first 70% of trading days = in-sample

export function round(n) { return Math.round(n * 10000) / 10000; }

export function stdDev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length);
}

const DOW = ['U', 'M', 'T', 'W', 'R', 'F', 'S']; // getUTCDay(): 0=Sun..6=Sat
export const DOW_LABEL = { M: 'Mon', T: 'Tue', W: 'Wed', R: 'Thu', F: 'Fri' };

// date-fns' parseISO() interprets a date-only string in the LOCAL timezone, not
// UTC — so parseISO('2026-05-01').getUTCDay() silently gives the wrong weekday
// whenever the process isn't running in TZ=UTC (e.g. dev machines set to a
// UTC+ zone shift every date back by a day). trade_date/today strings here are
// already-computed NY calendar dates with no time component, so they should be
// read as UTC midnight explicitly rather than through parseISO.
export function dowOf(dateOnlyStr) {
  return DOW[new Date(dateOnlyStr + 'T00:00:00Z').getUTCDay()];
}

export function dataCoverage(bars, dateFrom, dateTo) {
  const inRange = bars.filter(b => b.date >= dateFrom && b.date <= dateTo);
  if (inRange.length === 0) return { dataFrom: null, dataTo: null, coverageNote: 'No bars inside the requested range.' };
  const dataFrom = inRange[0].date, dataTo = inRange[inRange.length - 1].date;
  const gapDays = Math.round((parseISO(dataFrom) - parseISO(dateFrom)) / 86400000);
  const coverageNote = gapDays > 7
    ? `Data only from ${dataFrom} (requested ${dateFrom}). Results cover ${dataFrom} → ${dataTo}.` : null;
  return { dataFrom, dataTo, coverageNote };
}

// ─── Position sizing ──────────────────────────────────────────────────────────

export function sizeTrades(trades, params = {}) {
  const {
    sizingMode = 'RISK', positionPct = 0.10, riskPct = 0.005, compound = true, maxLeverage = 0,
  } = params;
  const accountSize = params.accountSize || DEFAULT_ACCOUNT;
  let equity = accountSize;
  return trades.map(t => {
    const base = compound ? equity : accountSize;
    let pnl;
    if (sizingMode === 'RISK') {
      const stopDist = Math.abs(t.entry_price - t.stop_price);
      let shares = stopDist > 0 ? (base * riskPct) / stopDist : 0;
      // Optional leverage cap so a very tight stop can't imply an un-executable position.
      if (maxLeverage > 0 && shares * t.entry_price > maxLeverage * base) {
        shares = (maxLeverage * base) / t.entry_price;
      }
      pnl = shares * t.entry_price * (t.return_pct / 100);
    } else {
      pnl = base * positionPct * (t.return_pct / 100);
    }
    pnl = round(pnl);
    equity += pnl;
    return { ...t, pnl_dollars: pnl };
  });
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export function metricSet(trades, accountSize = DEFAULT_ACCOUNT) {
  if (trades.length === 0) {
    return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgTradeReturnPct: 0, totalReturnPct: 0,
             totalPnlDollars: 0, sharpe: 0, profitFactor: 0, expectancy: 0, avgWinPct: 0, avgLossPct: 0,
             maxDrawdownPct: 0, targetHits: 0, stopHits: 0, timeExits: 0, eodExits: 0 };
  }
  const returns = trades.map(t => t.return_pct);
  const wins = returns.filter(r => r > 0);
  const losses = returns.filter(r => r <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl_dollars, 0);
  const grossWin = trades.filter(t => t.pnl_dollars > 0).reduce((s, t) => s + t.pnl_dollars, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl_dollars < 0).reduce((s, t) => s + t.pnl_dollars, 0));
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = stdDev(returns);

  let equity = accountSize, peak = accountSize, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl_dollars;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round((wins.length / returns.length) * 100),
    avgTradeReturnPct: round(avgReturn),
    totalReturnPct: round((totalPnl / accountSize) * 100),
    totalPnlDollars: round(totalPnl),
    sharpe: round(std > 0 ? (avgReturn / std) * Math.sqrt(252) : 0),
    profitFactor: round(grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0)),
    expectancy: round(totalPnl / trades.length),
    avgWinPct: round(wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0),
    avgLossPct: round(losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0),
    maxDrawdownPct: round(maxDD),
    targetHits: trades.filter(t => t.exit_result === 'TARGET').length,
    stopHits: trades.filter(t => t.exit_result === 'STOP').length,
    timeExits: trades.filter(t => t.exit_result === 'TIME').length,
    eodExits: trades.filter(t => t.exit_result === 'EOD').length,
  };
}

export function groupMetrics(trades, keyFn) {
  const groups = {};
  for (const t of trades) (groups[keyFn(t)] ||= []).push(t);
  const out = {};
  for (const k of Object.keys(groups).sort()) {
    const g = groups[k];
    const returns = g.map(t => t.return_pct);
    out[k] = {
      trades: g.length,
      winRate: round((returns.filter(r => r > 0).length / g.length) * 100),
      avgReturnPct: round(returns.reduce((a, b) => a + b, 0) / g.length),
      totalPnl: round(g.reduce((s, t) => s + (t.pnl_dollars || 0), 0)),
    };
  }
  return out;
}

// Full/IS/OOS metric set plus byDow/byExit (always included) and any
// engine-specific breakdowns passed in extraGroupings (e.g. ORB's byHour/
// byTrend/bySignal) — keyed exactly as before so callers see the same shape.
export function computeBacktestMetrics(trades, sortedTradeDates, params = {}, extraGroupings = {}) {
  const accountSize = params.accountSize || DEFAULT_ACCOUNT;
  const splitIdx = Math.floor(sortedTradeDates.length * IS_SPLIT);
  const splitDate = sortedTradeDates[splitIdx] || '9999-12-31';
  for (const t of trades) t.sample = t.trade_date < splitDate ? 'IS' : 'OOS';

  const full = metricSet(trades, accountSize);
  const is = metricSet(sizeTrades(trades.filter(t => t.sample === 'IS'), params), accountSize);
  const oos = metricSet(sizeTrades(trades.filter(t => t.sample === 'OOS'), params), accountSize);

  const groupings = {
    byDow: t => DOW_LABEL[dowOf(t.trade_date)] || '?',
    byExit: t => t.exit_result,
    ...extraGroupings,
  };
  const out = { full, is, oos, splitDate };
  for (const [name, keyFn] of Object.entries(groupings)) out[name] = groupMetrics(trades, keyFn);
  return out;
}
