import { addDays, format, parseISO } from 'date-fns';

const BASE_URL = 'https://api.topstepx.com';
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // JWT valid 24h per docs; refresh a bit early

let cachedToken = null;
let cachedTokenAt = 0;
const cachedContractId = new Map();

// Same symbolId convention as gex-breakout/src/dataSources/topstepx.js
// (confirmed live 2026-07-24: Contract/search is a loose/fuzzy match, not a
// root-symbol filter — filtering on symbolId avoids picking up an unrelated
// instrument that happens to match the search text).
const SYMBOL_ID_MAP = { ES: 'F.US.EP', MES: 'F.US.MES' };

function requireCredentials() {
  const apiKey = process.env.TOPSTEPX_API_KEY;
  const userName = process.env.TOPSTEPX_USERNAME;
  if (!apiKey) throw new Error('TOPSTEPX_API_KEY not set — see backend/.env.example.');
  if (!userName) throw new Error('TOPSTEPX_USERNAME not set — see backend/.env.example.');
  return { apiKey, userName };
}

async function login() {
  const { apiKey, userName } = requireCredentials();
  const res = await fetch(`${BASE_URL}/api/Auth/loginKey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'text/plain' },
    body: JSON.stringify({ userName, apiKey }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(`TopstepX login failed: ${res.status} ${data.errorMessage ?? JSON.stringify(data)}`);
  }
  return data.token;
}

async function getToken() {
  if (cachedToken && Date.now() - cachedTokenAt < TOKEN_TTL_MS) return cachedToken;
  cachedToken = await login();
  cachedTokenAt = Date.now();
  return cachedToken;
}

async function apiPost(path, body) {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'text/plain', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(`TopstepX ${path} -> ${res.status}: ${data.errorMessage ?? JSON.stringify(data)}`);
  }
  return data;
}

async function resolveFrontMonthContractId(symbolText) {
  if (cachedContractId.has(symbolText)) return cachedContractId.get(symbolText);
  const expectedSymbolId = SYMBOL_ID_MAP[symbolText];
  const data = await apiPost('/api/Contract/search', { searchText: symbolText, live: false });
  const matches = (data.contracts ?? []).filter(
    (c) => c.activeContract && (!expectedSymbolId || c.symbolId === expectedSymbolId)
  );
  if (!matches.length) {
    throw new Error(`No active contract found for "${symbolText}" (expected symbolId ${expectedSymbolId ?? 'unknown'})`);
  }
  const contractId = matches[0].id;
  cachedContractId.set(symbolText, contractId);
  return contractId;
}

function nyDateParts(isoTimestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(isoTimestamp));
  const get = (type) => parts.find((p) => p.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, nyTime: Number(get('hour')) * 100 + Number(get('minute')) };
}

// App-level symbol (matches the Yahoo-fetchable ticker used for the daily/ADX/VIX
// regime data — see marketData.js's loadDaily) mapped to TopstepX's own root symbol.
const APP_SYMBOL_TO_TOPSTEPX = { 'ES=F': 'ES', 'MES=F': 'MES' };

// 1-minute OHLCV bars for the current front-month contract, shaped like the old
// Databento-backed parsed bars ({date, ny_time, open, high, low, close, volume})
// so callers/cache tables don't need to change. Replaces Databento as this app's
// only 1m futures source (2026-09-04: TopstepX-only, no third-party data vendor).
//
// Takes an onChunk callback per API call rather than returning one big array —
// same reasoning as the old databento.js: don't hold a huge pull in memory if a
// caller ever requests a wide range. Chunked in 10-day windows to stay well
// under History/retrieveBars' own `limit` (a near-24hr session is ~1440
// bars/day; a 6-day pull was confirmed live 2026-07-30 to return complete and
// untruncated at 5519 bars — 10 days keeps real margin below where truncation
// was never actually tested).
//
// Real limitation, stated plainly: `resolveFrontMonthContractId` only returns
// the CURRENTLY active front-month contract, so a `fetchFrom` far enough back
// that a contract roll happened in between gets whatever price history that
// same contract instance has for that period (thin or absent pre-roll), not a
// true rolled continuous series the way Databento's `.c.0` symbology gave.
// Acceptable for this app's only caller (loadOrderFlowBars in marketData.js)
// — it already refuses to run on any range predating the live tick-volume
// capture, so it never requests genuinely deep history in practice. Re-check
// this assumption before reusing it for a caller that needs multi-year data.
export async function getTopstepXBars(symbol, fetchFrom, dateTo, onChunk) {
  const topstepxSymbol = APP_SYMBOL_TO_TOPSTEPX[symbol] || symbol;
  const contractId = await resolveFrontMonthContractId(topstepxSymbol);

  const now = new Date();
  const end = parseISO(dateTo) > now ? now : parseISO(dateTo);
  let chunkStart = parseISO(fetchFrom);
  let totalBars = 0;
  while (chunkStart <= end) {
    const chunkEndDate = addDays(chunkStart, 10);
    const chunkEnd = chunkEndDate > end ? end : chunkEndDate;
    const data = await apiPost('/api/History/retrieveBars', {
      contractId,
      live: false,
      startTime: `${format(chunkStart, 'yyyy-MM-dd')}T00:00:00Z`,
      endTime: `${format(chunkEnd, 'yyyy-MM-dd')}T23:59:59Z`,
      unit: 2, // Minute
      unitNumber: 1,
      limit: 20000,
      includePartialBar: false,
    });
    // TopstepX returns newest-first (confirmed live, same as gex-breakout's
    // identical fetchHistoricalBars) — sort ascending before parsing.
    const sorted = [...(data.bars ?? [])].sort((a, b) => a.t.localeCompare(b.t));
    const parsed = sorted.map((b) => {
      const { date, nyTime } = nyDateParts(b.t);
      const h = Math.floor(nyTime / 100), m = nyTime % 100;
      const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      return {
        symbol, date, ny_time: nyTime,
        utc_datetime: date + 'T' + timeStr + ':00',
        open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v ?? 0,
      };
    });
    if (parsed.length > 0) await onChunk(parsed);
    totalBars += parsed.length;
    chunkStart = addDays(chunkStart, 10);
  }
  return totalBars;
}
