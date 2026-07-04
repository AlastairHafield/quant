import { addDays, parseISO, format } from 'date-fns';
import { get15mBars } from '../api/intraday.js';
import { getHistoricalOHLCV } from '../api/prices.js';
import {
  getBars15m, upsertBars15m, getIntraday15m, upsertIntraday15m,
  getBars5m, upsertBars5m, getPrices, upsertPrices,
  saveMRRun, saveMRTrades,
} from '../data/db.js';
import { sma, rsi, bollinger, atr, adx, sessionVWAP, percentileRank } from './indicators.js';

const DEFAULT_ACCOUNT = 100_000;
const IS_SPLIT = 0.70; // first 70% of trading days = in-sample

export const MR_DEFAULTS = {
  signalType: 'VWAP_FADE',
  timeframe: '15m',
  direction: 'BOTH',
  // Position sizing
  sizingMode: 'NOTIONAL',   // NOTIONAL = X% of account as $ exposure | RISK = size so a stop-out loses X% of account
  accountSize: DEFAULT_ACCOUNT,
  positionPct: 0.10,        // NOTIONAL mode: fraction of account deployed per trade
  riskPct: 0.005,           // RISK mode: fraction of account risked per trade (to the stop)
  compound: true,           // size off running equity (true) vs fixed account (false)
  // VWAP_FADE
  zEntry: 2.0,
  // RSI_BB_FADE
  rsiLen: 2, rsiLow: 10, rsiHigh: 90, bbLen: 20, bbStd: 2, requireBB: true,
  // GAP_FADE
  gapMinPct: 0.3, gapMaxPct: 2.0,
  // PDL_FADE
  maxPenetrationATR: 0.5, retraceTargetPct: 25,
  // Exits
  atrStopMult: 1.5, fixedStop: 0.5, timeStopBars: 0, maxTradesPerDay: 2,
  // Session (NY HHMM) — entries only inside this window; always flat by EOD
  sessionStart: 1000, sessionEnd: 1530,
  // Regime filters (0 / 'OFF' = disabled)
  trendMode: 'OFF',      // OFF | ALIGN | FLAT_ONLY
  maxDailyADX: 0,
  vixMax: 0,
  atrPctileMin: 0,
  atrPctileMax: 100,
};

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadIntradayBars(symbol, fetchFrom, dateTo, timeframe, apiKey) {
  const [getCached, upsert] =
    timeframe === '15m' ? [getBars15m, upsertBars15m] :
    timeframe === '5m'  ? [getBars5m, upsertBars5m] :
                          [getIntraday15m, upsertIntraday15m];

  let bars = getCached(symbol, fetchFrom, dateTo);
  const cachedMin = bars[0]?.date;
  const cachedMax = bars[bars.length - 1]?.date;
  const cacheStale = bars.length === 0 || cachedMin > fetchFrom || cachedMax < dateTo;
  if (cacheStale) {
    console.log(`Fetching ${timeframe} data for ${symbol} (${fetchFrom} to ${dateTo})...`);
    const fresh = await get15mBars(symbol, fetchFrom, dateTo, apiKey, timeframe);
    if (fresh.length > 0) {
      upsert(fresh);
      bars = getCached(symbol, fetchFrom, dateTo);
    }
  }
  return bars;
}

async function loadDaily(symbol, warmupFrom, dateTo) {
  let daily = getPrices(symbol, warmupFrom, dateTo);
  const lastCached = daily[daily.length - 1]?.date;
  const staleTail = format(addDays(parseISO(dateTo), -7), 'yyyy-MM-dd');
  if (daily.length < 60 || !lastCached || lastCached < staleTail) {
    const fresh = await getHistoricalOHLCV(symbol, warmupFrom, dateTo);
    if (fresh.length > 0) {
      upsertPrices(fresh);
      daily = getPrices(symbol, warmupFrom, dateTo);
    }
  }
  return daily;
}

