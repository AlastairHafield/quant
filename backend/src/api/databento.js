import axios from 'axios';
import { addMonths, format, parseISO, subDays } from 'date-fns';
import { getNYDate, getNYHHMM } from './intraday.js';

const BASE_URL = 'https://hist.databento.com/v0';

// Historical 1-minute OHLCV bars from Databento (GLBX.MDP3 = CME Globex),
// covering the full near-24hr futures session — unlike FMP (RTH-only) or
// Alpaca (equities, no real pre-market liquidity before ~8am ET), this is the
// only source with genuine price movement outside NY trading hours. Default
// symbol is the continuous front-month contract (Databento's `.c.0` roll
// convention); prices come back fixed-point scaled by 1e9 per their spec.
//
// Takes an onChunk callback invoked with each month's parsed bars as they
// arrive, rather than accumulating the whole multi-year pull into one array
// and returning it at the end — a 16yr 1-minute ES pull is ~5.8M bar objects,
// which blew the default V8 heap (confirmed live: crashed with "JavaScript
// heap out of memory" after successfully fetching every single month, having
// saved nothing yet since the caller's upsert only ran on the final return
// value). The caller should persist each chunk immediately so progress
// survives a crash/interruption instead of being all-or-nothing.
export async function getDatabentoBars(symbol, from, to, onChunk, {
  apiKey = process.env.DATABENTO_API_KEY,
  dataset = 'GLBX.MDP3',
  schema = 'ohlcv-1m',
  stype = 'continuous',
} = {}) {
  if (!apiKey) {
    throw new Error('Databento credentials missing — set DATABENTO_API_KEY in .env.');
  }
  const http = axios.create({
    baseURL: BASE_URL,
    timeout: 120000,
    auth: { username: apiKey, password: '' },
  });

  // Databento rejects a `start`/`end` outside the dataset's actual available
  // range (422 data_start_before_available_start / data_end_after_available_end)
  // — GLBX.MDP3 only goes back to 2010-06-06, and "today" is never fully
  // written yet. Query the real bounds once rather than guessing/hardcoding a
  // date, then clamp the request to whichever is narrower.
  const { data: rangeData } = await http.get('/metadata.get_dataset_range', { params: { dataset } });
  const availableStart = parseISO(rangeData.start.slice(0, 10));
  const yesterday = subDays(new Date(), 1);
  const availableEnd = parseISO(rangeData.end.slice(0, 10)) > yesterday ? yesterday : parseISO(rangeData.end.slice(0, 10));

  const requestedStart = parseISO(from);
  let chunkStart = requestedStart < availableStart ? availableStart : requestedStart;
  const requestedEnd = parseISO(to);
  const end = requestedEnd > availableEnd ? availableEnd : requestedEnd;
  // Chunk by month — a 10yr+ 1-minute pull in one request risks a very large
  // single response; monthly chunks keep each request bounded and retriable,
  // same spirit as intraday.js's chunked Yahoo 15m fetch.
  let totalBars = 0;
  while (chunkStart <= end) {
    const chunkEnd = addMonths(chunkStart, 1) > end ? end : addMonths(chunkStart, 1);
    const { data } = await http.get('/timeseries.get_range', {
      params: {
        dataset,
        symbols: symbol,
        schema,
        stype_in: stype,
        start: `${format(chunkStart, 'yyyy-MM-dd')}T00:00:00Z`,
        end: `${format(chunkEnd, 'yyyy-MM-dd')}T23:59:59Z`,
        encoding: 'csv',
      },
      responseType: 'text',
    });
    const parsed = parseCsv(data, symbol);
    if (parsed.length > 0) await onChunk(parsed);
    console.log(`  Databento ${format(chunkStart, 'yyyy-MM')}: ${parsed.length} bars`);
    totalBars += parsed.length;
    chunkStart = addMonths(chunkStart, 1);
  }

  return totalBars;
}

function parseCsv(csvText, symbol) {
  const lines = csvText.trim().split('\n');
  if (lines.length <= 1) return [];
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const [tsEvent, , , , open, high, low, close, volume] = cols;
    if (!tsEvent) continue;
    const ms = Number(BigInt(tsEvent) / 1_000_000n);
    const dt = new Date(ms);
    const nyDate = getNYDate(dt);
    const nyTime = getNYHHMM(dt);
    const h = Math.floor(nyTime / 100), m = nyTime % 100;
    const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    bars.push({
      symbol,
      utc_datetime: nyDate + 'T' + timeStr + ':00',
      date: nyDate,
      ny_time: nyTime,
      open: Number(open) / 1e9,
      high: Number(high) / 1e9,
      low: Number(low) / 1e9,
      close: Number(close) / 1e9,
      volume: Number(volume) || 0,
    });
  }
  return bars;
}
