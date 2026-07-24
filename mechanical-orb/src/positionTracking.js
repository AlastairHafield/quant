// MFE/MAE (Maximum Favorable/Adverse Excursion), in points, always positive —
// "how far did price run in our favor / against us at any point" regardless of
// whether the trade ultimately won or lost. Used to later evaluate whether dynamic
// management (a moving stop, etc.) would actually have helped, against real data
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
