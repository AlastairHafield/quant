import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTradeStats, computeVetoBreakdown, computeDynamicExitStats, computeDailySummary } from "../src/dailySummary.js";

test("computeTradeStats: win rate, avg R-multiple, and $ P&L across closed trades only", () => {
  const trades = [
    { status: "closed", strategy: "A", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: 5520, realizedPnl: 100 }, // +2R
    { status: "closed", strategy: "B", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: 5495, realizedPnl: -25 }, // -0.5R
    { status: "open", strategy: "A", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: null, realizedPnl: null }, // ignored
  ];
  const stats = computeTradeStats(trades);
  assert.equal(stats.totalTrades, 2);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1);
  assert.equal(stats.winRate, 0.5);
  assert.equal(stats.totalRealizedPnl, 75);
  assert.equal(stats.avgRMultiple, 0.75); // (2 + -0.5) / 2
  assert.deepEqual(stats.byStrategy, { A: { count: 1, pnl: 100 }, B: { count: 1, pnl: -25 } });
  assert.deepEqual(stats.manualCloses, { count: 0, wins: 0, losses: 0, pnl: 0 });
});

test("computeTradeStats: empty input produces nulls, not NaN or a crash", () => {
  const stats = computeTradeStats([]);
  assert.equal(stats.totalTrades, 0);
  assert.equal(stats.winRate, null);
  assert.equal(stats.avgRMultiple, null);
  assert.deepEqual(stats.manualCloses, { count: 0, wins: 0, losses: 0, pnl: 0 });
});

test("computeTradeStats: breaks out manual closes separately from bracket-driven closes", () => {
  const trades = [
    { status: "closed", strategy: "A", outcome: "target_hit", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: 5520, realizedPnl: 100 },
    { status: "closed", strategy: "A", outcome: "manual_close", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: 5510, realizedPnl: 50 },
    { status: "closed", strategy: "B", outcome: "manual_close", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: 5495, realizedPnl: -25 },
  ];
  const stats = computeTradeStats(trades);
  assert.equal(stats.totalTrades, 3); // manual closes still count toward the overall totals
  assert.deepEqual(stats.manualCloses, { count: 2, wins: 1, losses: 1, pnl: 25 });
});

test("computeVetoBreakdown: counts vetoed signals by reason, ignores non-vetoed rows", () => {
  const signals = [
    { veto_reason: "flow_grade_F" },
    { veto_reason: "flow_grade_F" },
    { veto_reason: "wall_too_close" },
    { veto_reason: null },
  ];
  assert.deepEqual(computeVetoBreakdown(signals), { flow_grade_F: 2, wall_too_close: 1 });
});

test("computeDynamicExitStats: totals and per-action breakdown of $ value impact", () => {
  const exitActions = [
    { action: "EXIT_NOW", valueImpact: 50 },
    { action: "TIGHTEN_TRAIL", valueImpact: 20 },
    { action: "TIGHTEN_TRAIL", valueImpact: 15 },
  ];
  const result = computeDynamicExitStats(exitActions);
  assert.equal(result.totalValueImpact, 85);
  assert.deepEqual(result.byAction, {
    EXIT_NOW: { count: 1, valueImpact: 50 },
    TIGHTEN_TRAIL: { count: 2, valueImpact: 35 },
  });
});

test("computeDailySummary: combines all three into one object", () => {
  const summary = computeDailySummary(
    [{ status: "closed", strategy: "A", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: 5510, realizedPnl: 50 }],
    [{ action: "EXIT_NOW", valueImpact: 50 }],
    [{ veto_reason: "flow_grade_F" }]
  );
  assert.equal(summary.trades.totalTrades, 1);
  assert.equal(summary.dynamicExits.totalValueImpact, 50);
  assert.deepEqual(summary.vetoes, { flow_grade_F: 1 });
});
