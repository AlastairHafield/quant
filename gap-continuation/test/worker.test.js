import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorker, shouldFlushLogNow, findUntrackedPosition, accountNameHintFor, reconcileDecision } from "../src/worker.js";
import { CONFIG } from "../src/config.js";

function bar(open, high, low, close) {
  return { open, high, low, close };
}

// Sets up worker state directly (bypassing the network-touching day-rollover
// refreshes, same pattern as mechanical-orb's own worker tests) with a known
// priorClose/ADX, ready to evaluate the first RTH bar.
function primedWorker({ adxOk = true, priorClose = 100 } = {}) {
  const worker = createWorker();
  worker.currentDay = new Date(2026, 6, 27).toDateString(); // a real Monday
  worker.todayGapChecked = false;
  worker.priorClose = priorClose;
  worker.priorDayAdxOk = adxOk;
  worker.priorDayAdx = adxOk ? 30 : 15;
  return worker;
}

test("Worker: evaluates exactly once, at the first bar at/after 9:30 ET", () => {
  const worker = primedWorker();
  worker.onBar(bar(99.9, 100.1, 99.8, 100.0), new Date(2026, 6, 27, 9, 29)); // before open — ignored
  assert.equal(worker.logger.size, 0);
  assert.equal(worker.todayGapChecked, false);

  worker.onBar(bar(101, 101.2, 100.9, 101.1), new Date(2026, 6, 27, 9, 30)); // 1% gap up, evaluated
  assert.equal(worker.todayGapChecked, true);
  assert.equal(worker.logger.size, 1);

  worker.onBar(bar(101.5, 102, 101.4, 101.8), new Date(2026, 6, 27, 9, 31)); // second bar — not re-evaluated
  assert.equal(worker.logger.size, 1);
});

test("Worker: a gap below the threshold is vetoed and logged, no position opened", () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.onBar(bar(100.2, 100.3, 100.1, 100.2), new Date(2026, 6, 27, 9, 30)); // 0.2% gap, below 0.5%
  assert.equal(worker.openPosition, null);
  const row = worker.logger.buffer[0];
  assert.equal(row.veto_reason, "gap_too_small");
});

test("Worker: ADX not confirmed vetoes the day even with a real gap", () => {
  const worker = primedWorker({ adxOk: false, priorClose: 100 });
  worker.onBar(bar(101, 101.2, 100.9, 101.1), new Date(2026, 6, 27, 9, 30));
  assert.equal(worker.openPosition, null);
  assert.equal(worker.logger.buffer[0].veto_reason, "adx_below_threshold");
});

test("handleSignal: skips a new signal when the account already has an open position (shared with other bots)", () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.openPositions = [{ contractId: "CON.F.US.MES.U26", size: 4 }]; // e.g. GEX Breakout or Mechanical ORB

  worker.handleSignal({ direction: "long", entryPrice: 101.1, stopPrice: 100.5, targetPrice: 102, gapPct: 0.01 });

  assert.equal(worker.logger.buffer[0].veto_reason, "position_already_open");
  assert.equal(worker.openPosition, null);
});

test("handleSignal: proceeds normally when the account is flat", () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.openPositions = [];

  worker.handleSignal({ direction: "long", entryPrice: 101.1, stopPrice: 100.5, targetPrice: 102, gapPct: 0.01 });

  assert.equal(worker.logger.buffer[0].veto_reason, null);
});

test("handleSignal: a risk halt vetoes new entries even when the account is otherwise flat", () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.openPositions = [];
  worker.haltedForRisk = true;
  worker.haltReason = "daily_loss_cap (pnl -600.00)";

  worker.handleSignal({ direction: "long", entryPrice: 101.1, stopPrice: 100.5, targetPrice: 102, gapPct: 0.01 });

  assert.equal(worker.logger.buffer[0].veto_reason, "risk_halt:daily_loss_cap (pnl -600.00)");
  assert.equal(worker.openPosition, null);
});

test("checkAccountRisk: breaching the account-wide daily loss cap halts new entries for the rest of the day", async () => {
  const worker = primedWorker({ priorClose: 100 });
  const originalCap = CONFIG.risk.dailyLossCapDollars;
  CONFIG.risk.dailyLossCapDollars = 500;
  try {
    worker.account = { balance: 50000 };
    await worker.checkAccountRisk(new Date(2026, 6, 27, 10, 0)); // snapshots dayStartBalance
    assert.equal(worker.haltedForRisk, false);

    worker.account = { balance: 49400 }; // down $600, past the $500 cap
    await worker.checkAccountRisk(new Date(2026, 6, 27, 10, 5));
    assert.equal(worker.haltedForRisk, true);
    assert.match(worker.haltReason, /daily_loss_cap/);
  } finally {
    CONFIG.risk.dailyLossCapDollars = originalCap;
  }
});

