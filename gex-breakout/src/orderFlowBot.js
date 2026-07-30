// The Order Flow Bot's own strategy orchestration. Deliberately does NOT
// reuse checks.js's runChecks — that gate's POS_GAMMA/flip-break semantics
// are breakout-specific (Strategy A/B trade a breakout past a level, only
// "confirmed" in POS_GAMMA via a flip-break or explicit override) and wrong
// for a strategy that trades BOTH regimes on purpose, fading toward the
// flip in its own mean-reversion mode rather than needing to break past it.

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
// buy/sell-imbalance zones on NEG_GAMMA (trend) days, the session value area
// treated as a single zone on POS_GAMMA (mean-reversion) days. `side: null`
// on the value-area zone — it isn't buy/sell-imbalanced the way a footprint
// zone is, but the shared triggers below don't need a side, only low/high.
export function buildActiveZones(regimeInfo, { footprintZones, valueArea }) {
  if (regimeInfo.baseRegime === "NEG_GAMMA") return footprintZones;
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

// Evaluates the 3 shared, regime-agnostic triggers (absorption, path-of-
// least-resistance, lack-of-participation — design decision: a shared
// vocabulary run against whichever zone set the caller already picked for
// the day) against ONE zone. Path-of-least-resistance/lack-of-participation
// don't actually reference the zone (they're tape-character detectors over
// the trailing bars, independent of any level) — checked per-zone anyway so
// a resulting signal always carries a zone/zoneKey for cooldown tracking.
export function evaluateOrderFlowZone(zone, ctx) {
  const { bars, index, touchWindow, priorBars, config } = ctx;
  const bar = bars[index];
  const edgePrice = nearestZoneEdge(zone, bar.close);

  if (touchWindow && priorBars) {
    const fadeDirection = fadeDirectionFromEdge(zone, edgePrice);
    if (detectAbsorption(touchWindow, priorBars, edgePrice, fadeDirection, config.orderFlow.absorption)) {
      return { direction: fadeDirection, trigger: "absorption", entryPrice: bar.close };
    }
  }

  const polr = detectPathOfLeastResistance(bars, index, config.orderFlowBot.pathOfLeastResistance);
  if (polr) return { direction: polr.direction, trigger: "path_of_least_resistance", entryPrice: bar.close };

  const lop = detectLackOfParticipation(bars, index, config.orderFlowBot.lackOfParticipation);
  if (lop) return { direction: lop.direction, trigger: "lack_of_participation", entryPrice: bar.close };

  return null;
}

export function evaluateOrderFlowBot(ctx) {
  const { nowET, bars, index, regimeInfo, footprintZones, valueArea, touchWindow, priorBars, walls, config, dayState } = ctx;

  const gate = runOrderFlowChecks({ nowET, config });
  if (!gate.pass) return { strategy: "OF", veto: gate.vetoReason };

  if (dayState.orderFlowTradesToday >= config.orderFlowBot.maxTradesPerDay) {
    return { strategy: "OF", veto: "max_trades_per_day_reached" };
  }

  const bar = bars[index];
  let trigger = null;
  let zone = null;

  // detectFailedAuction is volume-profile-specific (needs the value area
  // directly, not a generic zone) — only meaningful on POS_GAMMA days, and
  // checked before the 3 shared triggers since it's the more decisive signal
  // when the value area itself has already rejected a probe.
  if (regimeInfo.baseRegime === "POS_GAMMA" && valueArea) {
    const failed = detectFailedAuction(bars, index, valueArea, config.orderFlowBot.volumeProfile);
    if (failed) {
      trigger = { direction: failed.direction, trigger: "failed_auction", entryPrice: bar.close };
      zone = { side: null, low: valueArea.low, high: valueArea.high };
    }
  }

  if (!trigger) {
    for (const candidateZone of buildActiveZones(regimeInfo, { footprintZones, valueArea })) {
      const candidateKey = zoneKeyFor(candidateZone);
      if (isZoneOnCooldown(candidateKey, dayState.zoneCooldowns, Date.now(), config.orderFlowBot.cooldownMinPerZone)) {
        continue;
      }
      const result = evaluateOrderFlowZone(candidateZone, { bars, index, touchWindow, priorBars, config });
      if (result) {
        trigger = result;
        zone = candidateZone;
        break;
      }
    }
  }

  if (!trigger) return null;

  const zoneKey = zoneKeyFor(zone);
  // The failed_auction path above doesn't check cooldown until here — same
  // cooldown map, checked once, regardless of which path found the trigger.
  if (isZoneOnCooldown(zoneKey, dayState.zoneCooldowns, Date.now(), config.orderFlowBot.cooldownMinPerZone)) {
    return null;
  }

  const wallResult = directionalWallFilter(trigger.entryPrice, trigger.direction, walls, config.levels.wallFilter);
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

  const isTrendDay = regimeInfo.baseRegime === "NEG_GAMMA";
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
