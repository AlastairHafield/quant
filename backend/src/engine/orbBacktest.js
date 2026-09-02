import { addDays, parseISO, format } from 'date-fns';
import { atr } from './indicators.js';
import { loadAllData, buildRegimeMap } from './marketData.js';
import { DEFAULT_ACCOUNT, sizeTrades, computeBacktestMetrics, dataCoverage, round, dowOf } from './backtestMetrics.js';
import { regimeRobustnessCheck, monteCarloDrawdown, deflatedSharpe, runWalkForward } from './robustness.js';
// NOTE: db.js (native better-sqlite3) is pulled in via dynamic import inside
// data/db.js access paths (routes.js et al) only, so the pure engine
// (backtestCore / sizeTrades / computeORBMetrics) can be imported and swept
// without loading any native addon.

// Opening-Range Breakout defaults. An ORB session:
//   1. build the Opening Range (OR) from the first `orBars` 15m bars of RTH
//   2. after the OR closes, take the first breakout beyond OR high/low (per `trigger`)
//   3. exit on stop / target / time / EOD — always flat by the close
export const ORB_DEFAULTS = {
  timeframe: '15m',
  orBars: 1,               // 1=15m OR, 2=30m, 4=60m
  direction: 'BOTH',       // LONG | SHORT | BOTH
  firstOnly: true,         // BOTH: only the first side to break gets taken that day
  // Entry style: CLOSE = bar closes beyond level | TOUCH = intrabar cross (stop fill at level)
  // | CLOSE_NEXT = enter next bar's open after a close beyond | CLOSE_2 = two consecutive closes beyond
  // | RETEST = break then pull back to the level | RETEST_CLOSE = break, pull back, then reclaim (close back through)
  // | FAILED_FADE = break, then close back inside the range (failed breakout) → trade the reversal
  trigger: 'CLOSE',
  // Position sizing
  sizingMode: 'RISK',      // RISK = size so a stop-out loses riskPct | NOTIONAL = deploy positionPct of account
  accountSize: DEFAULT_ACCOUNT,
  positionPct: 0.10,
  riskPct: 0.005,
  compound: true,
  maxLeverage: 0,           // 0 = off; RISK mode cap on notional / equity
  // Costs — round-trip, as % of notional, subtracted from every trade's return
  costPct: 0.02,
  // Stop
  stopMode: 'OR_OPPOSITE', // OR_OPPOSITE | OR_FRAC | ATR | FIXED_PCT
  stopParam: 1.0,          // OR_FRAC: ×OR range | ATR: ×ATR | FIXED_PCT: % of price
  // Target
  targetMode: 'R_MULTIPLE', // R_MULTIPLE | OR_MULTIPLE | ATR | FIXED_PCT | EOD | TRAIL
  targetParam: 2.0,         // R_MULTIPLE: ×risk | OR_MULTIPLE: ×OR range from level | ATR: ×ATR | FIXED_PCT: % | TRAIL: ×ATR trail dist
  // Exits / entry window
  timeStopBars: 0,          // 0 = off
  maxTradesPerDay: 1,       // re-entry allowance
  entryCutoff: 1300,        // no new breakouts at/after this NY HHMM (always flat by EOD regardless)
  // Setup filters (intraday, no lookahead)
  minORRangePct: 0,         // skip days whose OR range < this % of price
  maxORRangePct: 0,         // 0 = off; skip days whose OR range > this % of price
  volMult: 0,               // 0 = off; require breakout-bar volume ≥ volMult × avg OR-bar volume
  gapMode: 'OFF',           // OFF | GAP_ONLY (needs |gap| ≥ gapMinPct) | ALIGN (breakout must match gap sign)
  gapMinPct: 0.2,
  // Prior-day regime filters (from yesterday's daily bar — no lookahead)
  trendMode: 'OFF',         // OFF | ALIGN (breakout must match daily trend) | UP_ONLY | DOWN_ONLY
  minDailyADX: 0,           // require trending day (ADX ≥ x)
  maxDailyADX: 0,           // 0 = off
  vixMin: 0, vixMax: 0,
  atrPctileMin: 0, atrPctileMax: 100,
  dowMask: 'ALL',           // 'ALL' or subset of 'MTWRF' (Mon..Fri) to allow
  // Session VWAP alignment filter (no lookahead — cumulative from RTH open through "now")
  vwapMode: 'OFF',          // OFF | ALIGN (entry price must be beyond VWAP in the trade's direction)
  atrPeriod: 14,            // bars; scale this up when timeframe is finer than 15m for a comparable window
  // Session window (NY HHMM) bars are filtered to before anything else runs — the OR
  // is built from the first `orBars` bars *after* sessionStartET, and a position still
  // open at sessionEndET is always flattened there (same "flat by session end" rule
  // that applies to RTH, just parameterized). Defaults are RTH so every existing
  // symbol/timeframe combo behaves identically; only a non-RTH data source (e.g. a
  // near-24hr futures feed) would ever override these.
  sessionStartET: 930,
  sessionEndET: 1600,
};

