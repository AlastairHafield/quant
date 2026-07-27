const BASE_URL = "https://api.topstepx.com";
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // docs state JWT valid 24h; refresh a bit early

let cachedToken = null;
let cachedTokenAt = 0;
const cachedContractId = new Map();

function requireCredentials() {
  const apiKey = process.env.TOPSTEPX_API_KEY;
  const userName = process.env.TOPSTEPX_USERNAME;
  if (!apiKey) throw new Error("TOPSTEPX_API_KEY not set — see gap-continuation/.env.example");
  if (!userName) throw new Error("TOPSTEPX_USERNAME not set — see gap-continuation/.env.example");
  return { apiKey, userName };
}

// Same TopstepX/ProjectX Gateway integration as gex-breakout's and mechanical-orb's
// own dataSources/topstepx.js (duplicated rather than shared — self-contained-module
// convention). See [[topstepx-flashalpha-api-notes]] memory for what's been
// live-verified. This adapter combines mechanical-orb's daily-bar/ADX-lookback
// helpers with gex-breakout's bracket-order (stop AND target) support, since this
// strategy needs both — unlike mechanical-orb (stop-only, rides to EOD).
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

// Contract/search is a fuzzy match, not a root-symbol filter (live-verified
// on the other two bots) — filter on the confirmed symbolId, not just the
// first active result.
const SYMBOL_ID_MAP = { MES: "F.US.MES", ES: "F.US.EP" };
const TICK_SIZE_MAP = { MES: 0.25, ES: 0.25 };

export function tickSizeFor(symbolText) {
  const size = TICK_SIZE_MAP[symbolText];
  if (!size) throw new Error(`No known tickSize for "${symbolText}"`);
  return size;
}

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

// Real-UTC lookback window (not ET-relative — callers filter the returned
// bars' own timestamps down to whatever ET window they actually need). Used
// both to find yesterday's RTH close and (via a longer lookback) to backfill
// history if the worker starts mid-session.
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
  return (data.bars ?? []).map((b) => ({ high: b.h, low: b.l, close: b.c, open: b.o, timestamp: b.t }));
}

// Completed daily bars only (includePartialBar: false), sorted ascending (oldest
// first) so the last element is "yesterday" and adx()'s day-over-day math runs
// forward in time — confirmed live 2026-07-24 (on the other two bots) that the
// API returns bars *newest* first otherwise. lookbackDays is calendar days, so
// pad well past 2x adxPeriod to survive weekends/holidays.
export async function fetchDailyBars(symbolText, lookbackCalendarDays) {
  const contractId = await resolveFrontMonthContractId(symbolText);
  const now = new Date();
  const start = new Date(now.getTime() - lookbackCalendarDays * 24 * 60 * 60_000);
  const data = await apiPost("/api/History/retrieveBars", {
    contractId,
    live: false,
    startTime: start.toISOString(),
    endTime: now.toISOString(),
    unit: 4, // Day
    unitNumber: 1,
    limit: lookbackCalendarDays,
    includePartialBar: false,
  });
  return (data.bars ?? [])
    .map((b) => ({ high: b.h, low: b.l, close: b.c, timestamp: b.t }))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

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
      this.bar = { open: price, high: price, low: price, close: price, buyVolume: 0, sellVolume: 0 };
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

export const ORDER_SIDE = { BUY: 0, SELL: 1 };
export const ORDER_TYPE = { LIMIT: 1, MARKET: 2, STOP: 4, TRAILING_STOP: 5, JOIN_BID: 6, JOIN_ASK: 7 };

export function directionToSide(direction) {
  return direction === "long" ? ORDER_SIDE.BUY : ORDER_SIDE.SELL;
}

export function priceDistanceToTicks(distance, tickSize) {
  return Math.round(Math.abs(distance) / tickSize);
}

// Bracket ticks are a SIGNED offset from entry, not an absolute distance —
// live-verified on the other two bots (rejected with "ticks should be less
// than zero when longing" otherwise). Positive = above entry, negative =
// below, regardless of trade direction.
export function signedPriceOffsetTicks(fromPrice, toPrice, tickSize) {
  return Math.round((toPrice - fromPrice) / tickSize);
}

// This strategy has both a real stop AND a real target (1:1 R:R, unlike
// mechanical-orb's stop-only/ride-to-EOD) — entry is a market order with both
// brackets attached; TopstepX manages the one-cancels-other logic itself.
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

export async function placeBracketOrder(params) {
  const body = buildBracketOrderRequest(params);
  const data = await apiPost("/api/Order/place", body);
  return data.orderId;
}

export async function searchAccounts(onlyActiveAccounts = true) {
  const data = await apiPost("/api/Account/search", { onlyActiveAccounts });
  return data.accounts;
}

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
      `Multiple tradable accounts found, set GAP_CONTINUATION_ACCOUNT_NAME to disambiguate: ${tradable.map((a) => a.name).join(", ")}`
    );
  }
  return tradable[0];
}

let cachedAccountId = null;
export async function resolveAccountId(nameHint = process.env.GAP_CONTINUATION_ACCOUNT_NAME || null) {
  if (cachedAccountId != null) return cachedAccountId;
  const accounts = await searchAccounts(true);
  cachedAccountId = selectAccount(accounts, nameHint).id;
  return cachedAccountId;
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

// Closing a position does NOT cancel its bracket child orders (live-verified
// on the other two bots) — always cancel any remaining open orders on the
// contract as part of closing it.
export async function closePositionAndCancelOrders(accountId, contractId) {
  const closeResult = await apiPost("/api/Position/closeContract", { accountId, contractId });
  const openOrders = await searchOpenOrders(accountId);
  const stragglers = openOrders.filter((o) => o.contractId === contractId);
  await Promise.all(stragglers.map((o) => cancelOrder(accountId, o.id)));
  return { closeResult, canceledOrderIds: stragglers.map((o) => o.id) };
}

export async function fetchAccountSnapshot(accountId) {
  const [accounts, positions] = await Promise.all([searchAccounts(true), searchOpenPositions(accountId)]);
  const account = accounts.find((a) => a.id === accountId);
  return { account: account ?? null, positions };
}

const MARKET_HUB_URL = "https://rtc.topstepx.com/hubs/market";

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