test("tripRiskHalt: flattens an open position immediately rather than waiting for the next entry attempt", async () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.openPosition = {
    direction: "long",
    entryPrice: 101,
    stopPrice: 100.5,
    targetPrice: 102,
    size: 1,
    contractId: "CON.F.US.MES.U26",
    mfe: 0,
    mae: 0,
    mongoId: null,
  };
  worker.bars = [bar(101, 101.3, 100.9, 101.2)];

  await worker.tripRiskHalt("kill_switch");

  assert.equal(worker.openPosition, null);
  assert.equal(worker.haltedForRisk, true);
  assert.equal(worker.logger.buffer.at(-1).outcome, "risk_halt");
});

test("Worker: a gap UP with ADX confirmed opens a LONG position (signal-only mode)", () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.onBar(bar(101, 101.2, 100.9, 101.1), new Date(2026, 6, 27, 9, 30));
  assert.ok(worker.openPosition);
  assert.equal(worker.openPosition.direction, "long");
  assert.equal(worker.openPosition.entryPrice, 101.1);
  assert.ok(worker.openPosition.targetPrice > worker.openPosition.entryPrice);
  assert.ok(worker.openPosition.stopPrice < worker.openPosition.entryPrice);
});

test("Worker: a gap DOWN with ADX confirmed opens a SHORT position", () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.onBar(bar(99, 99.1, 98.8, 98.9), new Date(2026, 6, 27, 9, 30));
  assert.ok(worker.openPosition);
  assert.equal(worker.openPosition.direction, "short");
  assert.ok(worker.openPosition.targetPrice < worker.openPosition.entryPrice);
  assert.ok(worker.openPosition.stopPrice > worker.openPosition.entryPrice);
});

test("Worker: once a position is open, later bars don't re-evaluate or re-enter", () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.onBar(bar(101, 101.2, 100.9, 101.1), new Date(2026, 6, 27, 9, 30));
  assert.equal(worker.logger.size, 1);
  worker.onBar(bar(102, 103, 101.9, 102.5), new Date(2026, 6, 27, 10, 0));
  assert.equal(worker.logger.size, 1);
});

test("Worker: flattens automatically at the configured EOD time, logging MFE/MAE and outcome", async () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.onBar(bar(101, 101.2, 100.9, 101.1), new Date(2026, 6, 27, 9, 30)); // enters long @ 101.1
  assert.ok(worker.openPosition);

  worker.onBar(bar(101.3, 101.6, 101.2, 101.5), new Date(2026, 6, 27, 10, 0)); // runs up a bit first
  worker.onBar(bar(101.4, 101.5, 101.3, 101.4), new Date(2026, 6, 27, 15, 55)); // flatten time
  await new Promise((resolve) => setImmediate(resolve)); // let the async flatten() settle

  assert.equal(worker.openPosition, null);
  const row = worker.logger.buffer.find((r) => r.outcome === "eod_flatten");
  assert.ok(row, "expected an eod_flatten log row");
  assert.ok(row.mfe > 0);
});

test("Worker: detects a closed trade (bracket filled) and picks the outcome label closest to the approx exit price", () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.onBar(bar(101, 101.2, 100.9, 101.1), new Date(2026, 6, 27, 9, 30)); // enters long, target/stop set
  const { targetPrice } = worker.openPosition;

  worker.bars.push({ open: targetPrice, high: targetPrice, low: targetPrice, close: targetPrice });
  worker.openPositions = []; // broker no longer reports the position -> closed
  worker.detectClosedTrade();

  assert.equal(worker.openPosition, null);
  const row = worker.logger.buffer.find((r) => r.outcome === "target_hit");
  assert.ok(row, "expected a target_hit log row");
});

test("Worker: detectClosedTrade leaves the position tracked while the broker still reports it", () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.onBar(bar(101, 101.2, 100.9, 101.1), new Date(2026, 6, 27, 9, 30));
  worker.openPositions = [{ contractId: worker.openPosition.contractId }];
  worker.detectClosedTrade();
  assert.ok(worker.openPosition);
});

