import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SessionRiskManager,
  checkDataHealth,
  checkRecalcSettle,
  computeSizeMultiplier,
} from "../src/riskSession.js";
import { CONFIG } from "../src/config.js";

test("SessionRiskManager: a single winning trade halts that strategy for the day", () => {
  const mgr = new SessionRiskManager({ maxLossesPerStrategyPerDay: 2 });
  assert.equal(mgr.canTrade("A"), true);
  mgr.recordTradeResult("A", 50);
  assert.equal(mgr.canTrade("A"), false);
  assert.equal(mgr.canTrade("B"), true); // unaffected — halts are per strategy
});

test("SessionRiskManager: halts a strategy after maxLossesPerStrategyPerDay losers, win or no win", () => {
  const mgr = new SessionRiskManager({ maxLossesPerStrategyPerDay: 2 });
  mgr.recordTradeResult("B", -100);
  assert.equal(mgr.canTrade("B"), true);
  mgr.recordTradeResult("B", -50);
  assert.equal(mgr.canTrade("B"), false);
});

test("SessionRiskManager: strategies A and B are tracked fully independently", () => {
  const mgr = new SessionRiskManager({ maxLossesPerStrategyPerDay: 2 });
  mgr.recordTradeResult("A", -100);
  mgr.recordTradeResult("A", -50); // A halted (2 losses)
  mgr.recordTradeResult("B", 25); // B halted (1 win)
  assert.equal(mgr.canTrade("A"), false);
  assert.equal(mgr.canTrade("B"), false);
  assert.equal(mgr.lossesToday.A, 2);
  assert.equal(mgr.winsToday.B, 1);
});

test("SessionRiskManager: an unrecognized strategy (e.g. 'reconciled') is a no-op, not a crash", () => {
  const mgr = new SessionRiskManager({ maxLossesPerStrategyPerDay: 2 });
  mgr.recordTradeResult("reconciled", -100);
  assert.equal(mgr.haltedStrategies.size, 0);
});

test("SessionRiskManager: tracks ORB directions traded and Strategy B trades/cooldowns", () => {
  const mgr = new SessionRiskManager({ maxLossesPerStrategyPerDay: 2 });
  mgr.recordOrbTrade("long");
  mgr.recordStrategyBTrade("PRIOR_DAY_HIGH:5530.00", 1000);
  assert.equal(mgr.dayState.orbTradedDirections.has("long"), true);
  assert.equal(mgr.dayState.strategyBTradesToday, 1);
  assert.equal(mgr.dayState.levelCooldowns.get("PRIOR_DAY_HIGH:5530.00"), 1000);
});

test("SessionRiskManager: resetDay clears all day-scoped state", () => {
  const mgr = new SessionRiskManager({ maxLossesPerStrategyPerDay: 2 });
  mgr.recordTradeResult("A", -100);
  mgr.recordTradeResult("A", -50);
  mgr.recordOrbTrade("long");
  mgr.recordStrategyBTrade("X:1.00", 500);
  mgr.resetDay();
  assert.equal(mgr.canTrade("A"), true);
  assert.equal(mgr.dayState.orbTradedDirections.size, 0);
  assert.equal(mgr.dayState.strategyBTradesToday, 0);
  assert.equal(mgr.dayState.levelCooldowns.size, 0);
});

const haltCfg = CONFIG.risk.halt;

test("checkDataHealth: healthy when basis and delta feed are both fresh", () => {
  const now = new Date("2026-07-24T14:10:00Z");
  const result = checkDataHealth({
    basisAsOf: new Date("2026-07-24T14:05:00Z"),
    deltaFeedLastBarAt: new Date("2026-07-24T14:09:00Z"),
    now,
    haltCfg,
  });
  assert.equal(result.healthy, true);
});

test("checkDataHealth: unhealthy when basis is stale beyond the max age", () => {
  const now = new Date("2026-07-24T14:20:00Z");
  const result = checkDataHealth({
    basisAsOf: new Date("2026-07-24T14:05:00Z"), // 15 min old, cap is 10
    deltaFeedLastBarAt: new Date("2026-07-24T14:19:00Z"),
    now,
    haltCfg,
  });
  assert.equal(result.healthy, false);
  assert.equal(result.reason, "basis_stale");
});

test("checkDataHealth: unhealthy when the delta feed has gapped beyond the max", () => {
  const now = new Date("2026-07-24T14:10:00Z");
  const result = checkDataHealth({
    basisAsOf: new Date("2026-07-24T14:08:00Z"),
    deltaFeedLastBarAt: new Date("2026-07-24T14:05:00Z"), // 5 min gap, cap is 2
    now,
    haltCfg,
  });
  assert.equal(result.healthy, false);
  assert.equal(result.reason, "delta_feed_gap");
});

const settleCfg = CONFIG.risk.recalcSettle;

test("checkRecalcSettle: blocks entries just after a recalc that moved the flip a lot", () => {
  const result = checkRecalcSettle({
    flipMovedPts: 8,
    recalcAt: new Date("2026-07-24T14:15:00Z"),
    now: new Date("2026-07-24T14:15:30Z"),
    settleCfg,
  });
  assert.equal(result, true);
});

test("checkRecalcSettle: allows entries once the settle window has passed", () => {
  const result = checkRecalcSettle({
    flipMovedPts: 8,
    recalcAt: new Date("2026-07-24T14:15:00Z"),
    now: new Date("2026-07-24T14:17:00Z"),
    settleCfg,
  });
  assert.equal(result, false);
});

test("checkRecalcSettle: allows entries when the flip barely moved, even right after recalc", () => {
  const result = checkRecalcSettle({
    flipMovedPts: 1,
    recalcAt: new Date("2026-07-24T14:15:00Z"),
    now: new Date("2026-07-24T14:15:10Z"),
    settleCfg,
  });
  assert.equal(result, false);
});

test("computeSizeMultiplier: combines flow-grade sizing with the wall-filter multiplier", () => {
  const sizingCfg = { A: 1, B: 0.5 };
  assert.equal(computeSizeMultiplier("A", 1, sizingCfg), 1);
  assert.equal(computeSizeMultiplier("B", 1, sizingCfg), 0.5);
  assert.equal(computeSizeMultiplier("A", 0.5, sizingCfg), 0.5); // A-grade but breaking near a wall
  assert.equal(computeSizeMultiplier("B", 0.5, sizingCfg), 0.25);
});
