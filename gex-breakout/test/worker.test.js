import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minutesOf,
  shouldFlattenNow,
  tradesRequiringCloseOnFlip,
  untrackedPositions,
  shiftWalls,
  buildLevelState,
  shouldFlushLogNow,
  createWorker,
  isLiveExecutionAllowed,
  accountRoleFor,
  isBarStreamStale,
  isDepthStreamStale,
} from "../src/worker.js";
import { CONFIG } from "../src/config.js";

test("minutesOf converts a Date to minutes-since-midnight", () => {
  assert.equal(minutesOf(new Date(2026, 6, 24, 9, 30)), 570);
  assert.equal(minutesOf(new Date(2026, 6, 24, 0, 0)), 0);
});

test("isLiveExecutionAllowed: the Order Flow Bot needs its own separate flag on top of the bot-wide switch", () => {
  assert.equal(isLiveExecutionAllowed("OF", { executionEnabled: true, orderFlowBot: { executionEnabled: true } }), true);
  assert.equal(isLiveExecutionAllowed("OF", { executionEnabled: true, orderFlowBot: { executionEnabled: false } }), false);
  assert.equal(isLiveExecutionAllowed("OF", { executionEnabled: false, orderFlowBot: { executionEnabled: true } }), false);
});

test("accountRoleFor: the Order Flow Bot gets the practice-account role, everything else is 'default'", () => {
  assert.equal(accountRoleFor("OF"), "A");
  assert.equal(accountRoleFor("B"), "default");
  assert.equal(accountRoleFor("reconciled"), "default");
});

test("isLiveExecutionAllowed: Strategy B (and anything else) just follows the bot-wide switch", () => {
  assert.equal(isLiveExecutionAllowed("B", { executionEnabled: true, orderFlowBot: { executionEnabled: false } }), true);
  assert.equal(isLiveExecutionAllowed("B", { executionEnabled: false, orderFlowBot: { executionEnabled: false } }), false);
});

test("isBarStreamStale: false outside the trading day, regardless of how old the last bar is", () => {
  const veryOld = new Date(2026, 6, 29, 6, 0); // 6am ET, market not open yet
  const now = new Date(2026, 6, 29, 8, 0); // 8am ET, still not open
  assert.equal(isBarStreamStale(veryOld, now, CONFIG), false);
});

test("isBarStreamStale: false when no bar has ever been received yet (subscribeBarsWithRetry's own retry covers a failed initial connect)", () => {
  const now = new Date(2026, 6, 29, 10, 0); // 10am ET, within the trading day
  assert.equal(isBarStreamStale(null, now, CONFIG), false);
});

test("isBarStreamStale: false when the last bar is recent, true once it exceeds the threshold, during the trading day", () => {
  const now = new Date(2026, 6, 29, 10, 0); // 10am ET
  const recent = new Date(2026, 6, 29, 9, 58); // 2 min ago
  const stale = new Date(2026, 6, 29, 9, 55); // 5 min ago, threshold is 3
  assert.equal(isBarStreamStale(recent, now, CONFIG), false);
  assert.equal(isBarStreamStale(stale, now, CONFIG), true);
});

test("isDepthStreamStale: depth's own independent twin of isBarStreamStale, same trading-day/threshold logic", () => {
  const now = new Date(2026, 6, 29, 10, 0); // 10am ET
  const recent = new Date(2026, 6, 29, 9, 58);
  const stale = new Date(2026, 6, 29, 9, 55); // depthStaleThresholdMin is 3
  assert.equal(isDepthStreamStale(recent, now, CONFIG), false);
  assert.equal(isDepthStreamStale(stale, now, CONFIG), true);
  assert.equal(isDepthStreamStale(null, now, CONFIG), false); // never connected yet
  const outsideTradingDay = new Date(2026, 6, 29, 6, 0);
  assert.equal(isDepthStreamStale(stale, outsideTradingDay, CONFIG), false);
});

test("shouldFlattenNow: false before flattenAtET, true at/after it", () => {
  const config = { flattenAtET: { h: 15, m: 55 } };
  assert.equal(shouldFlattenNow(new Date(2026, 6, 24, 15, 54), config), false);
  assert.equal(shouldFlattenNow(new Date(2026, 6, 24, 15, 55), config), true);
  assert.equal(shouldFlattenNow(new Date(2026, 6, 24, 16, 30), config), true);
});

test("tradesRequiringCloseOnFlip: empty when no tracked trades exist for the contract", () => {
  assert.deepEqual(tradesRequiringCloseOnFlip([], "CON.F.US.MES.U26", "long"), []);
});

test("tradesRequiringCloseOnFlip: empty when every tracked trade on the contract already agrees with the new direction", () => {
  const trades = [
    { contractId: "CON.F.US.MES.U26", direction: "long", strategy: "OF" },
    { contractId: "CON.F.US.MES.U26", direction: "long", strategy: "B" },
  ];
  assert.deepEqual(tradesRequiringCloseOnFlip(trades, "CON.F.US.MES.U26", "long"), []);
});

