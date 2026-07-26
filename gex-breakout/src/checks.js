import { isFlipBreak } from "./regime.js";
import { directionalWallFilter } from "./levelEngine.js";

export function timeCheck(nowET, cutoffET) {
  const minutes = nowET.getHours() * 60 + nowET.getMinutes();
  return minutes < cutoffET.h * 60 + cutoffET.m;
}

export function regimeCheck({ regimeInfo, prevPrice, price, flipPointEs, posGammaOverride, flowGrade }) {
  if (regimeInfo.baseRegime === "NEG_GAMMA") return { pass: true };

  if (regimeInfo.nearFlip && isFlipBreak(prevPrice, price, flipPointEs)) {
    return { pass: true, viaFlipBreak: true };
  }

  if (posGammaOverride.enabled && flowGrade === posGammaOverride.requireFlowGrade) {
    return { pass: true, viaOverride: true };
  }

  return { pass: false };
}

export function flowGradeCheck(flowGrade, regimeResult) {
  if (regimeResult.viaOverride) return flowGrade === "A";
  return flowGrade === "A" || flowGrade === "B";
}

export function runChecks({
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
}) {
  if (!timeCheck(nowET, config.entryCutoffET)) {
    return { pass: false, vetoReason: "past_trading_cutoff" };
  }

  const regimeResult = regimeCheck({
    regimeInfo,
    prevPrice,
    price,
    flipPointEs,
    posGammaOverride: config.posGammaOverride,
    flowGrade,
  });
  if (!regimeResult.pass) {
    return { pass: false, vetoReason: "pos_gamma_no_confirmation" };
  }

  const wallResult = directionalWallFilter(breakoutLevel, direction, walls, config.levels.wallFilter);
  if (wallResult.action === "SKIP_OR_HALF" && config.levels.wallFilter.mode === "skip") {
    return { pass: false, vetoReason: "wall_too_close", wallResult };
  }

  if (!flowGradeCheck(flowGrade, regimeResult)) {
    return {
      pass: false,
      vetoReason: flowGrade === "F" ? "flow_grade_F" : "flow_grade_insufficient_for_override",
    };
  }

  const halfSize = wallResult.action === "SKIP_OR_HALF"; // only reachable when mode === "half_at_wall"
  return {
    pass: true,
    regimeResult,
    wallResult,
    sizeMultiplier: halfSize ? 0.5 : 1,
    targetCap: halfSize ? wallResult.wall.strike : null,
  };
}
