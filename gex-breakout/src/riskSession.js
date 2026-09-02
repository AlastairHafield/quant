// The Order Flow Bot is the only strategy with a real day-state identity to
// halt now (Strategy B was removed with GEX/FlashAlpha) — "reconciled" (a
// position this process didn't itself open, e.g. a manual trade) and
// anything else intentionally has none, same no-op as before.
const TRACKED_STRATEGIES = new Set(["OF"]);

export class SessionRiskManager {
  constructor(config) {
    this.config = config;
    this.resetDay();
  }

  resetDay() {
    this.haltedStrategies = new Set(); // "OF"
    // Lazily-initialized rather than pre-seeded — a hardcoded shape silently
    // produced NaN counters (and a loss-halt that could never trip) for any
    // strategy identifier other than exactly the pre-seeded ones.
    this.lossesToday = {};
    this.winsToday = {};
    this.orderFlowTradesToday = 0;
    this.zoneCooldowns = new Map(); // Order Flow Bot's own per-zone cooldown
  }

  get dayState() {
    return {
      orderFlowTradesToday: this.orderFlowTradesToday,
      zoneCooldowns: this.zoneCooldowns,
    };
  }

  // One winning trade locks in and halts that strategy for the rest of the
  // day; a strategy's own losses also halt it independently once they reach
  // maxLossesPerStrategyPerDay. Anything not in TRACKED_STRATEGIES (e.g. the
  // "reconciled" placeholder strategy used for positions this process didn't
  // itself open) has no day-state identity to halt, so it's a no-op.
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

  recordOrderFlowTrade(zoneKey, nowMs) {
    this.orderFlowTradesToday += 1;
    this.zoneCooldowns.set(zoneKey, nowMs);
  }

  canTrade(strategy) {
    return !this.haltedStrategies.has(strategy);
  }
}

export function computeSizeMultiplier(flowGrade, wallSizeMultiplier, sizingCfg) {
  const gradeSize = flowGrade === "A" ? sizingCfg.A : sizingCfg.B;
  return gradeSize * wallSizeMultiplier;
}
