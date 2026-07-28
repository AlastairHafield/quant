import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minutesOf,
  orbWindowBounds,
  isWithinOrbWindow,
  shouldFlattenNow,
  updateOrbRange,
  computeOrbFromHistoricalBars,
  tradesRequiringCloseOnFlip,
  untrackedPositions,
  shiftWalls,
  buildLevelState,
  shouldFlushLogNow,
  createWorker,
  isLiveExecutionAllowed,
  accountRoleFor,
} from "../src/worker.js";
import { CONFIG } from "../src/config.js";

test("minutesOf converts a Date to minutes-since-midnight", () => {
  assert.equal(minutesOf(new Date(2026, 6, 24, 9, 30)), 570);
  assert.equal(minutesOf(new Date(2026, 6, 24, 0, 0)), 0);
});

test("isLiveExecutionAllowed: Strategy A needs its own separate flag on top of the bot-wide switch", () => {
  assert.equal(isLiveExecutionAllowed("A", { executionEnabled: true, strategyA: { executionEnabled: true } }), true);
  assert.equal(isLiveExecutionAllowed("A", { executionEnabled: true, strategyA: { executionEnabled: false } }), false);
  assert.equal(isLiveExecutionAllowed("A", { executionEnabled: false, strategyA: { executionEnabled: true } }), false);
});

test("accountRoleFor: Strategy A gets its own role, everything else is 'default'", () => {
  assert.equal(accountRoleFor("A"), "A");
  assert.equal(accountRoleFor("B"), "default");
  assert.equal(accountRoleFor("reconciled"), "default");
});

test("isLiveExecutionAllowed: Strategy B (and anything else) just follows the bot-wide switch", () => {
  assert.equal(isLiveExecutionAllowed("B", { executionEnabled: true, strategyA: { executionEnabled: false } }), true);
  assert.equal(isLiveExecutionAllowed("B", { executionEnabled: false, strategyA: { executionEnabled: false } }), false);
});

test("orbWindowBounds derives the [open, open+window) range from config", () => {
  const bounds = orbWindowBounds({ sessionOpenET: { h: 9, m: 30 }, orbWindowMin: 15 });
  assert.deepEqual(bounds, { startMin: 570, endMin: 585 });
});

test("isWithinOrbWindow: true inside the window, false at/after the end and before the start", () => {
  const bounds = { startMin: 570, endMin: 585 };
  assert.equal(isWithinOrbWindow(new Date(2026, 6, 24, 9, 30), bounds), true);
  assert.equal(isWithinOrbWindow(new Date(2026, 6, 24, 9, 44), bounds), true);
  assert.equal(isWithinOrbWindow(new Date(2026, 6, 24, 9, 45), bounds), false);
  assert.equal(isWithinOrbWindow(new Date(2026, 6, 24, 9, 29), bounds), false);
});

test("shouldFlattenNow: false before flattenAtET, true at/after it", () => {
  const config = { flattenAtET: { h: 15, m: 55 } };
  assert.equal(shouldFlattenNow(new Date(2026, 6, 24, 15, 54), config), false);
  assert.equal(shouldFlattenNow(new Date(2026, 6, 24, 15, 55), config), true);
  assert.equal(shouldFlattenNow(new Date(2026, 6, 24, 16, 30), config), true);
});

test("updateOrbRange: expands high/low as bars come in, starting from null", () => {
  let range = { orbHigh: null, orbLow: null };
  range = updateOrbRange(range, { high: 5510, low: 5505 });
  assert.deepEqual(range, { orbHigh: 5510, orbLow: 5505 });
  range = updateOrbRange(range, { high: 5515, low: 5508 });
  assert.deepEqual(range, { orbHigh: 5515, orbLow: 5505 }); // high extends, low doesn't retreat
  range = updateOrbRange(range, { high: 5512, low: 5500 });
  assert.deepEqual(range, { orbHigh: 5515, orbLow: 5500 });
});

// identityToET stands in for the module's real ET-conversion function — bar
// timestamps here are constructed as already-ET-equivalent local Dates, same
// convention the rest of this suite uses to stay deterministic regardless of
// the machine's own timezone.
const identityToET = (d) => d;

