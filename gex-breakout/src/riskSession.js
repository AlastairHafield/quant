// The two strategies with a real day-state identity to halt — "reconciled"
// (a position this process didn't itself open, e.g. a manual trade) and
// anything else intentionally has none, same no-op as before.
const TRACKED_STRATEGIES = new Set(["B", "OF"]);

export class SessionRiskManager {
  constructor(config) {
    this.config = config;
    this.resetDay();
  }

  resetDay() {
    this.haltedStrategies = new Set(); // "B" | "OF"
    // Lazily-initialized rather than pre-seeded {A:0, B:0} — a hardcoded shape
    // silently produced NaN counters (and a loss-halt that could never trip)
    // for any strategy identifier other than exactly "A"/"B".
    this.lossesToday = {};
    this.winsToday = {};
    this.strategyBTradesToday = 0;
    this.levelCooldowns = new Map();
    this.orderFlowTradesToday = 0; // Order Flow Bot's own trade count, kept separate from Strategy B's
    this.zoneCooldowns = new Map(); // Order Flow Bot's own per-zone cooldown, kept separate from levelCooldowns
  }

  get dayState() {
    return {
      strategyBTradesToday: this.strategyBTradesToday,
      levelCooldowns: this.levelCooldowns,
      orderFlowTradesToday: this.orderFlowTradesToday,
      zoneCooldowns: this.zoneCooldowns,
    };
  }

  // One winning trade locks in and halts that strategy for the rest of the
  // day; a strategy's own losses also halt it independently once they reach
  // maxLossesPerStrategyPerDay. B and OF are tracked separately — a win/halt
  // on one has no effect on the other. Anything not in TRACKED_STRATEGIES
  // (e.g. the "reconciled" placeholder strategy used for positions this
  // process didn't itself open) has no day-state identity to halt, so it's a
  // no-op.
  recordTradeResult(strategy, pnl) {
    if (!TRACKED_STRATEGIES.has(strategy)) return;
    this.lossesToday[strategy] ??= 0;
    this.winsToday[strategy] ??= 0;
    if (pnl > 0) {
      this.winsToday[strategy] += 1;
      this.haltedStrategies.add(strategy);
    } else if (pnl < 0) {
      this.lossesToday[strategy] += 1;
      if (this.lossesToday[strategy] >= this.config.maxLossesPerStrategyPerDay) {
        this.haltedStrategies.add(strategy);
      }
    }
  }

  recordStrategyBTrade(levelKey, nowMs) {
    this.strategyBTradesToday += 1;
    this.levelCooldowns.set(levelKey, nowMs);
  }

  recordOrderFlowTrade(zoneKey, nowMs) {
    this.orderFlowTradesToday += 1;
    this.zoneCooldowns.set(zoneKey, nowMs);
  }

  canTrade(strategy) {
    return !this.haltedStrategies.has(strategy);
  }
}

export function checkDataHealth({ basisAsOf, deltaFeedLastBarAt, now, haltCfg }) {
  const basisAgeMin = (now.getTime() - basisAsOf.getTime()) / 60000;
  const deltaGapMin = (now.getTime() - deltaFeedLastBarAt.getTime()) / 60000;
  if (basisAgeMin > haltCfg.basisStaleMaxMin) return { healthy: false, reason: "basis_stale" };
  if (deltaGapMin > haltCfg.deltaFeedGapMaxMin) return { healthy: false, reason: "delta_feed_gap" };
  return { healthy: true };
}

export function checkRecalcSettle({ flipMovedPts, recalcAt, now, settleCfg }) {
  const minutesSinceRecalc = (now.getTime() - recalcAt.getTime()) / 60000;
  const withinSettleWindow = minutesSinceRecalc < settleCfg.noEntryMinutesAfterRecalc;
  const movedEnough = Math.abs(flipMovedPts) > settleCfg.flipMoveThresholdPts;
  return withinSettleWindow && movedEnough;
}

export function computeSizeMultiplier(flowGrade, wallSizeMultiplier, sizingCfg) {
  const gradeSize = flowGrade === "A" ? sizingCfg.A : sizingCfg.B;
  return gradeSize * wallSizeMultiplier;
}
