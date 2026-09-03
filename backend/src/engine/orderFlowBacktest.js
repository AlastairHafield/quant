import { DEFAULT_ACCOUNT, sizeTrades, computeBacktestMetrics, dataCoverage, round, dowOf } from './backtestMetrics.js';
import { regimeRobustnessCheck, monteCarloDrawdown } from './robustness.js';
// Reused directly from gex-breakout's own LIVE decision code — not a
// reimplementation. Every one of these is a pure function with zero npm
// dependencies (verified before wiring this up), so a relative cross-package
// import is safe and, more importantly, guarantees this backtest can never
// silently drift out of sync with what the live Order Flow Bot actually
// does — the exact same evaluateOrderFlowBot() call live worker.js makes is
// the one this file makes.
import { classifyRegime } from '../../../gex-breakout/src/regime.js';
import { buildOrderFlowWalls } from '../../../gex-breakout/src/levelEngine.js';
import { evaluateOrderFlowBot } from '../../../gex-breakout/src/orderFlowBot.js';
import { evaluateOrderFlowExit } from '../../../gex-breakout/src/orderFlowExits.js';
import { withCumDelta, buildAbsorptionWindow, detectDeltaDivergence } from '../../../gex-breakout/src/orderFlow.js';
import { buildSessionProfile, findPOC, computeValueArea } from '../../../gex-breakout/src/volumeProfile.js';

// ─── What this can and can't backtest ────────────────────────────────────
//
// This replays the Order Flow Bot's real per-bar decision logic
// (evaluateOrderFlowBot/evaluateOrderFlowExit, imported straight from
// gex-breakout/src/, not reimplemented) against historical 1-minute bars
// carrying per-bar aggressor buy/sell volume — captured live by
// gex-breakout/src/tickVolumeReporter.js from the bot's own real-time
// TopstepX trade stream and stored durably by backend/src/data/tickVolumeMongo.js
// (see marketData.js's loadOrderFlowBars, the only caller that fetches this
// data — TopstepX has no historical API for it, only a live feed, so there
// is no way to backfill dates before that reporter started running). Every
// trigger that only needs per-bar buy/sell volume (failed_auction,
// absorption against the session value area, path-of-least-resistance,
// lack-of-participation) is fully, faithfully backtestable this way.
//
// What is NOT faithfully backtestable yet: footprintZones (stacked buy/sell
// imbalance at individual price levels within a bar) needs genuine
// tick-by-tick, per-price data that this per-bar buy/sell split doesn't
// carry — footprintZones is always passed as [] here. Concretely
// this means: (1) on TREND days, the live bot's trend-continuation trailing
// stop (TIGHTEN_TO_PRICE, trailing behind the nearest footprint zone) can
// never fire in this backtest — trend-day trades here run to their stop or
// the far placeholder target instead of trailing, which will understate
// what a trend day actually nets live; (2) on TREND days, buildActiveZones
// returns the (empty) footprintZones directly, so absorption has no real
// zones to test against and will not fire — it only fires on RANGE days,
// against the session value area, which is unaffected by this gap.
// **Report both of these caveats alongside any result from this engine —
// they materially affect trend-day P&L specifically, not the whole
// backtest.**
//
// TAKE_PARTIAL (absorption-at-target) is simplified to a full exit at the
// current bar's close rather than live's partial-size-reduction — this is
// deliberately conservative (it locks in less total favorable movement than
// live's "take half, let the rest run" would), not an optimistic shortcut.

export const OF_BACKTEST_DEFAULTS = {
  sessionStartET: 930,
  sessionEndET: 1600,
  entryFloorET: 945,
  entryCutoffET: 1555,
  flattenAtET: 1555,
  // Regime (replaces live's net-GEX classification — see gex-breakout Phase 1)
  adxThreshold: 25,
  // Position sizing / costs — identical shape to orbBacktest's
  sizingMode: 'RISK', accountSize: DEFAULT_ACCOUNT, positionPct: 0.10, riskPct: 0.005, compound: true, maxLeverage: 0,
  costPct: 0.02,
  maxTradesPerDay: 3,
  cooldownMinPerZone: 60,
  triggerBufferPts: 1,
  stopCapPts: 12,
  breakevenAtR: 1,
  wallFilter: { nearPts: 15, mode: 'skip' },
  volumeProfile: { bucketSizePts: 1, valueAreaPct: 0.7, minSessionBars: 30, probeLookbackBars: 5 },
  orderFlow: {
    divergenceLookbackBars: 10,
    absorption: { touchBars: 3, volMultiple: 1.5, maxAdvancePts: 2, avgLookbackBars: 20 },
  },
  pathOfLeastResistance: { lookbackBars: 4, volumeLightMultiple: 2, avgLookbackBars: 20 },
  lackOfParticipation: { lookbackBars: 4, volumeDeclineMultiple: 2 },
  exit: { divergenceWithinBarsOfEntry: 5, placeholderTargetDistancePts: 500 },
  dowMask: 'ALL', minDailyADX: 0, maxDailyADX: 0, vixMin: 0, vixMax: 0, atrPctileMin: 0, atrPctileMax: 100,
};

