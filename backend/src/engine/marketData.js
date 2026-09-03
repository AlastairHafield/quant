import { addDays, parseISO, format } from 'date-fns';
import { sma, atr, adx, percentileRank } from './indicators.js';
// NOTE: db.js (native better-sqlite3) and the Yahoo/Alpaca/Databento fetchers are
// pulled in via dynamic import inside these async functions only, so any pure
// engine built on top (backtestCore-style functions) can be imported and swept
// without loading a native addon.

// Shared market-data loading for backtest engines (originally lived in
// orbBacktest.js; extracted once a second engine — gapFillBacktest.js — needed
// the same intraday/daily/regime loading, symbol-agnostic and strategy-agnostic).

// Dispatches on `timeframe` — 15m/5m/1h go through FMP/Yahoo (RTH-only), '1m'
// goes through Alpaca (US equities, ~5yr history but no real pre-market
// liquidity before ~8am ET), '1m-databento' goes through Databento (near-24hr
// futures session, e.g. continuous ES/MES, 16yr+ history).
export async function loadIntradayBars(symbol, fetchFrom, dateTo, apiKey, timeframe = '15m') {
  if (timeframe === '1m') return loadAlpaca1mBars(symbol, fetchFrom, dateTo);
  if (timeframe === '1m-databento') return loadDatabentoBars(symbol, fetchFrom, dateTo);

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

// App-level symbol (matches the Yahoo-fetchable ticker used for the daily/ADX/VIX
// regime data — see loadDaily) mapped to Databento's own continuous-contract
// symbology, so callers only ever deal in one consistent symbol string.
const DATABENTO_CONTINUOUS_SYMBOL = { 'ES=F': 'ES.c.0', 'MES=F': 'MES.c.0' };

// 1-minute bars from Databento (near-24hr futures session, e.g. continuous ES) —
// same cache/staleness pattern as loadAlpaca1mBars, sharing the generic bars_1m
// table under the app-level symbol key so it can't collide with a real equity
// ticker and stays consistent with the daily/regime data fetched under the
// same symbol.
async function loadDatabentoBars(symbol, fetchFrom, dateTo) {
  const { getBars1m, upsertBars1m } = await import('../data/db.js');
  const { getDatabentoBars } = await import('../api/databento.js');
  let bars = getBars1m(symbol, fetchFrom, dateTo);
  const cachedMin = bars[0]?.date;
  const cachedMax = bars[bars.length - 1]?.date;
  // Tolerance on both ends (same idea as loadDaily's staleHead/staleTail),
  // not an exact match against fetchFrom/dateTo — real market data can't have
  // a bar on the weekend date fetchFrom might land on, and Databento's own
  // available range trails "now" by a bit (won't serve the still-in-progress
  // trading day). Comparing with zero slack made cacheStale evaluate true
  // forever even once the cache was actually complete, refetching 10+ years
  // of data on every single call.
  const staleHead = format(addDays(parseISO(fetchFrom), 7), 'yyyy-MM-dd');
  const staleTail = format(addDays(parseISO(dateTo), -3), 'yyyy-MM-dd');
  const cacheStale = bars.length === 0 || cachedMin > staleHead || cachedMax < staleTail;
  if (cacheStale) {
    const databentoSymbol = DATABENTO_CONTINUOUS_SYMBOL[symbol] || symbol;
    console.log(`Fetching 1m data for ${symbol} (${fetchFrom} to ${dateTo}) from Databento (${databentoSymbol})...`);
    // Persisted chunk-by-chunk (see getDatabentoBars) rather than collected into
    // one array and upserted at the end — a multi-year 1-minute pull is millions
    // of bar objects, too large to hold in memory at once (confirmed live: this
    // crashed the process with an OOM before ever reaching this line).
    const totalBars = await getDatabentoBars(databentoSymbol, fetchFrom, dateTo, (chunkBars) => {
      upsertBars1m(chunkBars.map(b => ({ ...b, symbol }))); // store under the app-level symbol
    });
    if (totalBars > 0) {
      bars = getBars1m(symbol, fetchFrom, dateTo);
    }
  }
  return bars;
}

export async function loadDaily(symbol, warmupFrom, dateTo) {
  const { getPrices, upsertPrices } = await import('../data/db.js');
  const { getHistoricalOHLCV } = await import('../api/prices.js');
  let daily = getPrices(symbol, warmupFrom, dateTo);
  const firstCached = daily[0]?.date;
  const lastCached = daily[daily.length - 1]?.date;
  const staleTail = format(addDays(parseISO(dateTo), -7), 'yyyy-MM-dd');
  // A cache that starts well after warmupFrom is missing early history — this used to
  // go unnoticed because only the tail was checked, silently starving the regime map
  // (buildRegimeMap) of prior-day data for the whole gap, which makes day filters
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

// 1-minute bars carrying real per-minute aggressor buy/sell volume (tick_volume_1m,
// joined onto the OHLCV bars_1m/Databento cache by date+ny_time), plus the same
// prior-day ADX regime map every other engine uses. Deliberately refuses to run on
// plain OHLCV with no real tick-derived volume — orderFlowBacktest.js's entire
// premise is aggressor buy/sell volume (delta, absorption, path-of-least-resistance),
// so silently backtesting against fabricated/zero volume would produce a result that
// looks real but means nothing. There is currently no producer for tick_volume_1m
// (see db.js) — this will return `error` until one exists and has been run for the
// requested range.
export async function loadOrderFlowBars(symbol, dateFrom, dateTo, params = {}) {
  const { getTickVolume1m } = await import('../data/db.js');
  const fetchFrom = format(addDays(parseISO(dateFrom), -7), 'yyyy-MM-dd');
  const warmupFrom = format(addDays(parseISO(dateFrom), -300), 'yyyy-MM-dd');

  const [ohlcvBars, tickVolRows, daily, vix] = await Promise.all([
    loadIntradayBars(symbol, fetchFrom, dateTo, params.apiKey, params.timeframe || '1m-databento'),
    Promise.resolve(getTickVolume1m(symbol, dateFrom, dateTo)),
    loadDaily(symbol, warmupFrom, dateTo),
    loadDaily('^VIX', warmupFrom, dateTo),
  ]);

  if (tickVolRows.length === 0) {
    return {
      bars: [], regimeMap: {},
      error: `No per-minute buy/sell volume cached for ${symbol} ${dateFrom}..${dateTo} (tick_volume_1m has no rows in this range). The Order Flow backtest refuses to substitute plain OHLCV volume, since its entire premise is aggressor buy/sell volume — a Databento-trades-schema producer needs to populate tick_volume_1m for this range first.`,
    };
  }

  const volByKey = new Map();
  for (const r of tickVolRows) volByKey.set(`${r.date}|${r.ny_time}`, r);

  // Any minute with no real tick-derived volume is dropped rather than
  // backfilled with zeros/nulls-as-zero — a silent zero would read to the
  // order-flow logic as "no one traded," which is a fabricated signal, not
  // a faithful gap.
  const bars = ohlcvBars
    .filter((b) => b.date >= dateFrom && b.date <= dateTo)
    .map((b) => {
      const v = volByKey.get(`${b.date}|${b.ny_time}`);
      return v ? { ...b, buyVolume: v.buy_volume, sellVolume: v.sell_volume } : null;
    })
    .filter(Boolean);

  return { bars, regimeMap: buildRegimeMap(daily, vix) };
}

// Intraday bars + a prior-day regime map (trend/ADX/ATR-percentile/VIX) for a
// symbol over a date range — the combination every backtest engine in this app
// needs before it can run its own strategy-specific core loop.
export async function loadAllData(symbol, dateFrom, dateTo, params = {}) {
  const fetchFrom = format(addDays(parseISO(dateFrom), -7), 'yyyy-MM-dd');
  const warmupFrom = format(addDays(parseISO(dateFrom), -300), 'yyyy-MM-dd');
  const [bars, daily, vix] = await Promise.all([
    loadIntradayBars(symbol, fetchFrom, dateTo, params.apiKey, params.timeframe),
    loadDaily(symbol, warmupFrom, dateTo),
    loadDaily('^VIX', warmupFrom, dateTo),
  ]);
  return { bars, regimeMap: buildRegimeMap(daily, vix) };
}
