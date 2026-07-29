export function buildGexLevels(gexSnapshot) {
  const levels = [];
  if (gexSnapshot.flipPoint != null) {
    levels.push({
      type: "FLIP",
      price: gexSnapshot.flipPoint,
      role: "breakout_trigger_and_regime_boundary",
    });
  }
  for (const w of [...gexSnapshot.walls.aboveSpot, ...gexSnapshot.walls.belowSpot]) {
    levels.push({
      type: "GEX_WALL",
      price: w.strike,
      wallType: w.wallType,
      gex: w.gex,
      role: "target_and_filter",
    });
  }
  return levels;
}

export function buildDailyLevels({ priorDayHigh, priorDayLow, overnightHigh, overnightLow }) {
  return [
    { type: "PRIOR_DAY_HIGH", price: priorDayHigh, role: "strategyB_trigger" },
    { type: "PRIOR_DAY_LOW", price: priorDayLow, role: "strategyB_trigger" },
    { type: "OVERNIGHT_HIGH", price: overnightHigh, role: "strategyB_trigger" },
    { type: "OVERNIGHT_LOW", price: overnightLow, role: "strategyB_trigger" },
  ].filter((l) => l.price != null);
}

export function detectConsolidation(bars, { lookbackBars, maxRangePts }) {
  if (bars.length < lookbackBars) return null;
  const window = bars.slice(-lookbackBars);
  const rangeHigh = Math.max(...window.map((b) => b.high ?? b.close));
  const rangeLow = Math.min(...window.map((b) => b.low ?? b.close));
  if (rangeHigh - rangeLow > maxRangePts) return null;
  return { high: rangeHigh, low: rangeLow, barsCount: lookbackBars };
}

export function consolidationLevels(range) {
  if (!range) return [];
  return [
    { type: "CONSOL_HIGH", price: range.high, role: "strategyB_trigger", rangeHigh: range.high, rangeLow: range.low },
    { type: "CONSOL_LOW", price: range.low, role: "strategyB_trigger", rangeHigh: range.high, rangeLow: range.low },
  ];
}

export function directionalWallFilter(breakoutPrice, direction, walls, { nearPts }) {
  const allWalls = [...walls.aboveSpot, ...walls.belowSpot];
  const ahead = allWalls.filter((w) =>
    direction === "long" ? w.strike > breakoutPrice : w.strike < breakoutPrice
  );
  if (!ahead.length) return { action: "FULL", wall: null, distance: null };

  const nearest = ahead.reduce((closest, w) =>
    Math.abs(w.strike - breakoutPrice) < Math.abs(closest.strike - breakoutPrice) ? w : closest
  );
  const distance = Math.abs(nearest.strike - breakoutPrice);

  if (nearest.wallType === "POS_WALL" && distance < nearPts) {
    return { action: "SKIP_OR_HALF", wall: nearest, distance };
  }
  return { action: "FULL", wall: nearest, distance };
}

// Whether an open position still has room to run before hitting a wall — used
// by evaluateExit's regime-flip check (exitRules.js), which only tightens the
// trail if there's actually open space left to trail through. Reuses
// directionalWallFilter's same POS_WALL-proximity judgment already trusted
// for entry-time decisions, rather than defining a second notion of "near a
// wall."
export function isInOpenSpace(price, direction, walls, wallFilterCfg) {
  return directionalWallFilter(price, direction, walls, wallFilterCfg).action !== "SKIP_OR_HALF";
}
