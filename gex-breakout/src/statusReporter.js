import { CONFIG } from "./config.js";

export function buildStatusPayload(worker) {
  const lastBar = worker.bars.length ? worker.bars[worker.bars.length - 1] : null;
  return {
    signalOnly: !CONFIG.executionEnabled, // Strategy B (and everything but A) — the bot-wide switch
    instrumentTrade: CONFIG.instrumentTrade,
    instrumentData: CONFIG.instrumentData,
    lastPrice: lastBar?.close ?? null,
    barsToday: worker.bars.length,
    regime: worker.lastRegimeInfo?.regime ?? null,
    gex: worker.gexSnapshot
      ? {
          netGex: worker.gexSnapshot.netGex,
          confidence: worker.gexSnapshot.confidence,
          asOf: worker.gexSnapshot.asOf,
        }
      : null,
    flipPointEs: worker.levelState.flipPointEs,
    wallsEs: worker.levelState.wallsEs,
    basis: worker.basis,
    basisAsOf: worker.basisAsOf ? worker.basisAsOf.toISOString() : null,
    dayState: {
      strategyBTradesToday: worker.riskManager.dayState.strategyBTradesToday,
      orderFlowTradesToday: worker.riskManager.dayState.orderFlowTradesToday,
      haltedStrategies: [...worker.riskManager.haltedStrategies],
      winsToday: worker.riskManager.winsToday,
      lossesToday: worker.riskManager.lossesToday,
    },
    account: worker.account
      ? { id: worker.account.id, name: worker.account.name, balance: worker.account.balance }
      : null,
    openPositions: worker.openPositions,
    accountAsOf: worker.accountAsOf ? worker.accountAsOf.toISOString() : null,
    // The Order Flow Bot's own (practice) account — separate from everything
    // above, which is the "default" role (real Combine). See worker.js's
    // accountRoleFor/isLiveExecutionAllowed for how the two stay isolated.
    orderFlowBot: {
      signalOnly: !(CONFIG.executionEnabled && CONFIG.orderFlowBot.executionEnabled),
      account: worker.accountA
        ? { id: worker.accountA.id, name: worker.accountA.name, balance: worker.accountA.balance }
        : null,
      openPositions: worker.openPositionsA,
    },
    recentLog: worker.logger.buffer.slice(-50).reverse(),
    updatedAt: new Date().toISOString(),
  };
}

export async function pushStatus(worker, backendUrl, secret, fetchImpl = fetch) {
  const headers = { "Content-Type": "application/json" };
  if (secret) headers["X-Status-Secret"] = secret;
  try {
    const res = await fetchImpl(`${backendUrl}/api/gex-breakout/status`, {
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
