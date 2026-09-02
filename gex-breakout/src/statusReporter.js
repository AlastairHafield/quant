import { CONFIG } from "./config.js";
import { buildFootprintZones } from "./footprint.js";
import { buildOrderFlowWalls } from "./levelEngine.js";
import { topHeatmapZones, detectLargeRestingOrders } from "./depthBook.js";

// Only a bar/depth-staleness THRESHOLD check (isBarStreamStale/
// isDepthStreamStale) knows about trading-day bounds — "connected" here just
// means an event has arrived recently at all, useful at a glance regardless
// of session time.
function recentlyEventedWithin(lastEventAt, maxAgeMin) {
  if (!lastEventAt) return false;
  return Date.now() - lastEventAt.getTime() <= maxAgeMin * 60_000;
}

export function buildStatusPayload(worker) {
  const lastBar = worker.bars.length ? worker.bars[worker.bars.length - 1] : null;
  return {
    signalOnly: !CONFIG.executionEnabled, // the bot-wide switch (everything but the Order Flow Bot's own gate)
    instrumentTrade: CONFIG.instrumentTrade,
    instrumentData: CONFIG.instrumentData,
    lastPrice: lastBar?.close ?? null,
    barsToday: worker.bars.length,
    regime: worker.lastRegimeInfo?.regime ?? null,
    adx: worker.priorDayAdx,
    adxOk: worker.priorDayAdxOk,
    walls: buildOrderFlowWalls({ valueArea: worker.lastValueArea, poc: worker.lastPOC }),
    dayState: {
      orderFlowTradesToday: worker.riskManager.dayState.orderFlowTradesToday,
      haltedStrategies: [...worker.riskManager.haltedStrategies],
      winsToday: worker.riskManager.winsToday,
      lossesToday: worker.riskManager.lossesToday,
    },
    haltedForRisk: worker.haltedForRisk,
    haltReason: worker.haltReason,
    dayStartBalance: worker.dayStartBalance,
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
    // Order Flow Bot diagnostics — footprint/depth plumbing (Phase 3) plus
    // the session value area (Phase 4, promoted to instance fields
    // specifically so the dashboard can show them — see tryOrderFlow).
    // activeZones/topDepthZones are computed fresh each push rather than
    // cached on the worker, same as regime/levels.
    orderFlowDiagnostics: {
      footprintConnected: recentlyEventedWithin(worker.lastFootprintBarAt, CONFIG.barStaleThresholdMin),
      lastFootprintBarAt: worker.lastFootprintBarAt ? worker.lastFootprintBarAt.toISOString() : null,
      depthConnected: recentlyEventedWithin(worker.depthBook.lastEventAt, CONFIG.depthStaleThresholdMin),
      lastDepthEventAt: worker.depthBook.lastEventAt ? worker.depthBook.lastEventAt.toISOString() : null,
      activeZones: buildFootprintZones(worker.footprintBars, CONFIG.orderFlowBot.footprint),
      topDepthZones: topHeatmapZones(worker.depthBook.heatmap, 5),
      largeRestingOrders: worker.depthBook.lastSnapshot
        ? detectLargeRestingOrders(worker.depthBook.lastSnapshot, CONFIG.orderFlowBot.depth)
        : [],
      zoneCooldowns: [...worker.riskManager.zoneCooldowns.keys()],
      // baseRegime, not regime — regime can read "NEAR_FLIP" and mask which
      // zone set orderFlowBot.js's buildActiveZones actually picked today.
      baseRegime: worker.lastRegimeInfo?.baseRegime ?? null,
      poc: worker.lastPOC,
      valueArea: worker.lastValueArea,
      sessionBarsCount: worker.bars.length - worker.todaySessionStartIndex,
    },
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
