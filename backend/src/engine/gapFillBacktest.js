import { loadAllData } from './marketData.js';
import { DEFAULT_ACCOUNT, sizeTrades, computeBacktestMetrics, dataCoverage, round, dowOf } from './backtestMetrics.js';
import { regimeRobustnessCheck, monteCarloDrawdown, deflatedSharpe, runWalkForward } from './robustness.js';

// Gap-fill / overnight-gap strategy. A session's opening price vs the PRIOR
// session's closing price defines a "gap" — this tests whether price tends to
// retrace back toward that prior close (FADE, the classic gap-fill hypothesis)
// or keeps extending in the gap's direction (CONTINUATION, tested as the
// opposite-hypothesis comparison, same discipline as ORB's direction sweep).
//
// Session boundaries are the same NY-HHMM window ORB uses (sessionStartET/
// sessionEndET) — with the RTH default (930/1600) this is the classic
// "overnight gap": yesterday's RTH close vs today's RTH open. A near-24hr
// data source (e.g. Databento ES) lets this run on real futures data instead
// of RTH-only equities, but the gap itself is still measured across the same
// artificial RTH window, not the raw Friday-close-to-Sunday-reopen gap in the
// underlying continuous series — that's a distinct, larger gap worth its own
// dedicated check if this shows something real.
export const GAP_FILL_DEFAULTS = {
  timeframe: '15m',
  direction: 'FADE',        // FADE (bet on reversion toward priorClose) | CONTINUATION (bet the gap keeps extending)
  gapMinPct: 0.1,           // minimum |gap| % (vs prior close) required to trade at all
  gapMaxPct: 0,             // 0 = off; skip abnormally large gaps (news/crash days) if set
  targetMode: 'FILL_FRACTION', // FILL_FRACTION (FADE-style: fillFraction of the gap retraced) | R_MULTIPLE (targetParam × stop distance) | EOD (no fixed target, ride to close/stop)
  fillFraction: 1.0,        // FILL_FRACTION only: how much of the gap must retrace to count as "filled" (1.0 = full fill back to priorClose)
  targetParam: 2.0,         // R_MULTIPLE only: × stop distance
  stopMode: 'GAP_FRAC',     // GAP_FRAC = stopParam × the gap's own size | FIXED_PCT = stopParam% of entry price
  stopParam: 1.0,
  // Position sizing (identical model/fields to orbBacktest's)
  sizingMode: 'RISK', accountSize: DEFAULT_ACCOUNT, positionPct: 0.10, riskPct: 0.005, compound: true, maxLeverage: 0,
  costPct: 0.02,
  // Prior-day regime filters (from yesterday's daily bar — no lookahead), same shape as ORB
  trendMode: 'OFF', minDailyADX: 0, maxDailyADX: 0, vixMin: 0, vixMax: 0,
  atrPctileMin: 0, atrPctileMax: 100, dowMask: 'ALL',
  // Session window (NY HHMM) — gap = today's first in-window bar's close vs
  // yesterday's last in-window bar's close. Defaults are RTH so a plain equity
  // symbol behaves like the classic overnight-gap concept.
  sessionStartET: 930,
  sessionEndET: 1600,
};

function passesDayFilters(reg, dowChar, params) {
  if (params.dowMask !== 'ALL' && !params.dowMask.includes(dowChar)) return false;
  if (!reg) return true;
  if (params.minDailyADX > 0 && reg.adx != null && reg.adx < params.minDailyADX) return false;
  if (params.maxDailyADX > 0 && reg.adx != null && reg.adx > params.maxDailyADX) return false;
  if (params.vixMin > 0 && reg.vix != null && reg.vix < params.vixMin) return false;
  if (params.vixMax > 0 && reg.vix != null && reg.vix > params.vixMax) return false;
  if (params.atrPctileMin > 0 && reg.atrPctile != null && reg.atrPctile < params.atrPctileMin) return false;
  if (params.atrPctileMax < 100 && reg.atrPctile != null && reg.atrPctile > params.atrPctileMax) return false;
  return true;
}