// Regime for each trading day, computed from the PRIOR day's daily bar
// (no lookahead — today you only know yesterday's daily close).
function buildRegimeMap(dailyBars, vixBars) {
  const closes = dailyBars.map(b => b.close);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const adx14 = adx(dailyBars, 14);
  const atr14 = atr(dailyBars, 14);

  const vixByDate = {};
  for (const v of vixBars) vixByDate[v.date] = v.close;

  const regime = {};
  for (let i = 1; i < dailyBars.length; i++) {
    const p = i - 1; // prior day index
    let trend = 'FLAT';
    if (sma20[p] != null && sma50[p] != null) {
      if (closes[p] > sma20[p] && sma20[p] > sma50[p]) trend = 'UP';
      else if (closes[p] < sma20[p] && sma20[p] < sma50[p]) trend = 'DOWN';
    }
    regime[dailyBars[i].date] = {
      trend,
      adx: adx14[p],
      atrPctile: atr14[p] != null ? percentileRank(atr14, p, 100) : null,
      vix: vixByDate[dailyBars[p].date] ?? null,
    };
  }
  return regime;
}

function passesDayFilters(reg, params) {
  if (!reg) return true; // no regime data — don't filter the day out
  if (params.trendMode === 'FLAT_ONLY' && reg.trend !== 'FLAT') return false;
  if (params.maxDailyADX > 0 && reg.adx != null && reg.adx > params.maxDailyADX) return false;
  if (params.vixMax > 0 && reg.vix != null && reg.vix > params.vixMax) return false;
  if (params.atrPctileMin > 0 && reg.atrPctile != null && reg.atrPctile < params.atrPctileMin) return false;
  if (params.atrPctileMax < 100 && reg.atrPctile != null && reg.atrPctile > params.atrPctileMax) return false;
  return true;
}

function allowedByTrend(signal, reg, params) {
  if (params.trendMode !== 'ALIGN' || !reg) return true;
  if (signal === 'LONG') return reg.trend === 'UP';
  if (signal === 'SHORT') return reg.trend === 'DOWN';
  return true;
}

// ─── Core backtest (pure — operates on preloaded data) ───────────────────────

