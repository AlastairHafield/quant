import { getHistoricalOHLCV } from '../api/prices.js';
import { getEarningsEvents, getPrices, upsertPrices, saveBacktestRun, saveBacktestTrades } from '../data/db.js';
import { addDays, format, parseISO } from 'date-fns';

const HOLD_DAYS = 60;
const CAPITAL = 100_000;
const POSITION_PCT = 0.10;

export async function runBacktest(symbols, dateFrom, dateTo, apiKey, params = {}) {
  const holdDays = params.holdDays || HOLD_DAYS;
  const positionPct = params.positionPct || POSITION_PCT;

  console.log(`Running backtest: ${symbols.length} stocks, ${dateFrom} to ${dateTo}`);

  const events = getEarningsEvents(symbols, dateFrom, dateTo);
  console.log(`Found ${events.length} concordant signals`);

  if (events.length === 0) {
    return { error: 'No concordant signals found in date range. Run data load first.' };
  }

  const trades = [];

  for (const event of events) {
    const entryDate = event.reaction_day;
    const entryPrice = event.reaction_open;
    if (!entryDate || !entryPrice) continue;

    const exitDate = await getExitDate(event.symbol, entryDate, holdDays);
    if (!exitDate) continue;

    const exitPrice = await getExitPrice(event.symbol, exitDate);
    if (!exitPrice) continue;

    let returnPct;
    if (event.signal === 'LONG') {
      returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    } else {
      returnPct = ((entryPrice - exitPrice) / entryPrice) * 100;
    }

    const positionSize = CAPITAL * positionPct;
    const pnlDollars = positionSize * (returnPct / 100);

    trades.push({
      symbol: event.symbol,
      signal: event.signal,
      entry_date: entryDate,
      entry_price: entryPrice,
      exit_date: exitDate,
      exit_price: exitPrice,
      hold_days: holdDays,
      return_pct: returnPct,
      pnl_dollars: pnlDollars,
      earnings_event_id: event.id,
    });
  }

  if (trades.length === 0) {
    return { error: 'No complete trades (missing price data for exits). Check data load.' };
  }

  const metrics = calculateMetrics(trades, holdDays);

  const runId = saveBacktestRun({
    date_from: dateFrom,
    date_to: dateTo,
    universe_size: symbols.length,
    total_trades: trades.length,
    win_rate: metrics.winRate,
    total_return_pct: metrics.totalReturnPct,
    avg_trade_return_pct: metrics.avgTradeReturnPct,
    sharpe: metrics.sharpe,
    max_drawdown_pct: metrics.maxDrawdownPct,
    params: JSON.stringify({ holdDays, positionPct }),
  });

  const tradesWithRunId = trades.map(t => ({ ...t, run_id: runId }));
  saveBacktestTrades(tradesWithRunId);

  return {
    runId,
    metrics,
    trades: tradesWithRunId,
    equityCurve: buildEquityCurve(trades),
  };
}

function calculateMetrics(trades, holdDays = HOLD_DAYS) {
  const returns = trades.map(t => t.return_pct);
  const wins = returns.filter(r => r > 0);
  const winRate = (wins.length / returns.length) * 100;
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const totalPnl = trades.reduce((a, t) => a + t.pnl_dollars, 0);
  const totalReturnPct = (totalPnl / CAPITAL) * 100;
  const std = standardDeviation(returns);
  const sharpe = std > 0 ? (avgReturn / std) * Math.sqrt(252 / holdDays) : 0;
  const curve = buildEquityCurve(trades);
  const maxDrawdownPct = calcMaxDrawdown(curve);

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: returns.length - wins.length,
    winRate: round(winRate),
    avgTradeReturnPct: round(avgReturn),
    totalReturnPct: round(totalReturnPct),
    totalPnlDollars: round(totalPnl),
    sharpe: round(sharpe),
    maxDrawdownPct: round(maxDrawdownPct),
    bestTrade: round(Math.max(...returns)),
    worstTrade: round(Math.min(...returns)),
  };
}

function buildEquityCurve(trades) {
  const sorted = [...trades].sort((a, b) => a.entry_date.localeCompare(b.entry_date));
  let equity = CAPITAL;
  const curve = [{ date: sorted[0]?.entry_date || '', equity: CAPITAL }];
  for (const t of sorted) {
    equity += t.pnl_dollars;
    curve.push({ date: t.exit_date, equity: round(equity) });
  }
  return curve;
}

function calcMaxDrawdown(curve) {
  let peak = -Infinity;
  let maxDD = 0;
  for (const point of curve) {
    if (point.equity > peak) peak = point.equity;
    const dd = ((peak - point.equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

async function getExitDate(symbol, entryDate, holdDays) {
  const approxExitDate = format(addDays(parseISO(entryDate), Math.ceil(holdDays * 1.4)), 'yyyy-MM-dd');
  const priceTo = format(addDays(parseISO(approxExitDate), 5), 'yyyy-MM-dd');

  let prices = getPrices(symbol, entryDate, priceTo);
  let afterEntry = prices.filter(p => p.date > entryDate);

  if (afterEntry.length < holdDays) {
    const rows = await getHistoricalOHLCV(symbol, entryDate, priceTo);
    if (rows.length > 0) {
      upsertPrices(rows);
      prices = getPrices(symbol, entryDate, priceTo);
      afterEntry = prices.filter(p => p.date > entryDate);
    }
  }

  if (afterEntry.length < holdDays) return null;
  return afterEntry[holdDays - 1].date;
}

async function getExitPrice(symbol, exitDate) {
  const prices = getPrices(symbol, exitDate, exitDate);
  if (prices.length > 0) return prices[0].close;

  const rows = await getHistoricalOHLCV(symbol, exitDate, exitDate);
  if (rows.length > 0) {
    upsertPrices(rows);
    return rows[0].close;
  }
  return null;
}

function standardDeviation(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function round(n) {
  return Math.round(n * 100) / 100;
}
