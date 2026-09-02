// Shared across all three TopstepX worker bots (gap-continuation, mechanical-orb,
// gex-breakout) rather than duplicated per this codebase's usual self-contained-
// module convention (see each bot's sizing.js/dataSources/topstepx.js) — risk
// enforcement has to stay uniform across bots that share a real account, so
// drift here is a hazard that convention doesn't apply to.

// currentBalance/dayStartBalance come straight from the broker's own account
// snapshot (already polled every few seconds by every worker), not from summing
// this process's own trade log — that way it reflects the account's REAL P&L
// for the day, including any other bot's activity on the same shared account,
// commissions, and anything else a single strategy's own trade list can't see.
export function computeDailyPnl(currentBalance, dayStartBalance) {
  if (currentBalance == null || dayStartBalance == null) return null;
  return currentBalance - dayStartBalance;
}

export function isDailyLossCapBreached(dailyPnl, dailyLossCapDollars) {
  if (dailyPnl == null || dailyLossCapDollars == null) return false;
  return dailyPnl <= -Math.abs(dailyLossCapDollars);
}

// Guards against the exact class of bug that fired two real Strategy B trades
// at 30 contracts instead of ~2 on 2026-07-28: config.sizing.ladder.startingEquity
// was left at a stale/wrong value ($2,000) against a real ~$49,587 balance, so
// the ladder read that gap as 25x organic equity growth and instantly maxed its
// contract-count cap. Only fires when the account is well ABOVE its configured
// starting point (a real drawdown is the opposite failure mode, not this one),
// by more than maxGrowthRatio — real equity growth from a small starting size
// is expected to eventually cross this too, so treat this as "does the
// ladder's own premise still look plausible," not a permanent ceiling.
export function ladderStartingEquityPlausible(startingEquity, actualBalance, maxGrowthRatio = 3) {
  if (startingEquity == null || actualBalance == null) return true;
  if (actualBalance <= startingEquity) return true;
  return actualBalance / startingEquity <= maxGrowthRatio;
}
