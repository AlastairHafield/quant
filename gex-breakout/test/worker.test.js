import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minutesOf,
  orbWindowBounds,
  isWithinOrbWindow,
  updateOrbRange,
  computeOrbFromHistoricalBars,
  tradesRequiringCloseOnFlip,
  untrackedPositions,
  shiftWalls,
  buildLevelState,
  shouldFlushLogNow,
  createWorker,
} from "../src/worker.js";
import { CONFIG } from "../src/config.js";

test("minutesOf converts a Date to minutes-since-midnight", () => {
  assert.equal(minutesOf(new Date(2026, 6, 24, 9, 30)), 570);
  assert.equal(minutesOf(new Date(2026, 6, 24, 0, 0)), 0);
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

test("Worker end-to-end: the consecutive-loss kill switch stops further trading for the day", () => {
  const worker = createWorker();
  worker.riskManager.recordTradeResult(-100);
  worker.riskManager.recordTradeResult(-50);
  assert.equal(worker.riskManager.canTrade(), false);

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
  assert.equal(worker.logger.size, 0); // evaluateSignals bails out before ever logging
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

test("Worker: detectClosedTrades logs a closed-trade row (with MFE/MAE) once the broker no longer reports the position", () => {
  const worker = createWorker();
  worker.trackedTrades.push({
    strategy: "B", direction: "short", entryPrice: 5500, stopPrice: 5510, targetPrice: 5470,
    contractId: "CON.F.US.EP.U26", size: 2, orderId: 42, mfe: 15, mae: 4, openedAt: "t",
  });
  worker.bars.push({ close: 5486 });

  worker.openPositions = []; // broker reports nothing for this contract -> closed
  worker.detectClosedTrades();

  assert.equal(worker.trackedTrades.length, 0);
  const row = worker.logger.buffer.find((r) => r.outcome === "closed");
  assert.ok(row, "expected a closed-trade log row");
  assert.equal(row.strategy, "B");
  assert.equal(row.direction, "short");
  assert.equal(row.mfe, 15);
  assert.equal(row.mae, 4);
  assert.equal(row.approx_exit_price, 5486);
});

test("Worker: detectClosedTrades leaves a trade tracked while the broker still reports a matching position", () => {
  const worker = createWorker();
  worker.trackedTrades.push({
    strategy: "A", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520,
    contractId: "CON.F.US.EP.U26", size: 4, orderId: 1, mfe: 5, mae: 2, openedAt: "t",
  });
  worker.openPositions = [{ contractId: "CON.F.US.EP.U26", size: 4 }];
  worker.detectClosedTrades();

  assert.equal(worker.trackedTrades.length, 1);
  assert.equal(worker.logger.size, 0);
});

test("shouldFlushLogNow: null before the scheduled time or if already flushed today", () => {
  const flushET = { h: 16, m: 5 };
  assert.equal(shouldFlushLogNow(new Date(2026, 6, 24, 16, 4), flushET, null), null);
  const today = new Date(2026, 6, 24, 16, 5).toDateString();
  assert.equal(shouldFlushLogNow(new Date(2026, 6, 24, 16, 5), flushET, today), null);
});

test("shouldFlushLogNow: returns the day-key once at/after the scheduled time on a not-yet-flushed day", () => {
  const flushET = { h: 16, m: 5 };
  const t = new Date(2026, 6, 24, 16, 10);
  assert.equal(shouldFlushLogNow(t, flushET, null), t.toDateString());
  assert.equal(shouldFlushLogNow(t, flushET, "some other day"), t.toDateString());
});
