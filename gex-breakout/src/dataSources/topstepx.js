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
