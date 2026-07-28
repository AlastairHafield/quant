import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusPayload, pushStatus } from "../src/statusReporter.js";
import { createWorker } from "../src/worker.js";

test("buildStatusPayload: sane defaults before any data has arrived", () => {
  const worker = createWorker();
  const payload = buildStatusPayload(worker);

  assert.equal(payload.signalOnly, true);
  assert.equal(payload.lastPrice, null);
  assert.equal(payload.barsToday, 0);
  assert.equal(payload.regime, null);
  assert.equal(payload.gex, null);
  assert.equal(payload.basis, null);
  assert.deepEqual(payload.orb, { high: null, low: null, locked: false });
  assert.deepEqual(payload.dayState, {
    orbTradedDirections: [],
    strategyBTradesToday: 0,
    haltedStrategies: [],
    winsToday: { A: 0, B: 0 },
    lossesToday: { A: 0, B: 0 },
  });
  assert.deepEqual(payload.recentLog, []);
  assert.equal(payload.account, null);
  assert.deepEqual(payload.openPositions, []);
  assert.equal(payload.accountAsOf, null);
  assert.equal(payload.strategyA.signalOnly, true);
  assert.equal(payload.strategyA.account, null);
  assert.deepEqual(payload.strategyA.openPositions, []);
});

test("buildStatusPayload: reflects live account balance/positions once polled", () => {
  const worker = createWorker();
  worker.account = { id: 25804787, name: "PRAC-V2-416538-98727790", balance: 150000, canTrade: true };
  worker.openPositions = [{ id: 1, contractId: "CON.F.US.MES.U26", size: 4, averagePrice: 7462, type: 1 }];
  worker.accountAsOf = new Date("2026-07-24T14:00:00Z");

  const payload = buildStatusPayload(worker);
  assert.deepEqual(payload.account, { id: 25804787, name: "PRAC-V2-416538-98727790", balance: 150000 });
  assert.equal(payload.openPositions.length, 1);
  assert.equal(payload.accountAsOf, "2026-07-24T14:00:00.000Z");
});

test("buildStatusPayload: strategyA reports its OWN (practice) account, independent of the default account above", () => {
  const worker = createWorker();
  worker.account = { id: 1, name: "REAL", balance: 49586.83 };
  worker.openPositions = [{ id: 1, contractId: "CON.F.US.MES.U26", size: 2, averagePrice: 5500, type: 1 }];
  worker.accountA = { id: 2, name: "PRAC-V2-416538-98727790", balance: 149989.47 };
  worker.openPositionsA = [{ id: 2, contractId: "CON.F.US.MES.U26", size: 4, averagePrice: 5490, type: 2 }];

  const payload = buildStatusPayload(worker);
  assert.deepEqual(payload.strategyA.account, { id: 2, name: "PRAC-V2-416538-98727790", balance: 149989.47 });
  assert.equal(payload.strategyA.openPositions.length, 1);
  assert.equal(payload.strategyA.openPositions[0].size, 4);
  // The "default" account fields are untouched by strategyA's own state
  assert.equal(payload.account.balance, 49586.83);
  assert.equal(payload.openPositions.length, 1);
});

test("buildStatusPayload: reflects live GEX/basis/regime/day-state once populated", () => {
  const worker = createWorker();
  worker.gexSnapshot = { netGex: -5e9, flipPoint: 5400, walls: { aboveSpot: [], belowSpot: [] }, confidence: "FULL", asOf: "t" };
  worker.basis = 8;
  worker.basisAsOf = new Date("2026-07-24T14:00:00Z");
  worker.rebuildLevels();
  worker.lastRegimeInfo = { regime: "NEG_GAMMA", baseRegime: "NEG_GAMMA", nearFlip: false };
  worker.riskManager.recordOrbTrade("long");
  worker.riskManager.recordTradeResult("A", -100);
  worker.bars.push({ close: 5522 });

  const payload = buildStatusPayload(worker);
  assert.equal(payload.lastPrice, 5522);
  assert.equal(payload.regime, "NEG_GAMMA");
  assert.equal(payload.gex.netGex, -5e9);
  assert.equal(payload.flipPointEs, 5408);
  assert.equal(payload.basis, 8);
  assert.deepEqual(payload.dayState.orbTradedDirections, ["long"]);
  assert.equal(payload.dayState.lossesToday.A, 1);
});

test("buildStatusPayload: recentLog returns at most the last 50 rows, most recent first", () => {
  const worker = createWorker();
  for (let i = 0; i < 60; i++) worker.logger.log({ ts: `row-${i}` });
  const payload = buildStatusPayload(worker);
  assert.equal(payload.recentLog.length, 50);
  assert.equal(payload.recentLog[0].ts, "row-59");
  assert.equal(payload.recentLog[49].ts, "row-10");
});

test("pushStatus: POSTs the built payload to the backend's status endpoint, with the secret header when configured", async () => {
  const worker = createWorker();
  let capturedUrl, capturedInit;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true };
  };
  await pushStatus(worker, "https://quantapp.example.com", "s3cr3t", fakeFetch);

  assert.equal(capturedUrl, "https://quantapp.example.com/api/gex-breakout/status");
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.headers["X-Status-Secret"], "s3cr3t");
  assert.equal(JSON.parse(capturedInit.body).instrumentTrade, "MES");
});

test("pushStatus: omits the secret header when no secret is configured", async () => {
  const worker = createWorker();
  let capturedInit;
  const fakeFetch = async (url, init) => {
    capturedInit = init;
    return { ok: true };
  };
  await pushStatus(worker, "https://quantapp.example.com", undefined, fakeFetch);
  assert.equal("X-Status-Secret" in capturedInit.headers, false);
});

test("pushStatus: logs but does not throw when the push fails", async () => {
  const worker = createWorker();
  const fakeFetch = async () => {
    throw new Error("network down");
  };
  await assert.doesNotReject(() => pushStatus(worker, "https://quantapp.example.com", null, fakeFetch));
});
