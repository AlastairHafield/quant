import { CONFIG } from "./config.js";

export function buildStatusPayload(worker) {
  return {
    signalOnly: !CONFIG.executionEnabled,
    accountMode: CONFIG.accountMode,
    instrument: CONFIG.instrument,
    priorClose: worker.priorClose,
    adx: worker.priorDayAdx,
    adxOk: worker.priorDayAdxOk,
    todayGapChecked: worker.todayGapChecked,
    haltedForRisk: worker.haltedForRisk,
    haltReason: worker.haltReason,
    dayStartBalance: worker.dayStartBalance,
    openPosition: worker.openPosition
      ? {
          direction: worker.openPosition.direction,
          entryPrice: worker.openPosition.entryPrice,
          stopPrice: worker.openPosition.stopPrice,
          targetPrice: worker.openPosition.targetPrice,
          size: worker.openPosition.size,
          mfe: worker.openPosition.mfe,
          mae: worker.openPosition.mae,
        }
      : null,
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
    const res = await fetchImpl(`${backendUrl}/api/gap-continuation/status`, {
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
