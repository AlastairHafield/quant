import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRiskManager, computeSizeMultiplier } from "../src/riskSession.js";

test("SessionRiskManager: a single winning trade halts that strategy for the day", () => {
  const mgr = new SessionRiskManager({ maxLossesPerStrategyPerDay: 2 });
  assert.equal(mgr.canTrade("OF"), true);
  mgr.recordTradeResult("OF", 50);
  assert.equal(mgr.canTrade("OF"), false);
});

test("SessionRiskManager: halts a strategy after maxLossesPerStrategyPerDay losers, win or no win", () => {
  const mgr = new SessionRiskManager({ maxLossesPerStrategyPerDay: 2 });
  mgr.recordTradeResult("OF", -100);
  assert.equal(mgr.canTrade("OF"), true);
  mgr.recordTradeResult("OF", -50);
  assert.equal(mgr.canTrade("OF"), false);
});

test("SessionRiskManager: an unrecognized strategy (e.g. 'reconciled') is a no-op, not a crash", () => {
  const mgr = new SessionRiskManager({ maxLossesPerStrategyPerDay: 2 });
  mgr.recordTradeResult("reconciled", -100);
  assert.equal(mgr.haltedStrategies.size, 0);
});

test("SessionRiskManager: tracks Order Flow Bot zone cooldowns", () => {
  const mgr = new SessionRiskManager({ maxLossesPerStrategyPerDay: 2 });
  mgr.recordOrderFlowTrade("VA_HIGH:5530.00", 1000);
  assert.equal(mgr.dayState.orderFlowTradesToday, 1);
  assert.equal(mgr.dayState.zoneCooldowns.get("VA_HIGH:5530.00"), 1000);
});

test("SessionRiskManager: resetDay clears all day-scoped state", () => {
  const mgr = new SessionRiskManager({ maxLossesPerStrategyPerDay: 2 });
  mgr.recordTradeResult("OF", -100);
  mgr.recordTradeResult("OF", -50);
  mgr.recordOrderFlowTrade("VA_HIGH:5530.00", 1000);
  mgr.resetDay();
  assert.equal(mgr.canTrade("OF"), true);
  assert.equal(mgr.dayState.orderFlowTradesToday, 0);
  assert.equal(mgr.dayState.zoneCooldowns.size, 0);
});

test("computeSizeMultiplier: combines flow-grade sizing with the wall-filter multiplier", () => {
  const sizingCfg = { A: 1, B: 0.5 };
  assert.equal(computeSizeMultiplier("A", 1, sizingCfg), 1);
  assert.equal(computeSizeMultiplier("B", 1, sizingCfg), 0.5);
  assert.equal(computeSizeMultiplier("A", 0.5, sizingCfg), 0.5); // A-grade but breaking near a wall
  assert.equal(computeSizeMultiplier("B", 0.5, sizingCfg), 0.25);
});
