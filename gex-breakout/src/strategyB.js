import { runChecks } from "./checks.js";
import { computeStructuralStop, computeTarget } from "./tradeManagement.js";

export function checkBreakoutTrigger(price, level, triggerBufferPts) {
  if (price > level.price + triggerBufferPts) return "long";
  if (price < level.price - triggerBufferPts) return "short";
  return null;
}

export function checkProximity(priorBars, levelPrice, { withinPts, forMinutes }) {
  if (priorBars.length < forMinutes) return false;
  const window = priorBars.slice(-forMinutes);
  return window.every((b) => Math.abs(b.close - levelPrice) <= withinPts);
}

export function levelKeyFor(level) {
  return `${level.type}:${level.price.toFixed(2)}`;
}

export function isLevelOnCooldown(levelKey, cooldownMap, nowMs, cooldownMinutes) {
  const lastTradeMs = cooldownMap.get(levelKey);
  if (lastTradeMs == null) return false;
  return (nowMs - lastTradeMs) / 60000 < cooldownMinutes;
}

export function evaluateStrategyB(ctx) {
  const {
    price,
    prevPrice,
    priorBars,
    triggerLevels,
    regimeInfo,
    flipPointEs,
    walls,
    flowGrade,
    levels,
    nowET,
    nowMs,
    config,
    dayState,
  } = ctx;

  if (dayState.strategyBTradesToday >= config.strategyB.maxTradesPerDay) {
    return { strategy: "B", veto: "max_trades_per_day_reached" };
  }

  for (const level of triggerLevels) {
    const direction = checkBreakoutTrigger(price, level, config.strategyB.triggerBufferPts);
    if (!direction) continue;

    const levelKey = levelKeyFor(level);
    if (isLevelOnCooldown(levelKey, dayState.levelCooldowns, nowMs, config.strategyB.cooldownMinPerLevel)) {
      continue;
    }

    if (!checkProximity(priorBars, level.price, config.strategyB.proximity)) {
      continue;
    }

    const checks = runChecks({
      nowET,
      price,
      prevPrice,
      direction,
      breakoutLevel: level.price,
      regimeInfo,
      flipPointEs,
      walls,
      flowGrade,
      config,
    });
    if (!checks.pass) {
      return { strategy: "B", direction, level, levelKey, veto: checks.vetoReason };
    }

    const entryPrice = price;
    const stop = computeStructuralStop({
      structureHigh: level.rangeHigh ?? null,
      structureLow: level.rangeLow ?? null,
      entryPrice,
      direction,
      stopCapPts: config.strategyA.stopCapPts,
    });
    if (!stop.valid) {
      return { strategy: "B", direction, level, levelKey, veto: "stop_exceeds_cap" };
    }

    const target = computeTarget({
      direction,
      entryPrice,
      levels,
      maxDistancePts: config.strategyA.targetMaxDistancePts,
      fixedTargetR: config.strategyA.fixedTargetR,
      stopDistance: stop.distance,
    });
    const targetDistance = Math.abs(target.targetPrice - entryPrice);
    if (targetDistance < stop.distance) {
      return { strategy: "B", direction, level, levelKey, veto: "stop_exceeds_target" };
    }

    return {
      strategy: "B",
      direction,
      level,
      levelKey,
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

  return null;
}
