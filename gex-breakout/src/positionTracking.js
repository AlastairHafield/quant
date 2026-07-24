// MFE/MAE (Maximum Favorable/Adverse Excursion), in points, always positive —
// "how far did price run in our favor / against us at any point" regardless of
// whether the trade ultimately won or lost. Used to later evaluate whether dynamic
// management (breakeven, trailing) would actually have helped, against real data
// instead of a guess.
export function barExcursion(entryPrice, direction, bar) {
  if (direction === "long") {
    return { favorable: bar.high - entryPrice, adverse: entryPrice - bar.low };
  }
  return { favorable: entryPrice - bar.low, adverse: bar.high - entryPrice };
}

export function updateMfeMae(current, entryPrice, direction, bar) {
  const { favorable, adverse } = barExcursion(entryPrice, direction, bar);
  return {
    mfe: Math.max(current.mfe, favorable),
    mae: Math.max(current.mae, adverse),
  };
}

// Realized $ P&L for a closed trade — direction-signed points × contract
// multiplier × size.
export function computeRealizedPnl(entryPrice, exitPrice, direction, pointValue, size) {
  const pts = direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return pts * pointValue * size;
}

// $ value of risk no longer exposed after an early EXIT_NOW, vs. riding to the
// original stop — the distance between where we actually got out and where
// the original stop sat, computed at the moment of exit (no future
// simulation needed to know whether the stop would have been hit).
export function computeExitNowValueSaved(exitPrice, originalStopPrice, pointValue, size) {
  return Math.abs(exitPrice - originalStopPrice) * pointValue * size;
}

// $ reduction in maximum possible loss from tightening a resting stop.
export function computeTightenTrailValueSaved(oldStopPrice, newStopPrice, pointValue, size) {
  return Math.abs(newStopPrice - oldStopPrice) * pointValue * size;
}

// $ profit locked in on the reduced portion of a TAKE_PARTIAL, realized
// immediately regardless of what happens to the remaining runner.
export function computeTakePartialValueGained(entryPrice, currentPrice, direction, pointValue, partialSize) {
  const pts = direction === "long" ? currentPrice - entryPrice : entryPrice - currentPrice;
  return pts * pointValue * partialSize;
}