export function backtestCore(allBars, regimeMap, rawParams) {
  const params = { ...MR_DEFAULTS, ...rawParams };
  // Regular trading hours only — cached Yahoo data includes pre/post-market bars,
  // which would corrupt session VWAP, prior-day levels, gap detection, and EOD exits.
  const bars = allBars.filter(b => b.ny_time >= 930 && b.ny_time < 1600);
  const {
    signalType, direction,
    zEntry, rsiLen, rsiLow, rsiHigh, bbLen, bbStd, requireBB,
    gapMinPct, gapMaxPct, maxPenetrationATR, retraceTargetPct,
    atrStopMult, fixedStop, timeStopBars, maxTradesPerDay,
    sessionStart, sessionEnd,
  } = params;

  // Global indicator arrays across the whole RTH bar stream
  const closes = bars.map(b => b.close);
  const rsiArr = rsi(closes, rsiLen);
  const bb = bollinger(closes, bbLen, bbStd);
  const atrArr = atr(bars, 14);
  const globalIdx = new Map(bars.map((b, i) => [b.utc_datetime, i]));

  // Group by NY date
  const byDate = {};
  for (const bar of bars) {
    if (!byDate[bar.date]) byDate[bar.date] = [];
    byDate[bar.date].push(bar);
  }
  const sortedDates = Object.keys(byDate).sort();
  for (const d of sortedDates) byDate[d].sort((a, b) => a.utc_datetime.localeCompare(b.utc_datetime));

  const trades = [];
  let tradedDays = 0, filteredDays = 0;

  for (let di = 1; di < sortedDates.length; di++) {
    const today = sortedDates[di];
    const prevDay = sortedDates[di - 1];
    if (today < params.dateFrom || today > params.dateTo) continue;

    const reg = regimeMap[today] || null;
    if (!passesDayFilters(reg, params)) { filteredDays++; continue; }

    const dayBars = byDate[today];
    const prevBars = byDate[prevDay];
    if (!dayBars?.length || !prevBars?.length) continue;

    const { vwap, zscore } = sessionVWAP(dayBars);
    const pdHigh = Math.max(...prevBars.map(b => b.high));
    const pdLow = Math.min(...prevBars.map(b => b.low));
    const pdRange = pdHigh - pdLow;
    const prevClose = prevBars[prevBars.length - 1].close;

    let tradesToday = 0;
    let openPos = null;
    let pdHighDone = false, pdLowDone = false;
    tradedDays++;

    for (let i = 0; i < dayBars.length; i++) {
      const bar = dayBars[i];
      const gi = globalIdx.get(bar.utc_datetime);
      const isLastBar = i === dayBars.length - 1;

      // ── manage open position ──
      if (openPos) {
        openPos.barsHeld++;
        let exit = null;
        if (openPos.signal === 'LONG') {
          if (bar.low <= openPos.stop) exit = { price: openPos.stop, result: 'STOP' };
          else if (bar.high >= openPos.target) exit = { price: openPos.target, result: 'TARGET' };
        } else {
          if (bar.high >= openPos.stop) exit = { price: openPos.stop, result: 'STOP' };
          else if (bar.low <= openPos.target) exit = { price: openPos.target, result: 'TARGET' };
        }
        if (!exit && timeStopBars > 0 && openPos.barsHeld >= timeStopBars) exit = { price: bar.close, result: 'TIME' };
        if (!exit && isLastBar) exit = { price: bar.close, result: 'EOD' };

        if (exit) {
          const dirMult = openPos.signal === 'LONG' ? 1 : -1;
          const returnPct = ((exit.price - openPos.entry) / openPos.entry) * 100 * dirMult;
          trades.push({
            trade_date: today,
            entry_time: openPos.entryTime,
            signal: openPos.signal,
            signal_type: signalType,
            entry_price: round(openPos.entry),
            target_price: round(openPos.target),
            stop_price: round(openPos.stop),
            exit_price: round(exit.price),
            exit_result: exit.result,
            bars_held: openPos.barsHeld,
            return_pct: round(returnPct),
            regime_trend: reg ? reg.trend : 'NA',
          });
          openPos = null;
        }
        continue; // never enter on a bar we exited/held on
      }

      // ── look for a new entry ──
      if (tradesToday >= maxTradesPerDay || isLastBar) continue;

      const inSession = signalType === 'GAP_FADE'
        ? i === 0 // gap fade only triggers on the first bar of the day
        : bar.ny_time >= sessionStart && bar.ny_time < sessionEnd;
      if (!inSession) continue;

      const atrHere = atrArr[gi];
      let candidate = null; // { signal, target }

      if (signalType === 'VWAP_FADE') {
        const z = zscore[i];
        if (z != null) {
          if (z >= zEntry && bar.close > vwap[i]) candidate = { signal: 'SHORT', target: vwap[i] };
          else if (z <= -zEntry && bar.close < vwap[i]) candidate = { signal: 'LONG', target: vwap[i] };
        }
      } else if (signalType === 'RSI_BB_FADE') {
        const r = rsiArr[gi];
        if (r != null && bb.mid[gi] != null) {
          const longOk = r <= rsiLow && (!requireBB || bar.close <= bb.lower[gi]);
          const shortOk = r >= rsiHigh && (!requireBB || bar.close >= bb.upper[gi]);
          if (longOk && bar.close < bb.mid[gi]) candidate = { signal: 'LONG', target: bb.mid[gi] };
          else if (shortOk && bar.close > bb.mid[gi]) candidate = { signal: 'SHORT', target: bb.mid[gi] };
        }
      } else if (signalType === 'GAP_FADE') {
        const gapPct = ((bar.open - prevClose) / prevClose) * 100;
        const absGap = Math.abs(gapPct);
        if (absGap >= gapMinPct && absGap <= gapMaxPct) {
          if (gapPct > 0 && bar.close > prevClose) candidate = { signal: 'SHORT', target: prevClose };
          else if (gapPct < 0 && bar.close < prevClose) candidate = { signal: 'LONG', target: prevClose };
        }
      } else if (signalType === 'PDL_FADE') {
        if (atrHere != null && pdRange > 0) {
          if (!pdHighDone && bar.high > pdHigh && (bar.high - pdHigh) <= maxPenetrationATR * atrHere) {
            pdHighDone = true;
            const target = bar.close - (retraceTargetPct / 100) * pdRange;
            if (target < bar.close) candidate = { signal: 'SHORT', target };
          } else if (!pdLowDone && bar.low < pdLow && (pdLow - bar.low) <= maxPenetrationATR * atrHere) {
            pdLowDone = true;
            const target = bar.close + (retraceTargetPct / 100) * pdRange;
            if (target > bar.close) candidate = { signal: 'LONG', target };
          }
        }
      }

      if (!candidate) continue;
      if (direction !== 'BOTH' && candidate.signal !== direction) continue;
      if (!allowedByTrend(candidate.signal, reg, params)) continue;

      const entry = bar.close;
      const stopDist = atrStopMult > 0 && atrHere != null ? atrStopMult * atrHere : fixedStop;
      if (stopDist <= 0) continue;
      const stop = candidate.signal === 'LONG' ? entry - stopDist : entry + stopDist;

      // Target must be on the profitable side
      if (candidate.signal === 'LONG' && candidate.target <= entry) continue;
      if (candidate.signal === 'SHORT' && candidate.target >= entry) continue;

      openPos = {
        signal: candidate.signal,
        entry,
        target: candidate.target,
        stop,
        entryTime: bar.ny_time,
        barsHeld: 0,
      };
      tradesToday++;
    }
  }

  return { trades, tradedDays, filteredDays, params };
}

