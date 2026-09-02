// The Order Flow Bot's own strategy orchestration. Regime here is a
// TopstepX-only prior-day ADX classification (regime.js's classifyRegime) —
// "TREND"/"RANGE" — replacing the old net-GEX NEG_GAMMA/POS_GAMMA split
// (GEX/FlashAlpha removed). The Order Flow Bot trades BOTH regimes on
// purpose, with a different zone set and target mode for each.

import { timeCheck } from "./checks.js";
import { directionalWallFilter } from "./levelEngine.js";
import { detectAbsorption, detectPathOfLeastResistance, detectLackOfParticipation } from "./orderFlow.js";
import { detectFailedAuction, computeContrarianTarget } from "./volumeProfile.js";

// Order Flow Bot's own stop placement — deliberately NOT
// tradeManagement.js's computeStructuralStop, whose midpoint-of-structure
// formula assumes entry sits OUTSIDE the structure (Strategy A/B's breakout
// geometry: price broke past a level, the stop goes back inside the range it
// broke from). Order Flow Bot entries sit AT/INSIDE a zone (fade/continuation
// geometry) — a blind midpoint there can land on the WRONG side of entry
// entirely. Stop always sits triggerBufferPts beyond the zone edge on the
// side the trade's actually at risk from; overall distance is still
// validated against stopCapPts, same safety cap Strategy A/B use.
export function computeZoneStop({ zone, entryPrice, direction, stopCapPts, triggerBufferPts }) {
  const stopPrice = direction === "long" ? zone.low - triggerBufferPts : zone.high + triggerBufferPts;
  const distance = Math.abs(entryPrice - stopPrice);
  return { valid: distance <= stopCapPts, distance, stopPrice };
}

export function runOrderFlowChecks({ nowET, config }) {
  if (!timeCheck(nowET, config.entryCutoffET)) {
    return { pass: false, vetoReason: "past_trading_cutoff" };
  }
  if (!config.orderFlowBot.macroOverrideEnabled) {
    return { pass: false, vetoReason: "macro_override_off" };
  }
  return { pass: true };
}

export function zoneKeyFor(zone) {
  return `${zone.side ?? "VA"}:${zone.low.toFixed(2)}-${zone.high.toFixed(2)}`;
}

export function isZoneOnCooldown(zoneKey, cooldownMap, nowMs, cooldownMinutes) {
  const lastTradeMs = cooldownMap.get(zoneKey);
  if (lastTradeMs == null) return false;
  return (nowMs - lastTradeMs) / 60000 < cooldownMinutes;
}

// One active zone set per regime, per the plan's design: footprint's stacked
// buy/sell-imbalance zones on TREND days, the session value area treated as
// a single zone on RANGE (mean-reversion) days. `side: null` on the
// value-area zone — it isn't buy/sell-imbalanced the way a footprint zone
// is, but the shared triggers below don't need a side, only low/high.
export function buildActiveZones(regimeInfo, { footprintZones, valueArea }) {
  if (regimeInfo.baseRegime === "TREND") return footprintZones;
  if (!valueArea) return [];
  return [{ side: null, low: valueArea.low, high: valueArea.high }];
}

// Absorption needs a level price to test — the zone edge nearest the
// current close, since absorption only makes sense tested against whatever
// boundary price is actually being touched right now, not the far edge.
function nearestZoneEdge(zone, price) {
  return Math.abs(zone.high - price) <= Math.abs(zone.low - price) ? zone.high : zone.low;
}

function fadeDirectionFromEdge(zone, edgePrice) {
  return edgePrice === zone.high ? "short" : "long";
}

// Absorption at a zone edge — genuinely needs a real zone to test against,
// unlike path-of-least-resistance/lack-of-participation (see
// nearestZoneOrSynthetic below), so this stays a per-zone check.
export function evaluateZoneAbsorption(zone, ctx) {
  const { bars, index, touchWindow, priorBars, config } = ctx;
  if (!touchWindow || !priorBars) return null;
  const bar = bars[index];
  const edgePrice = nearestZoneEdge(zone, bar.close);
  const fadeDirection = fadeDirectionFromEdge(zone, edgePrice);
  if (detectAbsorption(touchWindow, priorBars, edgePrice, fadeDirection, config.orderFlow.absorption)) {
    return { direction: fadeDirection, trigger: "absorption", entryPrice: bar.close };
  }
  return null;
}

