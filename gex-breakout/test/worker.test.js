import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minutesOf,
  shouldFlattenNow,
  tradesRequiringCloseOnFlip,
  untrackedPositions,
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
  assert.equal(accountRoleFor("reconciled"), "default");
});

test("isLiveExecutionAllowed: anything but the Order Flow Bot just follows the bot-wide switch", () => {
  assert.equal(isLiveExecutionAllowed("reconciled", { executionEnabled: true, orderFlowBot: { executionEnabled: false } }), true);
  assert.equal(isLiveExecutionAllowed("reconciled", { executionEnabled: false, orderFlowBot: { executionEnabled: false } }), false);
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
    { contractId: "CON.F.US.MES.U26", direction: "long", strategy: "reconciled" },
  ];
  assert.deepEqual(tradesRequiringCloseOnFlip(trades, "CON.F.US.MES.U26", "long"), []);
});

test("tradesRequiringCloseOnFlip: ignores trades on other contracts", () => {
  const trades = [{ contractId: "CON.F.US.ES.U26", direction: "short", strategy: "OF" }];
  assert.deepEqual(tradesRequiringCloseOnFlip(trades, "CON.F.US.MES.U26", "long"), []);
});

test("tradesRequiringCloseOnFlip: returns every tracked trade on the contract (not just the opposite-direction one) once any of them conflicts — a contract has only one real net position", () => {
  const trades = [
    { contractId: "CON.F.US.MES.U26", direction: "short", strategy: "reconciled" },
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

function esBar({ high, low, close, buyVolume, sellVolume }) {
  return { high, low, close, volume: buyVolume + sellVolume, buyVolume, sellVolume };
}

test("checkDayRollover: resets risk-manager day-state and footprint bars on a new calendar day", () => {
  const worker = createWorker();
  worker.currentDay = new Date(2026, 6, 27).toDateString();
  worker.riskManager.recordTradeResult("OF", -100); // a loss recorded yesterday
  worker.riskManager.recordOrderFlowTrade("zone1", Date.now());
  worker.footprintBars.push([{ price: 5500, buyVolume: 1, sellVolume: 1 }]);

  worker.checkDayRollover(new Date(2026, 6, 28, 0, 1)); // just past midnight, a new day

  assert.equal(worker.currentDay, new Date(2026, 6, 28).toDateString());
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
  worker.riskManager.recordOrderFlowTrade("zone1", Date.now());

  worker.checkDayRollover(new Date(2026, 6, 27, 9, 40)); // still the same day

  assert.equal(worker.riskManager.dayState.orderFlowTradesToday, 1);
});

test("handleSignal: skips a new signal when the real account already has an open position (shared with other bots)", () => {
  const worker = createWorker();
  worker.openPositions = [{ contractId: "CON.F.US.MES.U26", size: 4 }]; // e.g. Mechanical ORB
  const result = { strategy: "reconciled", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, sizeMultiplier: 1 };

  worker.handleSignal(result, { regime: "TREND" }, { grade: "A" });

  const row = worker.logger.buffer[0];
  assert.equal(row.veto_reason, "position_already_open");
  assert.equal(worker.trackedTrades.length, 0);
});

test("handleSignal: proceeds normally when the account is flat", () => {
  const worker = createWorker();
  worker.openPositions = [];
  const result = { strategy: "reconciled", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, sizeMultiplier: 1 };

  worker.handleSignal(result, { regime: "TREND" }, { grade: "A" });

  const row = worker.logger.buffer[0];
  assert.equal(row.veto_reason, null);
});

test("handleSignal: an already-open position takes priority over the strategy's own veto reason in the logged row", () => {
  const worker = createWorker();
  worker.openPositions = [{ contractId: "CON.F.US.MES.U26", size: 4 }];
  const result = { strategy: "reconciled", direction: "long", veto: "wall_too_close", sizeMultiplier: 1 };

  worker.handleSignal(result, { regime: "RANGE" }, { grade: "A" });

  assert.equal(worker.logger.buffer[0].veto_reason, "position_already_open");
});

test("handleSignal: the Order Flow Bot checks its OWN (practice) account's positions, independent of the real account", () => {
  const worker = createWorker();
  worker.openPositions = [{ contractId: "CON.F.US.MES.U26", size: 4 }]; // real account has something open (e.g. another bot)
  worker.openPositionsA = []; // but the practice account is flat
  const result = { strategy: "OF", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, sizeMultiplier: 1 };

  worker.handleSignal(result, { regime: "TREND" }, { grade: "A" });

  assert.equal(worker.logger.buffer[0].veto_reason, null); // not blocked by the real account's unrelated position
});

test("Worker end-to-end: the Order Flow Bot's own loss/win halt stops further trading for the day", () => {
  const worker = createWorker();

  // Settle currentDay first — checkDayRollover (fired on the first onBar of
  // any fresh worker) resets riskManager.dayState, which would silently undo
  // the halt recorded below if it were set up before the day was established.
  worker.onBar(esBar({ high: 5500, low: 5498, close: 5499, buyVolume: 10, sellVolume: 10 }), new Date(2026, 6, 24, 9, 46));

  worker.riskManager.recordTradeResult("OF", -100);
  worker.riskManager.recordTradeResult("OF", -50); // OF halted: 2 losses
  assert.equal(worker.riskManager.canTrade("OF"), false);

  const sizeBefore = worker.logger.size;
  worker.onBar(
    esBar({ high: 5523, low: 5520, close: 5522, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 9, 47)
  );
  assert.equal(worker.logger.size, sizeBefore); // tryOrderFlow bails on its own halt before evaluating any real trigger logic
});

test("Worker end-to-end: tryOrderFlow fires a real lack-of-participation signal against a live footprint zone", () => {
  const worker = createWorker();
  worker.priorDayAdxOk = true; // TREND day -> stop/target routed through footprint zones, same as before

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

  // Excludes no_trigger_heartbeat rows — bar t(0) has no footprint zones yet
  // (onFootprintBar hasn't fired), so it logs a heartbeat before the real
  // signal arrives on a later bar.
  const row = worker.logger.buffer.find((r) => r.strategy === "OF" && r.veto_reason == null);
  assert.ok(row, "expected a logged Order Flow Bot signal");
  assert.equal(row.veto_reason, null);
  assert.equal(row.direction, "short");
  assert.equal(row.entry_price, 5500);
  assert.equal(row.stop_price, 5501);
  assert.equal(row.target_price, 5000);
  assert.equal(worker.riskManager.dayState.orderFlowTradesToday, 1);
  assert.equal(worker.riskManager.dayState.zoneCooldowns.has("buy:5498.00-5500.00"), true);
});

test("tryOrderFlow: logs a no_trigger_heartbeat row once, throttled by diagnosticHeartbeatMin", () => {
  const worker = createWorker();
  worker.priorDayAdxOk = true; // TREND day

  // Too few bars for absorption/POLR/LOP to ever match (lookbackBars: 4) —
  // guarantees evaluateOrderFlowBot returns a bare null every time, the
  // previously-silent path this heartbeat makes visible.
  worker.onBar(esBar({ high: 5500, low: 5498, close: 5499, buyVolume: 10, sellVolume: 10 }), new Date(2026, 6, 24, 9, 46));

  const heartbeats = () =>
    worker.logger.buffer.filter((r) => r.strategy === "OF" && r.veto_reason === "no_trigger_heartbeat");
  assert.equal(heartbeats().length, 1);
  assert.equal(heartbeats()[0].regime, "TREND");
  assert.equal(heartbeats()[0].delta_stats.baseRegime, "TREND");
  assert.equal(heartbeats()[0].delta_stats.polr.matched, false);
  assert.equal(heartbeats()[0].delta_stats.polr.reason, "insufficient_bars");
  assert.equal(heartbeats()[0].delta_stats.lop.matched, false);

  // A second bar arriving moments later (same real-world instant, well
  // inside diagnosticHeartbeatMin) must not log a second heartbeat.
  worker.onBar(esBar({ high: 5501, low: 5499, close: 5500, buyVolume: 10, sellVolume: 10 }), new Date(2026, 6, 24, 9, 47));
  assert.equal(heartbeats().length, 1);

  // Simulate the throttle window having elapsed — the next bar logs again.
  worker.lastOFHeartbeatAt = Date.now() - 16 * 60000;
  worker.onBar(esBar({ high: 5502, low: 5500, close: 5501, buyVolume: 10, sellVolume: 10 }), new Date(2026, 6, 24, 9, 48));
  assert.equal(heartbeats().length, 2);
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
    { baseRegime: "TREND", regime: "TREND" }
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
    baseRegime: "TREND",
    regime: "TREND",
  });

  assert.equal(worker.lastPOC, null);
  assert.equal(worker.lastValueArea, null);
});

test("executeSignal: clamps a too-tight stop to the broker's minimum distance, even in signal-only mode", async () => {
  const worker = createWorker();
  // MIN_STOP_TICKS(4) * MES tickSize(0.25) = 1pt minimum — computeZoneStop
  // can produce stops this tight (triggerBufferPts=1) when entry sits right
  // at the zone edge; 0.1pt here stands in for that case.
  const result = {
    strategy: "OF", direction: "long", entryPrice: 5500, stopPrice: 5499.9, targetPrice: 5510,
    zoneKey: "buy:5498.00-5500.00", sizeMultiplier: 1,
  };
  await worker.executeSignal(result, { regime: "TREND" }, { grade: "B" }, 2);
  assert.equal(result.stopPrice, 5499);
});

test("executeSignal: leaves an already-adequate stop untouched", async () => {
  const worker = createWorker();
  const result = {
    strategy: "OF", direction: "short", entryPrice: 5500, stopPrice: 5510, targetPrice: 5480,
    level: { price: 5500 }, sizeMultiplier: 1,
  };
  await worker.executeSignal(result, { regime: "TREND" }, { grade: "B" }, 2);
  assert.equal(result.stopPrice, 5510);
});

test("evaluateSignals: does not evaluate before sessionOpenET (pre-market)", () => {
  const worker = createWorker();

  // 2:04am ET, matching the real pre-market trade this gate was added to
  // prevent (2026-07-30, after Phase 1 removed the old orbLocked gate that
  // used to block this as a side effect). lastRegimeInfo only ever gets set
  // once evaluateSignals runs past the time gates, so it staying null proves
  // the gate stopped it before regime classification.
  worker.onBar(
    esBar({ high: 5523, low: 5520, close: 5522, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 2, 4)
  );
  assert.equal(worker.lastRegimeInfo, null);
});

test("evaluateSignals: still does not evaluate during the first 15 minutes of RTH (9:30-9:44)", () => {
  const worker = createWorker();

  worker.onBar(
    esBar({ high: 5523, low: 5520, close: 5522, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 9, 30)
  );
  assert.equal(worker.lastRegimeInfo, null); // sessionOpenET alone no longer lets it through
});

test("evaluateSignals: evaluates normally at/after entryFloorET (9:45)", () => {
  const worker = createWorker();

  worker.onBar(
    esBar({ high: 5523, low: 5520, close: 5522, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 9, 45)
  );
  assert.notEqual(worker.lastRegimeInfo, null); // reached regime classification — the gate let it through
});

test("evaluateSignals: a risk halt blocks the Order Flow Bot, logged distinctly from a normal veto", () => {
  const worker = createWorker();
  worker.haltedForRisk = true;
  worker.haltReason = "daily_loss_cap (pnl -1200.00)";

  worker.onBar(
    esBar({ high: 5523, low: 5520, close: 5522, buyVolume: 300, sellVolume: 50 }),
    new Date(2026, 6, 24, 9, 45)
  );

  assert.equal(worker.lastRegimeInfo, null); // never reached regime classification / tryOrderFlow
  assert.equal(worker.logger.buffer.at(-1).veto_reason, "risk_halt:daily_loss_cap (pnl -1200.00)");
});

test("checkAccountRisk: breaching the account-wide daily loss cap halts new entries for the rest of the day", async () => {
  const worker = createWorker();
  const originalCap = CONFIG.risk.dailyLossCapDollars;
  CONFIG.risk.dailyLossCapDollars = 500;
  try {
    worker.account = { balance: 50000 };
    await worker.checkAccountRisk(new Date(2026, 6, 24, 10, 0)); // snapshots dayStartBalance
    assert.equal(worker.haltedForRisk, false);

    worker.account = { balance: 49400 }; // down $600, past the $500 cap
    await worker.checkAccountRisk(new Date(2026, 6, 24, 10, 5));
    assert.equal(worker.haltedForRisk, true);
    assert.match(worker.haltReason, /daily_loss_cap/);
  } finally {
    CONFIG.risk.dailyLossCapDollars = originalCap;
  }
});

test("tripRiskHalt: sets the halt flag synchronously and attempts to flatten every tracked trade", async () => {
  const worker = createWorker();
  worker.trackedTrades.push({
    strategy: "OF",
    accountRole: "A",
    direction: "long",
    entryPrice: 5520,
    stopPrice: 5515,
    targetPrice: 5540,
    contractId: "CON.F.US.EP.U26",
    size: 4,
    orderId: 1,
    mfe: 0,
    mae: 0,
    openedAt: "t",
  });

  // flattenAll() genuinely hits the broker here (trackedTrades is only ever
  // populated when execution was live — see its own comment), so a real
  // TopstepX credential/network failure in this test environment is expected;
  // what matters is the halt flag is set BEFORE that call, not contingent on
  // its outcome, same resilience posture as every other pollAccount()-driven
  // check in this file.
  await worker.tripRiskHalt("kill_switch").catch(() => {});

  assert.equal(worker.haltedForRisk, true);
  assert.equal(worker.haltReason, "kill_switch");
});

test("Worker: onBar routes to the EOD flatten path (skips evaluateSignals) once past flattenAtET with an open trade", () => {
  const worker = createWorker();
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

test("Worker: evaluateOpenTrades leaves a healthy trade alone (HOLD)", () => {
  const worker = createWorker();
  worker.onBar(esBar({ high: 5501, low: 5499, close: 5500, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 10, 0));
  const entryIndex = worker.bars.length - 1;
  worker.trackedTrades.push({
    strategy: "OF", direction: "long", entryPrice: 5500, stopPrice: 5490, originalStopPrice: 5490,
    targetPrice: 5520, originalTargetPrice: 5520, brokenLevel: 5500, entryIndex,
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
  worker.lastRegimeInfo = { baseRegime: "TREND" }; // trend day -> trail instead of a fixed TP
  worker.lastFootprintZones = [{ side: "buy", low: 5490, high: 5495 }]; // below price -> eligible to trail behind for a long
  worker.trackedTrades.push({
    strategy: "OF", direction: "long", entryPrice: 5500, stopPrice: 5480, originalStopPrice: 5480,
    targetPrice: 6000, originalTargetPrice: 6000, brokenLevel: 5500, entryIndex,
    movedToBreakeven: true, actionInFlight: false, contractId: "CON.F.US.EP.U26", size: 4, orderId: 1,
    mfe: 0, mae: 0, openedAt: "t",
  });

  // stopPrice(5480) sits well below the zone's high(5495) -> TIGHTEN_TO_PRICE
  // moves it up to 5495, which is tighter, so actOnExitResult dispatches —
  // proven by actionInFlight being set synchronously before the broker
  // call's rejection settles (no credentials in this test environment).
  worker.onBar(esBar({ high: 5503, low: 5501, close: 5502, buyVolume: 50, sellVolume: 50 }), new Date(2026, 6, 24, 10, 1));
  assert.equal(worker.trackedTrades[0].actionInFlight, true);
});

test("Worker: detectClosedTrades logs a closed-trade row (with MFE/MAE) once the broker no longer reports the position", async () => {
  const worker = createWorker();
  worker.trackedTrades.push({
    strategy: "OF", direction: "short", entryPrice: 5500, stopPrice: 5510, targetPrice: 5470,
    contractId: "CON.F.US.EP.U26", size: 2, orderId: 42, mfe: 15, mae: 4, openedAt: "t",
  });
  worker.bars.push({ close: 5486 });

  worker.openPositions = []; // broker reports nothing for this contract -> closed
  await worker.detectClosedTrades();

  assert.equal(worker.trackedTrades.length, 0);
  const row = worker.logger.buffer.find((r) => r.outcome === "closed");
  assert.ok(row, "expected a closed-trade log row");
  assert.equal(row.strategy, "OF");
  assert.equal(row.direction, "short");
  assert.equal(row.mfe, 15);
  assert.equal(row.mae, 4);
  assert.equal(row.approx_exit_price, 5486);
});

test("Worker: a closed trade feeds the per-strategy win/loss halt — a losing close increments losses, a winning close halts that strategy", async () => {
  const worker = createWorker();

  worker.trackedTrades.push({
    strategy: "OF", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520,
    contractId: "CON.F.US.EP.U26", size: 2, orderId: 1, mfe: 0, mae: 10, openedAt: "t",
  });
  worker.bars.push({ close: 5492 }); // long, exited below entry -> a loss
  worker.openPositions = [];
  await worker.detectClosedTrades();
  assert.equal(worker.riskManager.lossesToday.OF, 1);
  assert.equal(worker.riskManager.canTrade("OF"), true); // 1 loss, cap is 2

  worker.trackedTrades.push({
    strategy: "OF", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520,
    contractId: "CON.F.US.EP.U26", size: 2, orderId: 2, mfe: 20, mae: 0, openedAt: "t",
  });
  worker.bars.push({ close: 5515 }); // long, exited above entry -> a win
  worker.openPositions = [];
  await worker.detectClosedTrades();
  assert.equal(worker.riskManager.winsToday.OF, 1);
  assert.equal(worker.riskManager.canTrade("OF"), false); // one winner and done for the day
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
    { accountRole: "default", strategy: "reconciled", direction: "long", entryPrice: 5500, stopPrice: 5490, targetPrice: 5520, contractId: "CON.F.US.MES.U26", size: 2, orderId: 1, mfe: 0, mae: 0, openedAt: "t" },
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

test("logClosedTrade: a manual_close outcome is logged distinctly and still feeds the win/loss halt like any other close", async () => {
  const worker = createWorker();
  worker.bars.push({ close: 5508 }); // closed above entry -> a win, same as if the target had filled
  // No real fills available (fakeClient) -> falls back to the bar-close approximation.
  const fakeClient = { resolveAccountId: async () => "acct1", fetchClosingTrades: async () => [] };
  await worker.logClosedTrade(
    {
      strategy: "OF",
      direction: "long",
      entryPrice: 5500,
      mfe: 8,
      mae: 0,
      mongoId: null,
      contractId: "CON.F.US.EP.U26",
      openedAt: new Date().toISOString(),
    },
    "manual_close",
    fakeClient
  );
  assert.equal(worker.riskManager.winsToday.OF, 1);
  const row = worker.logger.buffer.find((r) => r.outcome === "manual_close");
  assert.ok(row, "expected a manual_close log row");
});

test("logClosedTrade: uses the broker's real closing fill(s) instead of the bar-close approximation", async () => {
  const worker = createWorker();
  worker.bars.push({ close: 9999 }); // would look like a big win if the approximation were used
  const fakeClient = {
    resolveAccountId: async () => "acct1",
    fetchClosingTrades: async () => [
      { price: 5495, profitAndLoss: -25 }, // e.g. a partial
      { price: 5490, profitAndLoss: -50 }, // final leg
    ],
  };
  await worker.logClosedTrade(
    {
      strategy: "OF",
      direction: "long",
      entryPrice: 5500,
      mfe: 0,
      mae: 10,
      mongoId: null,
      contractId: "CON.F.US.EP.U26",
      openedAt: new Date().toISOString(),
    },
    "closed",
    fakeClient
  );
  const row = worker.logger.buffer.find((r) => r.outcome === "closed");
  assert.equal(row.approx_exit_price, 5490); // last closing fill's price, not the bar close
  assert.equal(row.realized_pnl, -75); // sum of both closing fills' real P&L
  assert.equal(worker.riskManager.lossesToday.OF, 1); // correctly counted as a loss, not the fake win the bar close would imply
});

test("logClosedTrade: falls back to the bar-close approximation when the real-fill lookup fails", async () => {
  const worker = createWorker();
  worker.bars.push({ close: 5508 });
  const fakeClient = {
    resolveAccountId: async () => {
      throw new Error("network down");
    },
  };
  await worker.logClosedTrade(
    { strategy: "OF", direction: "long", entryPrice: 5500, mfe: 8, mae: 0, mongoId: null, contractId: "CON.F.US.EP.U26", openedAt: new Date().toISOString() },
    "closed",
    fakeClient
  );
  const row = worker.logger.buffer.find((r) => r.outcome === "closed");
  assert.equal(row.approx_exit_price, 5508);
  assert.equal(worker.riskManager.winsToday.OF, 1);
});

test("reconcileOrphanedMongoTrades: closes a Mongo-open trade the broker no longer shows open, using its real fills", async () => {
  const worker = createWorker();
  worker.openPositions = []; // broker: nothing open on the default-role account
  worker.openPositionsA = [];
  const closedCalls = [];
  const fakeJournal = {
    fetchOpenTrades: async () => [
      {
        _id: "doc1",
        strategy: "OF",
        accountRole: "A",
        contractId: "CON.F.US.MES.U26",
        openedAt: "2026-07-31T19:11:00.444Z",
        mfe: 0,
        mae: 0,
      },
    ],
    closeTrade: async (id, update) => closedCalls.push({ id, update }),
  };
  const fakeBroker = {
    resolveAccountId: async () => "acct1",
    fetchClosingTrades: async () => [
      { price: 7513.75, profitAndLoss: 7.5 },
      { price: 7514.5, profitAndLoss: -10 },
    ],
  };

  await worker.reconcileOrphanedMongoTrades(fakeJournal, fakeBroker);

  assert.equal(closedCalls.length, 1);
  assert.equal(closedCalls[0].id, "doc1");
  assert.equal(closedCalls[0].update.exitPrice, 7514.5); // last closing fill
  assert.equal(closedCalls[0].update.realizedPnl, -2.5); // sum of both legs
  assert.equal(closedCalls[0].update.outcome, "closed");
});

test("reconcileOrphanedMongoTrades: leaves a trade alone if the broker still reports it open", async () => {
  const worker = createWorker();
  worker.openPositions = [{ contractId: "CON.F.US.MES.U26" }]; // still genuinely open
  worker.openPositionsA = [];
  const fakeJournal = {
    fetchOpenTrades: async () => [
      { _id: "doc1", strategy: "reconciled", accountRole: "default", contractId: "CON.F.US.MES.U26", openedAt: new Date().toISOString() },
    ],
    closeTrade: async () => assert.fail("should not close a trade the broker still reports open"),
  };
  const fakeBroker = { fetchClosingTrades: async () => assert.fail("should not even check fills") };

  await worker.reconcileOrphanedMongoTrades(fakeJournal, fakeBroker);
});

test("reconcileOrphanedMongoTrades: leaves a trade alone if no closing fill is found yet", async () => {
  const worker = createWorker();
  worker.openPositions = [];
  worker.openPositionsA = [];
  const fakeJournal = {
    fetchOpenTrades: async () => [
      { _id: "doc1", strategy: "reconciled", accountRole: "default", contractId: "CON.F.US.MES.U26", openedAt: new Date().toISOString() },
    ],
    closeTrade: async () => assert.fail("should not close without a real closing fill to base it on"),
  };
  const fakeBroker = { resolveAccountId: async () => "acct1", fetchClosingTrades: async () => [] };

  await worker.reconcileOrphanedMongoTrades(fakeJournal, fakeBroker);
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