test("Worker: a new day resets todayGapChecked, priorClose, and open-position tracking state", () => {
  const worker = primedWorker({ priorClose: 100 });
  worker.onBar(bar(101, 101.2, 100.9, 101.1), new Date(2026, 6, 27, 9, 30));
  assert.equal(worker.todayGapChecked, true);

  worker.onBar(bar(102, 102.1, 101.9, 102), new Date(2026, 6, 28, 9, 0)); // next day, before session open
  assert.equal(worker.todayGapChecked, false);
  assert.equal(worker.priorClose, null); // cleared until refreshPriorClose (network, no-ops in this test) resolves
});

test("findUntrackedPosition: matches a real broker position on our contract with a known type", () => {
  const positions = [
    { contractId: "CON.OTHER", type: 1, size: 2, averagePrice: 100 },
    { contractId: "CON.F.US.MES.U26", type: 1, size: 1, averagePrice: 7462 },
  ];
  const result = findUntrackedPosition(positions, "CON.F.US.MES.U26");
  assert.ok(result);
  assert.equal(result.averagePrice, 7462);
});

test("findUntrackedPosition: null when nothing matches our contract", () => {
  const positions = [{ contractId: "CON.OTHER", type: 1, size: 2, averagePrice: 100 }];
  assert.equal(findUntrackedPosition(positions, "CON.F.US.MES.U26"), null);
});

test("findUntrackedPosition: null when a position matches the contract but has an unrecognized type", () => {
  const positions = [{ contractId: "CON.F.US.MES.U26", type: 99, size: 1, averagePrice: 7462 }];
  assert.equal(findUntrackedPosition(positions, "CON.F.US.MES.U26"), null);
});

test("reconcileDecision: adopts our own open trade when contract, direction, and day all match", () => {
  const ownOpenTrade = {
    _id: "abc123", direction: "long", entryPrice: 101.1, stopPrice: 100.5, targetPrice: 102,
    gapPct: 0.01, contractId: "CON.F.US.MES.U26", dayKey: "Fri Sep 04 2026", mfe: 3, mae: -1,
  };
  const untrackedPosition = { contractId: "CON.F.US.MES.U26", direction: "long", size: 1, averagePrice: 101.1 };
  const decision = reconcileDecision({ ownOpenTrade, untrackedPosition, todayDayKey: "Fri Sep 04 2026" });
  assert.equal(decision.action, "adopt");
  assert.equal(decision.ownOpenTrade, ownOpenTrade);
  assert.equal(decision.position, untrackedPosition);
});

test("reconcileDecision: never adopts a foreign bot's position when we have no open trade of our own (the bug this fixes)", () => {
  const untrackedPosition = { contractId: "CON.F.US.MES.U26", direction: "short", size: 30, averagePrice: 7455.5 };
  const decision = reconcileDecision({ ownOpenTrade: null, untrackedPosition, todayDayKey: "Fri Sep 04 2026" });
  assert.equal(decision.action, "none");
});

test("reconcileDecision: does nothing when neither we nor the broker show a position", () => {
  const decision = reconcileDecision({ ownOpenTrade: null, untrackedPosition: null, todayDayKey: "Fri Sep 04 2026" });
  assert.equal(decision.action, "none");
});

test("reconcileDecision: closes our own record as stale when the broker no longer shows it open", () => {
  const ownOpenTrade = { _id: "abc123", direction: "long", contractId: "CON.F.US.MES.U26", dayKey: "Fri Sep 04 2026" };
  const decision = reconcileDecision({ ownOpenTrade, untrackedPosition: null, todayDayKey: "Fri Sep 04 2026" });
  assert.equal(decision.action, "close_stale");
  assert.equal(decision.ownOpenTrade, ownOpenTrade);
});

test("reconcileDecision: a same-contract, same-direction record from a PRIOR day is stale, not adopted (critic-opus's blocking finding)", () => {
  // Exactly the real production scenario found 2026-09-04: a leftover
  // status:"open" doc from Jul 30 would otherwise match the next bot that
  // happens to hold a same-direction position on this contract.
  const ownOpenTrade = {
    _id: "stale-jul30", direction: "short", contractId: "CON.F.US.MES.U26", dayKey: "Thu Jul 30 2026",
  };
  const untrackedPosition = { contractId: "CON.F.US.MES.U26", direction: "short", size: 10, averagePrice: 7450 };
  const decision = reconcileDecision({ ownOpenTrade, untrackedPosition, todayDayKey: "Fri Sep 04 2026" });
  assert.equal(decision.action, "close_stale");
  assert.equal(decision.reason, "stale (prior day)");
});