test("computeOrbFromHistoricalBars: reduces bars falling in the day+window to high/low, ignoring bars outside either", () => {
  const bounds = { startMin: 570, endMin: 585 }; // 9:30-9:45
  const bars = [
    { high: 5510, low: 5505, timestamp: new Date(2026, 6, 24, 9, 32) },
    { high: 5520, low: 5502, timestamp: new Date(2026, 6, 24, 9, 40) },
    { high: 5530, low: 5525, timestamp: new Date(2026, 6, 24, 9, 50) }, // right day, outside the window
    { high: 5999, low: 5001, timestamp: new Date(2026, 6, 23, 9, 32) }, // right window, wrong day
  ];
  const range = computeOrbFromHistoricalBars(bars, new Date(2026, 6, 24).toDateString(), bounds, identityToET);
  assert.deepEqual(range, { high: 5520, low: 5502 });
});

test("computeOrbFromHistoricalBars: null when no bars fall in the day+window", () => {
  const bounds = { startMin: 570, endMin: 585 };
  const bars = [{ high: 5510, low: 5505, timestamp: new Date(2026, 6, 24, 10, 0) }];
  assert.equal(computeOrbFromHistoricalBars(bars, new Date(2026, 6, 24).toDateString(), bounds, identityToET), null);
});

test("tradesRequiringCloseOnFlip: empty when no tracked trades exist for the contract", () => {
  assert.deepEqual(tradesRequiringCloseOnFlip([], "CON.F.US.MES.U26", "long"), []);
});

test("tradesRequiringCloseOnFlip: empty when every tracked trade on the contract already agrees with the new direction", () => {
  const trades = [
    { contractId: "CON.F.US.MES.U26", direction: "long", strategy: "A" },
    { contractId: "CON.F.US.MES.U26", direction: "long", strategy: "B" },
  ];
  assert.deepEqual(tradesRequiringCloseOnFlip(trades, "CON.F.US.MES.U26", "long"), []);
});

test("tradesRequiringCloseOnFlip: ignores trades on other contracts", () => {
  const trades = [{ contractId: "CON.F.US.ES.U26", direction: "short", strategy: "A" }];
  assert.deepEqual(tradesRequiringCloseOnFlip(trades, "CON.F.US.MES.U26", "long"), []);
});

test("tradesRequiringCloseOnFlip: returns every tracked trade on the contract (not just the opposite-direction one) once any of them conflicts — a contract has only one real net position", () => {
  const trades = [
    { contractId: "CON.F.US.MES.U26", direction: "short", strategy: "B" },
    { contractId: "CON.F.US.MES.U26", direction: "long", strategy: "A" }, // agrees with the new signal, but still shares the same net position
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
  const state = buildLevelState({ gexSnapshot: null, basis: null, orbHigh: null, orbLow: null, orbLocked: false, dailyLevels: [], consolRange: null });
  assert.deepEqual(state, {
    levels: [],
    triggerLevelsB: [],
    flipPointEs: null,
    wallsEs: { aboveSpot: [], belowSpot: [] },
  });
});

test("buildLevelState: composes GEX/ORB/daily/consolidation levels, basis-shifted", () => {
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
    orbHigh: 5520,
    orbLow: 5510,
    orbLocked: true,
    dailyLevels: [{ type: "PRIOR_DAY_HIGH", price: 5540, role: "strategyB_trigger" }],
    consolRange: { high: 5516, low: 5512 },
  });

  assert.equal(state.flipPointEs, 5508); // 5500 + 8
  assert.equal(state.wallsEs.aboveSpot[0].strike, 5533);
  assert.ok(state.levels.some((l) => l.type === "ORB_HIGH" && l.price === 5520));
  assert.ok(state.levels.some((l) => l.type === "PRIOR_DAY_HIGH" && l.price === 5540));
  assert.ok(state.levels.some((l) => l.type === "CONSOL_HIGH" && l.price === 5516));
  // Strategy B triggers exclude the ORB levels (those are Strategy A's own trigger)
  assert.ok(!state.triggerLevelsB.some((l) => l.type === "ORB_HIGH"));
  assert.ok(state.triggerLevelsB.some((l) => l.type === "GEX_WALL"));
});

function esBar({ high, low, close, buyVolume, sellVolume }) {
  return { high, low, close, volume: buyVolume + sellVolume, buyVolume, sellVolume };
}

test("checkDayRollover: resets ORB state, pending breakouts, and risk-manager day-state on a new calendar day", () => {
  const worker = createWorker();
  worker.currentDay = new Date(2026, 6, 27).toDateString();
  worker.orbHigh = 5520;
  worker.orbLow = 5510;
  worker.orbLocked = true;
  worker.orbBackfillInFlight = true;
  worker.pendingA = { direction: "long" };
  worker.pendingB = { direction: "short" };
  worker.riskManager.recordTradeResult("A", -100); // a loss recorded yesterday
  worker.riskManager.recordOrbTrade("long");

  worker.checkDayRollover(new Date(2026, 6, 28, 0, 1)); // just past midnight, a new day

  assert.equal(worker.currentDay, new Date(2026, 6, 28).toDateString());
  assert.equal(worker.orbHigh, null);
  assert.equal(worker.orbLow, null);
  assert.equal(worker.orbLocked, false);
  assert.equal(worker.orbBackfillInFlight, false);
  assert.equal(worker.pendingA, null);
  assert.equal(worker.pendingB, null);
  assert.equal(worker.riskManager.lossesToday.A, 0);
  assert.equal(worker.riskManager.orbTradedDirections.size, 0);
});