// Conservative: stop checked before target within a bar (assume the adverse
// level trades first). No trailing/time-stop modes — this is a same-day,
// fill-or-flatten strategy by construction.
function resolveGapExit(pos, bar, isLastBar) {
  if (pos.signal === 'LONG') {
    if (bar.low <= pos.stop) return { price: pos.stop, result: 'STOP' };
    if (pos.target != null && bar.high >= pos.target) return { price: pos.target, result: 'TARGET' };
  } else {
    if (bar.high >= pos.stop) return { price: pos.stop, result: 'STOP' };
    if (pos.target != null && bar.low <= pos.target) return { price: pos.target, result: 'TARGET' };
  }
  if (isLastBar) return { price: bar.close, result: 'EOD' };
  return null;
}

function closeGapTrade(trades, pos, exit, today, reg, params, gapPct) {
  const dirMult = pos.signal === 'LONG' ? 1 : -1;
  const gross = ((exit.price - pos.entry) / pos.entry) * 100 * dirMult;
  const net = gross - params.costPct;
  trades.push({
    trade_date: today,
    entry_time: pos.entryTime,
    signal: pos.signal,
    entry_price: round(pos.entry),
    target_price: pos.target != null ? round(pos.target) : null,
    stop_price: round(pos.initStop),
    exit_price: round(exit.price),
    exit_result: exit.result,
    bars_held: pos.barsHeld,
    gap_pct: round(gapPct),
    gross_return_pct: round(gross),
    return_pct: round(net),
    regime_trend: reg ? reg.trend : 'NA',
  });
}

// ─── Core backtest (pure) ────────────────────────────────────────────────────

export function gapFillCore(allBars, regimeMap, rawParams) {
  const params = { ...GAP_FILL_DEFAULTS, ...rawParams };
  const {
    direction, gapMinPct, gapMaxPct, targetMode, fillFraction, targetParam, stopMode, stopParam,
    sessionStartET, sessionEndET,
  } = params;

  const bars = allBars.filter(b => b.ny_time >= sessionStartET && b.ny_time < sessionEndET);
  const byDate = {};
  for (const bar of bars) (byDate[bar.date] ||= []).push(bar);
  const sortedDates = Object.keys(byDate).sort();
  for (const d of sortedDates) byDate[d].sort((a, b) => a.utc_datetime.localeCompare(b.utc_datetime));

  const trades = [];
  let tradedDays = 0, filteredDays = 0;
  let priorClose = null; // carried session-to-session, including through the pre-dateFrom warmup buffer

  for (const today of sortedDates) {
    const dayBars = byDate[today];
    if (!dayBars || dayBars.length < 2) continue; // need an entry bar + at least one more to resolve it

    if (priorClose == null) { priorClose = dayBars[dayBars.length - 1].close; continue; } // first session ever seen, nothing to gap against

    const inRange = today >= params.dateFrom && today <= params.dateTo;
    if (!inRange) { priorClose = dayBars[dayBars.length - 1].close; continue; }

    const dowChar = dowOf(today);
    const reg = regimeMap[today] || null;
    if (!passesDayFilters(reg, dowChar, params)) {
      filteredDays++;
      priorClose = dayBars[dayBars.length - 1].close;
      continue;
    }

    const entryPrice = dayBars[0].close; // fill at the first in-window bar's close, same convention as ORB
    const gap = dayBars[0].open - priorClose;
    const gapPct = (gap / priorClose) * 100;

    if (Math.abs(gapPct) < gapMinPct || (gapMaxPct > 0 && Math.abs(gapPct) > gapMaxPct)) {
      filteredDays++;
      priorClose = dayBars[dayBars.length - 1].close;
      continue;
    }

    const fade = direction === 'FADE';
    const sig = (gap > 0) === fade ? 'SHORT' : 'LONG';

    const gapSize = Math.abs(gap);
    const stopDist = stopMode === 'GAP_FRAC' ? stopParam * gapSize : (stopParam / 100) * entryPrice;
    if (stopDist <= 0) {
      filteredDays++;
      priorClose = dayBars[dayBars.length - 1].close;
      continue;
    }
    const stop = sig === 'LONG' ? entryPrice - stopDist : entryPrice + stopDist;
    // FILL_FRACTION targets a retracement toward priorClose (the FADE-style
    // target); R_MULTIPLE is a plain multiple of the stop distance, usable by
    // either direction; anything else (EOD) rides with no fixed target —
    // testing pure momentum-through-the-day in the trade's own direction.
    let target = null;
    if (targetMode === 'FILL_FRACTION') target = entryPrice - fillFraction * (entryPrice - priorClose);
    else if (targetMode === 'R_MULTIPLE') target = sig === 'LONG' ? entryPrice + targetParam * stopDist : entryPrice - targetParam * stopDist;

    tradedDays++;
    const pos = { signal: sig, entry: entryPrice, stop, initStop: stop, target, entryTime: dayBars[0].ny_time, barsHeld: 0 };
    for (let i = 1; i < dayBars.length; i++) {
      pos.barsHeld++;
      const bar = dayBars[i];
      const isLastBar = i === dayBars.length - 1;
      const ex = resolveGapExit(pos, bar, isLastBar);
      if (ex) { closeGapTrade(trades, pos, ex, today, reg, params, gapPct); break; }
    }

    priorClose = dayBars[dayBars.length - 1].close;
  }

  return { trades, tradedDays, filteredDays, params };
}