test("reconcileDecision: our own open trade on a DIFFERENT direction than what the broker shows is closed as stale, not adopted onto the wrong side", () => {
  const ownOpenTrade = { _id: "abc123", direction: "long", contractId: "CON.F.US.MES.U26", dayKey: "Fri Sep 04 2026" };
  const untrackedPosition = { contractId: "CON.F.US.MES.U26", direction: "short", size: 1, averagePrice: 7455 };
  const decision = reconcileDecision({ ownOpenTrade, untrackedPosition, todayDayKey: "Fri Sep 04 2026" });
  assert.equal(decision.action, "close_stale");
  assert.equal(decision.reason, "direction mismatch");
});

test("reconcileDecision: our own open trade on a DIFFERENT contract than what the broker shows is closed as stale, not adopted onto the wrong contract", () => {
  const ownOpenTrade = { _id: "abc123", direction: "long", contractId: "CON.F.US.MES.Z26", dayKey: "Fri Sep 04 2026" };
  const untrackedPosition = { contractId: "CON.F.US.MES.U26", direction: "long", size: 1, averagePrice: 7455 };
  const decision = reconcileDecision({ ownOpenTrade, untrackedPosition, todayDayKey: "Fri Sep 04 2026" });
  assert.equal(decision.action, "close_stale");
  assert.equal(decision.reason, "contract mismatch");
});

test("Worker: a reconciled position (no known stop/target) still gets flattened at EOD without guessing STOP-vs-TARGET", async () => {
  const worker = primedWorker({ priorClose: 100 });
  // Simulate what reconcileUntrackedPosition() would set after a restart —
  // no stopPrice/targetPrice since those aren't recoverable from a bare
  // broker position record.
  worker.openPosition = {
    direction: "long", entryPrice: 101.1, stopPrice: null, targetPrice: null,
    gapPct: null, size: 1, contractId: "CON.F.US.MES.U26", mfe: 0, mae: 0, mongoId: null,
  };
  worker.currentDay = new Date(2026, 6, 27).toDateString();
  worker.todayGapChecked = true;

  worker.onBar(bar(101.4, 101.5, 101.3, 101.4), new Date(2026, 6, 27, 15, 55)); // flatten time
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(worker.openPosition, null);
  const row = worker.logger.buffer.find((r) => r.outcome === "eod_flatten");
  assert.ok(row, "expected an eod_flatten log row even for a reconciled position");
});

test("shouldFlushLogNow: null before the scheduled time", () => {
  const flushET = { h: 16, m: 5 };
  assert.equal(shouldFlushLogNow(new Date(2026, 6, 27, 16, 4), flushET), null);
});

test("shouldFlushLogNow: returns the day-key at/after the scheduled time", () => {
  const flushET = { h: 16, m: 5 };
  const t = new Date(2026, 6, 27, 16, 10);
  assert.equal(shouldFlushLogNow(t, flushET), t.toDateString());
});

test("accountNameHintFor: live mode defers to resolveAccountId's own env-var default", () => {
  assert.equal(accountNameHintFor({ accountMode: "live", practiceAccountNameHint: "PRAC-123" }), undefined);
});

test("accountNameHintFor: practice mode resolves the practice account hint", () => {
  assert.equal(accountNameHintFor({ accountMode: "practice", practiceAccountNameHint: "PRAC-123" }), "PRAC-123");
});

test("checkAccountRisk: the account-wide $ daily loss cap does not apply in practice mode", async () => {
  const worker = createWorker();
  const originalCap = CONFIG.risk.dailyLossCapDollars;
  const originalMode = CONFIG.accountMode;
  CONFIG.risk.dailyLossCapDollars = 500;
  CONFIG.accountMode = "practice";
  try {
    worker.account = { balance: 50000 };
    await worker.checkAccountRisk(new Date(2026, 6, 27, 10, 0));
    worker.account = { balance: 40000 }; // down $10,000 — would trip live mode's $500 cap
    await worker.checkAccountRisk(new Date(2026, 6, 27, 10, 5));
    assert.equal(worker.haltedForRisk, false);
  } finally {
    CONFIG.risk.dailyLossCapDollars = originalCap;
    CONFIG.accountMode = originalMode;
  }
});
