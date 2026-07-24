import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOrbTrigger, evaluateStrategyA } from "../src/strategyA.js";
import { CONFIG } from "../src/config.js";

test("checkOrbTrigger: long/short/no-trigger with the buffer applied", () => {
  const args = { orbHigh: 5525, orbLow: 5500, triggerBufferPts: 1 };
  assert.equal(checkOrbTrigger({ price: 5526.5, ...args }), "long");
  assert.equal(checkOrbTrigger({ price: 5498.5, ...args }), "short");
  assert.equal(checkOrbTrigger({ price: 5525.5, ...args }), null); // inside the buffer
  assert.equal(checkOrbTrigger({ price: 5510, ...args }), null);
});

function baseCtx(overrides = {}) {
  return {
    price: 5527,
    prevPrice: 5524,
    orbHigh: 5525,
    orbLow: 5518, // tight ORB so mid-range stop stays under the 12pt cap
    regimeInfo: { baseRegime: "NEG_GAMMA", nearFlip: false, regime: "NEG_GAMMA" },
    flipPointEs: 5450,
    walls: { aboveSpot: [], belowSpot: [] },
    flowGrade: "A",
    levels: [{ type: "FLIP", price: 5545 }],
    nowET: new Date(2026, 6, 24, 9, 46),
    config: structuredClone(CONFIG),
    dayState: { orbTradedDirections: new Set() },
    ...overrides,
  };
}

test("evaluateStrategyA: no signal when price is inside the ORB + buffer", () => {
  assert.equal(evaluateStrategyA(baseCtx({ price: 5520 })), null);
});

test("evaluateStrategyA: vetoes a direction already traded today", () => {
  const ctx = baseCtx({ dayState: { orbTradedDirections: new Set(["long"]) } });
  const result = evaluateStrategyA(ctx);
  assert.equal(result.veto, "orb_direction_already_traded");
});

test("evaluateStrategyA: vetoes POS_GAMMA with no confirmation", () => {
  const ctx = baseCtx({ regimeInfo: { baseRegime: "POS_GAMMA", nearFlip: false, regime: "POS_GAMMA" } });
  const result = evaluateStrategyA(ctx);
  assert.equal(result.veto, "pos_gamma_no_confirmation");
});

test("evaluateStrategyA: vetoes when the structural stop exceeds the cap", () => {
  const ctx = baseCtx({ orbHigh: 5525, orbLow: 5495 }); // 30pt range -> mid-stop distance way over 12pt cap
  const result = evaluateStrategyA(ctx);
  assert.equal(result.veto, "stop_exceeds_cap");
});

test("evaluateStrategyA: produces a full signal on a clean NEG_GAMMA breakout with a GEX level target", () => {
  const result = evaluateStrategyA(baseCtx());
  assert.equal(result.veto, null);
  assert.equal(result.direction, "long");
  assert.equal(result.entryPrice, 5527);
  assert.equal(result.stopPrice, 5521.5); // mid of 5525/5518
  assert.equal(result.targetMode, "level");
  assert.equal(result.targetPrice, 5545);
  assert.equal(result.sizeMultiplier, 1);
});

test("evaluateStrategyA: falls back to fixed_R target when no GEX level lies ahead", () => {
  const ctx = baseCtx({ levels: [] });
  const result = evaluateStrategyA(ctx);
  assert.equal(result.targetMode, "fixed_R");
  const expectedR = result.stopDistance * CONFIG.strategyA.fixedTargetR;
  assert.equal(result.targetPrice, result.entryPrice + expectedR);
});

test("evaluateStrategyA: short breakout below ORB low works symmetrically", () => {
  const ctx = baseCtx({
    price: 5511,
    prevPrice: 5514,
    orbHigh: 5522,
    orbLow: 5515,
    levels: [{ type: "GEX_WALL", price: 5495 }],
  });
  const result = evaluateStrategyA(ctx);
  assert.equal(result.direction, "short");
  assert.equal(result.stopPrice, 5518.5);
  assert.equal(result.targetPrice, 5495);
});
