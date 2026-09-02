// TopstepX-only substitute for GEX strike walls, used by the Order Flow
// Bot's own directionalWallFilter call (worker.js's tryOrderFlow) since GEX/
// FlashAlpha removal — the session's value-area edges and POC stand in for
// "a level that's already absorbed real volume and could stall a
// continuation move," the same role GEX strike walls played. Every level
// here is tagged POS_WALL since that's the only wallType
// directionalWallFilter's skip/half-size logic actually inspects.
export function buildOrderFlowWalls({ valueArea, poc }) {
  const walls = [];
  if (valueArea?.high != null) walls.push({ strike: valueArea.high, wallType: "POS_WALL", source: "value_area_high" });
  if (valueArea?.low != null) walls.push({ strike: valueArea.low, wallType: "POS_WALL", source: "value_area_low" });
  if (poc != null) walls.push({ strike: poc, wallType: "POS_WALL", source: "poc" });
  return { aboveSpot: walls, belowSpot: [] };
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
