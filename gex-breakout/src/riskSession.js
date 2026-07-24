export class SessionRiskManager {
  constructor(config) {
    this.config = config;
    this.resetDay();
  }

  resetDay() {
    this.consecutiveLosses = 0;
    this.haltedForDay = false;
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

  recordTradeResult(pnl) {
    if (pnl < 0) {
      this.consecutiveLosses += 1;
      if (this.consecutiveLosses >= this.config.maxConsecLosses) {
        this.haltedForDay = true;
      }
    } else {
      this.consecutiveLosses = 0;
    }
  }

  recordOrbTrade(direction) {
    this.orbTradedDirections.add(direction);
  }

  recordStrategyBTrade(levelKey, nowMs) {
    this.strategyBTradesToday += 1;
    this.levelCooldowns.set(levelKey, nowMs);
  }

  canTrade() {
    return !this.haltedForDay;
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
