import { addDays, parseISO, format, isWeekend } from 'date-fns';
import { get15mBars } from '../api/intraday.js';
import { getIntraday15m, upsertIntraday15m, getBars15m, upsertBars15m, saveSDRun, saveSDTrades } from '../data/db.js';

const CAPITAL = 100_000;

export async function runSDBacktest(symbol, dateFrom, dateTo, params = {}) {
  const {
    div = 50,
    thresholdPct = 10,
    stopBuffer = 0.04,
    positionPct = 0.10,
    rrRatio = 1.5,
    sessionStart = 930,
    sessionEnd = 1100,
    direction = 'BOTH',
    timeframe = '1h',
    apiKey = null,
  } = params;

  console.log(`S&D Backtest: ${symbol} ${dateFrom} → ${dateTo}`);

  // Fetch one extra day before dateFrom to have prior-day zones on day 1
  const fetchFrom = getPrevTradingDay(dateFrom);

  let bars;
  if (timeframe === '15m') {
    bars = getBars15m(symbol, fetchFrom, dateTo);
    const cachedMin = bars[0]?.date;
    const cachedMax = bars[bars.length - 1]?.date;
    const cacheStale = bars.length === 0 || cachedMin > fetchFrom || cachedMax < dateTo;
    if (cacheStale) {
      console.log(`Fetching 15m data for ${symbol} (${fetchFrom} to ${dateTo}) in 58-day chunks...`);
      const fresh = await get15mBars(symbol, fetchFrom, dateTo, apiKey, '15m');
      if (fresh.length > 0) {
        upsertBars15m(fresh);
        bars = getBars15m(symbol, fetchFrom, dateTo);
      }
    }
  } else {
    bars = getIntraday15m(symbol, fetchFrom, dateTo);
    const cachedMin = bars[0]?.date;
    const cachedMax = bars[bars.length - 1]?.date;
    const cacheStale = bars.length === 0 || cachedMin > fetchFrom || cachedMax < dateTo;
    if (cacheStale) {
      console.log(`Fetching 1h data for ${symbol} (${fetchFrom} to ${dateTo})...`);
      const fresh = await get15mBars(symbol, fetchFrom, dateTo, apiKey, '1h');
      if (fresh.length > 0) {
        upsertIntraday15m(fresh);
        bars = getIntraday15m(symbol, fetchFrom, dateTo);
      }
    }
  }

  if (bars.length === 0) {
    return { error: `No ${timeframe} data available for ${symbol}. Try a date range within the last 2 years.` };
  }

  console.log(`Processing ${bars.length} ${timeframe} bars for ${symbol}`);

  // Group bars by NY date
  const byDate = {};
  for (const bar of bars) {
    if (!byDate[bar.date]) byDate[bar.date] = [];
    byDate[bar.date].push(bar);
  }
  // Each day's bars must be sorted chronologically
  for (const d of Object.keys(byDate)) {
    byDate[d].sort((a, b) => a.utc_datetime.localeCompare(b.utc_datetime));
  }

  const sortedDates = Object.keys(byDate).sort();
  const trades = [];

  for (let i = 1; i < sortedDates.length; i++) {
    const today = sortedDates[i];
    const yesterday = sortedDates[i - 1];

    if (today < dateFrom || today > dateTo) continue;

    const prevBars = byDate[yesterday];
    const todayBars = byDate[today];

    if (!prevBars || prevBars.length === 0) continue;

    // Calculate supply & demand zones from prior day's 1h bars
    const zones = calculateZones(prevBars, { div, thresholdPct });
    if (!zones.supZone && !zones.demZone) continue;

    // Session bars: configurable NY time window
    const sessionBars = todayBars.filter(b => b.ny_time >= sessionStart && b.ny_time < sessionEnd);
    if (sessionBars.length === 0) continue;

    // Session high/low starts from first session bar (9:30)
    let sessionHigh = sessionBars[0].high;
    let sessionLow  = sessionBars[0].low;
    let traded = false;

    for (let m = 0; m < sessionBars.length; m++) {
      if (traded) break;

      const bar = sessionBars[m];
      sessionHigh = Math.max(sessionHigh, bar.high);
      sessionLow = Math.min(sessionLow, bar.low);

      const activeZones = [
        zones.supZone ? { ...zones.supZone } : null,
        zones.demZone ? { ...zones.demZone } : null,
      ].filter(Boolean);

      for (const zone of activeZones) {
        if (traded) break;

        const { top, bottom } = zone;
        const touching = bar.low <= top && bar.high >= bottom;
        if (!touching) continue;

        // Approach: look at 1–2 prior 15m bars in this session
        const prev1 = m >= 1 ? sessionBars[m - 1] : null;
        const prev2 = m >= 2 ? sessionBars[m - 2] : null;

        const fromAbove = (prev1 && prev1.low > top) || (prev2 && prev2.low > top);
        const fromBelow = (prev1 && prev1.high < bottom) || (prev2 && prev2.high < bottom);

        if ((direction === 'BOTH' || direction === 'LONG') && fromAbove && !fromBelow) {
          const entryPrice = bar.close;
          const stop = bar.low - stopBuffer;
          const risk = entryPrice - stop;
          if (risk <= 0) continue;

          const target = entryPrice + risk * rrRatio;

          const barIndex = todayBars.indexOf(bar);
          const barsAfter = todayBars.slice(barIndex + 1);
          const exit = simulateExit(barsAfter, entryPrice, target, stop, 'LONG');

          const exitPrice = exit ? exit.price : bar.close;
          const exitResult = exit ? exit.result : 'EOD';
          const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
          const pnlDollars = CAPITAL * positionPct * (returnPct / 100);

          trades.push({
            trade_date: today,
            signal: 'LONG',
            zone_top: round(top),
            zone_bottom: round(bottom),
            session_ref: round(sessionHigh),
            entry_price: round(entryPrice),
            target_price: round(target),
            stop_price: round(stop),
            exit_price: round(exitPrice),
            exit_result: exitResult,
            return_pct: round(returnPct),
            rr_ratio: round(rrRatio),
            pnl_dollars: round(pnlDollars),
          });
          traded = true;
        }

        if ((direction === 'BOTH' || direction === 'SHORT') && fromBelow && !fromAbove && !traded) {
          const entryPrice = bar.close;
          const stop = bar.high + stopBuffer;
          const risk = stop - entryPrice;
          if (risk <= 0) continue;

          const target = entryPrice - risk * rrRatio;

          const barIndex = todayBars.indexOf(bar);
          const barsAfter = todayBars.slice(barIndex + 1);
          const exit = simulateExit(barsAfter, entryPrice, target, stop, 'SHORT');

          const exitPrice = exit ? exit.price : bar.close;
          const exitResult = exit ? exit.result : 'EOD';
          const returnPct = ((entryPrice - exitPrice) / entryPrice) * 100;
          const pnlDollars = CAPITAL * positionPct * (returnPct / 100);

          trades.push({
            trade_date: today,
            signal: 'SHORT',
            zone_top: round(top),
            zone_bottom: round(bottom),
            session_ref: round(sessionLow),
            entry_price: round(entryPrice),
            target_price: round(target),
            stop_price: round(stop),
            exit_price: round(exitPrice),
            exit_result: exitResult,
            return_pct: round(returnPct),
            rr_ratio: round(rrRatio),
            pnl_dollars: round(pnlDollars),
          });
          traded = true;
        }
      }
    }
  }

  if (trades.length === 0) {
    return { error: 'No trades generated. Zones may not have been touched during 9:45–11am on any day in the range. Try adjusting the Threshold % parameter.' };
  }

  const metrics = calculateMetrics(trades);

  const runId = saveSDRun({
    symbol,
    date_from: dateFrom,
    date_to: dateTo,
    total_trades: trades.length,
    win_rate: metrics.winRate,
    total_return_pct: metrics.totalReturnPct,
    avg_trade_return_pct: metrics.avgTradeReturnPct,
    sharpe: metrics.sharpe,
    max_drawdown_pct: metrics.maxDrawdownPct,
    params: JSON.stringify({ div, thresholdPct, stopBuffer, positionPct, rrRatio, sessionStart, sessionEnd, direction, timeframe }),
  });

  const tradesWithId = trades.map(t => ({ ...t, run_id: runId }));
  saveSDTrades(tradesWithId);

  return { runId, metrics };
}

