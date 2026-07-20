import { addDays, parseISO, format } from 'date-fns';
import { sma, atr, adx, percentileRank } from './indicators.js';
// NOTE: db.js (native better-sqlite3) and the Yahoo fetchers are pulled in via
// dynamic import inside the async data-loading paths only, so the pure engine
// (backtestCore / sizeTrades / computeORBMetrics / buildRegimeMap) can be imported
// and swept without loading any native addon.

const DEFAULT_ACCOUNT = 100_000;
const IS_SPLIT = 0.70; // first 70% of trading days = in-sample

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
};

// ─── Data loading (mirrors mrBacktest) ───────────────────────────────────────

// Dispatches on `timeframe` — this used to be hardcoded to 15m regardless of what
// was requested, so 5m/1m sweeps silently ran on 15m data. Now actually wired up.
async function loadIntradayBars(symbol, fetchFrom, dateTo, apiKey, timeframe = '15m') {
  if (timeframe === '1m') return loadAlpaca1mBars(symbol, fetchFrom, dateTo);

  const { getBars15m, getBars5m, upsertBars15m, upsertBars5m } = await import('../data/db.js');
  const { get15mBars } = await import('../api/intraday.js');
  const getCached = timeframe === '5m' ? getBars5m : getBars15m;
  const upsertCached = timeframe === '5m' ? upsertBars5m : upsertBars15m;

  let bars = getCached(symbol, fetchFrom, dateTo);
  const cachedMin = bars[0]?.date;
  const cachedMax = bars[bars.length - 1]?.date;
  const cacheStale = bars.length === 0 || cachedMin > fetchFrom || cachedMax < dateTo;
  if (cacheStale) {
    console.log(`Fetching ${timeframe} data for ${symbol} (${fetchFrom} to ${dateTo})...`);
    const fresh = await get15mBars(symbol, fetchFrom, dateTo, apiKey, timeframe);
    if (fresh.length > 0) {
      upsertCached(fresh);
      bars = getCached(symbol, fetchFrom, dateTo);
    }
  }
  return bars;
}

async function loadAlpaca1mBars(symbol, fetchFrom, dateTo) {
  const { getBars1m, upsertBars1m } = await import('../data/db.js');
  const { getAlpacaBars } = await import('../api/alpaca.js');
  let bars = getBars1m(symbol, fetchFrom, dateTo);
  const cachedMin = bars[0]?.date;
  const cachedMax = bars[bars.length - 1]?.date;
  const cacheStale = bars.length === 0 || cachedMin > fetchFrom || cachedMax < dateTo;
  if (cacheStale) {
    console.log(`Fetching 1m data for ${symbol} (${fetchFrom} to ${dateTo}) from Alpaca...`);
    const fresh = await getAlpacaBars(symbol, fetchFrom, dateTo, { timeframe: '1Min' });
    if (fresh.length > 0) {
      upsertBars1m(fresh);
      bars = getBars1m(symbol, fetchFrom, dateTo);
    }
  }
  return bars;
}

async function loadDaily(symbol, warmupFrom, dateTo) {
  const { getPrices, upsertPrices } = await import('../data/db.js');
  const { getHistoricalOHLCV } = await import('../api/prices.js');
  let daily = getPrices(symbol, warmupFrom, dateTo);
  const firstCached = daily[0]?.date;
  const lastCached = daily[daily.length - 1]?.date;
  const staleTail = format(addDays(parseISO(dateTo), -7), 'yyyy-MM-dd');
  // A cache that starts well after warmupFrom is missing early history — this used to
  // go unnoticed because only the tail was checked, silently starving the regime map
  // (buildRegimeMap) of prior-day data for the whole gap, which makes passesDayFilters
  // treat those days as unfiltered (reg == null → filters bypassed) instead of erroring.
  const staleHead = format(addDays(parseISO(warmupFrom), 7), 'yyyy-MM-dd');
  const cacheStale = daily.length < 60 || !lastCached || lastCached < staleTail || !firstCached || firstCached > staleHead;
  if (cacheStale) {
    const fresh = await getHistoricalOHLCV(symbol, warmupFrom, dateTo);
    if (fresh.length > 0) {
      upsertPrices(fresh);
      daily = getPrices(symbol, warmupFrom, dateTo);
    }
  }
  return daily;
}

// Regime for each trading day from the PRIOR day's daily bar (no lookahead).
export function buildRegimeMap(dailyBars, vixBars) {
  const closes = dailyBars.map(b => b.close);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const adx14 = adx(dailyBars, 14);
  const atr14 = atr(dailyBars, 14);

  const vixByDate = {};
  for (const v of vixBars) vixByDate[v.date] = v.close;

  const regime = {};
  for (let i = 1; i < dailyBars.length; i++) {
    const p = i - 1;
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
      prevClose: closes[p],
    };
  }
  return regime;
}

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
// keyed on (bars array identity, atrPeriod) so a sweep still hits the cache.
const ctxCache = new WeakMap();
function getContext(allBars, atrPeriod = 14) {
  let byPeriod = ctxCache.get(allBars);
  if (!byPeriod) { byPeriod = new Map(); ctxCache.set(allBars, byPeriod); }
  let ctx = byPeriod.get(atrPeriod);
  if (ctx) return ctx;

  const bars = allBars.filter(b => b.ny_time >= 930 && b.ny_time < 1600);
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
  byPeriod.set(atrPeriod, ctx);
  return ctx;
}

