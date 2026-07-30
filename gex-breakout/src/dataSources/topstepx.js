const BASE_URL = "https://api.topstepx.com";
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // docs state JWT valid 24h; refresh a bit early

let cachedToken = null;
let cachedTokenAt = 0;
const cachedContractId = new Map();

function requireCredentials() {
  const apiKey = process.env.TOPSTEPX_API_KEY;
  const userName = process.env.TOPSTEPX_USERNAME;
  if (!apiKey) throw new Error("TOPSTEPX_API_KEY not set — see gex-breakout/.env.example");
  if (!userName) throw new Error("TOPSTEPX_USERNAME not set — see gex-breakout/.env.example");
  return { apiKey, userName };
}

// Confirmed against ProjectX Gateway docs (gateway.docs.projectx.com) on 2026-07-24 —
// not yet tested against a live account (no TOPSTEPX_USERNAME provided). The
// Authorization header format below (Bearer <token>) is the standard JWT convention
// but is NOT explicitly confirmed by the docs — verify on the first real call.
async function login() {
  const { apiKey, userName } = requireCredentials();
  const res = await fetch(`${BASE_URL}/api/Auth/loginKey`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "text/plain" },
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
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      accept: "text/plain",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(`TopstepX ${path} -> ${res.status}: ${data.errorMessage ?? JSON.stringify(data)}`);
  }
  return data;
}

export async function searchContracts(searchText, live = false) {
  const data = await apiPost("/api/Contract/search", { searchText, live });
  return data.contracts;
}

// Confirmed live 2026-07-24: Contract/search("ES") is a loose/fuzzy match, not a
// root-symbol filter — it also returned Treasury notes, Japanese Yen, Mexican Peso,
// and MES contracts. Must filter on the confirmed symbolId, not just take the first
// active result.
const SYMBOL_ID_MAP = {
  ES: "F.US.EP",
  MES: "F.US.MES",
};

export async function resolveFrontMonthContractId(symbolText) {
  if (cachedContractId.has(symbolText)) return cachedContractId.get(symbolText);

  const expectedSymbolId = SYMBOL_ID_MAP[symbolText];
  const contracts = await searchContracts(symbolText, false);
  const matches = contracts.filter(
    (c) => c.activeContract && (!expectedSymbolId || c.symbolId === expectedSymbolId)
  );
  if (!matches.length) {
    throw new Error(`No active contract found for "${symbolText}" (expected symbolId ${expectedSymbolId ?? "unknown"})`);
  }
  if (matches.length > 1) {
    console.warn(`Multiple active contracts matched "${symbolText}", picking the first:`, matches);
  }
  const contractId = matches[0].id;
  cachedContractId.set(symbolText, contractId);
  return contractId;
}

// Confirmed live 2026-07-24: contract search response for ES/MES both showed
// tickSize: 0.25. Used to convert price distances (stop/target) into the tick
// counts TopstepX's bracket-order API requires.
const TICK_SIZE_MAP = {
  ES: 0.25,
  MES: 0.25,
};

export function tickSizeFor(symbolText) {
  const size = TICK_SIZE_MAP[symbolText];
  if (!size) throw new Error(`No known tickSize for "${symbolText}"`);
  return size;
}

// Live-verified 2026-07-24: a bracket stop rejected with "Invalid stop loss
// ticks (-1). Price should be at least 4 ticks away." — found by testing
// reopenAt's close+re-bracket mechanism for real (a dynamic-exit stop move
// landing within 4 ticks of the re-entry reference price, e.g. breakeven
// firing right as price is barely past 1R, would otherwise be silently
// rejected). Callers computing a new stop price for a live reopen should
// clamp to at least this distance from the reference price.
export const MIN_STOP_TICKS = 4;

