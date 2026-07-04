import YahooFinance from 'yahoo-finance2';
import { format, addDays, parseISO } from 'date-fns';

const yf = new YahooFinance({ suppressNotices: ['ripHistorical'] });
const YF_OPTS = { validateResult: false };

export async function getHistoricalOHLCV(symbol, from, to) {
  try {
    // Yahoo period2 is exclusive — add 1 day to include the to date
    const period2 = format(addDays(parseISO(to), 1), 'yyyy-MM-dd');

    const quotes = await yf.historical(
      symbol,
      { period1: from, period2, interval: '1d' },
      YF_OPTS
    );

    return quotes
      .filter(q => q.open != null && q.close != null)
      .map(q => ({
        symbol,
        date: format(q.date, 'yyyy-MM-dd'),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume || 0,
      }));
  } catch (e) {
    console.warn(`Yahoo Finance price fetch failed for ${symbol} (${from}→${to}): ${e.message}`);
    return [];
  }
}