// Reshapes the flat OF_BACKTEST_DEFAULTS into the nested shape
// evaluateOrderFlowBot/evaluateOrderFlowExit expect (mirroring gex-breakout's
// own config.js structure) — kept as a separate step so the params callers
// pass in (sweepable, flat) don't have to match that nesting themselves.
function toEngineConfig(params) {
  return {
    entryCutoffET: { h: Math.floor(params.entryCutoffET / 100), m: params.entryCutoffET % 100 },
    orderFlowBot: {
      triggerBufferPts: params.triggerBufferPts,
      macroOverrideEnabled: true,
      maxTradesPerDay: params.maxTradesPerDay,
      cooldownMinPerZone: params.cooldownMinPerZone,
      volumeProfile: params.volumeProfile,
      pathOfLeastResistance: params.pathOfLeastResistance,
      lackOfParticipation: params.lackOfParticipation,
      exit: params.exit,
    },
    levels: { wallFilter: params.wallFilter },
    orderFlow: params.orderFlow,
    tradeManagement: { stopCapPts: params.stopCapPts, breakevenAtR: params.breakevenAtR },
    exit: params.exit,
  };
}

function passesDayFilters(reg, dowChar, params) {
  if (params.dowMask !== 'ALL' && !params.dowMask.includes(dowChar)) return false;
  if (!reg) return true;
  if (params.minDailyADX > 0 && reg.adx != null && reg.adx < params.minDailyADX) return false;
  if (params.maxDailyADX > 0 && reg.adx != null && reg.adx > params.maxDailyADX) return false;
  if (params.vixMin > 0 && reg.vix != null && reg.vix < params.vixMin) return false;
  if (params.vixMax > 0 && reg.vix != null && reg.vix > params.vixMax) return false;
  if (params.atrPctileMin > 0 && reg.atrPctile != null && reg.atrPctile < params.atrPctileMin) return false;
  if (params.atrPctileMax < 100 && reg.atrPctile != null && reg.atrPctile > params.atrPctileMax) return false;
  return true;
}

function etDateFromBar(bar) {
  // ny_time is HHMM as an integer (e.g. 930, 1605) — bar.date is the ET
  // calendar date string. evaluateOrderFlowBot only reads nowET's
  // getHours/getMinutes (via checks.js's timeCheck), so a Date built purely
  // from these two fields, with no timezone conversion needed, is exact.
  const h = Math.floor(bar.ny_time / 100), m = bar.ny_time % 100;
  const [y, mo, d] = bar.date.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m);
}

function closeTrade(trades, pos, exitPrice, outcome, exitIdx, today, params) {
  const dirMult = pos.direction === 'long' ? 1 : -1;
  const gross = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 * dirMult;
  const net = gross - params.costPct;
  trades.push({
    trade_date: today,
    entry_time: pos.entryNyTime,
    signal: pos.direction === 'long' ? 'LONG' : 'SHORT',
    entry_price: round(pos.entryPrice),
    target_price: pos.targetPrice != null ? round(pos.targetPrice) : null,
    stop_price: round(pos.originalStopPrice),
    exit_price: round(exitPrice),
    exit_result: outcome,
    trigger: pos.trigger,
    is_trend_day: pos.isTrendDay,
    bars_held: exitIdx - pos.entryIndex,
    gross_return_pct: round(gross),
    return_pct: round(net),
    regime_trend: pos.isTrendDay ? 'TREND' : 'RANGE',
  });
}

// ─── Core backtest (pure) ────────────────────────────────────────────────