// Real-UTC lookback window (not ET-relative — callers filter the returned
// bars' own timestamps down to whatever ET window they actually need). Used
// to backfill the opening-range high/low from history when a worker starts
// or restarts after today's ORB window has already closed, since the live
// bar stream only ever builds the ORB in real time and has no memory of a
// window it wasn't running for.
export async function fetchRecentBars(symbolText, lookbackMinutes) {
  const contractId = await resolveFrontMonthContractId(symbolText);
  const now = new Date();
  const start = new Date(now.getTime() - lookbackMinutes * 60_000);
  const data = await apiPost("/api/History/retrieveBars", {
    contractId,
    live: false,
    startTime: start.toISOString(),
    endTime: now.toISOString(),
    unit: 2, // Minute
    unitNumber: 1,
    limit: lookbackMinutes,
    includePartialBar: false,
  });
  return (data.bars ?? []).map((b) => ({ high: b.h, low: b.l, close: b.c, timestamp: b.t }));
}

function nyDateParts(isoTimestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(isoTimestamp));
  const get = (type) => parts.find((p) => p.type === type).value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, nyTime: Number(get("hour")) * 100 + Number(get("minute")) };
}

// Historical 1-min OHLCV bars WITH real volume, shaped like
// backend/src/api/databento.js's parsed bars ({date, ny_time, open, high,
// low, close, volume}) so volumeProfile.js's groupBarsByDay/RTH-filtering
// works unchanged regardless of provider. Deliberately TopstepX, not
// Databento — Databento is reserved for the backend's historical
// backtesting only (paid via separate free-credit balance); the live bot's
// own data dependencies should stay limited to the broker it already
// authenticates against for everything else. Confirmed live 2026-07-30:
// despite no existing caller here ever having needed it, `History/
// retrieveBars` does return a real per-bar `v` (volume) field, and a 6-day
// 1-min pull came back complete in one call (5519 bars, no truncation) —
// unverified beyond roughly that range, so a multi-week pull may need the
// same monthly-chunking treatment Databento's own fetch already has.
export async function fetchHistoricalBars(symbolText, { fromDate, toDate }) {
  const contractId = await resolveFrontMonthContractId(symbolText);
  const data = await apiPost("/api/History/retrieveBars", {
    contractId,
    live: false,
    startTime: new Date(`${fromDate}T00:00:00Z`).toISOString(),
    endTime: new Date(`${toDate}T23:59:59Z`).toISOString(),
    unit: 2, // Minute
    unitNumber: 1,
    limit: 20000,
    includePartialBar: false,
  });
  // TopstepX returns newest-first (confirmed live, same as its daily bars —
  // see mechanical-orb's fetchDailyBars) — sort ascending by the raw
  // timestamp before converting to ET date/time parts.
  const sorted = [...(data.bars ?? [])].sort((a, b) => a.t.localeCompare(b.t));
  return sorted.map((b) => {
    const { date, nyTime } = nyDateParts(b.t);
    return { date, ny_time: nyTime, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v ?? 0 };
  });
}

export async function fetchLastPrice(symbolText) {
  const contractId = await resolveFrontMonthContractId(symbolText);
  const now = new Date();
  const start = new Date(now.getTime() - 15 * 60_000);
  const data = await apiPost("/api/History/retrieveBars", {
    contractId,
    live: false,
    startTime: start.toISOString(),
    endTime: now.toISOString(),
    unit: 2, // 1=Second, 2=Minute, 3=Hour, 4=Day, 5=Week, 6=Month
    unitNumber: 1,
    limit: 1,
    includePartialBar: true,
  });
  const bars = data.bars ?? [];
  if (!bars.length) throw new Error(`No recent bars for ${symbolText} (contract ${contractId})`);
  return bars[bars.length - 1].c;
}

// GatewayTrade payload per the docs: { symbolId, price, timestamp, type, volume },
// type 0 = Buy aggressor, 1 = Sell aggressor. Bucketed into 1-min bars for the
// order-flow module (delta = buyVolume - sellVolume per bar).
export function minuteBucketStart(timestampIso) {
  const d = new Date(timestampIso);
  d.setSeconds(0, 0);
  return d.getTime();
}

export class TradeBarAggregator {
  constructor(onBar) {
    this.onBar = onBar;
    this.currentBucket = null;
    this.bar = null;
  }

  onTrade({ price, volume, timestamp, type }) {
    const bucket = minuteBucketStart(timestamp);
    if (this.currentBucket !== null && bucket !== this.currentBucket) {
      this.flush();
    }
    if (this.bar === null) {
      this.bar = { high: price, low: price, close: price, buyVolume: 0, sellVolume: 0 };
    }
    this.currentBucket = bucket;
    this.bar.high = Math.max(this.bar.high, price);
    this.bar.low = Math.min(this.bar.low, price);
    this.bar.close = price;
    if (type === 0) this.bar.buyVolume += volume;
    else this.bar.sellVolume += volume;
  }

