import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeStructuralStop,
  computeTarget,
  rMultiple,
  checkBreakeven,
} from "../src/tradeManagement.js";

test("computeStructuralStop: uses the structure midpoint when a structure is given", () => {
  const stop = computeStructuralStop({
    structureHigh: 5525,
    structureLow: 5500,
    entryPrice: 5526,
    direction: "long",
    stopCapPts: 12,
  });
  assert.equal(stop.stopPrice, 5512.5);
  assert.equal(stop.distance, 13.5);
  assert.equal(stop.valid, false); // exceeds the 12pt cap
});

test("computeStructuralStop: valid when within the cap", () => {
  const stop = computeStructuralStop({
    structureHigh: 5525,
    structureLow: 5515,
    entryPrice: 5526,
    direction: "long",
    stopCapPts: 12,
  });
  assert.equal(stop.stopPrice, 5520);
  assert.equal(stop.distance, 6);
  assert.equal(stop.valid, true);
});

test("computeStructuralStop: falls back to the cap distance itself when no structure is given", () => {
  const long = computeStructuralStop({
    structureHigh: null,
    structureLow: null,
    entryPrice: 5500,
    direction: "long",
    stopCapPts: 12,
  });
  assert.equal(long.stopPrice, 5488);
  assert.equal(long.valid, true);

  const short = computeStructuralStop({
    structureHigh: null,
    structureLow: null,
    entryPrice: 5500,
    direction: "short",
    stopCapPts: 12,
  });
  assert.equal(short.stopPrice, 5512);
});

test("computeTarget: uses the nearest level ahead in the trade direction", () => {
  const levels = [
    { type: "FLIP", price: 5515 },
    { type: "GEX_WALL", price: 5540 },
    { type: "GEX_WALL", price: 5490 }, // behind, wrong direction
  ];
  const target = computeTarget({
    direction: "long",
    entryPrice: 5500,
    levels,
    maxDistancePts: 30,
    fixedTargetR: 2,
    stopDistance: 8,
  });
  assert.equal(target.mode, "level");
  assert.equal(target.targetPrice, 5515);
});

test("computeTarget: falls back to fixed R when no levels lie ahead", () => {
  const target = computeTarget({
    direction: "long",
    entryPrice: 5500,
    levels: [{ type: "GEX_WALL", price: 5490 }],
    maxDistancePts: 30,
    fixedTargetR: 2,
    stopDistance: 8,
  });
  assert.equal(target.mode, "fixed_R");
  assert.equal(target.targetPrice, 5516); // 5500 + 8*2
});

test("computeTarget: falls back to fixed R when the nearest level is beyond maxDistancePts", () => {
  const target = computeTarget({
    direction: "short",
    entryPrice: 5500,
    levels: [{ type: "FLIP", price: 5460 }],
    maxDistancePts: 30,
    fixedTargetR: 2,
    stopDistance: 8,
  });
  assert.equal(target.mode, "fixed_R");
  assert.equal(target.targetPrice, 5484); // 5500 - 8*2
});

test("rMultiple: long and short compute R relative to entry/stop distance", () => {
  assert.equal(rMultiple({ direction: "long", entryPrice: 5500, currentPrice: 5508, stopDistance: 8 }), 1);
  assert.equal(rMultiple({ direction: "short", entryPrice: 5500, currentPrice: 5492, stopDistance: 8 }), 1);
});

test("checkBreakeven: true once price reaches breakevenAtR, false before", () => {
  assert.equal(
    checkBreakeven({ direction: "long", entryPrice: 5500, stopDistance: 8, currentPrice: 5507, breakevenAtR: 1 }),
    false
  );
  assert.equal(
    checkBreakeven({ direction: "long", entryPrice: 5500, stopDistance: 8, currentPrice: 5508, breakevenAtR: 1 }),
    true
  );
});