test("tradesRequiringCloseOnFlip: ignores trades on other contracts", () => {
  const trades = [{ contractId: "CON.F.US.ES.U26", direction: "short", strategy: "OF" }];
  assert.deepEqual(tradesRequiringCloseOnFlip(trades, "CON.F.US.MES.U26", "long"), []);
});

test("tradesRequiringCloseOnFlip: returns every tracked trade on the contract (not just the opposite-direction one) once any of them conflicts — a contract has only one real net position", () => {
  const trades = [
    { contractId: "CON.F.US.MES.U26", direction: "short", strategy: "B" },
    { contractId: "CON.F.US.MES.U26", direction: "long", strategy: "OF" }, // agrees with the new signal, but still shares the same net position
  ];
  const toClose = tradesRequiringCloseOnFlip(trades, "CON.F.US.MES.U26", "long");
  assert.equal(toClose.length, 2);
  assert.deepEqual(toClose, trades);
});

test("untrackedPositions: returns broker positions with no matching trackedTrades entry, mapping type 1/2 to long/short", () => {
  const openPositions = [
    { contractId: "CON.F.US.MES.U26", type: 1, size: 2, averagePrice: 7489.25 }, // untracked
    { contractId: "CON.F.US.ES.U26", type: 2, size: 1, averagePrice: 5500 }, // already tracked
  ];
  const trackedTrades = [{ contractId: "CON.F.US.ES.U26", direction: "short" }];
  const result = untrackedPositions(openPositions, trackedTrades);
  assert.equal(result.length, 1);
  assert.equal(result[0].contractId, "CON.F.US.MES.U26");
});

test("untrackedPositions: skips positions with an unrecognized type rather than guess a direction", () => {
  const openPositions = [{ contractId: "CON.F.US.MES.U26", type: 0, size: 1, averagePrice: 7489.25 }];
  assert.deepEqual(untrackedPositions(openPositions, []), []);
});

test("untrackedPositions: empty when every open position is already tracked", () => {
  const openPositions = [{ contractId: "CON.F.US.MES.U26", type: 1, size: 2, averagePrice: 7489.25 }];
  const trackedTrades = [{ contractId: "CON.F.US.MES.U26", direction: "long" }];
  assert.deepEqual(untrackedPositions(openPositions, trackedTrades), []);
});

test("shiftWalls: shifts every wall's strike by the basis, preserving wallType/gex", () => {
  const walls = {
    aboveSpot: [{ strike: 5525, gex: 5e9, wallType: "POS_WALL" }],
    belowSpot: [{ strike: 5480, gex: -4e9, wallType: "NEG_WALL" }],
  };
  const shifted = shiftWalls(walls, 8);
  assert.equal(shifted.aboveSpot[0].strike, 5533);
  assert.equal(shifted.aboveSpot[0].wallType, "POS_WALL");
  assert.equal(shifted.belowSpot[0].strike, 5488);
});

test("buildLevelState: returns an empty state before GEX/basis are available", () => {
  const state = buildLevelState({ gexSnapshot: null, basis: null, dailyLevels: [], consolRange: null });
  assert.deepEqual(state, {
    levels: [],
    triggerLevelsB: [],
    flipPointEs: null,
    wallsEs: { aboveSpot: [], belowSpot: [] },
  });
});

test("buildLevelState: composes GEX/daily/consolidation levels, basis-shifted", () => {
  const gexSnapshot = {
    flipPoint: 5500,
    walls: {
      aboveSpot: [{ strike: 5525, gex: 5e9, wallType: "POS_WALL" }],
      belowSpot: [{ strike: 5480, gex: -4e9, wallType: "NEG_WALL" }],
    },
  };
  const state = buildLevelState({
    gexSnapshot,
    basis: 8,
    dailyLevels: [{ type: "PRIOR_DAY_HIGH", price: 5540, role: "strategyB_trigger" }],
    consolRange: { high: 5516, low: 5512 },
  });

  assert.equal(state.flipPointEs, 5508); // 5500 + 8
  assert.equal(state.wallsEs.aboveSpot[0].strike, 5533);
  assert.ok(state.levels.some((l) => l.type === "PRIOR_DAY_HIGH" && l.price === 5540));
  assert.ok(state.levels.some((l) => l.type === "CONSOL_HIGH" && l.price === 5516));
  assert.ok(state.triggerLevelsB.some((l) => l.type === "GEX_WALL"));
});

function esBar({ high, low, close, buyVolume, sellVolume }) {
  return { high, low, close, volume: buyVolume + sellVolume, buyVolume, sellVolume };
}

