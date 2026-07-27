// Ladder from topstep-prop-firm-plan (Phase 3, real-money destination): 1 contract
// base, +1 per $2,000 of equity growth, capped at 15. Same formula as mechanical-orb
// and gap-continuation's sizing.js — kept as its own copy per this codebase's
// self-contained-module convention rather than shared at runtime.
export function ladderContracts({ equity, ladder }) {
  const growthSteps = Math.floor((equity - ladder.startingEquity) / ladder.perContractEquityStep);
  const contracts = ladder.baseContracts + Math.max(0, growthSteps);
  return Math.min(contracts, ladder.cap);
}

// Ratio applied on top of a strategy's own base size (CONFIG.risk.sizing.A/B) and
// its wall-proximity multiplier, rather than the ladder count replacing them
// outright — this way Strategy A stays 2x Strategy B's size at every ladder step,
// not just at the starting 1-contract rung.
export function ladderRatio(equity, ladder) {
  return ladderContracts({ equity, ladder }) / ladder.baseContracts;
}
