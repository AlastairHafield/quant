import { runChecks } from "./checks.js";
import { computeStructuralStop, computeTarget } from "./tradeManagement.js";

export function checkOrbTrigger({ price, orbHigh, orbLow, triggerBufferPts }) {
  if (price > orbHigh + triggerBufferPts) return "long";
  if (price < orbLow - triggerBufferPts) return "short";
  return null;
}

export function evaluateStrategyA(ctx) {
  const {
    price,
    prevPrice,
    orbHigh,
    orbLow,
    regimeInfo,
    flipPointEs,
    walls,
    flowGrade,
    levels,
    nowET,
    config,
    dayState,
  } = ctx;

  const direction = checkOrbTrigger({
    price,
    orbHigh,
    orbLow,
    triggerBufferPts: config.strategyA.triggerBufferPts,
  });
  if (!direction) return null;

  if (dayState.orbTradedDirections.has(direction)) {
    return { strategy: "A", direction, veto: "orb_direction_already_traded" };
  }

  const breakoutLevel = direction === "long" ? orbHigh : orbLow;
  const checks = runChecks({
    nowET,
    price,
    prevPrice,
    direction,
    breakoutLevel,
    regimeInfo,
    flipPointEs,
    walls,
    flowGrade,
    config,
  });
  if (!checks.pass) {
    return { strategy: "A", direction, veto: checks.vetoReason };
  }

  const entryPrice = price;
  const stop = computeStructuralStop({
    structureHigh: orbHigh,
    structureLow: orbLow,
    entryPrice,
    direction,
    stopCapPts: config.strategyA.stopCapPts,
  });
  if (!stop.valid) {
    return { strategy: "A", direction, veto: "stop_exceeds_cap" };
  }

  const target = computeTarget({
    direction,
    entryPrice,
    levels,
    maxDistancePts: config.strategyA.targetMaxDistancePts,
    fixedTargetR: config.strategyA.fixedTargetR,
    stopDistance: stop.distance,
  });

  return {
    strategy: "A",
    direction,
    entryPrice,
    stopPrice: stop.stopPrice,
    stopDistance: stop.distance,
    targetPrice: target.targetPrice,
    targetMode: target.mode,
    sizeMultiplier: checks.sizeMultiplier,
    flowGrade,
    regime: regimeInfo.regime,
    veto: null,
  };
}