// Intraday/daily/regime data loading now lives in marketData.js (shared with
// gapFillBacktest.js and any future engine) — loadAllData/buildRegimeMap
// imported at the top of this file.

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

function allowedByVwap(signal, price, vwapHere, mode) {
  if (mode !== 'ALIGN' || vwapHere == null || price == null) return true;
  return signal === 'LONG' ? price > vwapHere : price < vwapHere;
}

function allowedByTrend(signal, reg, params) {
  const m = params.trendMode;
  if (m === 'OFF' || !reg) return true;
  if (m === 'UP_ONLY') return signal === 'LONG';
  if (m === 'DOWN_ONLY') return signal === 'SHORT';
  if (m === 'ALIGN') {
    if (signal === 'LONG') return reg.trend === 'UP';
    if (signal === 'SHORT') return reg.trend === 'DOWN';
  }
  return true;
}

// ─── Per-symbol precompute cache ─────────────────────────────────────────────
// Day grouping + VWAP are param-independent; ATR depends on atrPeriod (which
// normally isn't swept, but matters when comparing timeframes — e.g. ATR(14) on
// 1m bars is a 14-minute window, not comparable to ATR(14) on 15m bars). Cache
// keyed on (bars array identity, atrPeriod, session window) so a sweep still hits the cache.
const ctxCache = new WeakMap();
function getContext(allBars, atrPeriod = 14, sessionStartET = 930, sessionEndET = 1600) {
  let byKey = ctxCache.get(allBars);
  if (!byKey) { byKey = new Map(); ctxCache.set(allBars, byKey); }
  const cacheKey = `${atrPeriod}|${sessionStartET}|${sessionEndET}`;
  let ctx = byKey.get(cacheKey);
  if (ctx) return ctx;

  const bars = allBars.filter(b => b.ny_time >= sessionStartET && b.ny_time < sessionEndET);
  const atrArr = atr(bars, atrPeriod);
  const globalIdx = new Map(bars.map((b, i) => [b.utc_datetime, i]));
  const byDate = {};
  for (const bar of bars) (byDate[bar.date] ||= []).push(bar);
  const sortedDates = Object.keys(byDate).sort();
  for (const d of sortedDates) byDate[d].sort((a, b) => a.utc_datetime.localeCompare(b.utc_datetime));

  // Session VWAP: cumulative typical-price×volume ÷ cumulative volume from RTH
  // open through "now" — no lookahead, resets each day.
  const vwapArr = new Array(bars.length).fill(null);
  for (const d of sortedDates) {
    let cumPV = 0, cumVol = 0;
    for (const bar of byDate[d]) {
      const tp = (bar.high + bar.low + bar.close) / 3;
      cumPV += tp * (bar.volume || 0);
      cumVol += (bar.volume || 0);
      vwapArr[globalIdx.get(bar.utc_datetime)] = cumVol > 0 ? cumPV / cumVol : null;
    }
  }

  ctx = { bars, atrArr, globalIdx, byDate, sortedDates, vwapArr };
  byKey.set(cacheKey, ctx);
  return ctx;
}


// ─── Core backtest (pure) ────────────────────────────────────────────────────

