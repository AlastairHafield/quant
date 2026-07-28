import express from 'express';
import { buildUniverse, getCurrentUniverse } from '../engine/universe.js';
import { loadEarningsAndSignals } from '../engine/signals.js';
import { runBacktest } from '../engine/backtest.js';
import { runSDBacktest } from '../engine/sdBacktest.js';
import { runMRBacktest, runMRSweep } from '../engine/mrBacktest.js';
import { runORBBacktest, runORBSweep } from '../engine/orbBacktest.js';
import { parsePineScriptParams } from '../engine/parsePineScript.js';
import { getBacktestRuns, getBacktestTrades, getEarningsEvents, removeStock, getSDRuns, getSDTrades, getMRRuns, getMRRun, getMRTrades, getMRSweep, getORBRuns, getORBRun, getORBTrades, getORBSweep } from '../data/db.js';
import { setGexBreakoutStatus, getGexBreakoutStatus } from '../data/gexBreakoutStatus.js';
import { setMechanicalOrbStatus, getMechanicalOrbStatus } from '../data/mechanicalOrbStatus.js';
import { setGapContinuationStatus, getGapContinuationStatus } from '../data/gapContinuationStatus.js';
import { fetchTrades, fetchExitActions, fetchDailySummaries } from '../data/tradeJournalMongo.js';

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

export default router;