test("checkDayRollover: resets pending Strategy B breakouts and risk-manager day-state on a new calendar day", () => {
  const worker = createWorker();
  worker.currentDay = new Date(2026, 6, 27).toDateString();
  worker.pendingB = { direction: "short" };
  worker.riskManager.recordTradeResult("OF", -100); // a loss recorded yesterday
  worker.riskManager.recordOrderFlowTrade("zone1", Date.now());
  worker.footprintBars.push([{ price: 5500, buyVolume: 1, sellVolume: 1 }]);

  worker.checkDayRollover(new Date(2026, 6, 28, 0, 1)); // just past midnight, a new day

  assert.equal(worker.currentDay, new Date(2026, 6, 28).toDateString());
  assert.equal(worker.pendingB, null);
  assert.equal(worker.riskManager.lossesToday.OF, undefined); // lazily-initialized, resetDay clears the whole object
  assert.equal(worker.riskManager.dayState.orderFlowTradesToday, 0);
  assert.equal(worker.riskManager.dayState.zoneCooldowns.size, 0);
  assert.deepEqual(worker.footprintBars, []);
});

test("checkDayRollover: marks today's session as starting at this.bars' current length", () => {
  const worker = createWorker();
  worker.bars.push({ close: 100 }, { close: 101 }, { close: 102 }); // 3 bars from a prior day
  worker.currentDay = new Date(2026, 6, 27).toDateString();

  worker.checkDayRollover(new Date(2026, 6, 28, 0, 1));

  assert.equal(worker.todaySessionStartIndex, 3);
});

test("checkDayRollover: a no-op when called again the same day (doesn't wipe in-progress state)", () => {
  const worker = createWorker();
  worker.currentDay = new Date(2026, 6, 27).toDateString();
  worker.pendingB = { direction: "short" };

  worker.checkDayRollover(new Date(2026, 6, 27, 9, 40)); // still the same day

  assert.deepEqual(worker.pendingB, { direction: "short" });
});

test("handleSignal: skips a new signal when the real account already has an open position (shared with other bots)", () => {
  const worker = createWorker();
  worker.openPositions = [{ contractId: "CON.F.US.MES.U26", size: 4 }]; // e.g. Mechanical ORB
  const result = { strategy: "B", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, sizeMultiplier: 1 };

  worker.handleSignal(result, { regime: "NEG_GAMMA" }, { grade: "A" });

  const row = worker.logger.buffer[0];
  assert.equal(row.veto_reason, "position_already_open");
  assert.equal(worker.trackedTrades.length, 0);
});

test("handleSignal: proceeds normally when the account is flat", () => {
  const worker = createWorker();
  worker.openPositions = [];
  const result = { strategy: "B", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, sizeMultiplier: 1 };

  worker.handleSignal(result, { regime: "NEG_GAMMA" }, { grade: "A" });

  const row = worker.logger.buffer[0];
  assert.equal(row.veto_reason, null);
});

test("handleSignal: an already-open position takes priority over the strategy's own veto reason in the logged row", () => {
  const worker = createWorker();
  worker.openPositions = [{ contractId: "CON.F.US.MES.U26", size: 4 }];
  const result = { strategy: "B", direction: "long", veto: "pos_gamma_no_confirmation", sizeMultiplier: 1 };

  worker.handleSignal(result, { regime: "POS_GAMMA" }, { grade: "A" });

  assert.equal(worker.logger.buffer[0].veto_reason, "position_already_open");
});

test("handleSignal: the Order Flow Bot checks its OWN (practice) account's positions, independent of the real account", () => {
  const worker = createWorker();
  worker.openPositions = [{ contractId: "CON.F.US.MES.U26", size: 4 }]; // real account has something open (e.g. Strategy B)
  worker.openPositionsA = []; // but the practice account is flat
  const result = { strategy: "OF", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, sizeMultiplier: 1 };

  worker.handleSignal(result, { regime: "NEG_GAMMA" }, { grade: "A" });

  assert.equal(worker.logger.buffer[0].veto_reason, null); // not blocked by the real account's unrelated position
});

test("handleSignal: Strategy B is unaffected by the Order Flow Bot's own practice-account position", () => {
  const worker = createWorker();
  worker.openPositions = []; // real account is flat
  worker.openPositionsA = [{ contractId: "CON.F.US.MES.U26", size: 4 }]; // practice account has something open
  const result = { strategy: "B", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, sizeMultiplier: 1 };

  worker.handleSignal(result, { regime: "NEG_GAMMA" }, { grade: "A" });

  assert.equal(worker.logger.buffer[0].veto_reason, null); // not blocked by the Order Flow Bot's unrelated practice position
});