// ─── Data-driven entry points (mirrors orbBacktest.js) ───────────────────────

export async function runGapFillBacktest(symbol, dateFrom, dateTo, params = {}) {
  const { bars, regimeMap } = await loadAllData(symbol, dateFrom, dateTo, params);
  if (bars.length === 0) return { error: `No ${params.timeframe || '15m'} data available for ${symbol}.` };
  const coverage = dataCoverage(bars, dateFrom, dateTo);
  const result = await runOne(bars, regimeMap, { ...params, symbol, dateFrom, dateTo, sweepId: null });
  if (result.error) return result;
  return { runId: result.runId, metrics: result.metrics, tradedDays: result.tradedDays, filteredDays: result.filteredDays, ...coverage };
}

async function runOne(bars, regimeMap, params) {
  const { saveGapFillRun, saveGapFillTrades } = await import('../data/db.js');
  const { trades, tradedDays, filteredDays, params: applied } = gapFillCore(bars, regimeMap, params);
  if (trades.length === 0) return { error: 'No trades generated.' };
  const tradeDates = [...new Set(bars.map(b => b.date).filter(d => d >= params.dateFrom && d <= params.dateTo))].sort();
  const sized = sizeTrades(trades, applied);
  const metrics = computeBacktestMetrics(sized, tradeDates, applied, {
    bySignal: t => t.signal,
    byGapSize: t => {
      const g = Math.abs(t.gap_pct);
      return g < 0.2 ? '0.1-0.2%' : g < 0.3 ? '0.2-0.3%' : g < 0.5 ? '0.3-0.5%' : '0.5%+';
    },
  });
  metrics.regimeRobustness = regimeRobustnessCheck(sized, t => t.regime_trend);
  metrics.monteCarlo = sized.length >= 20
    ? monteCarloDrawdown(sized, applied.accountSize || DEFAULT_ACCOUNT)
    : null;

  const { apiKey, ...paramsToSave } = applied;
  const runId = saveGapFillRun({
    symbol: params.symbol, date_from: params.dateFrom, date_to: params.dateTo,
    timeframe: params.timeframe || '15m', sweep_id: params.sweepId || null,
    total_trades: metrics.full.totalTrades, win_rate: metrics.full.winRate,
    total_return_pct: metrics.full.totalReturnPct, avg_trade_return_pct: metrics.full.avgTradeReturnPct,
    sharpe: metrics.full.sharpe, profit_factor: metrics.full.profitFactor, max_drawdown_pct: metrics.full.maxDrawdownPct,
    is_trades: metrics.is.totalTrades, is_win_rate: metrics.is.winRate, is_return_pct: metrics.is.totalReturnPct,
    is_sharpe: metrics.is.sharpe, is_profit_factor: metrics.is.profitFactor,
    oos_trades: metrics.oos.totalTrades, oos_win_rate: metrics.oos.winRate, oos_return_pct: metrics.oos.totalReturnPct,
    oos_sharpe: metrics.oos.sharpe, oos_profit_factor: metrics.oos.profitFactor,
    params: JSON.stringify(paramsToSave), metrics: JSON.stringify(metrics),
  });
  saveGapFillTrades(sized.map(t => ({ ...t, run_id: runId })));
  return { runId, metrics, tradedDays, filteredDays };
}

