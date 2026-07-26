export class SessionRiskManager {
  constructor(config) {
    this.config = config;
    this.resetDay();
  }

  resetDay() {
    this.haltedStrategies = new Set(); // "A" | "B"
    this.lossesToday = { A: 0, B: 0 };
    this.winsToday = { A: 0, B: 0 };
    this.orbTradedDirections = new Set();
    this.strategyBTradesToday = 0;
    this.levelCooldowns = new Map();
  }

  get dayState() {
    return {
      orbTradedDirections: this.orbTradedDirections,
      strategyBTradesToday: this.strategyBTradesToday,
      levelCooldowns: this.levelCooldowns,
    };
  }

  // One winning trade locks in and halts that strategy for the rest of the
  // day; a strategy's own losses also halt it independently once they reach
  // maxLossesPerStrategyPerDay. A and B are tracked separately — a win/halt
  // on one has no effect on the other. Anything other than "A"/"B" (e.g. the
  // "reconciled" placeholder strategy used for positions this process didn't
  // itself open) has no day-state identity to halt, so it's a no-op.
  recordTradeResult(strategy, pnl) {
    if (strategy !== "A" && strategy !== "B") return;
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

  recordOrbTrade(direction) {
    this.orbTradedDirections.add(direction);
  }

  recordStrategyBTrade(levelKey, nowMs) {
    this.strategyBTradesToday += 1;
    this.levelCooldowns.set(levelKey, nowMs);
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
