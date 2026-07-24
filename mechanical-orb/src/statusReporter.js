import { CONFIG } from "./config.js";

export function buildStatusPayload(worker) {
  const lastBar = worker.bars.length ? worker.bars[worker.bars.length - 1] : null;
  return {
    signalOnly: !CONFIG.executionEnabled,
    instrument: CONFIG.instrument,
    lastPrice: lastBar?.close ?? null,
    barsToday: worker.bars.length,
    orb: { high: worker.orbHigh, low: worker.orbLow, locked: worker.orbLocked },
    adx: worker.priorDayAdx,
    adxOk: worker.priorDayAdxOk,
    tradedToday: worker.dayState.tradedToday,
    account: worker.account
      ? { id: worker.account.id, name: worker.account.name, balance: worker.account.balance }
      : null,
    openPositions: worker.openPositions,
    accountAsOf: worker.accountAsOf ? worker.accountAsOf.toISOString() : null,
    recentLog: worker.logger.buffer.slice(-50).reverse(),
    updatedAt: new Date().toISOString(),
  };
}

export async function pushStatus(worker, backendUrl, secret, fetchImpl = fetch) {
  const headers = { "Content-Type": "application/json" };
  if (secret) headers["X-Status-Secret"] = secret;
  try {
    const res = await fetchImpl(`${backendUrl}/api/mechanical-orb/status`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildStatusPayload(worker)),
    });
    if (!res.ok) console.error(`Status push failed: ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error("Status push failed:", e.message);
  }
}

export function startStatusReporter(worker, { backendUrl, secret, intervalMs = 3000 }) {
  pushStatus(worker, backendUrl, secret);
  return setInterval(() => pushStatus(worker, backendUrl, secret), intervalMs);
}
