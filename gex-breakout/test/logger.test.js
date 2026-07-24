import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLogRow, SignalLogger } from "../src/logger.js";

test("buildLogRow: maps fields and defaults missing optionals to null/false", () => {
  const row = buildLogRow({ ts: "2026-07-24T14:30:00.000Z", strategy: "A", direction: "long" });
  assert.equal(row.ts, "2026-07-24T14:30:00.000Z");
  assert.equal(row.strategy, "A");
  assert.equal(row.direction, "long");
  assert.equal(row.level_type, null);
  assert.equal(row.level_price, null);
  assert.equal(row.absorbed, false);
  assert.equal(row.veto_reason, null);
});

test("buildLogRow: pulls level_type/level_price from a level object", () => {
  const row = buildLogRow({ ts: "t", level: { type: "FLIP", price: 5510 } });
  assert.equal(row.level_type, "FLIP");
  assert.equal(row.level_price, 5510);
});

test("SignalLogger: log appends to the buffer and returns the row", () => {
  const logger = new SignalLogger();
  const row = logger.log(buildLogRow({ ts: "t1" }));
  assert.equal(logger.size, 1);
  assert.equal(row.ts, "t1");
});

test("SignalLogger: drain empties the buffer and returns everything logged", () => {
  const logger = new SignalLogger();
  logger.log(buildLogRow({ ts: "t1" }));
  logger.log(buildLogRow({ ts: "t2" }));
  const drained = logger.drain();
  assert.equal(drained.length, 2);
  assert.equal(logger.size, 0);
});