const MAX_COMBOS = 2000;

export async function runGapFillSweep(symbol, dateFrom, dateTo, baseParams = {}, grid = {}) {
  const gridKeys = Object.keys(grid).filter(k => Array.isArray(grid[k]) && grid[k].length > 0);
  if (gridKeys.length === 0) return { error: 'Sweep grid is empty.' };
  let combos = [{}];
  for (const key of gridKeys) {
    const next = [];
    for (const combo of combos) for (const v of grid[key]) next.push({ ...combo, [key]: v });
    combos = next;
    if (combos.length > MAX_COMBOS) return { error: `Sweep too large (${combos.length}, max ${MAX_COMBOS}).` };
  }
  const { bars, regimeMap } = await loadAllData(symbol, dateFrom, dateTo, baseParams);
  if (bars.length === 0) return { error: `No ${baseParams.timeframe || '15m'} data available for ${symbol}.` };
  const coverage = dataCoverage(bars, dateFrom, dateTo);

  const sweepId = `gapfillsweep_${Date.now()}`;
  const results = [];
  for (const combo of combos) {
    const merged = { ...baseParams, ...combo, symbol, dateFrom, dateTo, sweepId };
    const r = await runOne(bars, regimeMap, merged);
    results.push({
      combo, runId: r.error ? null : r.runId, error: r.error || null,
      trades: r.error ? 0 : r.metrics.full.totalTrades,
      isReturnPct: r.error ? null : r.metrics.is.totalReturnPct,
      oosReturnPct: r.error ? null : r.metrics.oos.totalReturnPct,
      oosSharpe: r.error ? null : r.metrics.oos.sharpe,
      oosProfitFactor: r.error ? null : r.metrics.oos.profitFactor,
      oosWinRate: r.error ? null : r.metrics.oos.winRate,
    });
  }
  results.sort((a, b) => (b.oosSharpe ?? -999) - (a.oosSharpe ?? -999));

  // Deflated Sharpe for the winner only — see orbBacktest.js's identical comment.
  let deflatedSharpeOfTop = null;
  if (results[0]?.runId != null) {
    const { getGapFillTrades } = await import('../data/db.js');
    const oosReturns = getGapFillTrades(results[0].runId)
      .filter(t => t.sample === 'OOS')
      .map(t => t.return_pct);
    deflatedSharpeOfTop = deflatedSharpe(oosReturns, combos.length);
  }

  return { sweepId, comboCount: combos.length, gridKeys, results, deflatedSharpeOfTop, ...coverage };
}

// ─── Walk-forward validation ─────────────────────────────────────────────────

export async function runGapFillWalkForward(symbol, dateFrom, dateTo, baseParams = {}, grid = {}, numFolds = 4) {
  const { bars, regimeMap } = await loadAllData(symbol, dateFrom, dateTo, baseParams);
  if (bars.length === 0) return { error: `No ${baseParams.timeframe || '15m'} data available for ${symbol}.` };
  const coverage = dataCoverage(bars, dateFrom, dateTo);
  const result = runWalkForward({
    coreFn: gapFillCore, bars, regimeMap, baseParams, grid, dateFrom, dateTo, numFolds,
    accountSize: baseParams.accountSize,
  });
  if (result.error) return result;
  return { ...result, ...coverage };
}
