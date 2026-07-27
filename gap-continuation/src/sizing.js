// Ladder from topstep-prop-firm-plan (Phase 3, real-money destination): 1 contract
// base, +1 per $2,000 of equity growth, capped at 15. Built as a real, reusable
// function for when this moves off the practice/monitoring phase — not active
// while config.sizing.mode is "FLAT".
export function ladderContracts({ equity, ladder }) {
  const growthSteps = Math.floor((equity - ladder.startingEquity) / ladder.perContractEquityStep);
  const contracts = ladder.baseContracts + Math.max(0, growthSteps);
  return Math.min(contracts, ladder.cap);
}

export function computeSize(config, equity) {
  if (config.sizing.mode === "FLAT") return config.sizing.flatContracts;
  return ladderContracts({ equity, ladder: config.sizing.ladder });
}