export function backtestCore(allBars, regimeMap, rawParams) {
  const params = { ...ORB_DEFAULTS, ...rawParams };
  const {
    orBars, direction, firstOnly, trigger,
    stopMode, stopParam, targetMode, targetParam,
    timeStopBars, maxTradesPerDay, entryCutoff,
    minORRangePct, maxORRangePct, volMult, gapMode, gapMinPct,
    sessionStartET, sessionEndET,
  } = params;

  const { atrArr, globalIdx, byDate, sortedDates, vwapArr } = getContext(allBars, params.atrPeriod, sessionStartET, sessionEndET);
  const trades = [];
  let tradedDays = 0, filteredDays = 0;

  for (const today of sortedDates) {
    if (today < params.dateFrom || today > params.dateTo) continue;
    const dayBars = byDate[today];
    if (!dayBars || dayBars.length < orBars + 2) continue; // need OR + room to trade

    const dowChar = dowOf(today);
    const reg = regimeMap[today] || null;
    if (!passesDayFilters(reg, dowChar, params)) { filteredDays++; continue; }

    // ── Opening Range from first `orBars` bars ──
    const orSlice = dayBars.slice(0, orBars);
    const orHigh = Math.max(...orSlice.map(b => b.high));
    const orLow = Math.min(...orSlice.map(b => b.low));
    const orRange = orHigh - orLow;
    if (orRange <= 0) continue;
    const orMid = (orHigh + orLow) / 2;
    const orRangePct = (orRange / orMid) * 100;
    if (minORRangePct > 0 && orRangePct < minORRangePct) { filteredDays++; continue; }
    if (maxORRangePct > 0 && orRangePct > maxORRangePct) { filteredDays++; continue; }

    const orAvgVol = orSlice.reduce((s, b) => s + (b.volume || 0), 0) / orBars;
    const dayOpen = dayBars[0].open;
    const gapPct = reg?.prevClose ? ((dayOpen - reg.prevClose) / reg.prevClose) * 100 : 0;
    if (gapMode === 'GAP_ONLY' && Math.abs(gapPct) < gapMinPct) { filteredDays++; continue; }

    tradedDays++;
    let tradesToday = 0;
    let openPos = null;
    let brokeThisDay = false; // for firstOnly (immediate CLOSE/TOUCH styles)
    const st = { armedDir: null, pulledBack: false, consecUp: 0, consecDn: 0 }; // stateful entry styles

    for (let i = orBars; i < dayBars.length; i++) {
      const bar = dayBars[i];
      const gi = globalIdx.get(bar.utc_datetime);
      const isLastBar = i === dayBars.length - 1;

      // ── manage open position ──
      if (openPos) {
        openPos.barsHeld++;
        const ex = resolveExit(openPos, bar, timeStopBars, isLastBar);
        if (ex) { closeTrade(trades, openPos, ex, today, reg, params, gapPct); openPos = null; }
        else continue; // still holding — no new entry this bar
        if (isLastBar) continue;
      }

      // ── look for a breakout entry ──
      if (tradesToday >= maxTradesPerDay || isLastBar) continue;
      if (bar.ny_time >= entryCutoff) continue;

      const atrHere = atrArr[gi];
      const canLong = direction === 'LONG' || direction === 'BOTH';
      const canShort = direction === 'SHORT' || direction === 'BOTH';
      let sig = null, entry = null, entryIntrabar = false;

      if (trigger === 'CLOSE' || trigger === 'TOUCH') {
        // Immediate: enter the moment a bar closes beyond (CLOSE) or price crosses (TOUCH).
        if (firstOnly && brokeThisDay) continue;
        const upBreak = trigger === 'CLOSE' ? bar.close > orHigh : bar.high > orHigh;
        const dnBreak = trigger === 'CLOSE' ? bar.close < orLow : bar.low < orLow;
        if (upBreak && canLong) { sig = 'LONG'; entry = trigger === 'CLOSE' ? bar.close : orHigh; entryIntrabar = trigger === 'TOUCH'; }
        else if (dnBreak && canShort) { sig = 'SHORT'; entry = trigger === 'CLOSE' ? bar.close : orLow; entryIntrabar = trigger === 'TOUCH'; }
        else if (upBreak || dnBreak) { brokeThisDay = true; continue; } // broke a side we don't trade
        else continue;
        brokeThisDay = true;
      } else {
        // Stateful: confirmation (CLOSE_NEXT / CLOSE_2) and break-retest (RETEST / RETEST_CLOSE).
        const c = resolveEntryStateful(bar, orHigh, orLow, trigger, canLong, canShort, st);
        if (!c) continue;
        sig = c.signal; entry = c.entry; entryIntrabar = c.intrabar;
      }
      if (!allowedByTrend(sig, reg, params)) continue;
      if (gapMode === 'ALIGN' && Math.sign(gapPct) !== (sig === 'LONG' ? 1 : -1)) continue;
      if (volMult > 0 && orAvgVol > 0 && (bar.volume || 0) < volMult * orAvgVol) continue;
      if (!allowedByVwap(sig, entry, vwapArr[gi], params.vwapMode)) continue;

      // stop distance
      let stopDist;
      if (stopMode === 'OR_OPPOSITE') stopDist = sig === 'LONG' ? entry - orLow : orHigh - entry;
      else if (stopMode === 'OR_FRAC') stopDist = stopParam * orRange;
      else if (stopMode === 'ATR') stopDist = atrHere != null ? stopParam * atrHere : null;
      else stopDist = (stopParam / 100) * entry; // FIXED_PCT
      if (stopDist == null || stopDist <= 0) continue;
      const stop = sig === 'LONG' ? entry - stopDist : entry + stopDist;

      // target
      let target = null, trailDist = null;
      if (targetMode === 'R_MULTIPLE') target = sig === 'LONG' ? entry + targetParam * stopDist : entry - targetParam * stopDist;
      else if (targetMode === 'OR_MULTIPLE') target = sig === 'LONG' ? orHigh + targetParam * orRange : orLow - targetParam * orRange;
      else if (targetMode === 'ATR') target = atrHere != null ? (sig === 'LONG' ? entry + targetParam * atrHere : entry - targetParam * atrHere) : null;
      else if (targetMode === 'FIXED_PCT') target = sig === 'LONG' ? entry * (1 + targetParam / 100) : entry * (1 - targetParam / 100);
      else if (targetMode === 'TRAIL') trailDist = atrHere != null ? targetParam * atrHere : null;
      // EOD → target stays null, ride to close

      openPos = {
        signal: sig, entry, stop, initStop: stop, target, trailDist,
        extreme: entry, // for trailing
        entryTime: bar.ny_time, barsHeld: 0, orRangePct,
      };

      // Intrabar-fill entries (touch / retest / next-bar-open) can hit stop/target within the same bar
      if (entryIntrabar) {
        const ex = resolveExit(openPos, bar, timeStopBars, isLastBar);
        if (ex) { closeTrade(trades, openPos, ex, today, reg, params, gapPct); openPos = null; }
      }
      tradesToday++;
    }
  }

  return { trades, tradedDays, filteredDays, params };
}