// ─── Position sizing ─────────────────────────────────────────────────────────
// Turns each trade's price move (return_pct) into a dollar P&L, walking the
// trades in chronological order so equity can compound. Pure — returns new objects.
// `return_pct` is the signed % gain to the position, so profit-per-share =
// entry_price * return_pct/100 for both longs and shorts.
export function sizeTrades(trades, params) {
  const { sizingMode, positionPct, riskPct, compound } = { ...MR_DEFAULTS, ...params };
  const accountSize = params.accountSize || DEFAULT_ACCOUNT;
  let equity = accountSize;

  return trades.map(t => {
    const base = compound ? equity : accountSize;
    const profitPerShare = t.entry_price * (t.return_pct / 100);
    let pnl;
    if (sizingMode === 'RISK') {
      const stopDist = Math.abs(t.entry_price - t.stop_price);
      const shares = stopDist > 0 ? (base * riskPct) / stopDist : 0;
      pnl = shares * profitPerShare;
    } else {
      // NOTIONAL: deploy positionPct of the account; return_pct is the % move on that notional
      pnl = base * positionPct * (t.return_pct / 100);
    }
    pnl = round(pnl);
    equity += pnl;
    return { ...t, pnl_dollars: pnl };
  });
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

function metricSet(trades, accountSize = DEFAULT_ACCOUNT) {
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

function groupMetrics(trades, keyFn) {
  const groups = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups[k]) groups[k] = [];
    groups[k].push(t);
  }
  const out = {};
  for (const k of Object.keys(groups).sort()) {
    const g = groups[k];
    const returns = g.map(t => t.return_pct);
    out[k] = {
      trades: g.length,
      winRate: round((returns.filter(r => r > 0).length / g.length) * 100),
      avgReturnPct: round(returns.reduce((a, b) => a + b, 0) / g.length),
      totalPnl: round(g.reduce((s, t) => s + t.pnl_dollars, 0)),
    };
  }
  return out;
}