  flush() {
    if (this.bar) {
      this.onBar(this.bar);
      this.bar = null;
    }
  }
}

// Same GatewayTrade stream TradeBarAggregator already consumes (no new
// subscription) — buckets by EXACT traded price within the minute, at
// whatever tick granularity trades occur at. Deliberately does not re-bucket
// to orderFlowBot.footprint.bucketSizePts itself — that's a config-driven
// choice, and this adapter has no CONFIG dependency (matches TradeBarAggregator's
// own convention); footprint.js's buildFootprintZones does the coarser
// re-bucketing when it consumes these bars.
export class FootprintBarAggregator {
  constructor(onFootprintBar) {
    this.onFootprintBar = onFootprintBar;
    this.currentBucket = null;
    this.levels = null; // Map<price, {buyVolume, sellVolume}>
  }

  onTrade({ price, volume, timestamp, type }) {
    const bucket = minuteBucketStart(timestamp);
    if (this.currentBucket !== null && bucket !== this.currentBucket) {
      this.flush();
    }
    if (this.levels === null) this.levels = new Map();
    this.currentBucket = bucket;
    const level = this.levels.get(price) ?? { buyVolume: 0, sellVolume: 0 };
    if (type === 0) level.buyVolume += volume;
    else level.sellVolume += volume;
    this.levels.set(price, level);
  }

  flush() {
    if (this.levels && this.levels.size) {
      const levels = [...this.levels.entries()]
        .map(([price, v]) => ({ price, buyVolume: v.buyVolume, sellVolume: v.sellVolume }))
        .sort((a, b) => a.price - b.price);
      this.onFootprintBar(levels);
    }
    this.levels = null;
  }
}

// ---- Account / order / position (execution) ----
// order/place, Account/search, Position/searchOpen, Order/searchOpen confirmed
// against the ProjectX Gateway docs 2026-07-24. Live-verify account selection and
// a single minimal test order before trusting this for real signal-driven trading.

export const ORDER_SIDE = { BUY: 0, SELL: 1 };
export const ORDER_TYPE = { LIMIT: 1, MARKET: 2, STOP: 4, TRAILING_STOP: 5, JOIN_BID: 6, JOIN_ASK: 7 };

export function directionToSide(direction) {
  return direction === "long" ? ORDER_SIDE.BUY : ORDER_SIDE.SELL;
}

export function priceDistanceToTicks(distance, tickSize) {
  return Math.round(Math.abs(distance) / tickSize);
}

// Live-verified 2026-07-24: bracket ticks are a SIGNED offset from entry, not an
// absolute distance — the API rejected a long's stop with "ticks should be less
// than zero when longing." Positive = above entry, negative = below, regardless of
// trade direction (a long's stop is below entry -> negative; a short's stop is
// above entry -> positive, and vice versa for the target).
export function signedPriceOffsetTicks(fromPrice, toPrice, tickSize) {
  return Math.round((toPrice - fromPrice) / tickSize);
}

// Entry is a market order (closest live equivalent to the strategies' "trigger-bar
// close" entry mode — by the time a signal is processed, price has already moved
// past that close). Stop/target are attached as native OCO brackets in ticks, not
// separate orders — TopstepX manages the one-cancels-other logic itself.
export function buildBracketOrderRequest({
  accountId,
  contractId,
  direction,
  size,
  entryPrice,
  stopPrice,
  targetPrice,
  tickSize,
  customTag,
}) {
  return {
    accountId,
    contractId,
    type: ORDER_TYPE.MARKET,
    side: directionToSide(direction),
    size,
    customTag,
    stopLossBracket: { ticks: signedPriceOffsetTicks(entryPrice, stopPrice, tickSize), type: ORDER_TYPE.STOP },
    takeProfitBracket: { ticks: signedPriceOffsetTicks(entryPrice, targetPrice, tickSize), type: ORDER_TYPE.LIMIT },
  };
}

