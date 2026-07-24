import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minutesOf,
  orbWindowBounds,
  isWithinOrbWindow,
  updateOrbRange,
  shiftWalls,
  buildLevelState,
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
