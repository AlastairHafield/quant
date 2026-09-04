import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runORBBacktest, runORBWalkForward } from '../engine/orbBacktest.js';
import { runGapFillBacktest, runGapFillWalkForward } from '../engine/gapFillBacktest.js';
import { runOrderFlowBacktest } from '../engine/orderFlowBacktest.js';
import { fetchLedgerTrades, fetchDailyLedger } from '../data/tradeJournalMongo.js';
import { summarizeLiveTrades, computeLiveVsBacktestDrift, groupTradesByDay, buildShadowDayReports } from '../engine/reconciliation.js';
import { evaluatePromotionGate } from '../engine/promotionGate.js';
import { describePromotionAction } from '../engine/promotionAction.js';
import { logAuditEntry, fetchAuditLog } from '../data/agentAuditLog.js';

// MCP front door onto this same backend, for the scheduled agent-harness
// routine specifically — its cloud sandbox's network egress proxy only
// permits a fixed allowlist (package registries + Anthropic's own APIs), NOT
// arbitrary outbound HTTPS to this app's own REST API (confirmed live
// 2026-09-04: neither a per-environment "domain allowlist" setting nor a
// repo-level .claude/settings.json sandbox config affected it — that proxy
// sits outside both). An MCP connector is a different, permitted path for a
// CCR sandbox to reach an external service (the same mechanism the
// Interactive-Brokers-IBKR connector already uses), so this exposes the
// exact same operations backend/src/api/routes.js does as MCP tools instead
// of HTTP endpoints. Calls the underlying engine/data functions directly
// (not a loopback HTTP call to its own routes) — same functions, same
// results, whichever front door is used.
//
// See agent-harness/PROTOCOL.md for what each of these means and when to
// use it; tool descriptions below are deliberately terse pointers back to
// that document rather than a duplicate explanation that could drift out of
// sync with it.

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(e) {
  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }], isError: true };
}