// ─── Zone calculation (translated from Pine Script) ──────────────────────────

function calculateZones(bars, { div = 50, thresholdPct = 10 } = {}) {
  const dayHigh = Math.max(...bars.map(b => b.high));
  const dayLow  = Math.min(...bars.map(b => b.low));
  const dayVol  = bars.reduce((sum, b) => sum + b.volume, 0);

  if (dayVol === 0 || dayHigh === dayLow) return { supZone: null, demZone: null };

  const r = (dayHigh - dayLow) / div;

  let supLvl = dayHigh, supPrev = dayHigh, supSum = 0, supZone = null;
  let demLvl = dayLow,  demPrev = dayLow,  demSum = 0, demZone = null;

  for (let i = 0; i < div; i++) {
    supLvl -= r;
    demLvl += r;

    for (const bar of bars) {
      if (bar.high > supLvl && bar.high < supPrev) supSum += bar.volume;
      if (bar.low  < demLvl && bar.low  > demPrev) demSum += bar.volume;
    }

    if (!supZone && (supSum / dayVol * 100) > thresholdPct) {
      supZone = { top: dayHigh, bottom: supLvl };
    }
    if (!demZone && (demSum / dayVol * 100) > thresholdPct) {
      demZone = { top: demLvl, bottom: dayLow };
    }
    if (supZone && demZone) break;

    supPrev = supLvl;
    demPrev = demLvl;
  }

  return { supZone, demZone };
}

