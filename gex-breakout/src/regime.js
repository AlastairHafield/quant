// TopstepX-only regime classification for the Order Flow Bot — replaces the
// old net-GEX-derived NEG_GAMMA/POS_GAMMA split (GEX/FlashAlpha removed).
// "TREND" (prior-day ADX >= threshold, same filter gap-continuation and
// mechanical-orb already use) stands in for the old trending-day regime
// (footprint continuation zones, no fixed TP); "RANGE" stands in for the old
// mean-reversion regime (session value-area fade, contrarian target). See
// orderFlowBot.js's buildActiveZones/isTrendDay and detectFailedAuction's
// regime gate, all of which key off baseRegime by this same name.
export function classifyRegime({ trendDayOk }) {
  const baseRegime = trendDayOk ? "TREND" : "RANGE";
  return { baseRegime, regime: baseRegime };
}
