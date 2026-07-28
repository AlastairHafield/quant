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

test("computeTradeStats: Strategy A's practice-account trades are excluded from every real-money figure", () => {
  const trades = [
    { status: "closed", strategy: "B", accountRole: "default", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: 5520, realizedPnl: 100 },
    { status: "closed", strategy: "A", accountRole: "A", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: 5900, realizedPnl: 4000 }, // a huge practice "win" that must not leak into real $
    { status: "closed", strategy: "A", accountRole: "A", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: 5495, realizedPnl: -25 },
  ];
  const stats = computeTradeStats(trades);

  assert.equal(stats.totalTrades, 1); // only the real (default-role) trade
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 0);
  assert.equal(stats.totalRealizedPnl, 100); // the $4000 practice "win" is NOT blended in
  assert.deepEqual(stats.practice, { count: 2, wins: 1, losses: 1, pnl: 3975 });
  // byStrategy still shows both, for visibility into practice performance too
  assert.deepEqual(stats.byStrategy, { B: { count: 1, pnl: 100 }, A: { count: 2, pnl: 3975 } });
});

test("computeTradeStats: a trade with no accountRole field (pre-existing data) is treated as real", () => {
  const trades = [
    { status: "closed", strategy: "B", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: 5520, realizedPnl: 100 },
  ];
  const stats = computeTradeStats(trades);
  assert.equal(stats.totalTrades, 1);
  assert.equal(stats.totalRealizedPnl, 100);
  assert.deepEqual(stats.practice, { count: 0, wins: 0, losses: 0, pnl: 0 });
});

test("computeTradeStats: excludedFromStats trades are left out of every aggregate entirely, byStrategy included", () => {
  const trades = [
    { status: "closed", strategy: "B", direction: "short", entryPrice: 7437, exitPrice: 7437.5, realizedPnl: -75, excludedFromStats: true, excludedReason: "2026-07-28 ladder sizing bug" },
    { status: "closed", strategy: "B", direction: "short", entryPrice: 7429.5, exitPrice: 7430.5, realizedPnl: -150, excludedFromStats: true, excludedReason: "2026-07-28 ladder sizing bug" },
    { status: "closed", strategy: "B", direction: "long", entryPrice: 5500, originalStopPrice: 5490, exitPrice: 5520, realizedPnl: 100 },
  ];
  const stats = computeTradeStats(trades);
  assert.equal(stats.totalTrades, 1); // only the one non-excluded trade
  assert.equal(stats.totalRealizedPnl, 100); // the two -$75/-$150 bug trades are not blended in
  assert.deepEqual(stats.byStrategy, { B: { count: 1, pnl: 100 } }); // excluded trades don't even show up here
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
