import express from 'express';
import { buildUniverse, getCurrentUniverse } from '../engine/universe.js';
import { loadEarningsAndSignals } from '../engine/signals.js';
import { runBacktest } from '../engine/backtest.js';
import { runSDBacktest } from '../engine/sdBacktest.js';
import { runMRBacktest, runMRSweep } from '../engine/mrBacktest.js';
import { runORBBacktest, runORBSweep, runORBWalkForward } from '../engine/orbBacktest.js';
import { runGapFillBacktest, runGapFillSweep, runGapFillWalkForward } from '../engine/gapFillBacktest.js';
import { runOrderFlowBacktest } from '../engine/orderFlowBacktest.js';
import { upsertTickVolume1m } from '../data/tickVolumeMongo.js';
import { parsePineScriptParams } from '../engine/parsePineScript.js';
import { getBacktestRuns, getBacktestTrades, getEarningsEvents, removeStock, getSDRuns, getSDTrades, getMRRuns, getMRRun, getMRTrades, getMRSweep, getORBRuns, getORBRun, getORBTrades, getORBSweep, getGapFillRuns, getGapFillRun, getGapFillTrades, getGapFillSweep } from '../data/db.js';
import { setGexBreakoutStatus, getGexBreakoutStatus } from '../data/gexBreakoutStatus.js';
import { setMechanicalOrbStatus, getMechanicalOrbStatus } from '../data/mechanicalOrbStatus.js';
import { setGapContinuationStatus, getGapContinuationStatus } from '../data/gapContinuationStatus.js';
import { fetchTrades, fetchExitActions, fetchDailySummaries, fetchLedgerTrades, fetchDailyLedger } from '../data/tradeJournalMongo.js';
import { summarizeLiveTrades, computeLiveVsBacktestDrift, groupTradesByDay, buildShadowDayReports } from '../engine/reconciliation.js';
import { evaluatePromotionGate } from '../engine/promotionGate.js';
import { describePromotionAction } from '../engine/promotionAction.js';
import { logAuditEntry, fetchAuditLog } from '../data/agentAuditLog.js';

const router = express.Router();

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// === UNIVERSE ===

