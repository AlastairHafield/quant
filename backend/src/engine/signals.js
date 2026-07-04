import FMPClient from '../api/fmp.js';
import { getHistoricalOHLCV } from '../api/prices.js';
import { upsertEarningsEvent, upsertPrices, getPrices } from '../data/db.js';
import { addDays, format, parseISO, isWeekend } from 'date-fns';

const MIN_SURPRISE_PCT = 1.0;
const MIN_REACTION_PCT = 0.5;

export async function loadEarningsAndSignals(symbols, dateFrom, dateTo, apiKey) {
  const fmp = new FMPClient(apiKey);
  const results = [];

  for (const symbol of symbols) {
    try {
      console.log(`Processing earnings for ${symbol}...`);

      const earnings = await fmp.getEarningsHistory(symbol, 40);
      if (!earnings || earnings.length === 0) continue;

      // Filter to date range — new API uses epsActual instead of eps
      const inRange = earnings.filter(e => {
        if (!e.date || e.epsActual == null || e.epsEstimated == null) return false;
        return e.date >= dateFrom && e.date <= dateTo;
      });

      for (const e of inRange) {
        const event = await processEarningsEvent(e, symbol);
        if (event) {
          upsertEarningsEvent(event);
          results.push(event);
        }
      }

      await sleep(300);
    } catch (err) {
      console.warn(`Error processing ${symbol}: ${err.message}`);
    }
  }

  return results;
}

async function processEarningsEvent(e, symbol) {
  const reportDate = e.date;
  const actualEPS = e.epsActual;
  const estimatedEPS = e.epsEstimated;

  if (actualEPS == null || estimatedEPS == null || estimatedEPS === 0) return null;

  const surprisePct = ((actualEPS - estimatedEPS) / Math.abs(estimatedEPS)) * 100;

  // FMP stable API doesn't include time-of-day — default BMO
  // AMC detection would need a separate earnings calendar lookup
  const timeOfDay = 'BMO';
  const reactionDay = getNextTradingDay(reportDate, timeOfDay);

  const priceFrom = format(addDays(parseISO(reportDate), -3), 'yyyy-MM-dd');
  const priceTo = format(addDays(parseISO(reactionDay), 1), 'yyyy-MM-dd');

  let prices = getPrices(symbol, priceFrom, priceTo);

  if (prices.length === 0) {
    const rows = await getHistoricalOHLCV(symbol, priceFrom, priceTo);
    if (rows.length > 0) {
      upsertPrices(rows);
      prices = getPrices(symbol, priceFrom, priceTo);
    }
  }

  const reactionDayData = prices.find(p => p.date === reactionDay);
  const prevClose = getPrevClose(prices, reactionDay);

  if (!reactionDayData || !prevClose) return null;

  const reactionPct = ((reactionDayData.open - prevClose) / prevClose) * 100;

  const surprisePositive = surprisePct >= MIN_SURPRISE_PCT;
  const surpriseNegative = surprisePct <= -MIN_SURPRISE_PCT;
  const reactionPositive = reactionPct >= MIN_REACTION_PCT;
  const reactionNegative = reactionPct <= -MIN_REACTION_PCT;

  let signal = 'NO_TRADE';
  let concordant = 0;

  if (surprisePositive && reactionPositive) {
    signal = 'LONG';
    concordant = 1;
  } else if (surpriseNegative && reactionNegative) {
    signal = 'SHORT';
    concordant = 1;
  }

  return {
    symbol,
    report_date: reportDate,
    fiscal_period: e.fiscalDateEnding || null,
    actual_eps: actualEPS,
    estimated_eps: estimatedEPS,
    surprise_pct: surprisePct,
    time_of_day: timeOfDay,
    reaction_day: reactionDay,
    reaction_open: reactionDayData.open,
    reaction_prev_close: prevClose,
    reaction_pct: reactionPct,
    signal,
    concordant,
  };
}

function getNextTradingDay(dateStr, timeOfDay) {
  let d = parseISO(dateStr);
  if (timeOfDay === 'AMC') {
    d = addDays(d, 1);
  }
  while (isWeekend(d)) {
    d = addDays(d, 1);
  }
  return format(d, 'yyyy-MM-dd');
}

function getPrevClose(prices, reactionDay) {
  const sorted = prices
    .filter(p => p.date < reactionDay)
    .sort((a, b) => b.date.localeCompare(a.date));
  return sorted.length > 0 ? sorted[0].close : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