export function orderFlowBacktestCore(allBars, regimeMap, rawParams) {
  const params = { ...OF_BACKTEST_DEFAULTS, ...rawParams };
  const engineConfig = toEngineConfig(params);

  const sessionBars = allBars.filter((b) => b.ny_time >= params.sessionStartET && b.ny_time < params.sessionEndET);
  if (sessionBars.some((b) => b.buyVolume == null && b.sellVolume == null)) {
    return { error: 'Bars are missing buyVolume/sellVolume — this engine needs per-minute aggressor volume (tick_volume_1m), not plain OHLCV.' };
  }
  // withCumDelta is a single forward pass — bar i's cumDelta only ever
  // depends on bars[0..i], never later bars. This causality is what the
  // whole rest of this file depends on; see the module-level comment on
  // repainting risk in agent-harness/PROTOCOL.md.
  const bars = withCumDelta(sessionBars.map((b) => ({ ...b, buyVolume: b.buyVolume ?? 0, sellVolume: b.sellVolume ?? 0 })));

  const byDate = {};
  for (const bar of bars) (byDate[bar.date] ||= []).push(bar);
  const sortedDates = Object.keys(byDate).sort();

  const trades = [];
  let tradedDays = 0, filteredDays = 0;

  for (const today of sortedDates) {
    if (today < params.dateFrom || today > params.dateTo) continue;
    const dayBars = byDate[today];
    if (!dayBars || dayBars.length < params.volumeProfile.minSessionBars) continue;

    const dowChar = dowOf(today);
    const reg = regimeMap[today] || null;
    if (!passesDayFilters(reg, dowChar, params)) { filteredDays++; continue; }

    const regimeInfo = classifyRegime({ trendDayOk: reg?.adx != null && reg.adx >= params.adxThreshold });
    tradedDays++;

    const dayState = { orderFlowTradesToday: 0, zoneCooldowns: new Map() };
    const todaySessionStartGlobalIndex = bars.indexOf(dayBars[0]);
    let openPos = null;

    for (let di = 0; di < dayBars.length; di++) {
      const bar = dayBars[di];
      const idx = todaySessionStartGlobalIndex + di;
      const isLastBar = di === dayBars.length - 1;
      const t = etDateFromBar(bar);

      // ── manage an open position ──
      if (openPos) {
        if (bar.high >= openPos.mfeHigh) openPos.mfeHigh = bar.high;
        if (bar.low <= openPos.maeLow) openPos.maeLow = bar.low;

        let exitPrice = null, outcome = null;
        if (openPos.direction === 'long') {
          if (bar.low <= openPos.stopPrice) { exitPrice = openPos.stopPrice; outcome = 'STOP'; }
          else if (bar.high >= openPos.targetPrice) { exitPrice = openPos.targetPrice; outcome = 'TARGET'; }
        } else {
          if (bar.high >= openPos.stopPrice) { exitPrice = openPos.stopPrice; outcome = 'STOP'; }
          else if (bar.low <= openPos.targetPrice) { exitPrice = openPos.targetPrice; outcome = 'TARGET'; }
        }

        if (exitPrice == null && !isLastBar) {
          // breakeven-at-1R — same trigger worker.js's evaluateOpenTrades uses
          if (!openPos.movedToBreakeven) {
            const riskDist = Math.abs(openPos.entryPrice - openPos.originalStopPrice);
            const favorableMove = openPos.direction === 'long' ? openPos.mfeHigh - openPos.entryPrice : openPos.entryPrice - openPos.maeLow;
            if (favorableMove >= riskDist * params.breakevenAtR) {
              openPos.stopPrice = openPos.entryPrice;
              openPos.movedToBreakeven = true;
            }
          }

          const absorptionWindow = buildAbsorptionWindow(bars, idx, params.orderFlow.absorption);
          const exitResult = evaluateOrderFlowExit({
            direction: openPos.direction,
            entryIndex: openPos.entryIndex,
            currentIndex: idx,
            bars,
            touchWindow: absorptionWindow?.touchWindow ?? null,
            priorBars: absorptionWindow?.priorBars ?? [],
            levelPriceForAbsorption: openPos.targetPrice,
            isTrendDay: openPos.isTrendDay,
            nearestZonePrice: null, // no footprint data — see module comment
            config: engineConfig,
          });
          if (exitResult.action === 'EXIT_NOW' || exitResult.action === 'TAKE_PARTIAL') {
            exitPrice = bar.close;
            outcome = exitResult.action === 'EXIT_NOW' ? 'EXIT_NOW' : 'PARTIAL_TREATED_AS_FULL';
          }
        }

        if (exitPrice == null && (isLastBar || bar.ny_time >= params.flattenAtET)) {
          exitPrice = bar.close;
          outcome = 'EOD';
        }

        if (exitPrice != null) {
          closeTrade(trades, openPos, exitPrice, outcome, idx, today, params);
          openPos = null;
        }
        if (openPos) continue; // still open, no new entry this bar
      }

      // ── look for a new entry ──
      if (isLastBar) continue; // no next bar left to manage an exit on — never open here
      if (dayState.orderFlowTradesToday >= params.maxTradesPerDay) continue;
      if (bar.ny_time < params.entryFloorET || bar.ny_time >= params.entryCutoffET) continue;
      if (bar.ny_time >= params.flattenAtET) continue;

      let valueArea = null, poc = null;
      if (di + 1 >= params.volumeProfile.minSessionBars) {
        const sliceBars = bars.slice(todaySessionStartGlobalIndex, idx + 1); // causal: up to & including `idx` only
        const profile = buildSessionProfile(sliceBars, params.volumeProfile);
        poc = findPOC(profile);
        valueArea = computeValueArea(profile, poc, params.volumeProfile.valueAreaPct);
      }
      const walls = buildOrderFlowWalls({ valueArea, poc });
      const absorptionWindow = buildAbsorptionWindow(bars, idx, params.orderFlow.absorption);

      // evaluateOrderFlowBot's own zone-cooldown check (isZoneOnCooldown, inside
      // orderFlowBot.js) reads Date.now() directly — live-correct (real trading
      // clock), but incompatible with replaying history: every call in this loop
      // would otherwise see the SAME real wall-clock instant regardless of how
      // much simulated market time has actually passed, which would make a
      // zone's cooldown either never expire or never apply. Faithfully
      // reproducing the live cooldown behavior against simulated time means
      // pointing Date.now() at this bar's own ET timestamp for the (synchronous,
      // single-threaded) duration of this one call, and restoring it immediately
      // after — never left patched between bars.
      const simulatedMs = t.getTime();
      const realDateNow = Date.now;
      let result;
      try {
        Date.now = () => simulatedMs;
        result = evaluateOrderFlowBot({
          nowET: t,
          bars,
          index: idx,
          regimeInfo,
          footprintZones: [], // see module comment — no tick-level footprint data available
          valueArea,
          touchWindow: absorptionWindow?.touchWindow ?? null,
          priorBars: absorptionWindow?.priorBars ?? [],
          walls,
          config: engineConfig,
          dayState,
        });
      } finally {
        Date.now = realDateNow;
      }

      if (!result || result.veto) continue;

      dayState.orderFlowTradesToday += 1;
      dayState.zoneCooldowns.set(result.zoneKey, simulatedMs);

      openPos = {
        direction: result.direction,
        entryPrice: result.entryPrice,
        stopPrice: result.stopPrice,
        originalStopPrice: result.stopPrice,
        targetPrice: result.targetPrice,
        entryIndex: idx,
        entryNyTime: bar.ny_time,
        isTrendDay: result.isTrendDay,
        trigger: result.trigger,
        movedToBreakeven: false,
        mfeHigh: bar.high,
        maeLow: bar.low,
      };
    }
  }

  return { trades, tradedDays, filteredDays, params };
}