// Get current universe
router.get('/universe', (req, res) => {
  try {
    const universe = getCurrentUniverse();
    res.json({ success: true, data: universe, count: universe.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Remove a stock from the universe (soft delete)
router.delete('/universe/:symbol', (req, res) => {
  try {
    removeStock(req.params.symbol.toUpperCase());
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Build/refresh universe from S&P 500
router.post('/universe/build', async (req, res) => {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return res.status(400).json({ success: false, error: 'FMP_API_KEY not set' });

  try {
    res.json({ success: true, message: 'Universe build started. Check logs.' });
    // Run async
    buildUniverse(apiKey, true)
      .then(u => console.log(`Universe built: ${u.length} stocks`))
      .catch(e => console.error('Universe build failed:', e.message));
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === DATA LOAD ===

// Load earnings events and generate signals for universe
router.post('/data/load', async (req, res) => {
  const { dateFrom, dateTo, symbols } = req.body;
  const apiKey = process.env.FMP_API_KEY;

  if (!apiKey) return res.status(400).json({ success: false, error: 'FMP_API_KEY not set' });
  if (!dateFrom || !dateTo) return res.status(400).json({ success: false, error: 'dateFrom and dateTo required' });

  const universe = symbols?.length ? symbols : getCurrentUniverse().map(s => s.symbol);
  if (universe.length === 0) return res.status(400).json({ success: false, error: 'No stocks in universe. Build universe first.' });

  try {
    res.json({
      success: true,
      message: `Loading earnings data for ${universe.length} stocks from ${dateFrom} to ${dateTo}. This will take several minutes.`,
      universe,
    });

    loadEarningsAndSignals(universe, dateFrom, dateTo, apiKey)
      .then(events => console.log(`Data load complete: ${events.length} events processed`))
      .catch(e => console.error('Data load failed:', e.message));
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get loaded signals
router.get('/signals', (req, res) => {
  const { dateFrom, dateTo } = req.query;
  try {
    const universe = getCurrentUniverse().map(s => s.symbol);
    const from = dateFrom || '2018-01-01';
    const to = dateTo || new Date().toISOString().split('T')[0];
    const events = getEarningsEvents(universe, from, to);
    res.json({ success: true, data: events, count: events.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === BACKTEST ===

router.post('/backtest/run', async (req, res) => {
  const { dateFrom, dateTo, symbols, holdDays, positionPct } = req.body;
  const apiKey = process.env.FMP_API_KEY;

  if (!apiKey) return res.status(400).json({ success: false, error: 'FMP_API_KEY not set' });
  if (!dateFrom || !dateTo) return res.status(400).json({ success: false, error: 'dateFrom and dateTo required' });

  const universe = symbols?.length ? symbols : getCurrentUniverse().map(s => s.symbol);

  try {
    const result = await runBacktest(universe, dateFrom, dateTo, apiKey, {
      holdDays: holdDays || 60,
      positionPct: positionPct || 0.10,
    });

    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/backtest/runs', (req, res) => {
  try {
    const runs = getBacktestRuns();
    res.json({ success: true, data: runs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/backtest/runs/:id/trades', (req, res) => {
  try {
    const trades = getBacktestTrades(parseInt(req.params.id));
    res.json({ success: true, data: trades });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === S&D ZONE BACKTEST ===

router.post('/sd/backtest/run', async (req, res) => {
  const { symbol, dateFrom, dateTo, div, thresholdPct, stopBuffer, positionPct, rrRatio, sessionStart, sessionEnd, direction, timeframe } = req.body;

  if (!symbol || !dateFrom || !dateTo) {
    return res.status(400).json({ success: false, error: 'symbol, dateFrom, and dateTo are required' });
  }

  try {
    const result = await runSDBacktest(symbol.toUpperCase(), dateFrom, dateTo, {
      div: div || 50,
      thresholdPct: thresholdPct || 10,
      stopBuffer: stopBuffer || 0.04,
      positionPct: positionPct || 0.10,
      rrRatio: rrRatio || 1.5,
      sessionStart: sessionStart || 930,
      sessionEnd: sessionEnd || 1100,
      direction: direction || 'BOTH',
      timeframe: timeframe || '1h',
      apiKey: process.env.FMP_API_KEY || null,
    });

    if (result.error) {
      return res.json({ success: false, error: result.error });
    }

    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/sd/backtest/runs', (req, res) => {
  try {
    res.json({ success: true, data: getSDRuns() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/sd/backtest/runs/:id/trades', (req, res) => {
  try {
    res.json({ success: true, data: getSDTrades(parseInt(req.params.id)) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === MEAN-REVERSION BACKTEST ===

router.post('/mr/backtest/run', async (req, res) => {
  const { symbol, dateFrom, dateTo, ...params } = req.body;
  if (!symbol || !dateFrom || !dateTo) {
    return res.status(400).json({ success: false, error: 'symbol, dateFrom, and dateTo are required' });
  }
  try {
    const result = await runMRBacktest(symbol.toUpperCase(), dateFrom, dateTo, {
      ...params,
      apiKey: process.env.FMP_API_KEY || null,
    });
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('MR backtest failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/mr/sweep/run', async (req, res) => {
  const { symbol, dateFrom, dateTo, baseParams, grid } = req.body;
  if (!symbol || !dateFrom || !dateTo) {
    return res.status(400).json({ success: false, error: 'symbol, dateFrom, and dateTo are required' });
  }
  try {
    const result = await runMRSweep(symbol.toUpperCase(), dateFrom, dateTo, {
      ...(baseParams || {}),
      apiKey: process.env.FMP_API_KEY || null,
    }, grid || {});
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('MR sweep failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/mr/backtest/runs', (req, res) => {
  try {
    res.json({ success: true, data: getMRRuns() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/mr/backtest/runs/:id', (req, res) => {
  try {
    res.json({ success: true, data: getMRRun(parseInt(req.params.id)) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/mr/backtest/runs/:id/trades', (req, res) => {
  try {
    res.json({ success: true, data: getMRTrades(parseInt(req.params.id)) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/mr/sweeps/:sweepId', (req, res) => {
  try {
    res.json({ success: true, data: getMRSweep(req.params.sweepId) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === OPENING-RANGE BREAKOUT BACKTEST ===

router.post('/orb/backtest/run', async (req, res) => {
  const { symbol, dateFrom, dateTo, ...params } = req.body;
  if (!symbol || !dateFrom || !dateTo) {
    return res.status(400).json({ success: false, error: 'symbol, dateFrom, and dateTo are required' });
  }
  try {
    const result = await runORBBacktest(symbol.toUpperCase(), dateFrom, dateTo, {
      ...params,
      apiKey: process.env.FMP_API_KEY || null,
    });
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('ORB backtest failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/orb/sweep/run', async (req, res) => {
  const { symbol, dateFrom, dateTo, baseParams, grid } = req.body;
  if (!symbol || !dateFrom || !dateTo) {
    return res.status(400).json({ success: false, error: 'symbol, dateFrom, and dateTo are required' });
  }
  try {
    const result = await runORBSweep(symbol.toUpperCase(), dateFrom, dateTo, {
      ...(baseParams || {}),
      apiKey: process.env.FMP_API_KEY || null,
    }, grid || {});
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('ORB sweep failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/orb/backtest/runs', (req, res) => {
  try {
    res.json({ success: true, data: getORBRuns() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/orb/backtest/runs/:id', (req, res) => {
  try {
    res.json({ success: true, data: getORBRun(parseInt(req.params.id)) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/orb/backtest/runs/:id/trades', (req, res) => {
  try {
    res.json({ success: true, data: getORBTrades(parseInt(req.params.id)) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/orb/sweeps/:sweepId', (req, res) => {
  try {
    res.json({ success: true, data: getORBSweep(req.params.sweepId) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/orb/walkforward/run', async (req, res) => {
  const { symbol, dateFrom, dateTo, baseParams, grid, numFolds } = req.body;
  if (!symbol || !dateFrom || !dateTo) {
    return res.status(400).json({ success: false, error: 'symbol, dateFrom, and dateTo are required' });
  }
  try {
    const result = await runORBWalkForward(symbol.toUpperCase(), dateFrom, dateTo, {
      ...(baseParams || {}),
      apiKey: process.env.FMP_API_KEY || null,
    }, grid || {}, numFolds || 4);
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('ORB walk-forward failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// === GAP FILL / OVERNIGHT GAP BACKTEST (same shape as ORB above) ===

router.post('/gapfill/backtest/run', async (req, res) => {
  const { symbol, dateFrom, dateTo, ...params } = req.body;
  if (!symbol || !dateFrom || !dateTo) {
    return res.status(400).json({ success: false, error: 'symbol, dateFrom, and dateTo are required' });
  }
  try {
    const result = await runGapFillBacktest(symbol.toUpperCase(), dateFrom, dateTo, {
      ...params,
      apiKey: process.env.FMP_API_KEY || null,
    });
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('Gap-fill backtest failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/gapfill/sweep/run', async (req, res) => {
  const { symbol, dateFrom, dateTo, baseParams, grid } = req.body;
  if (!symbol || !dateFrom || !dateTo) {
    return res.status(400).json({ success: false, error: 'symbol, dateFrom, and dateTo are required' });
  }
  try {
    const result = await runGapFillSweep(symbol.toUpperCase(), dateFrom, dateTo, {
      ...(baseParams || {}),
      apiKey: process.env.FMP_API_KEY || null,
    }, grid || {});
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('Gap-fill sweep failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/gapfill/walkforward/run', async (req, res) => {
  const { symbol, dateFrom, dateTo, baseParams, grid, numFolds } = req.body;
  if (!symbol || !dateFrom || !dateTo) {
    return res.status(400).json({ success: false, error: 'symbol, dateFrom, and dateTo are required' });
  }
  try {
    const result = await runGapFillWalkForward(symbol.toUpperCase(), dateFrom, dateTo, {
      ...(baseParams || {}),
      apiKey: process.env.FMP_API_KEY || null,
    }, grid || {}, numFolds || 4);
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('Gap-fill walk-forward failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/gapfill/backtest/runs', (req, res) => {
  try {
    res.json({ success: true, data: getGapFillRuns() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/gapfill/backtest/runs/:id', (req, res) => {
  try {
    res.json({ success: true, data: getGapFillRun(parseInt(req.params.id)) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/gapfill/backtest/runs/:id/trades', (req, res) => {
  try {
    res.json({ success: true, data: getGapFillTrades(parseInt(req.params.id)) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/gapfill/sweeps/:sweepId', (req, res) => {
  try {
    res.json({ success: true, data: getGapFillSweep(req.params.sweepId) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === ORDER FLOW BOT BACKTEST (gex-breakout's "OF") ===
// Reuses gex-breakout's own live decision code directly (see
// orderFlowBacktest.js's header) rather than a reimplementation — deliberately
// no /sweep or /walkforward route yet, and no SQLite run persistence, until
// this core engine has been run against real tick_volume_1m data and someone
// has confirmed it actually matches live (see marketData.js's
// loadOrderFlowBars, which currently refuses to run without that data).
router.post('/orderflow/backtest/run', async (req, res) => {
  const { symbol, dateFrom, dateTo, ...params } = req.body;
  if (!symbol || !dateFrom || !dateTo) {
    return res.status(400).json({ success: false, error: 'symbol, dateFrom, and dateTo are required' });
  }
  try {
    const result = await runOrderFlowBacktest(symbol.toUpperCase(), dateFrom, dateTo, params);
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('Order Flow backtest failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Durable capture of the live Order Flow Bot's own per-minute aggressor
// buy/sell volume — see gex-breakout/src/tickVolumeReporter.js (the sender)
// and tickVolumeMongo.js (why this is Mongo, not the SQLite bar cache).
// Reuses the same shared-secret relay pattern as the status-relay routes
// above, and the same secret (GEX_STATUS_SECRET) — this is the same trusted
// worker process, not a new integration needing its own secret to manage.
router.post('/order-flow/tick-volume', async (req, res) => {
  const expected = process.env.GEX_STATUS_SECRET;
  if (expected && req.headers['x-status-secret'] !== expected) {
    return res.status(401).json({ success: false, error: 'invalid status secret' });
  }
  const { symbol, rows } = req.body;
  if (!symbol || !Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ success: false, error: 'symbol and a non-empty rows array are required' });
  }
  try {
    await upsertTickVolume1m(symbol, rows);
    res.json({ success: true, count: rows.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/sd/parse-pinescript', async (req, res) => {
  const { code } = req.body;
  if (!code || !code.trim()) {
    return res.status(400).json({ success: false, error: 'Pine Script code is required' });
  }
  try {
    const params = await parsePineScriptParams(code);
    res.json({ success: true, data: params });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === GEX BREAKOUT (live worker status relay) ===
// The gex-breakout worker runs as a separate Heroku dyno with no public routing of
// its own, so it POSTs its status here on an interval and the frontend polls it
// back from this (publicly reachable) backend instead of talking to the worker
// directly.

router.post('/gex-breakout/status', (req, res) => {
  const expected = process.env.GEX_STATUS_SECRET;
  if (expected && req.headers['x-status-secret'] !== expected) {
    return res.status(401).json({ success: false, error: 'invalid status secret' });
  }
  setGexBreakoutStatus(req.body);
  res.json({ success: true });
});

router.get('/gex-breakout/status', (req, res) => {
  const status = getGexBreakoutStatus();
  if (!status) return res.status(404).json({ success: false, error: 'no status reported yet' });
  res.json({ success: true, data: status });
});

// === MECHANICAL ORB (same relay pattern as GEX Breakout above) ===

router.post('/mechanical-orb/status', (req, res) => {
  const expected = process.env.MECHANICAL_ORB_STATUS_SECRET;
  if (expected && req.headers['x-status-secret'] !== expected) {
    return res.status(401).json({ success: false, error: 'invalid status secret' });
  }
  setMechanicalOrbStatus(req.body);
  res.json({ success: true });
});

router.get('/mechanical-orb/status', (req, res) => {
  const status = getMechanicalOrbStatus();
  if (!status) return res.status(404).json({ success: false, error: 'no status reported yet' });
  res.json({ success: true, data: status });
});

// === GAP CONTINUATION (same relay pattern as GEX Breakout/Mechanical ORB above) ===

router.post('/gap-continuation/status', (req, res) => {
  const expected = process.env.GAP_CONTINUATION_STATUS_SECRET;
  if (expected && req.headers['x-status-secret'] !== expected) {
    return res.status(401).json({ success: false, error: 'invalid status secret' });
  }
  setGapContinuationStatus(req.body);
  res.json({ success: true });
});

router.get('/gap-continuation/status', (req, res) => {
  const status = getGapContinuationStatus();
  if (!status) return res.status(404).json({ success: false, error: 'no status reported yet' });
  res.json({ success: true, data: status });
});

// === TRADE JOURNAL (read-only, backed by gex-breakout's Mongo trade journal) ===

router.get('/trade-journal/trades', async (req, res) => {
  try {
    const trades = await fetchTrades({
      dayKey: req.query.dayKey || undefined,
      accountRole: req.query.accountRole || undefined,
    });
    res.json({ success: true, data: trades });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/trade-journal/exit-actions', async (req, res) => {
  try {
    const exitActions = await fetchExitActions({ dayKey: req.query.dayKey || undefined });
    res.json({ success: true, data: exitActions });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/trade-journal/daily-summaries', async (req, res) => {
  try {
    const summaries = await fetchDailySummaries();
    res.json({ success: true, data: summaries });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === UNIFIED LEDGER (Phase 3 — all three strategies' Mongo trade journals, one place) ===

router.get('/ledger/trades', async (req, res) => {
  try {
    const trades = await fetchLedgerTrades({
      dayKey: req.query.dayKey || undefined,
      system: req.query.system || undefined,
    });
    res.json({ success: true, data: trades });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/ledger/daily', async (req, res) => {
  if (!req.query.dayKey) {
    return res.status(400).json({ success: false, error: 'dayKey is required (Date.prototype.toDateString() format, e.g. "Mon Jan 05 2026")' });
  }
  try {
    const ledger = await fetchDailyLedger(req.query.dayKey);
    res.json({ success: true, data: ledger });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === LIVE-VS-BACKTEST RECONCILIATION (Phase 3) ===
// Deliberately takes backtestStats from the caller rather than re-deriving it
// here — see reconciliation.js's own comment on why auto-mapping a live
// bot's config onto a backtest engine's params is left to a human/agent who
// knows the intended mapping, not guessed at in this endpoint. Call
// /orb/backtest/run or /gapfill/backtest/run yourself over the same date
// range with the live bot's real parameters, then pass its
// data.metrics.full (or .oos) straight through as backtestStats.
router.post('/reconciliation/run', async (req, res) => {
  const { system, closedFrom, closedTo, backtestStats, tolerances } = req.body;
  if (!system || !closedFrom || !closedTo || !backtestStats) {
    return res.status(400).json({ success: false, error: 'system, closedFrom, closedTo, and backtestStats are required' });
  }
  try {
    const liveTrades = await fetchLedgerTrades({ system, closedFrom, closedTo, limit: 2000 });
    const liveStats = summarizeLiveTrades(liveTrades);
    const drift = computeLiveVsBacktestDrift(liveStats, backtestStats, tolerances || {});
    res.json({ success: true, data: { system, closedFrom, closedTo, liveStats, backtestStats, ...drift } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Builds promotionGate.js's `shadowDays` array in one call instead of the
// agent assembling it via N separate /reconciliation/run calls (one per
// practice day) — see reconciliation.js's buildShadowDayReports for why each
// day's comparison is cumulative (day 1..N), not day-N-alone: these
// strategies trade too infrequently for any single day to be individually
// comparable.
router.post('/reconciliation/shadow-days', async (req, res) => {
  const { system, dateFrom, dateTo, backtestStats, tolerances } = req.body;
  if (!system || !dateFrom || !dateTo || !backtestStats) {
    return res.status(400).json({ success: false, error: 'system, dateFrom, dateTo, and backtestStats are required' });
  }
  try {
    const trades = await fetchLedgerTrades({ system, closedFrom: dateFrom, closedTo: dateTo, limit: 2000 });
    const dailyGroups = groupTradesByDay(trades);
    const shadowDays = buildShadowDayReports(dailyGroups, backtestStats, tolerances || {});
    res.json({ success: true, data: { system, dateFrom, dateTo, shadowDays } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === PROMOTION GATE (Phase 4) ===
// Pure decision, no side effects — does NOT flip anything live itself. Feed
// it walkForward (POST .../walkforward/run's data), regime
// (metrics.regimeRobustness from a backtest run), deflated
// (a sweep's deflatedSharpeOfTop), and shadowDays (the array
// POST /reconciliation/shadow-days returns).
router.post('/promotion-gate/evaluate', (req, res) => {
  const { walkForward, regime, deflated, shadowDays, criteria } = req.body;
  try {
    const result = evaluatePromotionGate({ walkForward, regime, deflated, shadowDays }, criteria || {});
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Generates (never executes) the exact command to flip a strategy live once
// its promotion gate has approved — see promotionAction.js's own comment on
// why this stops short of running it itself.
router.post('/promotion-gate/action', (req, res) => {
  const { strategy, gateResult } = req.body;
  if (!strategy || !gateResult) {
    return res.status(400).json({ success: false, error: 'strategy and gateResult are required' });
  }
  try {
    res.json({ success: true, data: describePromotionAction(strategy, gateResult) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === AGENT HARNESS AUDIT LOG (Phase 5) ===

router.post('/agent-harness/audit-log', async (req, res) => {
  if (!req.body?.type || !req.body?.strategy) {
    return res.status(400).json({ success: false, error: 'type and strategy are required' });
  }
  try {
    const entry = await logAuditEntry(req.body);
    res.json({ success: true, data: entry });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/agent-harness/audit-log', async (req, res) => {
  try {
    const entries = await fetchAuditLog({
      strategy: req.query.strategy || undefined,
      type: req.query.type || undefined,
      debateId: req.query.debateId || undefined,
      limit: req.query.limit ? parseInt(req.query.limit) : undefined,
    });
    res.json({ success: true, data: entries });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
