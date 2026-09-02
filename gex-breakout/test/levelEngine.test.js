import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOrderFlowWalls, directionalWallFilter } from "../src/levelEngine.js";

test("buildOrderFlowWalls: emits value-area high/low and POC, all tagged POS_WALL", () => {
  const walls = buildOrderFlowWalls({ valueArea: { high: 5510, low: 5490 }, poc: 5500 });
  assert.equal(walls.belowSpot.length, 0);
  assert.equal(walls.aboveSpot.length, 3);
  assert.ok(walls.aboveSpot.every((w) => w.wallType === "POS_WALL"));
  assert.ok(walls.aboveSpot.some((w) => w.strike === 5510 && w.source === "value_area_high"));
  assert.ok(walls.aboveSpot.some((w) => w.strike === 5490 && w.source === "value_area_low"));
  assert.ok(walls.aboveSpot.some((w) => w.strike === 5500 && w.source === "poc"));
});

test("buildOrderFlowWalls: empty when no value area or POC is available yet", () => {
  assert.deepEqual(buildOrderFlowWalls({ valueArea: null, poc: null }), { aboveSpot: [], belowSpot: [] });
});

const walls = {
  aboveSpot: [
    { strike: 5525, wallType: "POS_WALL" },
    { strike: 5550, wallType: "POS_WALL" },
  ],
  belowSpot: [
    { strike: 5480, wallType: "POS_WALL" },
    { strike: 5460, wallType: "POS_WALL" },
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

test("directionalWallFilter skips a short breakout into a near wall regardless of which side it sits on", () => {
  const result = directionalWallFilter(5482, "short", walls, { nearPts: 15 });
  assert.equal(result.action, "SKIP_OR_HALF");
  assert.equal(result.wall.strike, 5480);
});

test("directionalWallFilter returns FULL with no wall when nothing lies ahead", () => {
  const result = directionalWallFilter(5600, "long", walls, { nearPts: 15 });
  assert.equal(result.action, "FULL");
  assert.equal(result.wall, null);
});