export function createBackendMcpServer() {
  const server = new McpServer({ name: 'quant-backend', version: '1.0.0' });

  server.registerTool('ledger_daily', {
    title: 'Unified daily P&L ledger',
    description: 'All 3 strategies\' realized P&L, win/loss, MFE/MAE for one calendar day. dayKey format: Date.prototype.toDateString(), e.g. "Wed Sep 03 2026". See PROTOCOL.md daily-loop step 1.',
    inputSchema: { dayKey: z.string() },
  }, async ({ dayKey }) => {
    try { return textResult({ success: true, data: await fetchDailyLedger(dayKey) }); }
    catch (e) { return errorResult(e); }
  });

  server.registerTool('ledger_trades', {
    title: 'Raw ledger trades',
    description: 'Raw trade docs, optionally filtered by system (Mongo db name: gap_continuation | mechanical_orb | gex_breakout), dayKey, or a closedFrom/closedTo range (bare YYYY-MM-DD or full ISO timestamps).',
    inputSchema: {
      system: z.string().optional(),
      dayKey: z.string().optional(),
      closedFrom: z.string().optional(),
      closedTo: z.string().optional(),
      limit: z.number().optional(),
    },
  }, async (args) => {
    try { return textResult({ success: true, data: await fetchLedgerTrades(args) }); }
    catch (e) { return errorResult(e); }
  });

  server.registerTool('orb_backtest_run', {
    title: 'Mechanical ORB backtest',
    description: 'Runs the opening-range-breakout backtest engine. params carries the engine\'s own fields (direction, stopMode, entryCutoff, minDailyADX, etc — see orbBacktest.js\'s ORB_DEFAULTS); merge in mechanical-orb\'s live config values yourself, this tool does not read them for you.',
    inputSchema: { symbol: z.string(), dateFrom: z.string(), dateTo: z.string(), params: z.record(z.any()).optional() },
  }, async ({ symbol, dateFrom, dateTo, params }) => {
    try { return textResult({ success: true, data: await runORBBacktest(symbol, dateFrom, dateTo, params || {}) }); }
    catch (e) { return errorResult(e); }
  });

  server.registerTool('orb_walkforward_run', {
    title: 'Mechanical ORB walk-forward validation',
    description: 'Anchored walk-forward across numFolds (default 4). grid must have at least one non-empty array key even to test a single fixed config (pass e.g. {stopParam: [1.5]}) — see robustness.js\'s runWalkForward.',
    inputSchema: {
      symbol: z.string(), dateFrom: z.string(), dateTo: z.string(),
      baseParams: z.record(z.any()).optional(), grid: z.record(z.any()).optional(), numFolds: z.number().optional(),
    },
  }, async ({ symbol, dateFrom, dateTo, baseParams, grid, numFolds }) => {
    try { return textResult({ success: true, data: await runORBWalkForward(symbol, dateFrom, dateTo, baseParams || {}, grid || {}, numFolds || 4) }); }
    catch (e) { return errorResult(e); }
  });

  server.registerTool('gapfill_backtest_run', {
    title: 'Gap-continuation backtest',
    description: 'Runs the gap-fill/continuation backtest engine (gapFillBacktest.js\'s GAP_FILL_DEFAULTS fields go in params). gap-continuation\'s live config uses direction: "CONTINUATION".',
    inputSchema: { symbol: z.string(), dateFrom: z.string(), dateTo: z.string(), params: z.record(z.any()).optional() },
  }, async ({ symbol, dateFrom, dateTo, params }) => {
    try { return textResult({ success: true, data: await runGapFillBacktest(symbol, dateFrom, dateTo, params || {}) }); }
    catch (e) { return errorResult(e); }
  });

  server.registerTool('gapfill_walkforward_run', {
    title: 'Gap-continuation walk-forward validation',
    description: 'Anchored walk-forward for the gap-fill engine. Same grid requirement as orb_walkforward_run.',
    inputSchema: {
      symbol: z.string(), dateFrom: z.string(), dateTo: z.string(),
      baseParams: z.record(z.any()).optional(), grid: z.record(z.any()).optional(), numFolds: z.number().optional(),
    },
  }, async ({ symbol, dateFrom, dateTo, baseParams, grid, numFolds }) => {
    try { return textResult({ success: true, data: await runGapFillWalkForward(symbol, dateFrom, dateTo, baseParams || {}, grid || {}, numFolds || 4) }); }
    catch (e) { return errorResult(e); }
  });

  server.registerTool('orderflow_backtest_run', {
    title: 'Order Flow Bot backtest (data-gated)',
    description: 'Backtests gex-breakout\'s Order Flow Bot by calling its own live decision code directly. Needs real per-minute aggressor buy/sell volume captured by tickVolumeReporter.js since it started running — will error for any range that predates or has gaps in that capture. Read orderFlowBacktest.js\'s header comment (footprintZones/TIGHTEN_TO_PRICE caveats) before trusting a TREND-day result.',
    inputSchema: { symbol: z.string(), dateFrom: z.string(), dateTo: z.string(), params: z.record(z.any()).optional() },
  }, async ({ symbol, dateFrom, dateTo, params }) => {
    try { return textResult({ success: true, data: await runOrderFlowBacktest(symbol, dateFrom, dateTo, params || {}) }); }
    catch (e) { return errorResult(e); }
  });

  server.registerTool('reconciliation_run', {
    title: 'Live-vs-backtest drift for one strategy',
    description: 'Compares a strategy\'s actual recent live trades against a backtest\'s predicted stats over the same window. backtestStats is a backtest run\'s metrics.full or .oos (from *_backtest_run above).',
    inputSchema: {
      system: z.string(), closedFrom: z.string(), closedTo: z.string(),
      backtestStats: z.record(z.any()), tolerances: z.record(z.any()).optional(),
    },
  }, async ({ system, closedFrom, closedTo, backtestStats, tolerances }) => {
    try {
      const liveTrades = await fetchLedgerTrades({ system, closedFrom, closedTo, limit: 2000 });
      const liveStats = summarizeLiveTrades(liveTrades);
      const drift = computeLiveVsBacktestDrift(liveStats, backtestStats, tolerances || {});
      return textResult({ success: true, data: { system, closedFrom, closedTo, liveStats, backtestStats, ...drift } });
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('reconciliation_shadow_days', {
    title: 'Build promotion-gate shadowDays (cumulative per day)',
    description: 'Builds promotionGate\'s shadowDays array in one call. Each day\'s comparison is CUMULATIVE (day 1..N, not day N alone) — these strategies trade too infrequently for a single day to hit the 5-trade minimum to be comparable. See reconciliation.js\'s buildShadowDayReports.',
    inputSchema: {
      system: z.string(), dateFrom: z.string(), dateTo: z.string(),
      backtestStats: z.record(z.any()), tolerances: z.record(z.any()).optional(),
    },
  }, async ({ system, dateFrom, dateTo, backtestStats, tolerances }) => {
    try {
      const trades = await fetchLedgerTrades({ system, closedFrom: dateFrom, closedTo: dateTo, limit: 2000 });
      const dailyGroups = groupTradesByDay(trades);
      const shadowDays = buildShadowDayReports(dailyGroups, backtestStats, tolerances || {});
      return textResult({ success: true, data: { system, dateFrom, dateTo, shadowDays } });
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('promotion_gate_evaluate', {
    title: 'Evaluate the promotion gate',
    description: 'Pure decision, no side effects. Feed it walkForward (from *_walkforward_run), regime (metrics.regimeRobustness from a backtest run), deflated (a sweep\'s deflatedSharpeOfTop), and shadowDays (from reconciliation_shadow_days).',
    inputSchema: {
      walkForward: z.record(z.any()).optional(), regime: z.record(z.any()).optional(),
      deflated: z.record(z.any()).optional(), shadowDays: z.array(z.any()).optional(),
      criteria: z.record(z.any()).optional(),
    },
  }, async ({ walkForward, regime, deflated, shadowDays, criteria }) => {
    try { return textResult({ success: true, data: evaluatePromotionGate({ walkForward, regime, deflated, shadowDays }, criteria || {}) }); }
    catch (e) { return errorResult(e); }
  });

  server.registerTool('promotion_gate_action', {
    title: 'Get the (unexecuted) promotion command',
    description: 'Generates but never executes the exact command a human needs to run to flip a strategy live once its promotion gate has approved. strategy uses the directory-name form (gap-continuation | mechanical-orb | gex-breakout).',
    inputSchema: { strategy: z.string(), gateResult: z.record(z.any()) },
  }, async ({ strategy, gateResult }) => {
    try { return textResult({ success: true, data: describePromotionAction(strategy, gateResult) }); }
    catch (e) { return errorResult(e); }
  });

  server.registerTool('audit_log_write', {
    title: 'Write an agent-harness audit entry',
    description: 'Auto-posts to Discord. type: watch|proposal|grade|promotion|demotion|error. role: proposer|critic-opus|etc. Omit debateId on a proposal entry to get one generated (read it off the returned data.debateId); required on every entry responding to that proposal. See PROTOCOL.md\'s "Thread every response" section.',
    inputSchema: {
      type: z.enum(['watch', 'proposal', 'grade', 'promotion', 'demotion', 'error']),
      role: z.string().optional(),
      strategy: z.string(),
      summary: z.string(),
      details: z.union([z.string(), z.record(z.any())]).optional(),
      debateId: z.string().optional(),
    },
  }, async (entry) => {
    try { return textResult({ success: true, data: await logAuditEntry(entry) }); }
    catch (e) { return errorResult(e); }
  });

  server.registerTool('audit_log_read', {
    title: 'Read recent agent-harness audit entries',
    description: 'Filter by strategy, type, and/or debateId (pull one full proposal->critique->verdict exchange with debateId).',
    inputSchema: {
      strategy: z.string().optional(), type: z.string().optional(),
      debateId: z.string().optional(), limit: z.number().optional(),
    },
  }, async (args) => {
    try { return textResult({ success: true, data: await fetchAuditLog(args) }); }
    catch (e) { return errorResult(e); }
  });

  return server;
}
