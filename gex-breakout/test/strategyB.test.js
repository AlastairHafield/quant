import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkBreakoutTrigger,
  checkProximity,
  levelKeyFor,
  isLevelOnCooldown,
  evaluateStrategyB,
} from "../src/strategyB.js";
import { CONFIG } from "../src/config.js";

test("checkBreakoutTrigger: long/short/no-trigger with the buffer applied", () => {
  const level = { price: 5500 };
  assert.equal(checkBreakoutTrigger(5501.5, level, 1), "long");
  assert.equal(checkBreakoutTrigger(5498.5, level, 1), "short");
  assert.equal(checkBreakoutTrigger(5500.5, level, 1), null);
});

function closeBars(prices) {
  return prices.map((close) => ({ close }));
}

test("checkProximity: passes when every bar in the window sits within range of the level", () => {
  const bars = closeBars(Array(15).fill(5502));
  assert.equal(checkProximity(bars, 5500, { withinPts: 10, forMinutes: 15 }), true);
});

test("checkProximity: fails with too few prior bars", () => {
  const bars = closeBars(Array(10).fill(5502));
  assert.equal(checkProximity(bars, 5500, { withinPts: 10, forMinutes: 15 }), false);
});

test("checkProximity: fails if any bar in the window strayed outside the range", () => {
  const bars = closeBars([...Array(14).fill(5502), 5515]);
  assert.equal(checkProximity(bars, 5500, { withinPts: 10, forMinutes: 15 }), false);
});

test("levelKeyFor: formats a stable key from type and price", () => {
  assert.equal(levelKeyFor({ type: "PRIOR_DAY_HIGH", price: 5530.125 }), "PRIOR_DAY_HIGH:5530.13");
});

test("isLevelOnCooldown: true within the window, false after it expires or if never traded", () => {
  const cooldownMap = new Map([["PRIOR_DAY_HIGH:5530.00", 1000 * 60 * 10]]); // traded at t=10min (in ms)
  assert.equal(isLevelOnCooldown("PRIOR_DAY_HIGH:5530.00", cooldownMap, 1000 * 60 * 30, 60), true); // 20 min later
  assert.equal(isLevelOnCooldown("PRIOR_DAY_HIGH:5530.00", cooldownMap, 1000 * 60 * 80, 60), false); // 70 min later
  assert.equal(isLevelOnCooldown("OTHER:1.00", cooldownMap, 1000 * 60 * 30, 60), false);
});

function baseCtx(overrides = {}) {
  return {
    price: 5532,
    prevPrice: 5528,
    priorBars: closeBars(Array(15).fill(5529)),
    triggerLevels: [{ type: "PRIOR_DAY_HIGH", price: 5530 }],
    regimeInfo: { baseRegime: "NEG_GAMMA", nearFlip: false, regime: "NEG_GAMMA" },
    flipPointEs: 5450,
    walls: { aboveSpot: [], belowSpot: [] },
    flowGrade: "A",
    levels: [{ type: "FLIP", price: 5560 }],
    nowET: new Date(2026, 6, 24, 11, 0),
    nowMs: 1000 * 60 * 100,
    config: structuredClone(CONFIG),
    dayState: { strategyBTradesToday: 0, levelCooldowns: new Map() },
    ...overrides,
  };
}

test("evaluateStrategyB: vetoes once the daily trade cap is reached", () => {
  const ctx = baseCtx({ dayState: { strategyBTradesToday: 3, levelCooldowns: new Map() } });
  const result = evaluateStrategyB(ctx);
  assert.equal(result.veto, "max_trades_per_day_reached");
});

test("evaluateStrategyB: no signal when no candidate level triggers", () => {
  const ctx = baseCtx({ price: 5529 });
  assert.equal(evaluateStrategyB(ctx), null);
});

test("evaluateStrategyB: skips a level still on cooldown, falling through to no signal", () => {
  const cooldownMap = new Map([["PRIOR_DAY_HIGH:5530.00", 1000 * 60 * 90]]); // traded 10 min ago
  const ctx = baseCtx({ dayState: { strategyBTradesToday: 0, levelCooldowns: cooldownMap } });
  assert.equal(evaluateStrategyB(ctx), null);
});

test("evaluateStrategyB: skips a level that hasn't met the proximity requirement", () => {
  const ctx = baseCtx({ priorBars: closeBars(Array(15).fill(5510)) }); // never spent time near 5530
  assert.equal(evaluateStrategyB(ctx), null);
});

test("evaluateStrategyB: produces a full signal with a GEX-level target on a clean breakout", () => {
  const result = evaluateStrategyB(baseCtx());
  assert.equal(result.veto, null);
  assert.equal(result.direction, "long");
  assert.equal(result.level.type, "PRIOR_DAY_HIGH");
  assert.equal(result.entryPrice, 5532);
  assert.equal(result.targetMode, "level");
  assert.equal(result.targetPrice, 5560);
});

test("evaluateStrategyB: uses the consolidation range for the structural stop when present", () => {
  const ctx = baseCtx({
    price: 5509,
    prevPrice: 5506,
    priorBars: closeBars(Array(15).fill(5503)),
    triggerLevels: [{ type: "CONSOL_HIGH", price: 5507.5, rangeHigh: 5507.5, rangeLow: 5500 }],
  });
  const result = evaluateStrategyB(ctx);
  assert.equal(result.veto, null);
  assert.equal(result.stopPrice, 5503.75); // mid of 5507.5/5500
});

test("evaluateStrategyB: vetoes when the resulting structural stop exceeds the cap", () => {
  const ctx = baseCtx({
    price: 5542,
    prevPrice: 5538,
    priorBars: closeBars(Array(15).fill(5535)),
    triggerLevels: [{ type: "CONSOL_HIGH", price: 5540, rangeHigh: 5540, rangeLow: 5500 }],
  });
  const result = evaluateStrategyB(ctx);
  assert.equal(result.veto, "stop_exceeds_cap");
});

test("evaluateStrategyB: propagates a veto reason from the shared checks (e.g. flow grade F)", () => {
  const ctx = baseCtx({ flowGrade: "F" });
  const result = evaluateStrategyB(ctx);
  assert.equal(result.veto, "flow_grade_F");
});
