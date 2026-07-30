// Order Flow Bot's own dynamic in-trade management — mirrors exitRules.js's
// evaluateExit action vocabulary (HOLD/EXIT_NOW/TAKE_PARTIAL/TIGHTEN_TRAIL)
// plus one new TIGHTEN_TO_PRICE action, but with OF-specific triggers.
// Strategy B's failed-breakout/regime-flip-to-POS_GAMMA checks don't apply
// here — the Order Flow Bot trades BOTH regimes with different zone sets by
// design, so "flipped to POS_GAMMA" isn't itself a reason to bail.

import { detectAbsorption, detectDeltaDivergence } from "./orderFlow.js";

// The nearest active zone edge on the SAFE side of current price for
// `direction` (below price for a long, above for a short) — a support/
// resistance reference to trail the stop behind on a trend day. Zones on the
// wrong side (already passed) aren't candidates to trail behind. Returns
// null with no eligible zone, same as having no zones at all.
export function nearestZonePriceFor(zones, direction, currentPrice) {
  const edgePrice = (z) => (direction === "long" ? z.high : z.low);
  const eligible = zones.filter((z) => (direction === "long" ? z.high < currentPrice : z.low > currentPrice));
  if (!eligible.length) return null;
  const nearest = eligible.reduce((closest, z) =>
    Math.abs(edgePrice(z) - currentPrice) < Math.abs(edgePrice(closest) - currentPrice) ? z : closest
  );
  return edgePrice(nearest);
}

export function evaluateOrderFlowExit(ctx) {
  const {
    direction,
    entryIndex,
    currentIndex,
    bars,
    touchWindow,
    priorBars,
    levelPriceForAbsorption,
    isTrendDay,
    nearestZonePrice,
    config,
  } = ctx;

  // Early failed-thesis exit: a delta divergence shortly after entry means
  // the confirming order flow that justified the trade never showed up.
  if (
    currentIndex - entryIndex <= config.exit.divergenceWithinBarsOfEntry &&
    detectDeltaDivergence(bars, currentIndex, { lookbackBars: config.orderFlow.divergenceLookbackBars })
  ) {
    return { action: "EXIT_NOW", reason: "delta_divergence_after_entry" };
  }

  if (
    touchWindow &&
    levelPriceForAbsorption != null &&
    detectAbsorption(touchWindow, priorBars, levelPriceForAbsorption, direction, config.orderFlow.absorption)
  ) {
    return { action: "TAKE_PARTIAL", reason: "absorption_at_target" };
  }

  // Trend days deliberately have no fixed take-profit (see orderFlowBot.js's
  // placeholderTargetDistancePts) — this trails the stop behind the nearest
  // active zone instead, recomputed fresh each bar by the caller (worker.js)
  // from that bar's current footprint zones, not fixed at entry.
  if (isTrendDay && nearestZonePrice != null) {
    return { action: "TIGHTEN_TO_PRICE", reason: "trail_behind_nearest_zone", price: nearestZonePrice };
  }

  return { action: "HOLD" };
}
