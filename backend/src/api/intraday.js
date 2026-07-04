import YahooFinance from 'yahoo-finance2';
import axios from 'axios';
import { format, addDays, subDays, parseISO } from 'date-fns';

const yf = new YahooFinance({ suppressNotices: ['ripHistorical'] });

export async function get15mBars(symbol, from, to, _apiKey, timeframe = '1h') {
  if (timeframe === '15m') {
    return fetch15mChunked(symbol, from, to);
  }
  if (timeframe === '5m') {
    return fetch5m(symbol, from, to);
  }
  try {
    const result = await yf.chart(symbol, {
      period1: from,
      period2: format(addDays(parseISO(to), 1), 'yyyy-MM-dd'),
      interval: '1h',
    }, { validateResult: false });

    const quotes = (result?.quotes || []).filter(q => q.open != null && q.close != null);
    if (quotes.length === 0) return [];
    return quotes.map(q => mapQuote(q, symbol)).sort((a, b) => a.utc_datetime.localeCompare(b.utc_datetime));
  } catch (e) {
    console.warn(`Yahoo 1h fetch failed for ${symbol}: ${e.message}`);
    return [];
  }
}

async function fetch15mChunked(symbol, from, to) {
  const allBars = [];
  // Yahoo now only serves 15m bars for the last ~60 days — clamp so chunks don't get rejected.
  const earliest = subDays(new Date(), 59);
  let startDate = parseISO(from);
  if (startDate < earliest) startDate = earliest;
  let chunkEnd = addDays(parseISO(to), 1);

  while (chunkEnd > startDate) {
    let chunkStart = subDays(chunkEnd, 58);
    if (chunkStart < startDate) chunkStart = startDate;

    try {
      const result = await yf.chart(symbol, {
        period1: format(chunkStart, 'yyyy-MM-dd'),
        period2: format(chunkEnd,  'yyyy-MM-dd'),
        interval: '15m',
      }, { validateResult: false });

      const quotes = (result?.quotes || []).filter(q => q.open != null && q.close != null);
      allBars.push(...quotes.map(q => mapQuote(q, symbol)));
      console.log(`  15m chunk ${format(chunkStart, 'yyyy-MM-dd')} → ${format(chunkEnd, 'yyyy-MM-dd')}: ${quotes.length} bars`);
    } catch (e) {
      console.warn(`Yahoo 15m chunk failed for ${symbol} (${format(chunkStart, 'yyyy-MM-dd')} → ${format(chunkEnd, 'yyyy-MM-dd')}): ${e.message}`);
    }

    chunkEnd = subDays(chunkStart, 1);
  }

  const seen = new Set();
  return allBars
    .filter(b => { if (seen.has(b.utc_datetime)) return false; seen.add(b.utc_datetime); return true; })
    .sort((a, b) => a.utc_datetime.localeCompare(b.utc_datetime));
}

// Yahoo only serves 5m bars for roughly the last 60 days — single fetch, clamped.
async function fetch5m(symbol, from, to) {
  const earliest = subDays(new Date(), 59);
  let start = parseISO(from);
  if (start < earliest) start = earliest;

  try {
    const result = await yf.chart(symbol, {
      period1: format(start, 'yyyy-MM-dd'),
      period2: format(addDays(parseISO(to), 1), 'yyyy-MM-dd'),
      interval: '5m',
    }, { validateResult: false });

    const quotes = (result?.quotes || []).filter(q => q.open != null && q.close != null);
    if (quotes.length === 0) return [];
    return quotes.map(q => mapQuote(q, symbol)).sort((a, b) => a.utc_datetime.localeCompare(b.utc_datetime));
  } catch (e) {
    console.warn(`Yahoo 5m fetch failed for ${symbol}: ${e.message}`);
    return [];
  }
}

function mapQuote(q, symbol) {
  const dt = typeof q.date === 'number' ? new Date(q.date * 1000) : new Date(q.date);
  const nyDate = getNYDate(dt);
  const nyTime = getNYHHMM(dt);
  const h = Math.floor(nyTime / 100), m = nyTime % 100;
  const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  return {
    symbol,
    utc_datetime: nyDate + 'T' + timeStr + ':00',
    date: nyDate,
    ny_time: nyTime,
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
    volume: q.volume || 0,
  };
}

function getNYDate(dt) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(dt);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function getNYHHMM(dt) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(dt);
  const h = parseInt(parts.find(p => p.type === 'hour').value);
  const min = parseInt(parts.find(p => p.type === 'minute').value);
  return h * 100 + min;
}