test("checkDayRollover: a no-op when called again the same day (doesn't wipe an in-progress ORB build)", () => {
  const worker = createWorker();
  worker.currentDay = new Date(2026, 6, 27).toDateString();
  worker.orbHigh = 5520;
  worker.orbLow = 5510;

  worker.checkDayRollover(new Date(2026, 6, 27, 9, 40)); // still the same day

  assert.equal(worker.orbHigh, 5520);
  assert.equal(worker.orbLow, 5510);
});

test("onBar: a stale orbLocked=true from a late-day backfill on one day does not carry into the next day's pre-market bars (caught live 2026-07-28)", () => {
  const worker = createWorker();
  // Simulates exactly what happened live: a worker restart late on day 1
  // backfills that day's already-completed ORB, locking it — nothing used to
  // reset this before the next calendar day's pre-market bars arrived.
  worker.currentDay = new Date(2026, 6, 27).toDateString();
  worker.orbHigh = 5520;
  worker.orbLow = 5510;
  worker.orbLocked = true;
  worker.gexSnapshot = { netGex: -5e9, flipPoint: 5500, walls: { aboveSpot: [], belowSpot: [] }, confidence: "FULL" };
  worker.basis = 0;
  worker.rebuildLevels();

  // A pre-market bar on the NEXT day, well before the real 9:30 ET session.
  worker.onBar(esBar({ high: 5525, low: 5522, close: 5524, buyVolume: 100, sellVolume: 10 }), new Date(2026, 6, 28, 4, 6));

  assert.equal(worker.orbLocked, false); // reset by day rollover
  assert.equal(worker.logger.size, 0); // evaluateSignals never ran — no signal, no trade
});