export function computeMRMetrics(trades, sortedTradeDates, params = {}) {
  const accountSize = params.accountSize || DEFAULT_ACCOUNT;
  // IS/OOS split on trading-day boundary
  const splitIdx = Math.floor(sortedTradeDates.length * IS_SPLIT);
  const splitDate = sortedTradeDates[splitIdx] || '9999-12-31';
  for (const t of trades) t.sample = t.trade_date < splitDate ? 'IS' : 'OOS';

  // `trades` are sized over the full sequence (drives the equity curve + trade log).
  // Re-size IS and OOS as standalone sequences each starting at the account size, so
  // the OOS $ figures aren't inflated by IS compounding — keeps IS vs OOS comparable.
  const full = metricSet(trades, accountSize);
  const is = metricSet(sizeTrades(trades.filter(t => t.sample === 'IS'), params), accountSize);
  const oos = metricSet(sizeTrades(trades.filter(t => t.sample === 'OOS'), params), accountSize);

  return {
    full, is, oos,
    splitDate,
    byTrend: groupMetrics(trades, t => t.regime_trend),
    byHour: groupMetrics(trades, t => String(Math.floor(t.entry_time / 100)).padStart(2, '0') + ':00'),
    bySignal: groupMetrics(trades, t => t.signal),
  };
}

// ─── Public entry points ─────────────────────────────────────────────────────

async function loadAllData(symbol, dateFrom, dateTo, timeframe, apiKey) {
  // one extra week before dateFrom for prior-day levels + indicator warmup
  const fetchFrom = format(addDays(parseISO(dateFrom), -7), 'yyyy-MM-dd');
  const warmupFrom = format(addDays(parseISO(dateFrom), -300), 'yyyy-MM-dd');

  const [bars, daily, vix] = await Promise.all([
    loadIntradayBars(symbol, fetchFrom, dateTo, timeframe, apiKey),
    loadDaily(symbol, warmupFrom, dateTo),
    loadDaily('^VIX', warmupFrom, dateTo),
  ]);
  return { bars, regimeMap: buildRegimeMap(daily, vix) };
}

export async function runMRBacktest(symbol, dateFrom, dateTo, params = {}) {
  console.log(`MR Backtest: ${symbol} ${dateFrom} → ${dateTo} [${params.signalType || MR_DEFAULTS.signalType}]`);
  const timeframe = params.timeframe || MR_DEFAULTS.timeframe;
  const { bars, regimeMap } = await loadAllData(symbol, dateFrom, dateTo, timeframe, params.apiKey);

  if (bars.length === 0) {
    return { error: `No ${timeframe} data available for ${symbol}. ${timeframe === '1h' ? 'Try a range within the last 2 years.' : `${timeframe} data only covers the last ~60 days.`}` };
  }
  console.log(`Processing ${bars.length} ${timeframe} bars for ${symbol}`);

  const coverage = dataCoverage(bars, dateFrom, dateTo);
  const result = runOne(bars, regimeMap, { ...params, symbol, dateFrom, dateTo, timeframe, sweepId: null });
  if (result.error) return result;
  return { runId: result.runId, metrics: result.metrics, tradedDays: result.tradedDays, filteredDays: result.filteredDays, ...coverage };
}

function runOne(bars, regimeMap, params) {
  const { trades, tradedDays, filteredDays, params: applied } = backtestCore(bars, regimeMap, params);
  if (trades.length === 0) {
    return { error: 'No trades generated. Loosen the entry threshold or widen the session window / filters.' };
  }

  const tradeDates = [...new Set(bars.map(b => b.date).filter(d => d >= params.dateFrom && d <= params.dateTo))].sort();
  const sized = sizeTrades(trades, applied);
  const metrics = computeMRMetrics(sized, tradeDates, applied);

  const { apiKey, ...paramsToSave } = applied;
  const runId = saveMRRun({
    symbol: params.symbol,
    date_from: params.dateFrom,
    date_to: params.dateTo,
    signal_type: applied.signalType,
    timeframe: params.timeframe,
    sweep_id: params.sweepId || null,
    total_trades: metrics.full.totalTrades,
    win_rate: metrics.full.winRate,
    total_return_pct: metrics.full.totalReturnPct,
    avg_trade_return_pct: metrics.full.avgTradeReturnPct,
    sharpe: metrics.full.sharpe,
    profit_factor: metrics.full.profitFactor,
    max_drawdown_pct: metrics.full.maxDrawdownPct,
    is_trades: metrics.is.totalTrades,
    is_win_rate: metrics.is.winRate,
    is_return_pct: metrics.is.totalReturnPct,
    is_sharpe: metrics.is.sharpe,
    is_profit_factor: metrics.is.profitFactor,
    oos_trades: metrics.oos.totalTrades,
    oos_win_rate: metrics.oos.winRate,
    oos_return_pct: metrics.oos.totalReturnPct,
    oos_sharpe: metrics.oos.sharpe,
    oos_profit_factor: metrics.oos.profitFactor,
    params: JSON.stringify(paramsToSave),
    metrics: JSON.stringify(metrics),
  });

  saveMRTrades(sized.map(t => ({ ...t, run_id: runId })));
  return { runId, metrics, tradedDays, filteredDays };
}