// ─── Exit simulation ─────────────────────────────────────────────────────────

function simulateExit(bars, entryPrice, target, stop, direction) {
  for (const bar of bars) {
    if (direction === 'LONG') {
      if (bar.low  <= stop)   return { price: stop,   date: bar.date, result: 'STOP'   };
      if (bar.high >= target) return { price: target, date: bar.date, result: 'TARGET' };
    } else {
      if (bar.high >= stop)  return { price: stop,   date: bar.date, result: 'STOP'   };
      if (bar.low  <= target) return { price: target, date: bar.date, result: 'TARGET' };
    }
  }
  const last = bars[bars.length - 1];
  if (last) return { price: last.close, date: last.date, result: 'EOD' };
  return null;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

function calculateMetrics(trades) {
  const returns = trades.map(t => t.return_pct);
  const wins = returns.filter(r => r > 0);
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl_dollars, 0);
  const winRate = (wins.length / returns.length) * 100;
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const totalReturnPct = (totalPnl / CAPITAL) * 100;
  const std = stdDev(returns);
  const sharpe = std > 0 ? (avgReturn / std) * Math.sqrt(252) : 0;

  let equity = CAPITAL, peak = CAPITAL, maxDD = 0;
  for (const t of [...trades].sort((a, b) => a.trade_date.localeCompare(b.trade_date))) {
    equity += t.pnl_dollars;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const targetHits = trades.filter(t => t.exit_result === 'TARGET').length;
  const stopHits   = trades.filter(t => t.exit_result === 'STOP').length;
  const eodExits   = trades.filter(t => t.exit_result === 'EOD').length;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: returns.length - wins.length,
    winRate: round(winRate),
    avgTradeReturnPct: round(avgReturn),
    totalReturnPct: round(totalReturnPct),
    totalPnlDollars: round(totalPnl),
    sharpe: round(sharpe),
    maxDrawdownPct: round(maxDD),
    targetHits,
    stopHits,
    eodExits,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPrevTradingDay(dateStr) {
  let d = addDays(parseISO(dateStr), -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return format(d, 'yyyy-MM-dd');
}

function stdDev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}