test("Worker end-to-end: a clean NEG_GAMMA ORB breakout with strong flow produces a non-vetoed Strategy A signal", () => {
  const worker = createWorker();
  worker.gexSnapshot = {
    netGex: -5e9,
    flipPoint: 5400,
    walls: { aboveSpot: [], belowSpot: [] },
    confidence: "FULL",
  };
  worker.basis = 8; // ES = SPX + 8, so flip in ES terms = 5408
  worker.rebuildLevels();

  // ORB window: 09:30-09:44, tight range so the mid-range stop stays under the cap.
  for (let m = 30; m < 45; m++) {
    worker.onBar(esBar({ high: 5520, low: 5515, close: 5518, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 9, m));
  }
  assert.equal(worker.orbHigh, 5520);
  assert.equal(worker.orbLow, 5515);
  assert.equal(worker.orbLocked, false); // not locked until the first bar after the window

  // 20 quiet bars post-window to build a baseline avg delta/volume, still inside the ORB range.
  for (let i = 0; i < 20; i++) {
    worker.onBar(
      esBar({ high: 5518.1, low: 5517.9, close: 5518, buyVolume: 55, sellVolume: 45 }),
      new Date(2026, 6, 24, 9, 45 + i)
    );
  }
  assert.equal(worker.orbLocked, true);

  // Strong breakout bar + confirmation bar, both clearly buy-side.
  worker.onBar(
    esBar({ high: 5523, low: 5520, close: 5522, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 10, 5)
  );
  worker.onBar(
    esBar({ high: 5524, low: 5521, close: 5523, buyVolume: 150, sellVolume: 50 }),
    new Date(2026, 6, 24, 10, 6)
  );

  const rows = worker.logger.buffer;
  const signalRow = rows.find((r) => r.strategy === "A" && r.veto_reason === null);
  assert.ok(signalRow, "expected a non-vetoed Strategy A signal in the log");
  assert.equal(signalRow.direction, "long");
  assert.equal(signalRow.flow_grade, "A");
  assert.ok(worker.riskManager.dayState.orbTradedDirections.has("long"));
});

test("Worker end-to-end: POS_GAMMA regime vetoes an ORB breakout with no flip break or override", () => {
  const worker = createWorker();
  worker.gexSnapshot = {
    netGex: 5e9, // POS_GAMMA
    flipPoint: 5900, // far from price, no NEAR_FLIP
    walls: { aboveSpot: [], belowSpot: [] },
    confidence: "FULL",
  };
  worker.basis = 0;
  worker.rebuildLevels();

  for (let m = 30; m < 45; m++) {
    worker.onBar(esBar({ high: 5520, low: 5515, close: 5518, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 9, m));
  }
  for (let i = 0; i < 20; i++) {
    worker.onBar(
      esBar({ high: 5518.1, low: 5517.9, close: 5518, buyVolume: 55, sellVolume: 45 }),
      new Date(2026, 6, 24, 9, 45 + i)
    );
  }
  worker.onBar(
    esBar({ high: 5523, low: 5520, close: 5522, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 10, 5)
  );
  worker.onBar(
    esBar({ high: 5524, low: 5521, close: 5523, buyVolume: 150, sellVolume: 50 }),
    new Date(2026, 6, 24, 10, 6)
  );

  const rows = worker.logger.buffer;
  const vetoRow = rows.find((r) => r.strategy === "A");
  assert.ok(vetoRow);
  assert.equal(vetoRow.veto_reason, "pos_gamma_no_confirmation");
  assert.equal(worker.riskManager.dayState.orbTradedDirections.size, 0);
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

test("handleSignal: Strategy A checks its OWN (practice) account's positions, independent of the real account", () => {
  const worker = createWorker();
  worker.openPositions = [{ contractId: "CON.F.US.MES.U26", size: 4 }]; // real account has something open (e.g. Strategy B)
  worker.openPositionsA = []; // but the practice account is flat
  const result = { strategy: "A", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, sizeMultiplier: 1 };

  worker.handleSignal(result, { regime: "NEG_GAMMA" }, { grade: "A" });

  assert.equal(worker.logger.buffer[0].veto_reason, null); // not blocked by the real account's unrelated position
});

test("handleSignal: Strategy B is unaffected by Strategy A's own practice-account position", () => {
  const worker = createWorker();
  worker.openPositions = []; // real account is flat
  worker.openPositionsA = [{ contractId: "CON.F.US.MES.U26", size: 4 }]; // practice account has something open
  const result = { strategy: "B", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, sizeMultiplier: 1 };

  worker.handleSignal(result, { regime: "NEG_GAMMA" }, { grade: "A" });

  assert.equal(worker.logger.buffer[0].veto_reason, null); // not blocked by Strategy A's unrelated practice position
});

test("Worker end-to-end: a strategy's own loss/win halt stops further trading for the day", () => {
  const worker = createWorker();
  worker.riskManager.recordTradeResult("A", -100);
  worker.riskManager.recordTradeResult("A", -50); // A halted: 2 losses
  worker.riskManager.recordTradeResult("B", 25); // B halted: 1 winner
  assert.equal(worker.riskManager.canTrade("A"), false);
  assert.equal(worker.riskManager.canTrade("B"), false);

  worker.gexSnapshot = { netGex: -5e9, flipPoint: 5400, walls: { aboveSpot: [], belowSpot: [] } };
  worker.basis = 0;
  worker.rebuildLevels();
  for (let m = 30; m < 45; m++) {
    worker.onBar(esBar({ high: 5520, low: 5515, close: 5518, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 9, m));
  }
  worker.onBar(
    esBar({ high: 5523, low: 5520, close: 5522, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 9, 46)
  );
  assert.equal(worker.logger.size, 0); // both tryStrategyA/tryStrategyB bail out before ever logging
});

test("Worker: onBar routes to the EOD flatten path (skips evaluateSignals) once past flattenAtET with an open trade", () => {
  const worker = createWorker();
  worker.orbHigh = 5525;
  worker.orbLow = 5518;
  worker.orbLocked = true;
  worker.gexSnapshot = { netGex: -5e9, flipPoint: 5400, walls: { aboveSpot: [], belowSpot: [] } };
  worker.basis = 0;
  worker.rebuildLevels();
  worker.trackedTrades.push({
    strategy: "A", direction: "long", entryPrice: 5520, stopPrice: 5515, targetPrice: 5540,
    contractId: "CON.F.US.EP.U26", size: 4, orderId: 1, mfe: 0, mae: 0, openedAt: "t",
  });

  // A clean breakout bar that would otherwise fire a Strategy A signal.
  worker.onBar(
    esBar({ high: 5528, low: 5526, close: 5527, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 15, 56)
  );
  assert.equal(worker.logger.size, 0); // evaluateSignals never ran
});

test("Worker: onBar does not take the flatten path when there's nothing open (falls through to evaluateSignals)", () => {
  const worker = createWorker();
  worker.orbHigh = 5525;
  worker.orbLow = 5518;
  worker.orbLocked = true;
  worker.gexSnapshot = { netGex: -5e9, flipPoint: 5400, walls: { aboveSpot: [], belowSpot: [] } };
  worker.basis = 0;
  worker.rebuildLevels();

  // Also past entryCutoffET (12:00), so evaluateSignals itself bails out too —
  // this just confirms flattenAll() is never reached with an empty
  // trackedTrades (no broker call attempted, nothing thrown synchronously).
  assert.doesNotThrow(() => {
    worker.onBar(esBar({ high: 5528, low: 5526, close: 5527, buyVolume: 300, sellVolume: 50 }), new Date(2026, 6, 24, 15, 56));
  });
  assert.equal(worker.trackedTrades.length, 0);
});

test("Worker: onBar updates MFE/MAE for every tracked trade as new bars arrive", () => {
  const worker = createWorker();
  worker.trackedTrades.push({
    strategy: "A", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520,
    contractId: "CON.F.US.EP.U26", size: 4, orderId: 1, mfe: 0, mae: 0, openedAt: "t",
  });

  worker.onBar(esBar({ high: 5510, low: 5497, close: 5505, buyVolume: 10, sellVolume: 5 }), new Date(2026, 6, 24, 9, 10));
  assert.equal(worker.trackedTrades[0].mfe, 10); // 5510-5500
  assert.equal(worker.trackedTrades[0].mae, 3); // 5500-5497

  worker.onBar(esBar({ high: 5508, low: 5480, close: 5490, buyVolume: 5, sellVolume: 20 }), new Date(2026, 6, 24, 9, 11));
  assert.equal(worker.trackedTrades[0].mfe, 10); // unchanged, prior bar's high was better
  assert.equal(worker.trackedTrades[0].mae, 20); // 5500-5480, new worse adverse excursion
});

test("Worker: evaluateOpenTrades dispatches a non-HOLD evaluateExit result (failed breakout) for a tracked trade", () => {
  const worker = createWorker();
  worker.onBar(esBar({ high: 5501, low: 5499, close: 5500, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 10, 0));
  const entryIndex = worker.bars.length - 1;
  worker.trackedTrades.push({
    strategy: "A", direction: "long", entryPrice: 5500, stopPrice: 5490, originalStopPrice: 5490,
    targetPrice: 5520, originalTargetPrice: 5520, brokenLevel: 5500, entryIndex, lastRegimeBase: "NEG_GAMMA",
    movedToBreakeven: true, actionInFlight: false, contractId: "CON.F.US.EP.U26", size: 4, orderId: 1,
    mfe: 0, mae: 0, openedAt: "t",
  });

  // Closes below brokenLevel(5500) - failedBreakoutPts(2) = 5498 -> EXIT_NOW.
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
    strategy: "A", direction: "long", entryPrice: 5500, stopPrice: 5490, originalStopPrice: 5490,
    targetPrice: 5520, originalTargetPrice: 5520, brokenLevel: 5500, entryIndex, lastRegimeBase: "NEG_GAMMA",
    movedToBreakeven: true, actionInFlight: false, contractId: "CON.F.US.EP.U26", size: 4, orderId: 1,
    mfe: 0, mae: 0, openedAt: "t",
  });

  worker.onBar(esBar({ high: 5503, low: 5501, close: 5502, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 10, 1));
  assert.equal(worker.trackedTrades[0].actionInFlight, false);
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
    strategy: "A", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520,
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
    { accountRole: "A", strategy: "A", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, contractId: "CON.F.US.MES.U26", size: 2, orderId: 2, mfe: 0, mae: 0, openedAt: "t" },
  ];
  worker.bars.push({ close: 5510 });
  worker.openPositions = [{ contractId: "CON.F.US.MES.U26" }]; // real account: still open -> keep the "default" trade
  worker.openPositionsA = []; // practice account: broker reports nothing -> the "A" trade closed

  await worker.detectClosedTrades();

  assert.equal(worker.trackedTrades.length, 1);
  assert.equal(worker.trackedTrades[0].accountRole, "default");
});

test("closeOnDirectionFlip: only considers trades from the SAME account role as the incoming signal", async () => {
  const worker = createWorker();
  worker.trackedTrades = [
    { accountRole: "A", direction: "short", contractId: "CON.F.US.MES.U26", strategy: "A" },
  ];

  // A same-contract LONG flip on the "default" role must not touch Strategy
  // A's opposite-direction practice trade — that's a different account, and
  // finding no "default"-role trades to close means this returns before ever
  // touching the network.
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