// ─── Sweep ───────────────────────────────────────────────────────────────────

const MAX_COMBOS = 500;

export async function runMRSweep(symbol, dateFrom, dateTo, baseParams = {}, grid = {}) {
  const gridKeys = Object.keys(grid).filter(k => Array.isArray(grid[k]) && grid[k].length > 0);
  if (gridKeys.length === 0) return { error: 'Sweep grid is empty — give at least one parameter a list of values.' };

  let combos = [{}];
  for (const key of gridKeys) {
    const next = [];
    for (const combo of combos) for (const v of grid[key]) next.push({ ...combo, [key]: v });
    combos = next;
    if (combos.length > MAX_COMBOS) return { error: `Sweep too large (${combos.length} combos, max ${MAX_COMBOS}). Reduce ranges.` };
  }

  const timeframe = baseParams.timeframe || MR_DEFAULTS.timeframe;
  console.log(`MR Sweep: ${symbol} ${dateFrom} → ${dateTo}, ${combos.length} combos over [${gridKeys.join(', ')}]`);
  const { bars, regimeMap } = await loadAllData(symbol, dateFrom, dateTo, timeframe, baseParams.apiKey);
  if (bars.length === 0) return { error: `No ${timeframe} data available for ${symbol}.` };
  const coverage = dataCoverage(bars, dateFrom, dateTo);

  const sweepId = `sweep_${Date.now()}`;
  const results = [];
  for (const combo of combos) {
    const merged = { ...baseParams, ...combo, symbol, dateFrom, dateTo, timeframe, sweepId };
    const r = runOne(bars, regimeMap, merged);
    results.push({
      combo,
      runId: r.error ? null : r.runId,
      error: r.error || null,
      trades: r.error ? 0 : r.metrics.full.totalTrades,
      isSharpe: r.error ? null : r.metrics.is.sharpe,
      oosSharpe: r.error ? null : r.metrics.oos.sharpe,
      isReturnPct: r.error ? null : r.metrics.is.totalReturnPct,
      oosReturnPct: r.error ? null : r.metrics.oos.totalReturnPct,
      oosProfitFactor: r.error ? null : r.metrics.oos.profitFactor,
      oosWinRate: r.error ? null : r.metrics.oos.winRate,
    });
  }

  results.sort((a, b) => (b.oosSharpe ?? -999) - (a.oosSharpe ?? -999) || (b.oosProfitFactor ?? -999) - (a.oosProfitFactor ?? -999));
  return { sweepId, comboCount: combos.length, gridKeys, results, ...coverage };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Actual data coverage vs the requested range — Yahoo silently truncates
// sub-hourly history, so the user must see what was really tested.
function dataCoverage(bars, dateFrom, dateTo) {
  const inRange = bars.filter(b => b.date >= dateFrom && b.date <= dateTo);
  if (inRange.length === 0) return { dataFrom: null, dataTo: null, coverageNote: 'No bars inside the requested range.' };
  const dataFrom = inRange[0].date;
  const dataTo = inRange[inRange.length - 1].date;
  const gapDays = Math.round((parseISO(dataFrom) - parseISO(dateFrom)) / 86400000);
  const coverageNote = gapDays > 7
    ? `Data only available from ${dataFrom} (requested ${dateFrom}) — Yahoo limits sub-hourly bars to ~60 days. Results cover ${dataFrom} → ${dataTo}.`
    : null;
  return { dataFrom, dataTo, coverageNote };
}

function stdDev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length);
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}
