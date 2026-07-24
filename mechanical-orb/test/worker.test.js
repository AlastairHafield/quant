import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorker } from "../src/worker.js";

function bar(high, low, close) {
  return { high, low, close };
}

test("Worker: tracks the OR during the window, locks it once the window ends", () => {
  const worker = createWorker();
  worker.currentDay = new Date(2026, 6, 24).toDateString(); // skip the rollover's network-touching ADX refresh
  worker.priorDayAdxOk = true;
  worker.priorDayAdx = 30;

  for (let m = 30; m < 45; m++) {
    worker.onBar(bar(5520, 5515, 5518), new Date(2026, 6, 24, 9, m));
  }
  assert.equal(worker.orbHigh, 5520);
  assert.equal(worker.orbLow, 5515);
  assert.equal(worker.orbLocked, false);

  worker.onBar(bar(5518.1, 5517.9, 5518), new Date(2026, 6, 24, 9, 45));
  assert.equal(worker.orbLocked, true);
});

function primedWorker({ adxOk = true } = {}) {
  const worker = createWorker();
  worker.currentDay = new Date(2026, 6, 24).toDateString();
  worker.priorDayAdxOk = adxOk;
  worker.priorDayAdx = adxOk ? 30 : 15;
  for (let m = 30; m < 45; m++) {
    worker.onBar(bar(5520, 5515, 5518), new Date(2026, 6, 24, 9, m));
  }
  worker.onBar(bar(5518.1, 5517.9, 5518), new Date(2026, 6, 24, 9, 45)); // locks the OR
  return worker;
}

test("Worker: no signal while price stays inside the OR", () => {
  const worker = primedWorker();
  worker.onBar(bar(5519, 5516, 5518), new Date(2026, 6, 24, 9, 46));
  assert.equal(worker.logger.size, 0);
});

test("Worker: a clean breakout with ADX confirmed produces a non-vetoed signal and marks the day traded", () => {
  const worker = primedWorker({ adxOk: true });
  worker.onBar(bar(5523, 5520, 5522), new Date(2026, 6, 24, 9, 50));

  assert.equal(worker.dayState.tradedToday, true);
  const row = worker.logger.buffer.find((r) => r.veto_reason === null);
  assert.ok(row, "expected a non-vetoed log row");
  assert.equal(row.direction, "long");
  assert.equal(row.entry_price, 5522);
});

test("Worker: a breakout without ADX confirmation is vetoed and does not mark the day traded", () => {
  const worker = primedWorker({ adxOk: false });
  worker.onBar(bar(5523, 5520, 5522), new Date(2026, 6, 24, 9, 50));

  assert.equal(worker.dayState.tradedToday, false);
  const row = worker.logger.buffer[0];
  assert.equal(row.veto_reason, "adx_below_threshold");
});

test("Worker: once a position is open, subsequent bars don't re-evaluate entries (one trade per day)", () => {
  const worker = primedWorker({ adxOk: true });
  worker.onBar(bar(5523, 5520, 5522), new Date(2026, 6, 24, 9, 50)); // enters
  assert.equal(worker.logger.size, 1);

  worker.onBar(bar(5530, 5528, 5529), new Date(2026, 6, 24, 9, 55)); // price keeps moving, no re-entry
  assert.equal(worker.logger.size, 1);
});

test("Worker: flattens automatically at the configured EOD time when a position is open", async () => {
  const worker = primedWorker({ adxOk: true });
  worker.onBar(bar(5523, 5520, 5522), new Date(2026, 6, 24, 9, 50)); // enters
  assert.ok(worker.openPosition);

  worker.onBar(bar(5540, 5538, 5539), new Date(2026, 6, 24, 15, 55)); // flatten time
  await new Promise((resolve) => setImmediate(resolve)); // let the async flatten() settle
  assert.equal(worker.openPosition, null);
});

test("Worker: a new day resets the OR, day-traded flag, and open position tracking state", () => {
  const worker = primedWorker({ adxOk: true });
  worker.onBar(bar(5523, 5520, 5522), new Date(2026, 6, 24, 9, 50));
  assert.equal(worker.dayState.tradedToday, true);

  worker.onBar(bar(5510, 5505, 5508), new Date(2026, 6, 25, 9, 30)); // next day, ORB window again
  assert.equal(worker.dayState.tradedToday, false);
  assert.equal(worker.orbLocked, false);
  assert.equal(worker.orbHigh, 5510);
});