export async function searchAccounts(onlyActiveAccounts = true) {
  const data = await apiPost("/api/Account/search", { onlyActiveAccounts });
  return data.accounts;
}

// Picks the practice account to trade. With one tradable account this is
// unambiguous; with more than one, pass nameHint (a substring of the account name)
// to disambiguate rather than silently guessing which account to risk real (paper)
// orders on.
export function selectAccount(accounts, nameHint = null) {
  const tradable = accounts.filter((a) => a.canTrade);
  if (!tradable.length) throw new Error("No tradable accounts found");
  if (nameHint) {
    const match = tradable.find((a) => a.name.includes(nameHint));
    if (!match) {
      throw new Error(`No account matching "${nameHint}" among: ${tradable.map((a) => a.name).join(", ")}`);
    }
    return match;
  }
  if (tradable.length > 1) {
    throw new Error(
      `Multiple tradable accounts found, set TOPSTEPX_ACCOUNT_NAME to disambiguate: ${tradable.map((a) => a.name).join(", ")}`
    );
  }
  return tradable[0];
}

// Keyed by nameHint, not a single value — GEX Breakout now resolves two
// different accounts in the same process (Strategy A on practice, everything
// else on the real Combine), so a single-slot cache would silently return
// whichever account resolved first for every later call regardless of the
// nameHint actually passed in.
const cachedAccountIds = new Map();
export async function resolveAccountId(nameHint = process.env.TOPSTEPX_ACCOUNT_NAME || null) {
  const cacheKey = nameHint ?? "";
  if (cachedAccountIds.has(cacheKey)) return cachedAccountIds.get(cacheKey);
  const accounts = await searchAccounts(true);
  const accountId = selectAccount(accounts, nameHint).id;
  cachedAccountIds.set(cacheKey, accountId);
  return accountId;
}

export async function placeBracketOrder(params) {
  const body = buildBracketOrderRequest(params);
  const data = await apiPost("/api/Order/place", body);
  return data.orderId;
}

export async function searchOpenPositions(accountId) {
  const data = await apiPost("/api/Position/searchOpen", { accountId });
  return data.positions;
}

export async function searchOpenOrders(accountId) {
  const data = await apiPost("/api/Order/searchOpen", { accountId });
  return data.orders;
}

export async function cancelOrder(accountId, orderId) {
  return apiPost("/api/Order/cancel", { accountId, orderId });
}

// Cancels every resting order on a contract WITHOUT touching the position
// itself — distinct from closePositionAndCancelOrders below, which closes
// the position too. Needed when re-bracketing a still-open (e.g. partially
// reduced) position: the original stop/target orders were sized for the old
// position size, and this broker's behavior when a bracket order is left
// larger than the current position isn't something we've verified, so the
// safe move is to cancel and replace rather than assume it's handled.
export async function cancelOrdersOnContract(accountId, contractId) {
  const openOrders = await searchOpenOrders(accountId);
  const stragglers = openOrders.filter((o) => o.contractId === contractId);
  await Promise.all(stragglers.map((o) => cancelOrder(accountId, o.id)));
  return stragglers.map((o) => o.id);
}

// Live-verified 2026-07-24: closing a position does NOT cancel its bracket
// child orders — after Position/closeContract, the stop-loss and take-profit
// orders were still sitting as live working orders with no position behind them
// (found by testing a real close, not assumed). Left alone, a stale bracket order
// could fill later and open an unwanted new position. Always cancel any remaining
// open orders on the contract as part of closing it.
export async function closePositionAndCancelOrders(accountId, contractId) {
  const closeResult = await apiPost("/api/Position/closeContract", { accountId, contractId });
  const canceledOrderIds = await cancelOrdersOnContract(accountId, contractId);
  return { closeResult, canceledOrderIds };
}

// Balance + open positions for the dashboard's live account stats. Polling REST is
// simpler and more robust here than the not-yet-verified user-hub push events —
// account/position state doesn't need sub-second latency the way order flow does.
export async function fetchAccountSnapshot(accountId) {
  const [accounts, positions] = await Promise.all([searchAccounts(true), searchOpenPositions(accountId)]);
  const account = accounts.find((a) => a.id === accountId);
  return { account: account ?? null, positions };
}