// The zone nearest entryPrice (by midpoint), or a synthetic point-based one
// sized off stopCapPts if none exist yet. Path-of-least-resistance/lack-of-
// participation don't reference a zone at all (pure tape-character reads —
// detectPathOfLeastResistance/detectLackOfParticipation take no zone
// parameter), but still need SOME zone shape for stop placement and cooldown
// tracking, the same as every other Order Flow Bot signal.
//
// Real live gap caught 2026-07-30 (first live session): these two triggers
// used to be evaluated ONLY inside the per-zone loop below, so on a day with
// zero qualifying footprint zones — which is exactly what the very first
// live session hit, footprint zones need 3+ consecutive stacked-imbalance
// buckets to form and simply hadn't yet — neither trigger was ever even
// checked, despite needing no zone in the first place. User noticed real
// price action that looked like a clean breakout produced no signal at all.
//
// Synthetic half-width is stopCapPts MINUS triggerBufferPts, not the full
// stopCapPts — computeZoneStop adds its own triggerBufferPts margin beyond
// whichever edge it uses, so a full-stopCapPts-wide synthetic zone would
// always push the total stop distance past stopCapPts and veto every single
// synthetic-zone trigger with stop_exceeds_cap. Caught by hand-verifying the
// test math before trusting it, not by the test itself.
export function nearestZoneOrSynthetic(zones, entryPrice, stopCapPts, triggerBufferPts) {
  if (!zones.length) {
    const halfWidth = stopCapPts - triggerBufferPts;
    return { side: null, low: entryPrice - halfWidth, high: entryPrice + halfWidth };
  }
  return zones.reduce((closest, z) => {
    const mid = (z.low + z.high) / 2;
    const closestMid = (closest.low + closest.high) / 2;
    return Math.abs(mid - entryPrice) < Math.abs(closestMid - entryPrice) ? z : closest;
  });
}

