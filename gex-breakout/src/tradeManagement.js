export function computeStructuralStop({ structureHigh, structureLow, entryPrice, direction, stopCapPts }) {
  let stopPrice;
  if (structureHigh != null && structureLow != null) {
    stopPrice = (structureHigh + structureLow) / 2;
  } else {
    stopPrice = direction === "long" ? entryPrice - stopCapPts : entryPrice + stopCapPts;
  }
  const distance = Math.abs(entryPrice - stopPrice);
  return { valid: distance <= stopCapPts, distance, stopPrice };
}

export function computeTarget({ direction, entryPrice, levels, maxDistancePts, fixedTargetR, stopDistance }) {
  const fixedR = () => ({
    targetPrice:
      direction === "long"
        ? entryPrice + stopDistance * fixedTargetR
        : entryPrice - stopDistance * fixedTargetR,
    mode: "fixed_R",
  });

  const ahead = levels.filter((l) => (direction === "long" ? l.price > entryPrice : l.price < entryPrice));
  if (!ahead.length) return fixedR();

  const nearest = ahead.reduce((closest, l) =>
    Math.abs(l.price - entryPrice) < Math.abs(closest.price - entryPrice) ? l : closest
  );
  const distance = Math.abs(nearest.price - entryPrice);
  if (distance > maxDistancePts) return fixedR();

  return { targetPrice: nearest.price, mode: "level", level: nearest };
}

export function rMultiple({ direction, entryPrice, currentPrice, stopDistance }) {
  return direction === "long"
    ? (currentPrice - entryPrice) / stopDistance
    : (entryPrice - currentPrice) / stopDistance;
}

export function checkBreakeven({ direction, entryPrice, stopDistance, currentPrice, breakevenAtR }) {
  return rMultiple({ direction, entryPrice, currentPrice, stopDistance }) >= breakevenAtR;
}