const USER_HUB_URL = "https://rtc.topstepx.com/hubs/user";

// Written from docs (event names GatewayUserAccount/Position/Order/Trade, subscribe
// methods SubscribeAccounts/Orders/Positions/Trades) but the exact invoke signatures
// (does SubscribeAccounts take an accountId or not?) are NOT confirmed — verify on
// first live connection, same as subscribeBars needed fixing for its payload shape.
export async function subscribeUserUpdates(accountId, handlers = {}) {
  const { HubConnectionBuilder, LogLevel } = await import("@microsoft/signalr");

  const connection = new HubConnectionBuilder()
    .withUrl(USER_HUB_URL, { accessTokenFactory: () => getToken() })
    .withAutomaticReconnect()
    .configureLogging(LogLevel.Warning)
    .build();

  if (handlers.onAccount) connection.on("GatewayUserAccount", handlers.onAccount);
  if (handlers.onPosition) connection.on("GatewayUserPosition", handlers.onPosition);
  if (handlers.onOrder) connection.on("GatewayUserOrder", handlers.onOrder);
  if (handlers.onTrade) connection.on("GatewayUserTrade", handlers.onTrade);

  await connection.start();
  await connection.invoke("SubscribeAccounts");
  await connection.invoke("SubscribeOrders", accountId);
  await connection.invoke("SubscribePositions", accountId);
  await connection.invoke("SubscribeTrades", accountId);

  return connection;
}

const MARKET_HUB_URL = "https://rtc.topstepx.com/hubs/market";

// Live-tested against the TopstepX practice account 2026-07-24. Hub URL,
// accessTokenFactory pattern, and SubscribeContractTrades method name all confirmed
// correct. One thing the docs got wrong (or I misread): GatewayTrade's second arg is
// an ARRAY of trade prints batched per event, not a single trade object — a real bug,
// caught by logging the raw payload before trusting the assumed shape.
// onFootprintBar is optional — existing callers (just gex-breakout's own
// worker so far) are unaffected since it defaults to undefined and the
// footprint aggregator is simply never constructed.
export async function subscribeBars(symbolText, onBar, onFootprintBar) {
  const { HubConnectionBuilder, LogLevel } = await import("@microsoft/signalr");
  const contractId = await resolveFrontMonthContractId(symbolText);
  const aggregator = new TradeBarAggregator(onBar);
  const footprintAggregator = onFootprintBar ? new FootprintBarAggregator(onFootprintBar) : null;

  const connection = new HubConnectionBuilder()
    .withUrl(MARKET_HUB_URL, { accessTokenFactory: () => getToken() })
    .withAutomaticReconnect()
    .configureLogging(LogLevel.Warning)
    .build();

  connection.on("GatewayTrade", (_evtContractId, trades) => {
    for (const trade of trades) {
      aggregator.onTrade(trade);
      footprintAggregator?.onTrade(trade);
    }
  });

  await connection.start();
  await connection.invoke("SubscribeContractTrades", contractId);

  return connection;
}

// Mirrors subscribeBars exactly (same hub, same accessTokenFactory pattern) —
// per the ProjectX docs, GatewayDepth(contractId, data) events after invoking
// SubscribeContractMarketDepth(contractId). The exact `data` shape is
// UNCONFIRMED: this codebase has direct precedent for these docs being wrong
// (GatewayTrade's second arg turned out to be an array, only caught by
// logging the raw payload live) — deliberately not parsed here yet. Callers
// get the raw event as-is; DepthBookAggregator.onDepthEvent (depthBook.js) is
// where real parsing lands once a live session confirms the shape.
export async function subscribeDepth(symbolText, onDepthEvent) {
  const { HubConnectionBuilder, LogLevel } = await import("@microsoft/signalr");
  const contractId = await resolveFrontMonthContractId(symbolText);

  const connection = new HubConnectionBuilder()
    .withUrl(MARKET_HUB_URL, { accessTokenFactory: () => getToken() })
    .withAutomaticReconnect()
    .configureLogging(LogLevel.Warning)
    .build();

  connection.on("GatewayDepth", (_evtContractId, data) => onDepthEvent(data));

  await connection.start();
  await connection.invoke("SubscribeContractMarketDepth", contractId);

  return connection;
}