function computeOFMetrics(trades, sortedTradeDates, params) {
  const metrics = computeBacktestMetrics(trades, sortedTradeDates, params, {
    byTrend: (t) => t.regime_trend,
    byTrigger: (t) => t.trigger ?? 'unknown',
    bySignal: (t) => t.signal,
  });
  metrics.regimeRobustness = regimeRobustnessCheck(trades, (t) => t.regime_trend);
  metrics.monteCarlo = trades.length >= 20 ? monteCarloDrawdown(trades, params.accountSize || DEFAULT_ACCOUNT) : null;
  return metrics;
}

// ─── Data-driven entry point ─────────────────────────────────────────────
// Deliberately no runOrderFlowSweep/runOrderFlowWalkForward yet, unlike the
// other two engines — get this core validated against real tick_volume_1m
// data first (see marketData.js's loadOrderFlowBars, which currently
// refuses to run without it) before building the heavier sweep/walk-forward
// machinery on top of an engine nobody's confirmed matches live yet.

export async function runOrderFlowBacktest(symbol, dateFrom, dateTo, params = {}) {
  const { loadOrderFlowBars } = await import('./marketData.js');
  const { bars, regimeMap, error } = await loadOrderFlowBars(symbol, dateFrom, dateTo, params);
  if (error) return { error };
  if (bars.length === 0) return { error: `No order-flow (buy/sell volume) bars available for ${symbol} in this range.` };

  const coverage = dataCoverage(bars, dateFrom, dateTo);
  const merged = { ...params, dateFrom, dateTo };
  const result = orderFlowBacktestCore(bars, regimeMap, merged);
  if (result.error) return result;
  const { trades, tradedDays, filteredDays, params: applied } = result;
  if (trades.length === 0) return { error: 'No trades generated.', tradedDays, filteredDays, ...coverage };

  const tradeDates = [...new Set(bars.map((b) => b.date).filter((d) => d >= dateFrom && d <= dateTo))].sort();
  const sized = sizeTrades(trades, applied);
  const metrics = computeOFMetrics(sized, tradeDates, applied);

  return { metrics, tradedDays, filteredDays, ...coverage };
}