const DOW = ['U', 'M', 'T', 'W', 'R', 'F', 'S']; // getUTCDay(): 0=Sun..6=Sat

// ─── Core backtest (pure) ────────────────────────────────────────────────────

export function backtestCore(allBars, regimeMap, rawParams) {
  const params = { ...ORB_DEFAULTS, ...rawParams };
  const {
    orBars, direction, firstOnly, trigger,
    stopMode, stopParam, targetMode, targetParam,
    timeStopBars, maxTradesPerDay, entryCutoff,
    minORRangePct, maxORRangePct, volMult, gapMode, gapMinPct,
  } = params;

  const { atrArr, globalIdx, byDate, sortedDates, vwapArr } = getContext(allBars, params.atrPeriod);
  const trades = [];
  let tradedDays = 0, filteredDays = 0;

  for (const today of sortedDates) {
    if (today < params.dateFrom || today > params.dateTo) continue;
    const dayBars = byDate[today];
    if (!dayBars || dayBars.length < orBars + 2) continue; // need OR + room to trade

    const dowChar = DOW[parseISO(today).getUTCDay()];
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

// ─── Position sizing (identical model to mrBacktest) ─────────────────────────

export function sizeTrades(trades, params) {
  const { sizingMode, positionPct, riskPct, compound, maxLeverage } = { ...ORB_DEFAULTS, ...params };
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

const DOW_LABEL = { M: 'Mon', T: 'Tue', W: 'Wed', R: 'Thu', F: 'Fri' };

export function computeORBMetrics(trades, sortedTradeDates, params = {}) {
  const accountSize = params.accountSize || DEFAULT_ACCOUNT;
  const splitIdx = Math.floor(sortedTradeDates.length * IS_SPLIT);
  const splitDate = sortedTradeDates[splitIdx] || '9999-12-31';
  for (const t of trades) t.sample = t.trade_date < splitDate ? 'IS' : 'OOS';

  const full = metricSet(trades, accountSize);
  const is = metricSet(sizeTrades(trades.filter(t => t.sample === 'IS'), params), accountSize);
  const oos = metricSet(sizeTrades(trades.filter(t => t.sample === 'OOS'), params), accountSize);

  return {
    full, is, oos, splitDate,
    byTrend: groupMetrics(trades, t => t.regime_trend),
    byHour: groupMetrics(trades, t => String(Math.floor(t.entry_time / 100)).padStart(2, '0') + ':00'),
    bySignal: groupMetrics(trades, t => t.signal),
    byDow: groupMetrics(trades, t => DOW_LABEL[DOW[parseISO(t.trade_date).getUTCDay()]] || '?'),
    byExit: groupMetrics(trades, t => t.exit_result),
  };
}

// ─── Data-driven entry points ────────────────────────────────────────────────

async function loadAllData(symbol, dateFrom, dateTo, params = {}) {
  const fetchFrom = format(addDays(parseISO(dateFrom), -7), 'yyyy-MM-dd');
  const warmupFrom = format(addDays(parseISO(dateFrom), -300), 'yyyy-MM-dd');
  const [bars, daily, vix] = await Promise.all([
    loadIntradayBars(symbol, fetchFrom, dateTo, params.apiKey, params.timeframe),
    loadDaily(symbol, warmupFrom, dateTo),
    loadDaily('^VIX', warmupFrom, dateTo),
  ]);
  return { bars, regimeMap: buildRegimeMap(daily, vix) };
}

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
  return { sweepId, comboCount: combos.length, gridKeys, results, ...coverage };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dataCoverage(bars, dateFrom, dateTo) {
  const inRange = bars.filter(b => b.date >= dateFrom && b.date <= dateTo);
  if (inRange.length === 0) return { dataFrom: null, dataTo: null, coverageNote: 'No bars inside the requested range.' };
  const dataFrom = inRange[0].date, dataTo = inRange[inRange.length - 1].date;
  const gapDays = Math.round((parseISO(dataFrom) - parseISO(dateFrom)) / 86400000);
  const coverageNote = gapDays > 7
    ? `Data only from ${dataFrom} (requested ${dateFrom}). Results cover ${dataFrom} → ${dataTo}.` : null;
  return { dataFrom, dataTo, coverageNote };
}

function stdDev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length);
}

function round(n) { return Math.round(n * 10000) / 10000; }