export function evaluateOrderFlowBot(ctx) {
  const { nowET, bars, index, regimeInfo, footprintZones, valueArea, touchWindow, priorBars, walls, config, dayState } = ctx;

  const gate = runOrderFlowChecks({ nowET, config });
  if (!gate.pass) return { strategy: "OF", veto: gate.vetoReason };

  if (dayState.orderFlowTradesToday >= config.orderFlowBot.maxTradesPerDay) {
    return { strategy: "OF", veto: "max_trades_per_day_reached" };
  }

  const bar = bars[index];
  const zones = buildActiveZones(regimeInfo, { footprintZones, valueArea });
  let trigger = null;
  let zone = null;

  // detectFailedAuction is volume-profile-specific (needs the value area
  // directly, not a generic zone) — only meaningful on RANGE days, and
  // checked before everything else since it's the more decisive signal when
  // the value area itself has already rejected a probe.
  if (regimeInfo.baseRegime === "RANGE" && valueArea) {
    const failed = detectFailedAuction(bars, index, valueArea, config.orderFlowBot.volumeProfile);
    if (failed) {
      trigger = { direction: failed.direction, trigger: "failed_auction", entryPrice: bar.close };
      zone = { side: null, low: valueArea.low, high: valueArea.high };
    }
  }

  // Absorption — genuinely zone-specific, checked per zone; zones already on
  // cooldown are skipped so a different, still-eligible zone still gets a
  // chance this same bar.
  if (!trigger) {
    for (const candidateZone of zones) {
      const candidateKey = zoneKeyFor(candidateZone);
      if (isZoneOnCooldown(candidateKey, dayState.zoneCooldowns, Date.now(), config.orderFlowBot.cooldownMinPerZone)) {
        continue;
      }
      const result = evaluateZoneAbsorption(candidateZone, { bars, index, touchWindow, priorBars, config });
      if (result) {
        trigger = result;
        zone = candidateZone;
        break;
      }
    }
  }

  // Path-of-least-resistance / lack-of-participation — zone-independent,
  // checked once regardless of how many (if any) real zones currently exist.
  if (!trigger) {
    const polr = detectPathOfLeastResistance(bars, index, config.orderFlowBot.pathOfLeastResistance);
    const lop = !polr ? detectLackOfParticipation(bars, index, config.orderFlowBot.lackOfParticipation) : null;
    const tape = polr
      ? { direction: polr.direction, trigger: "path_of_least_resistance" }
      : lop
        ? { direction: lop.direction, trigger: "lack_of_participation" }
        : null;
    if (tape) {
      const candidateZone = nearestZoneOrSynthetic(
        zones,
        bar.close,
        config.tradeManagement.stopCapPts,
        config.orderFlowBot.triggerBufferPts
      );
      const candidateKey = zoneKeyFor(candidateZone);
      if (!isZoneOnCooldown(candidateKey, dayState.zoneCooldowns, Date.now(), config.orderFlowBot.cooldownMinPerZone)) {
        trigger = { ...tape, entryPrice: bar.close };
        zone = candidateZone;
      }
    }
  }

  if (!trigger) return null;

  const zoneKey = zoneKeyFor(zone);
  // failed_auction's own path above doesn't check cooldown until here — same
  // cooldown map, checked once more regardless of which path found the
  // trigger (a harmless no-op re-check for absorption/POLR/LOP, which
  // already filtered on cooldown before ever setting trigger).
  if (isZoneOnCooldown(zoneKey, dayState.zoneCooldowns, Date.now(), config.orderFlowBot.cooldownMinPerZone)) {
    return null;
  }

  // The wall filter only makes sense for a CONTINUATION trigger
  // (path_of_least_resistance: "ride the move that's already happening") —
  // a nearby POS_WALL ahead can genuinely stall/reverse that kind of move,
  // the same risk it guards against for Strategy A/B's breakouts. Every
  // other OF trigger (failed_auction, absorption, lack_of_participation) is
  // a FADE toward the nearest structure — shorting into a nearby POS_WALL
  // is often the whole thesis there, not a risk to dodge. Applying the same
  // filter to both was vetoing the large majority of OF's signals on
  // extreme positive-gamma days (live-confirmed 2026-07-31: 32 of 51 OF
  // evaluations that day were wall_too_close, 100% of them fade-type
  // triggers, on a day where POS_WALLs sat packed densely around spot —
  // exactly the days OF's fade logic exists for).
  const isContinuationTrigger = trigger.trigger === "path_of_least_resistance";
  const wallResult = isContinuationTrigger
    ? directionalWallFilter(trigger.entryPrice, trigger.direction, walls, config.levels.wallFilter)
    : { action: "FULL", wall: null, distance: null };
  if (wallResult.action === "SKIP_OR_HALF" && config.levels.wallFilter.mode === "skip") {
    return { strategy: "OF", direction: trigger.direction, zone, zoneKey, veto: "wall_too_close" };
  }

  const stop = computeZoneStop({
    zone,
    entryPrice: trigger.entryPrice,
    direction: trigger.direction,
    stopCapPts: config.tradeManagement.stopCapPts,
    triggerBufferPts: config.orderFlowBot.triggerBufferPts,
  });
  if (!stop.valid) {
    return { strategy: "OF", direction: trigger.direction, zone, zoneKey, veto: "stop_exceeds_cap" };
  }

  const isTrendDay = regimeInfo.baseRegime === "TREND";
  let targetPrice, targetMode;
  if (isTrendDay) {
    // No fixed TP by design on trend days — orderFlowExits.js's
    // TIGHTEN_TO_PRICE trails the stop behind the nearest zone instead. A
    // real, far placeholder target rather than an omitted one: whether the
    // broker's bracket API accepts a null take-profit is unverified — see
    // config's placeholderTargetDistancePts comment, resolve live in Phase 6
    // rather than guess in the automatic loop.
    targetPrice =
      trigger.direction === "long"
        ? trigger.entryPrice + config.orderFlowBot.exit.placeholderTargetDistancePts
        : trigger.entryPrice - config.orderFlowBot.exit.placeholderTargetDistancePts;
    targetMode = "trend_trail_placeholder";
  } else {
    targetPrice = computeContrarianTarget(zone, trigger.direction);
    targetMode = "contrarian_value_area";
  }

  const targetDistance = Math.abs(targetPrice - trigger.entryPrice);
  if (targetDistance < stop.distance) {
    return { strategy: "OF", direction: trigger.direction, zone, zoneKey, veto: "stop_exceeds_target" };
  }

  return {
    strategy: "OF",
    direction: trigger.direction,
    trigger: trigger.trigger,
    zone,
    zoneKey,
    // Shaped like Strategy A/B's `level` ({type, price}) so the shared
    // logger/journal (buildLogRow) and executeSignal's generic
    // `result.breakoutLevel ?? result.level?.price ?? null` fallback (used
    // for trade.brokenLevel, which evaluateOpenTrades checks is non-null
    // before attempting dynamic management) both work unchanged.
    level: { type: trigger.trigger.toUpperCase(), price: trigger.entryPrice },
    entryPrice: trigger.entryPrice,
    stopPrice: stop.stopPrice,
    stopDistance: stop.distance,
    targetPrice,
    targetMode,
    sizeMultiplier: wallResult.action === "SKIP_OR_HALF" ? 0.5 : 1,
    isTrendDay,
    regime: regimeInfo.regime,
    veto: null,
  };
}