// Stateful breakout entry styles. Returns { signal, entry, intrabar } when a fill
// triggers on this bar, else null. Mutates `st` (per-day) to carry the setup forward.
//   CLOSE_NEXT   — one bar closes beyond the range → enter at the NEXT bar's open
//   CLOSE_2      — two consecutive closes beyond → enter at the 2nd close
//   RETEST       — close beyond, then price pulls back to the level → enter at the level
//   RETEST_CLOSE — close beyond, pull back, then a bar closes back through → enter at that close
//   FAILED_FADE  — close beyond, then a bar closes back INSIDE the range → fade the failed breakout
function resolveEntryStateful(bar, orHigh, orLow, style, canLong, canShort, st) {
  const closeUp = bar.close > orHigh, closeDn = bar.close < orLow;

  if (style === 'FAILED_FADE') {
    // armedDir tracks which side broke out; the eventual TRADE direction is the opposite.
    if (st.armedDir === 'SHORT') { // broke up, watching for it to fail back below the high
      if (bar.close < orHigh) { st.armedDir = null; return { signal: 'SHORT', entry: bar.close, intrabar: false }; }
      return null;
    }
    if (st.armedDir === 'LONG') { // broke down, watching for it to fail back above the low
      if (bar.close > orLow) { st.armedDir = null; return { signal: 'LONG', entry: bar.close, intrabar: false }; }
      return null;
    }
    if (closeUp && canShort) st.armedDir = 'SHORT';
    else if (closeDn && canLong) st.armedDir = 'LONG';
    return null;
  }

  if (style === 'CLOSE_NEXT') {
    if (st.armedDir === 'LONG')  { st.armedDir = null; return { signal: 'LONG',  entry: bar.open, intrabar: true }; }
    if (st.armedDir === 'SHORT') { st.armedDir = null; return { signal: 'SHORT', entry: bar.open, intrabar: true }; }
    if (closeUp && canLong) st.armedDir = 'LONG';
    else if (closeDn && canShort) st.armedDir = 'SHORT';
    return null;
  }

  if (style === 'CLOSE_2') {
    st.consecUp = closeUp ? st.consecUp + 1 : 0;
    st.consecDn = closeDn ? st.consecDn + 1 : 0;
    if (st.consecUp >= 2 && canLong)  { st.consecUp = 0; return { signal: 'LONG',  entry: bar.close, intrabar: false }; }
    if (st.consecDn >= 2 && canShort) { st.consecDn = 0; return { signal: 'SHORT', entry: bar.close, intrabar: false }; }
    return null;
  }

  if (style === 'RETEST' || style === 'RETEST_CLOSE') {
    if (st.armedDir === 'LONG') {
      if (bar.low <= orHigh) st.pulledBack = true;
      if (st.pulledBack) {
        if (style === 'RETEST') { st.armedDir = null; return { signal: 'LONG', entry: orHigh, intrabar: true }; }
        if (bar.close > orHigh) { st.armedDir = null; return { signal: 'LONG', entry: bar.close, intrabar: false }; }
      }
      return null;
    }
    if (st.armedDir === 'SHORT') {
      if (bar.high >= orLow) st.pulledBack = true;
      if (st.pulledBack) {
        if (style === 'RETEST') { st.armedDir = null; return { signal: 'SHORT', entry: orLow, intrabar: true }; }
        if (bar.close < orLow) { st.armedDir = null; return { signal: 'SHORT', entry: bar.close, intrabar: false }; }
      }
      return null;
    }
    if (closeUp && canLong) { st.armedDir = 'LONG'; st.pulledBack = false; }
    else if (closeDn && canShort) { st.armedDir = 'SHORT'; st.pulledBack = false; }
    return null;
  }

  return null;
}

