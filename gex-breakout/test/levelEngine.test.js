import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGexLevels,
  buildDailyLevels,
  detectConsolidation,
  consolidationLevels,
  directionalWallFilter,
  isInOpenSpace,
} from "../src/levelEngine.js";

test("buildGexLevels emits the flip point and all wall levels", () => {
  const gexSnapshot = {
    flipPoint: 5510.5,
    walls: {
      aboveSpot: [{ strike: 5525, gex: 5e9, wallType: "POS_WALL" }],
      belowSpot: [{ strike: 5480, gex: -4e9, wallType: "NEG_WALL" }],
    },
  };
  const levels = buildGexLevels(gexSnapshot);
  assert.equal(levels.length, 3);
  assert.equal(levels[0].type, "FLIP");
  assert.equal(levels[0].price, 5510.5);
  assert.ok(levels.some((l) => l.type === "GEX_WALL" && l.price === 5525 && l.wallType === "POS_WALL"));
  assert.ok(levels.some((l) => l.type === "GEX_WALL" && l.price === 5480 && l.wallType === "NEG_WALL"));
});

test("buildGexLevels omits the flip level when there is no crossing", () => {
  const levels = buildGexLevels({ flipPoint: null, walls: { aboveSpot: [], belowSpot: [] } });
  assert.equal(levels.length, 0);
});

test("buildDailyLevels filters out missing prior/overnight levels", () => {
  const levels = buildDailyLevels({
    priorDayHigh: 5530,
    priorDayLow: 5490,
    overnightHigh: null,
    overnightLow: undefined,
  });
  assert.deepEqual(
    levels.map((l) => l.type),
    ["PRIOR_DAY_HIGH", "PRIOR_DAY_LOW"]
  );
});

function bar(high, low) {
  return { high, low };
}

test("detectConsolidation finds a qualifying range in the most recent lookback window", () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(100 + (i % 3), 100 - (i % 2)));
  const range = detectConsolidation(bars, { lookbackBars: 20, maxRangePts: 8 });
  assert.ok(range);
  assert.equal(range.high, Math.max(...bars.map((b) => b.high)));
  assert.equal(range.low, Math.min(...bars.map((b) => b.low)));
});

test("detectConsolidation returns null when the range is too wide", () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(100 + i, 100));
  const range = detectConsolidation(bars, { lookbackBars: 20, maxRangePts: 8 });
  assert.equal(range, null);
});

test("detectConsolidation returns null with fewer bars than the lookback", () => {
  const bars = Array.from({ length: 5 }, () => bar(101, 100));
  assert.equal(detectConsolidation(bars, { lookbackBars: 20, maxRangePts: 8 }), null);
});

test("consolidationLevels converts a range into strategyB trigger levels, carrying the range bounds", () => {
  assert.deepEqual(consolidationLevels({ high: 106, low: 100 }), [
    { type: "CONSOL_HIGH", price: 106, role: "strategyB_trigger", rangeHigh: 106, rangeLow: 100 },
    { type: "CONSOL_LOW", price: 100, role: "strategyB_trigger", rangeHigh: 106, rangeLow: 100 },
  ]);
  assert.deepEqual(consolidationLevels(null), []);
});

const walls = {
  aboveSpot: [
    { strike: 5525, gex: 5e9, wallType: "POS_WALL" },
    { strike: 5550, gex: 1e9, wallType: "POS_WALL" },
  ],
  belowSpot: [
    { strike: 5480, gex: -4e9, wallType: "NEG_WALL" },
    { strike: 5460, gex: -1e9, wallType: "NEG_WALL" },
  ],
};

test("directionalWallFilter skips a long breakout into a near POS wall", () => {
  const result = directionalWallFilter(5518, "long", walls, { nearPts: 15 });
  assert.equal(result.action, "SKIP_OR_HALF");
  assert.equal(result.wall.strike, 5525);
  assert.equal(result.distance, 7);
});

test("directionalWallFilter allows a long breakout with open space ahead", () => {
  const result = directionalWallFilter(5500, "long", walls, { nearPts: 15 });
  assert.equal(result.action, "FULL");
  assert.equal(result.wall.strike, 5525);
});

test("directionalWallFilter allows a short breakout toward a near NEG wall (support, not resistance)", () => {
  const result = directionalWallFilter(5482, "short", walls, { nearPts: 15 });
  assert.equal(result.action, "FULL");
  assert.equal(result.wall.strike, 5480);
});

test("isInOpenSpace: false when a POS wall is close ahead, true otherwise", () => {
  assert.equal(isInOpenSpace(5518, "long", walls, { nearPts: 15 }), false);
  assert.equal(isInOpenSpace(5500, "long", walls, { nearPts: 15 }), true);
  assert.equal(isInOpenSpace(5482, "short", walls, { nearPts: 15 }), true); // NEG wall ahead doesn't count
});

test("directionalWallFilter skips a short breakout into a near POS wall regardless of which side it sits on", () => {
  const mixedWalls = { aboveSpot: [], belowSpot: [{ strike: 5480, gex: 2e9, wallType: "POS_WALL" }] };
  const result = directionalWallFilter(5490, "short", mixedWalls, { nearPts: 15 });
  assert.equal(result.action, "SKIP_OR_HALF");
});

test("directionalWallFilter returns FULL with no wall when nothing lies ahead", () => {
  const result = directionalWallFilter(5600, "long", walls, { nearPts: 15 });
  assert.equal(result.action, "FULL");
  assert.equal(result.wall, null);
});
