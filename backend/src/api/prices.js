import YahooFinance from 'yahoo-finance2';
import { format, addDays, parseISO } from 'date-fns';

const yf = new YahooFinance({ suppressNotices: ['ripHistorical'] });
const YF_OPTS = { validateResult: false };

export async function getHistoricalOHLCV(symbol, from, to, retriesLeft = 1) {
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
    // A caller (e.g. orbBacktest's regime map) silently treats an empty result
    // as "no daily data available" and skips any filter that depends on it —
    // a transient network blip here doesn't surface as an error, it just
    // quietly disables regime/ADX filtering for the whole run. One retry
    // catches the transient case (confirmed live: back-to-back identical
    // requests failed then succeeded) before giving up for real.
    if (retriesLeft > 0) {
      console.warn(`Yahoo Finance price fetch failed for ${symbol} (${from}→${to}): ${e.message} — retrying once`);
      return getHistoricalOHLCV(symbol, from, to, retriesLeft - 1);
    }
    console.warn(`Yahoo Finance price fetch failed for ${symbol} (${from}→${to}): ${e.message}`);
    return [];
  }
}