// Resolve an intrabar exit for an open position. Conservative: stop is checked
// before target (assume the adverse level trades first within the bar).
function resolveExit(pos, bar, timeStopBars, isLastBar) {
  // update trailing stop from the running extreme
  if (pos.trailDist != null) {
    if (pos.signal === 'LONG') {
      if (bar.high > pos.extreme) pos.extreme = bar.high;
      const t = pos.extreme - pos.trailDist;
      if (t > pos.stop) pos.stop = t;
    } else {
      if (bar.low < pos.extreme) pos.extreme = bar.low;
      const t = pos.extreme + pos.trailDist;
      if (t < pos.stop) pos.stop = t;
    }
  }
  if (pos.signal === 'LONG') {
    if (bar.low <= pos.stop) return { price: pos.stop, result: 'STOP' };
    if (pos.target != null && bar.high >= pos.target) return { price: pos.target, result: 'TARGET' };
  } else {
    if (bar.high >= pos.stop) return { price: pos.stop, result: 'STOP' };
    if (pos.target != null && bar.low <= pos.target) return { price: pos.target, result: 'TARGET' };
  }
  if (timeStopBars > 0 && pos.barsHeld >= timeStopBars) return { price: bar.close, result: 'TIME' };
  if (isLastBar) return { price: bar.close, result: 'EOD' };
  return null;
}

function closeTrade(trades, pos, exit, today, reg, params, gapPct) {
  const dirMult = pos.signal === 'LONG' ? 1 : -1;
  const gross = ((exit.price - pos.entry) / pos.entry) * 100 * dirMult;
  const net = gross - params.costPct;
  trades.push({
    trade_date: today,
    entry_time: pos.entryTime,
    signal: pos.signal,
    entry_price: round(pos.entry),
    target_price: pos.target != null ? round(pos.target) : null,
    // Initial protective stop — the risk reference for position sizing. For a
    // trailing exit, where the moving stop finally hit is captured by exit_price.
    stop_price: round(pos.initStop),
    exit_price: round(exit.price),
    exit_result: exit.result,
    bars_held: pos.barsHeld,
    or_range_pct: round(pos.orRangePct),
    gap_pct: round(gapPct),
    gross_return_pct: round(gross),
    return_pct: round(net),
    regime_trend: reg ? reg.trend : 'NA',
  });
}

