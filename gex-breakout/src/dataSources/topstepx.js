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

let cachedAccountId = null;
export async function resolveAccountId(nameHint = process.env.TOPSTEPX_ACCOUNT_NAME || null) {
  if (cachedAccountId != null) return cachedAccountId;
  const accounts = await searchAccounts(true);
  cachedAccountId = selectAccount(accounts, nameHint).id;
  return cachedAccountId;
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

// Live-verified 2026-07-24: closing a position does NOT cancel its bracket
// child orders — after Position/closeContract, the stop-loss and take-profit
// orders were still sitting as live working orders with no position behind them
// (found by testing a real close, not assumed). Left alone, a stale bracket order
// could fill later and open an unwanted new position. Always cancel any remaining
// open orders on the contract as part of closing it.
export async function closePositionAndCancelOrders(accountId, contractId) {
  const closeResult = await apiPost("/api/Position/closeContract", { accountId, contractId });
  const openOrders = await searchOpenOrders(accountId);
  const stragglers = openOrders.filter((o) => o.contractId === contractId);
  await Promise.all(stragglers.map((o) => cancelOrder(accountId, o.id)));
  return { closeResult, canceledOrderIds: stragglers.map((o) => o.id) };
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
export async function subscribeBars(symbolText, onBar) {
  const { HubConnectionBuilder, LogLevel } = await import("@microsoft/signalr");
  const contractId = await resolveFrontMonthContractId(symbolText);
  const aggregator = new TradeBarAggregator(onBar);

  const connection = new HubConnectionBuilder()
    .withUrl(MARKET_HUB_URL, { accessTokenFactory: () => getToken() })
    .withAutomaticReconnect()
    .configureLogging(LogLevel.Warning)
    .build();

  connection.on("GatewayTrade", (_evtContractId, trades) => {
    for (const trade of trades) aggregator.onTrade(trade);
  });

  await connection.start();
  await connection.invoke("SubscribeContractTrades", contractId);

  return connection;
}
