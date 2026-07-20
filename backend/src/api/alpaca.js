import axios from 'axios';
import { getNYDate, getNYHHMM } from './intraday.js';

const DATA_BASE_URL = 'https://data.alpaca.markets';
const PAGE_LIMIT = 10000;

// Historical bars from Alpaca's Market Data API (v2). Free/Basic plan accounts
// only have entitlement to the IEX feed (not full-tape SIP), which is fine for
// backtesting — same OHLCV shape, ~2.5% of consolidated volume but no gaps in
// the bar timeline itself. `timeframe` uses Alpaca's own vocabulary directly:
// '1Min' | '5Min' | '15Min' | '1Hour' | '1Day'.
export async function getAlpacaBars(symbol, from, to, {
  timeframe = '1Min',
  keyId = process.env.APCA_API_KEY_ID,
  secretKey = process.env.APCA_API_SECRET_KEY,
  feed = process.env.APCA_DATA_FEED || 'iex',
} = {}) {
  if (!keyId || !secretKey) {
    throw new Error('Alpaca credentials missing — set APCA_API_KEY_ID / APCA_API_SECRET_KEY in .env.');
  }
  const http = axios.create({
    baseURL: DATA_BASE_URL,
    timeout: 20000,
    headers: { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey },
  });

  const start = `${from}T00:00:00Z`;
  const end = `${to}T23:59:59Z`;
  const raw = [];
  let pageToken;
  do {
    const { data } = await http.get(`/v2/stocks/${symbol}/bars`, {
      params: { timeframe, start, end, limit: PAGE_LIMIT, adjustment: 'raw', feed, page_token: pageToken },
    });
    raw.push(...(data.bars || []));
    pageToken = data.next_page_token || undefined;
  } while (pageToken);

  return raw.map(b => mapAlpacaBar(b, symbol)).sort((a, b) => a.utc_datetime.localeCompare(b.utc_datetime));
}

// NOTE: `utc_datetime` here follows the same (slightly misnamed) convention as
// intraday.js's mapQuote — it's actually an NY-local wall-clock string, used
// purely as the sortable/unique key the rest of the engine expects.
function mapAlpacaBar(b, symbol) {
  const dt = new Date(b.t);
  const nyDate = getNYDate(dt);
  const nyTime = getNYHHMM(dt);
  const h = Math.floor(nyTime / 100), m = nyTime % 100;
  const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  return {
    symbol,
    utc_datetime: nyDate + 'T' + timeStr + ':00',
    date: nyDate,
    ny_time: nyTime,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v || 0,
  };
}