// ─── Metrics (ORB-specific groupings on top of the shared full/IS/OOS/byDow/byExit) ──

function computeORBMetrics(trades, sortedTradeDates, params = {}) {
  const metrics = computeBacktestMetrics(trades, sortedTradeDates, params, {
    byTrend: t => t.regime_trend,
    byHour: t => String(Math.floor(t.entry_time / 100)).padStart(2, '0') + ':00',
    bySignal: t => t.signal,
  });
  // trades here are already sized (pnl_dollars present) — see runOne below.
  metrics.regimeRobustness = regimeRobustnessCheck(trades, t => t.regime_trend);
  metrics.monteCarlo = trades.length >= 20
    ? monteCarloDrawdown(trades, params.accountSize || DEFAULT_ACCOUNT)
    : null;
  return metrics;
}

// ─── Data-driven entry points ────────────────────────────────────────────────

export async function runORBBacktest(symbol, dateFrom, dateTo, params = {}) {
  const { bars, regimeMap } = await loadAllData(symbol, dateFrom, dateTo, params);
  if (bars.length === 0) return { error: `No ${params.timeframe || '15m'} data available for ${symbol}.` };
  const coverage = dataCoverage(bars, dateFrom, dateTo);
  const result = await runOne(bars, regimeMap, { ...params, symbol, dateFrom, dateTo, sweepId: null });
  if (result.error) return result;
  return { runId: result.runId, metrics: result.metrics, tradedDays: result.tradedDays, filteredDays: result.filteredDays, ...coverage };
}

async function runOne(bars, regimeMap, params) {
  const { saveORBRun, saveORBTrades } = await import('../data/db.js');
  const { trades, tradedDays, filteredDays, params: applied } = backtestCore(bars, regimeMap, params);
  if (trades.length === 0) return { error: 'No trades generated.' };
  const tradeDates = [...new Set(bars.map(b => b.date).filter(d => d >= params.dateFrom && d <= params.dateTo))].sort();
  const sized = sizeTrades(trades, applied);
  const metrics = computeORBMetrics(sized, tradeDates, applied);

  const { apiKey, ...paramsToSave } = applied;
  const runId = saveORBRun({
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
  saveORBTrades(sized.map(t => ({ ...t, run_id: runId })));
  return { runId, metrics, tradedDays, filteredDays };
}

// ─── Sweep ───────────────────────────────────────────────────────────────────

const MAX_COMBOS = 2000;

export async function runORBSweep(symbol, dateFrom, dateTo, baseParams = {}, grid = {}) {
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

  const sweepId = `orbsweep_${Date.now()}`;
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

  // Deflated Sharpe for the winner only — the naive best-of-N OOS Sharpe above
  // is biased upward exactly because N combos were tried; this haircuts it
  // for that selection effect. Computed on the winner's own OOS trades, not
  // held in memory for every combo during the loop above.
  let deflatedSharpeOfTop = null;
  if (results[0]?.runId != null) {
    const { getORBTrades } = await import('../data/db.js');
    const oosReturns = getORBTrades(results[0].runId)
      .filter(t => t.sample === 'OOS')
      .map(t => t.return_pct);
    deflatedSharpeOfTop = deflatedSharpe(oosReturns, combos.length);
  }

  return { sweepId, comboCount: combos.length, gridKeys, results, deflatedSharpeOfTop, ...coverage };
}

// ─── Walk-forward validation ─────────────────────────────────────────────────

export async function runORBWalkForward(symbol, dateFrom, dateTo, baseParams = {}, grid = {}, numFolds = 4) {
  const { bars, regimeMap } = await loadAllData(symbol, dateFrom, dateTo, baseParams);
  if (bars.length === 0) return { error: `No ${baseParams.timeframe || '15m'} data available for ${symbol}.` };
  const coverage = dataCoverage(bars, dateFrom, dateTo);
  const result = runWalkForward({
    coreFn: backtestCore, bars, regimeMap, baseParams, grid, dateFrom, dateTo, numFolds,
    accountSize: baseParams.accountSize,
  });
  if (result.error) return result;
  return { ...result, ...coverage };
}

