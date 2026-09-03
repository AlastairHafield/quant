// Durable capture of the live Order Flow Bot's own per-minute aggressor
// buy/sell volume — already computed for every bar via TopstepX's real-time
// GatewayTrade stream (see dataSources/topstepx.js's TradeBarAggregator).
// This is the ONLY source of this data: TopstepX's historical REST API
// (History/retrieveBars) only ever returns one combined volume field, never
// a buy/sell split — that split only exists on the live feed. Posted to the
// backend, which persists it to MongoDB (not its own ephemeral-filesystem
// SQLite cache — see backend/src/data/tickVolumeMongo.js for why), so this
// is the sole way backend/src/engine/orderFlowBacktest.js will ever get real
// data to backtest against.
//
// Deliberately buffer-and-batch rather than one HTTP call per bar: bars
// arrive once a minute, so batching costs nothing in latency and means a
// transient backend hiccup doesn't drop data — unsent rows just accumulate
// and go out on the next flush. MAX_BUFFERED caps memory if the backend is
// down for an extended stretch; it's generous (see below), not a real limit
// this is expected to hit.

const MAX_BUFFERED = 2000; // ~33 hours at one bar/minute — far more slack than any realistic backend outage

// TopstepX's own instrument symbol (CONFIG.instrumentData, e.g. "ES"/"MES")
// vs. the app-level symbol key everything else in this codebase stores
// historical bars under (marketData.js's DATABENTO_CONTINUOUS_SYMBOL uses
// the same "ES=F"/"MES=F" convention) — this capture has to write under the
// SAME key the backtest will later read under, or the join in
// loadOrderFlowBars silently finds nothing.
const APP_LEVEL_SYMBOL = { ES: 'ES=F', MES: 'MES=F' };

export function appLevelSymbolFor(topstepxSymbol) {
  return APP_LEVEL_SYMBOL[topstepxSymbol] ?? topstepxSymbol;
}

export function createTickVolumeBuffer() {
  return { rows: [] };
}

// t is a nowET()-style Date (see worker.js) — its local getters already
// reflect ET wall-clock time, same convention checks.js's timeCheck relies
// on, so no timezone conversion is needed here either.
export function etDateAndTime(t) {
  const date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  const ny_time = t.getHours() * 100 + t.getMinutes();
  return { date, ny_time };
}

export function bufferTickVolumeBar(buffer, t, { buyVolume, sellVolume }) {
  const { date, ny_time } = etDateAndTime(t);
  buffer.rows.push({ date, ny_time, buy_volume: buyVolume, sell_volume: sellVolume });
  if (buffer.rows.length > MAX_BUFFERED) buffer.rows.splice(0, buffer.rows.length - MAX_BUFFERED);
}

// Snapshots exactly what's buffered right now before the network call, so a
// bar appended mid-flight (onBar can fire again while this await is
// pending) is neither lost nor double-counted — it's simply left in the
// buffer for the next flush. This DOES rely on the request actually
// finishing promptly: the success path below removes the first `sentCount`
// rows unconditionally, and bufferTickVolumeBar's own MAX_BUFFERED trim also
// splices from the front — if a request were somehow left hanging for as
// long as it'd take to buffer past MAX_BUFFERED (~33hrs at one bar/minute),
// those two front-splices could remove the wrong rows. The FETCH_TIMEOUT_MS
// bound below exists specifically to make that precondition impossible, not
// to handle a slow-but-eventually-successful backend gracefully (a timeout
// here is just a failed flush, retried next interval like any other).
const FETCH_TIMEOUT_MS = 15_000;

export async function flushTickVolume(buffer, symbol, backendUrl, secret, fetchImpl = fetch) {
  const sentCount = buffer.rows.length;
  if (!sentCount) return;
  const rowsToSend = buffer.rows.slice(0, sentCount);
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Status-Secret'] = secret;
  try {
    const res = await fetchImpl(`${backendUrl}/api/order-flow/tick-volume`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ symbol: appLevelSymbolFor(symbol), rows: rowsToSend }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Tick-volume push failed: ${res.status} ${await res.text()}`);
      return; // left in the buffer — retried on the next interval
    }
    buffer.rows.splice(0, sentCount);
  } catch (e) {
    console.error('Tick-volume push failed:', e.message);
  }
}

export function startTickVolumeReporter(buffer, symbol, { backendUrl, secret, intervalMs = 30_000 }) {
  return setInterval(() => flushTickVolume(buffer, symbol, backendUrl, secret), intervalMs);
}