test("Worker end-to-end: a strategy's own loss/win halt stops further trading for the day", () => {
  const worker = createWorker();
  worker.riskManager.recordTradeResult("OF", -100);
  worker.riskManager.recordTradeResult("OF", -50); // OF halted: 2 losses
  worker.riskManager.recordTradeResult("B", 25); // B halted: 1 winner
  assert.equal(worker.riskManager.canTrade("OF"), false);
  assert.equal(worker.riskManager.canTrade("B"), false);

  worker.gexSnapshot = { netGex: -5e9, flipPoint: 5400, walls: { aboveSpot: [], belowSpot: [] } };
  worker.basis = 0;
  worker.rebuildLevels();
  worker.onBar(
    esBar({ high: 5523, low: 5520, close: 5522, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 9, 46)
  );
  assert.equal(worker.logger.size, 0); // both bail out on their own halt before evaluating any real trigger logic
});

test("Worker end-to-end: tryOrderFlow fires a real lack-of-participation signal against a live footprint zone", () => {
  const worker = createWorker();
  worker.gexSnapshot = { netGex: -5e9, flipPoint: 5400, walls: { aboveSpot: [], belowSpot: [] } }; // NEG_GAMMA
  worker.basis = 0;
  worker.rebuildLevels();

  // 4 flat-close bars (rules out path-of-least-resistance, which needs net
  // price movement) with volume declining by more than half and cumulative
  // delta's slope flattening in the second half — lack-of-participation's
  // exact trigger shape (see its own unit tests in orderFlow.test.js).
  // Only 4 bars total, well short of buildAbsorptionWindow's ~23-bar
  // requirement, so absorption is skipped and this really is exercising the
  // lack-of-participation fallthrough, not absorption.
  const t = (m) => new Date(2026, 6, 24, 10, m);
  worker.onBar(esBar({ high: 5500.5, low: 5499.5, close: 5500, buyVolume: 20, sellVolume: 5 }), t(0));

  // Set up AFTER the first onBar, not before — the first onBar of any
  // session triggers checkDayRollover (currentDay starts null), which
  // resets footprintBars; in real operation footprint data only ever
  // arrives after that's already happened.
  worker.onFootprintBar([
    { price: 5498, buyVolume: 30, sellVolume: 1 },
    { price: 5499, buyVolume: 30, sellVolume: 1 },
    { price: 5500, buyVolume: 30, sellVolume: 1 },
  ]);

  worker.onBar(esBar({ high: 5500.5, low: 5499.5, close: 5500, buyVolume: 20, sellVolume: 5 }), t(1));
  worker.onBar(esBar({ high: 5500.5, low: 5499.5, close: 5500, buyVolume: 5, sellVolume: 5 }), t(2));
  worker.onBar(esBar({ high: 5500.5, low: 5499.5, close: 5500, buyVolume: 5, sellVolume: 5 }), t(3));

  const row = worker.logger.buffer.find((r) => r.strategy === "OF");
  assert.ok(row, "expected a logged Order Flow Bot signal");
  assert.equal(row.veto_reason, null);
  assert.equal(row.direction, "short");
  assert.equal(row.entry_price, 5500);
  assert.equal(row.stop_price, 5501);
  assert.equal(row.target_price, 5000);
  assert.equal(worker.riskManager.dayState.orderFlowTradesToday, 1);
  assert.equal(worker.riskManager.dayState.zoneCooldowns.has("buy:5498.00-5500.00"), true);
});

test("tryOrderFlow: promotes POC/value area to instance fields once minSessionBars is cleared", () => {
  const worker = createWorker();
  // Matches real CONFIG.orderFlowBot.volumeProfile.minSessionBars (30) —
  // flat range so POC/value area are trivially non-null, exact values aren't
  // the point here (volumeProfile.test.js already covers the math).
  for (let i = 0; i < 30; i++) {
    worker.bars.push({ high: 5501, low: 5499, close: 5500, buyVolume: 10, sellVolume: 10, cumDelta: 0 });
  }
  worker.todaySessionStartIndex = 0;
  const lastIdx = worker.bars.length - 1;
  worker.tryOrderFlow(
    worker.bars[lastIdx],
    worker.bars[lastIdx - 1],
    lastIdx,
    new Date(2026, 6, 24, 10, 0),
    { baseRegime: "NEG_GAMMA", regime: "NEG_GAMMA" }
  );

  assert.notEqual(worker.lastPOC, null);
  assert.notEqual(worker.lastValueArea, null);
  assert.ok(worker.sessionVolumeProfile.length > 0);
});

test("tryOrderFlow: leaves POC/value area null while the session is still thin", () => {
  const worker = createWorker();
  worker.bars.push({ high: 5501, low: 5499, close: 5500, buyVolume: 10, sellVolume: 10, cumDelta: 0 });
  worker.todaySessionStartIndex = 0;
  worker.tryOrderFlow(worker.bars[0], worker.bars[0], 0, new Date(2026, 6, 24, 10, 0), {
    baseRegime: "NEG_GAMMA",
    regime: "NEG_GAMMA",
  });

  assert.equal(worker.lastPOC, null);
  assert.equal(worker.lastValueArea, null);
});

test("evaluateSignals: does not evaluate before sessionOpenET (pre-market)", () => {
  const worker = createWorker();
  worker.gexSnapshot = { netGex: -5e9, flipPoint: 5400, walls: { aboveSpot: [], belowSpot: [] } };
  worker.basis = 0;
  worker.rebuildLevels();

  // 2:04am ET, matching the real pre-market trade this gate was added to
  // prevent (2026-07-30, after Phase 1 removed the old orbLocked gate that
  // used to block this as a side effect). lastRegimeInfo only ever gets set
  // once evaluateSignals runs past the time gates, so it staying null proves
  // the gate stopped it before regime classification, let alone either strategy.
  worker.onBar(
    esBar({ high: 5523, low: 5520, close: 5522, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 2, 4)
  );
  assert.equal(worker.lastRegimeInfo, null);
});

test("evaluateSignals: evaluates normally at/after sessionOpenET", () => {
  const worker = createWorker();
  worker.gexSnapshot = { netGex: -5e9, flipPoint: 5400, walls: { aboveSpot: [], belowSpot: [] } };
  worker.basis = 0;
  worker.rebuildLevels();

  worker.onBar(
    esBar({ high: 5523, low: 5520, close: 5522, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 9, 30)
  );
  assert.notEqual(worker.lastRegimeInfo, null); // reached regime classification — the gate let it through
});

test("Worker: onBar routes to the EOD flatten path (skips evaluateSignals) once past flattenAtET with an open trade", () => {
  const worker = createWorker();
  worker.gexSnapshot = { netGex: -5e9, flipPoint: 5400, walls: { aboveSpot: [], belowSpot: [] } };
  worker.basis = 0;
  worker.rebuildLevels();
  worker.trackedTrades.push({
    strategy: "OF", direction: "long", entryPrice: 5520, stopPrice: 5515, targetPrice: 5540,
    contractId: "CON.F.US.EP.U26", size: 4, orderId: 1, mfe: 0, mae: 0, openedAt: "t",
  });

  // A clean breakout bar that would otherwise fire a signal if evaluateSignals ran.
  worker.onBar(
    esBar({ high: 5528, low: 5526, close: 5527, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 15, 56)
  );
  assert.equal(worker.logger.size, 0); // evaluateSignals never ran
});

test("Worker: onBar does not take the flatten path when there's nothing open (falls through to evaluateSignals)", () => {
  const worker = createWorker();
  worker.gexSnapshot = { netGex: -5e9, flipPoint: 5400, walls: { aboveSpot: [], belowSpot: [] } };
  worker.basis = 0;
  worker.rebuildLevels();

  // Confirms flattenAll() is never reached with an empty trackedTrades (no
  // broker call attempted, nothing thrown synchronously).
  assert.doesNotThrow(() => {
    worker.onBar(esBar({ high: 5528, low: 5526, close: 5527, buyVolume: 300, sellVolume: 50 }), new Date(2026, 6, 24, 15, 56));
  });
  assert.equal(worker.trackedTrades.length, 0);
});

test("Worker: onBar updates MFE/MAE for every tracked trade as new bars arrive", () => {
  const worker = createWorker();
  worker.trackedTrades.push({
    strategy: "OF", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520,
    contractId: "CON.F.US.EP.U26", size: 4, orderId: 1, mfe: 0, mae: 0, openedAt: "t",
  });

  worker.onBar(esBar({ high: 5510, low: 5497, close: 5505, buyVolume: 10, sellVolume: 5 }), new Date(2026, 6, 24, 9, 10));
  assert.equal(worker.trackedTrades[0].mfe, 10); // 5510-5500
  assert.equal(worker.trackedTrades[0].mae, 3); // 5500-5497

  worker.onBar(esBar({ high: 5508, low: 5480, close: 5490, buyVolume: 5, sellVolume: 20 }), new Date(2026, 6, 24, 9, 11));
  assert.equal(worker.trackedTrades[0].mfe, 10); // unchanged, prior bar's high was better
  assert.equal(worker.trackedTrades[0].mae, 20); // 5500-5480, new worse adverse excursion
});

test("Worker: onFootprintBar accumulates levels and records the last-received time", () => {
  const worker = createWorker();
  assert.equal(worker.lastFootprintBarAt, null);
  assert.deepEqual(worker.footprintBars, []);

  worker.onFootprintBar([{ price: 5500, buyVolume: 10, sellVolume: 2 }]);
  assert.equal(worker.footprintBars.length, 1);
  assert.deepEqual(worker.footprintBars[0], [{ price: 5500, buyVolume: 10, sellVolume: 2 }]);
  assert.notEqual(worker.lastFootprintBarAt, null);

  worker.onFootprintBar([{ price: 5501, buyVolume: 3, sellVolume: 8 }]);
  assert.equal(worker.footprintBars.length, 2);
});

test("Worker: evaluateOpenTrades dispatches a non-HOLD evaluateExit result (failed breakout) for a tracked trade", () => {
  const worker = createWorker();
  worker.onBar(esBar({ high: 5501, low: 5499, close: 5500, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 10, 0));
  const entryIndex = worker.bars.length - 1;
  worker.trackedTrades.push({
    strategy: "B", direction: "long", entryPrice: 5500, stopPrice: 5490, originalStopPrice: 5490,
    targetPrice: 5520, originalTargetPrice: 5520, brokenLevel: 5500, entryIndex, lastRegimeBase: "NEG_GAMMA",
    movedToBreakeven: true, actionInFlight: false, contractId: "CON.F.US.EP.U26", size: 4, orderId: 1,
    mfe: 0, mae: 0, openedAt: "t",
  });

  // Strategy B routes through the generic evaluateExit. Closes below
  // brokenLevel(5500) - failedBreakoutPts(2) = 5498 -> EXIT_NOW.
  // executionEnabled is false in tests, so the real broker call inside
  // actOnExitResult rejects (no credentials) and is caught asynchronously —
  // actionInFlight being true immediately after onBar (set synchronously,
  // before that rejection settles) is exactly what proves evaluateOpenTrades
  // correctly identified a non-HOLD result and dispatched it.
  worker.onBar(esBar({ high: 5497, low: 5495, close: 5496, buyVolume: 10, sellVolume: 40 }), new Date(2026, 6, 24, 10, 1));
  assert.equal(worker.trackedTrades[0].actionInFlight, true);
});

test("Worker: evaluateOpenTrades leaves a healthy trade alone (HOLD)", () => {
  const worker = createWorker();
  worker.onBar(esBar({ high: 5501, low: 5499, close: 5500, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 10, 0));
  const entryIndex = worker.bars.length - 1;
  worker.trackedTrades.push({
    strategy: "B", direction: "long", entryPrice: 5500, stopPrice: 5490, originalStopPrice: 5490,
    targetPrice: 5520, originalTargetPrice: 5520, brokenLevel: 5500, entryIndex, lastRegimeBase: "NEG_GAMMA",
    movedToBreakeven: true, actionInFlight: false, contractId: "CON.F.US.EP.U26", size: 4, orderId: 1,
    mfe: 0, mae: 0, openedAt: "t",
  });

  worker.onBar(esBar({ high: 5503, low: 5501, close: 5502, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 10, 1));
  assert.equal(worker.trackedTrades[0].actionInFlight, false);
});

test("Worker: evaluateOpenTrades dispatches TIGHTEN_TO_PRICE for an Order Flow Bot trade trailing a zone on a trend day", () => {
  const worker = createWorker();
  worker.onBar(esBar({ high: 5501, low: 5499, close: 5500, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 10, 0));
  const entryIndex = worker.bars.length - 1;
  worker.lastRegimeInfo = { baseRegime: "NEG_GAMMA" }; // trend day -> trail instead of a fixed TP
  worker.lastFootprintZones = [{ side: "buy", low: 5490, high: 5495 }]; // below price -> eligible to trail behind for a long
  worker.trackedTrades.push({
    strategy: "OF", direction: "long", entryPrice: 5500, stopPrice: 5480, originalStopPrice: 5480,
    targetPrice: 6000, originalTargetPrice: 6000, brokenLevel: 5500, entryIndex, lastRegimeBase: "NEG_GAMMA",
    movedToBreakeven: true, actionInFlight: false, contractId: "CON.F.US.EP.U26", size: 4, orderId: 1,
    mfe: 0, mae: 0, openedAt: "t",
  });

  // stopPrice(5480) sits well below the zone's high(5495) -> TIGHTEN_TO_PRICE
  // moves it up to 5495, which is tighter, so actOnExitResult dispatches —
  // proven the same way the EXIT_NOW test above does (actionInFlight set
  // synchronously before the broker call's rejection settles).
  worker.onBar(esBar({ high: 5503, low: 5501, close: 5502, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 10, 1));
  assert.equal(worker.trackedTrades[0].actionInFlight, true);
});

test("Worker: detectClosedTrades logs a closed-trade row (with MFE/MAE) once the broker no longer reports the position", async () => {
  const worker = createWorker();
  worker.trackedTrades.push({
    strategy: "B", direction: "short", entryPrice: 5500, stopPrice: 5510, targetPrice: 5470,
    contractId: "CON.F.US.EP.U26", size: 2, orderId: 42, mfe: 15, mae: 4, openedAt: "t",
  });
  worker.bars.push({ close: 5486 });

  worker.openPositions = []; // broker reports nothing for this contract -> closed
  await worker.detectClosedTrades();

  assert.equal(worker.trackedTrades.length, 0);
  const row = worker.logger.buffer.find((r) => r.outcome === "closed");
  assert.ok(row, "expected a closed-trade log row");
  assert.equal(row.strategy, "B");
  assert.equal(row.direction, "short");
  assert.equal(row.mfe, 15);
  assert.equal(row.mae, 4);
  assert.equal(row.approx_exit_price, 5486);
});

test("Worker: a closed trade feeds the per-strategy win/loss halt — a losing close increments losses, a winning close halts that strategy", async () => {
  const worker = createWorker();

  worker.trackedTrades.push({
    strategy: "B", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520,
    contractId: "CON.F.US.EP.U26", size: 2, orderId: 1, mfe: 0, mae: 10, openedAt: "t",
  });
  worker.bars.push({ close: 5492 }); // long, exited below entry -> a loss
  worker.openPositions = [];
  await worker.detectClosedTrades();
  assert.equal(worker.riskManager.lossesToday.B, 1);
  assert.equal(worker.riskManager.canTrade("B"), true); // 1 loss, cap is 2

  worker.trackedTrades.push({
    strategy: "B", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520,
    contractId: "CON.F.US.EP.U26", size: 2, orderId: 2, mfe: 20, mae: 0, openedAt: "t",
  });
  worker.bars.push({ close: 5515 }); // long, exited above entry -> a win
  worker.openPositions = [];
  await worker.detectClosedTrades();
  assert.equal(worker.riskManager.winsToday.B, 1);
  assert.equal(worker.riskManager.canTrade("B"), false); // one winner and done for the day
});

test("Worker: detectClosedTrades leaves a trade tracked while the broker still reports a matching position", async () => {
  const worker = createWorker();
  worker.trackedTrades.push({
    strategy: "OF", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520,
    contractId: "CON.F.US.EP.U26", size: 4, orderId: 1, mfe: 5, mae: 2, openedAt: "t",
  });
  worker.openPositions = [{ contractId: "CON.F.US.EP.U26", size: 4 }];
  await worker.detectClosedTrades();

  assert.equal(worker.trackedTrades.length, 1);
  assert.equal(worker.logger.size, 0);
});

test("detectClosedTrades: checks each tracked trade against its OWN account role's positions, not the other account's", async () => {
  const worker = createWorker();
  worker.trackedTrades = [
    { accountRole: "default", strategy: "B", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, contractId: "CON.F.US.MES.U26", size: 2, orderId: 1, mfe: 0, mae: 0, openedAt: "t" },
    { accountRole: "A", strategy: "OF", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, contractId: "CON.F.US.MES.U26", size: 2, orderId: 2, mfe: 0, mae: 0, openedAt: "t" },
  ];
  worker.bars.push({ close: 5510 });
  worker.openPositions = [{ contractId: "CON.F.US.MES.U26" }]; // real account: still open -> keep the "default" trade
  worker.openPositionsA = []; // practice account: broker reports nothing -> the "A"-role trade closed

  await worker.detectClosedTrades();

  assert.equal(worker.trackedTrades.length, 1);
  assert.equal(worker.trackedTrades[0].accountRole, "default");
});

test("closeOnDirectionFlip: only considers trades from the SAME account role as the incoming signal", async () => {
  const worker = createWorker();
  worker.trackedTrades = [
    { accountRole: "A", direction: "short", contractId: "CON.F.US.MES.U26", strategy: "OF" },
  ];

  // A same-contract LONG flip on the "default" role must not touch the Order
  // Flow Bot's opposite-direction practice trade — that's a different
  // account, and finding no "default"-role trades to close means this
  // returns before ever touching the network.
  await worker.closeOnDirectionFlip("real-account-id", "CON.F.US.MES.U26", "long", "default");

  assert.equal(worker.trackedTrades.length, 1);
});

test("classifyPassiveClose: orphaned bracket orders still resting -> manual_close, and they get cancelled", async () => {
  const worker = createWorker();
  const trade = { contractId: "CON.F.US.EP.U26" };
  const cancelled = [];
  const fakeClient = {
    resolveAccountId: async () => "acct1",
    searchOpenOrders: async () => [
      { id: "o1", contractId: "CON.F.US.EP.U26" },
      { id: "o2", contractId: "CON.F.US.EP.U26" },
      { id: "o3", contractId: "CON.OTHER" }, // a different contract's resting order — not ours to touch
    ],
    cancelOrder: async (accountId, orderId) => cancelled.push([accountId, orderId]),
  };

  const outcome = await worker.classifyPassiveClose(trade, fakeClient);

  assert.equal(outcome, "manual_close");
  assert.deepEqual(cancelled.sort(), [["acct1", "o1"], ["acct1", "o2"]]);
});

test("classifyPassiveClose: no resting orders on the contract -> closed (a genuine bracket fill)", async () => {
  const worker = createWorker();
  const trade = { contractId: "CON.F.US.EP.U26" };
  const fakeClient = {
    resolveAccountId: async () => "acct1",
    searchOpenOrders: async () => [{ id: "o1", contractId: "CON.OTHER" }],
    cancelOrder: async () => assert.fail("should not cancel anything when nothing is orphaned"),
  };

  const outcome = await worker.classifyPassiveClose(trade, fakeClient);
  assert.equal(outcome, "closed");
});

test("classifyPassiveClose: falls back to closed if the broker check itself fails", async () => {
  const worker = createWorker();
  const trade = { contractId: "CON.F.US.EP.U26" };
  const fakeClient = {
    resolveAccountId: async () => {
      throw new Error("network down");
    },
  };

  const outcome = await worker.classifyPassiveClose(trade, fakeClient);
  assert.equal(outcome, "closed");
});

test("logClosedTrade: a manual_close outcome is logged distinctly and still feeds the win/loss halt like any other close", () => {
  const worker = createWorker();
  worker.bars.push({ close: 5508 }); // closed above entry -> a win, same as if the target had filled
  worker.logClosedTrade(
    { strategy: "B", direction: "long", entryPrice: 5500, mfe: 8, mae: 0, mongoId: null },
    "manual_close"
  );
  assert.equal(worker.riskManager.winsToday.B, 1);
  const row = worker.logger.buffer.find((r) => r.outcome === "manual_close");
  assert.ok(row, "expected a manual_close log row");
});

test("notifyManualTradeDetected: does not throw when called with a constructed trade", () => {
  const worker = createWorker();
  assert.doesNotThrow(() =>
    worker.notifyManualTradeDetected({ accountRole: "default", direction: "long", size: 5, entryPrice: 7432.75 })
  );
});

test("notifyManualClose: does not throw when called with a constructed trade and a realized P&L", () => {
  const worker = createWorker();
  assert.doesNotThrow(() =>
    worker.notifyManualClose({ strategy: "B", direction: "long", entryPrice: 7432.75, size: 5 }, 7450, 431.25)
  );
});

test("confirmRealEntryPrice: corrects entry/stop/target to the broker's real fill, preserving the R-distance", async () => {
  const worker = createWorker();
  const trade = { entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, mongoId: null };
  const fakeClient = {
    searchOpenPositions: async () => [{ contractId: "CON.F.US.EP.U26", averagePrice: 5493.75 }],
  };

  await worker.confirmRealEntryPrice(trade, "acct1", "CON.F.US.EP.U26", fakeClient);

  assert.equal(trade.entryPrice, 5493.75);
  assert.equal(trade.stopPrice, 5483.75); // same -10 offset from entry, preserved
  assert.equal(trade.originalStopPrice, 5483.75);
  assert.equal(trade.targetPrice, 5513.75); // same +20 offset from entry, preserved
  assert.equal(trade.originalTargetPrice, 5513.75);
});

test("confirmRealEntryPrice: retries until the position shows up, then stops", async () => {
  const worker = createWorker();
  const trade = { entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, mongoId: null };
  let calls = 0;
  const fakeClient = {
    searchOpenPositions: async () => {
      calls += 1;
      if (calls < 3) return []; // not visible yet
      return [{ contractId: "CON.F.US.EP.U26", averagePrice: 5500.25 }];
    },
  };

  await worker.confirmRealEntryPrice(trade, "acct1", "CON.F.US.EP.U26", fakeClient, 5, 1);

  assert.equal(calls, 3);
  assert.equal(trade.entryPrice, 5500.25);
});

test("confirmRealEntryPrice: gives up after all attempts and leaves the theoretical entry untouched", async () => {
  const worker = createWorker();
  const trade = { entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, mongoId: null };
  const fakeClient = { searchOpenPositions: async () => [] }; // position never shows up

  await worker.confirmRealEntryPrice(trade, "acct1", "CON.F.US.EP.U26", fakeClient, 3, 1);

  assert.equal(trade.entryPrice, 5500); // untouched
});

test("confirmRealEntryPrice: a lookup failure is swallowed, leaving the theoretical entry untouched", async () => {
  const worker = createWorker();
  const trade = { entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, mongoId: null };
  const fakeClient = {
    searchOpenPositions: async () => {
      throw new Error("network down");
    },
  };

  await worker.confirmRealEntryPrice(trade, "acct1", "CON.F.US.EP.U26", fakeClient);

  assert.equal(trade.entryPrice, 5500);
});

test("shouldFlushLogNow: null before the scheduled time", () => {
  const flushET = { h: 16, m: 5 };
  assert.equal(shouldFlushLogNow(new Date(2026, 6, 24, 16, 4), flushET), null);
});

test("shouldFlushLogNow: returns the day-key at/after the scheduled time — whether it's already been flushed is checked separately, against Mongo", () => {
  const flushET = { h: 16, m: 5 };
  const t = new Date(2026, 6, 24, 16, 10);
  assert.equal(shouldFlushLogNow(t, flushET), t.toDateString());
});
