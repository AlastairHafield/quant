import { detectDeltaDivergence, detectAbsorption } from "./orderFlow.js";

export function checkFailedBreakout({ direction, currentClose, brokenLevel, failedBreakoutPts }) {
  return direction === "long"
    ? currentClose < brokenLevel - failedBreakoutPts
    : currentClose > brokenLevel + failedBreakoutPts;
}

export function checkDivergenceAfterEntry({
  bars,
  entryIndex,
  currentIndex,
  divergenceLookbackBars,
  withinBars,
}) {
  if (currentIndex - entryIndex > withinBars) return false;
  return detectDeltaDivergence(bars, currentIndex, { lookbackBars: divergenceLookbackBars });
}

export function regimeFlipToPosGamma({ prevRegimeBase, currentRegimeBase, inOpenSpace }) {
  return prevRegimeBase !== "POS_GAMMA" && currentRegimeBase === "POS_GAMMA" && inOpenSpace;
}

export function evaluateExit(ctx) {
  const {
    direction,
    currentBar,
    brokenLevel,
    entryIndex,
    currentIndex,
    bars,
    inOpenSpace,
    prevRegimeBase,
    currentRegimeBase,
    touchWindow,
    priorBars,
    levelPriceForAbsorption,
    config,
  } = ctx;

  if (
    checkFailedBreakout({
      direction,
      currentClose: currentBar.close,
      brokenLevel,
      failedBreakoutPts: config.exit.failedBreakoutPts,
    })
  ) {
    return { action: "EXIT_NOW", reason: "failed_breakout" };
  }

  if (
    checkDivergenceAfterEntry({
      bars,
      entryIndex,
      currentIndex,
      divergenceLookbackBars: config.orderFlow.divergenceLookbackBars,
      withinBars: config.exit.divergenceWithinBarsOfEntry,
    })
  ) {
    return { action: "EXIT_NOW", reason: "delta_divergence_after_entry" };
  }

  if (
    touchWindow &&
    levelPriceForAbsorption != null &&
    detectAbsorption(touchWindow, priorBars, levelPriceForAbsorption, direction, config.orderFlow.absorption)
  ) {
    return { action: "TAKE_PARTIAL", reason: "absorption_at_level" };
  }

  if (regimeFlipToPosGamma({ prevRegimeBase, currentRegimeBase, inOpenSpace })) {
    return {
      action: "TIGHTEN_TRAIL",
      reason: "regime_flipped_to_pos_gamma",
      trailBars: config.exit.posGammaTrailBars,
    };
  }

  return { action: "HOLD" };
}
