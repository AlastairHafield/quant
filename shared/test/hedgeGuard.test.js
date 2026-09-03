import { test } from "node:test";
import assert from "node:assert/strict";
import { directionOfPosition, wouldOpenSimultaneousPosition, wouldHedge, POSITION_TYPE_TO_DIRECTION } from "../hedgeGuard.js";

test("directionOfPosition: maps ProjectX position type 1/2 to long/short", () => {
  assert.equal(directionOfPosition({ type: 1 }), "long");
  assert.equal(directionOfPosition({ type: 2 }), "short");
});

test("directionOfPosition: an unrecognized type is null, not a wrong guess", () => {
  assert.equal(directionOfPosition({ type: 0 }), null);
  assert.equal(directionOfPosition({ type: 99 }), null);
  assert.equal(directionOfPosition({}), null);
});

test("wouldOpenSimultaneousPosition: false with nothing open", () => {
  assert.equal(wouldOpenSimultaneousPosition([]), false);
});

test("wouldOpenSimultaneousPosition: true with ANY open position, even same-direction — gap-continuation/mechanical-orb's stricter 'at most one, period' policy", () => {
  assert.equal(wouldOpenSimultaneousPosition([{ contractId: "CON.F.US.MES.U26", type: 1 }]), true);
});

test("wouldOpenSimultaneousPosition: true even for a position opened by the OTHER bot sharing the account", () => {
  // The whole point: this checks the broker's real account state, which
  // reflects both bots' positions since they share one account — not
  // either bot's own local trade tracking.
  const otherBotsPosition = [{ contractId: "CON.F.US.MES.U26", type: 2 }];
  assert.equal(wouldOpenSimultaneousPosition(otherBotsPosition), true);
});

test("wouldHedge: false with no open positions on the contract", () => {
  assert.equal(wouldHedge([], "CON.F.US.MES.U26", "long"), false);
});

test("wouldHedge: false when the only open position on this contract already agrees with newDirection", () => {
  const positions = [{ contractId: "CON.F.US.MES.U26", type: 1 }]; // long
  assert.equal(wouldHedge(positions, "CON.F.US.MES.U26", "long"), false);
});

test("wouldHedge: true when an open position on this contract OPPOSES newDirection — the actual hedge case", () => {
  const positions = [{ contractId: "CON.F.US.MES.U26", type: 1 }]; // long
  assert.equal(wouldHedge(positions, "CON.F.US.MES.U26", "short"), true);
});

test("wouldHedge: ignores an opposing position on a DIFFERENT contract", () => {
  const positions = [{ contractId: "CON.F.US.ES.U26", type: 1 }]; // long, different contract
  assert.equal(wouldHedge(positions, "CON.F.US.MES.U26", "short"), false);
});

test("POSITION_TYPE_TO_DIRECTION: exported mapping matches the confirmed-live ProjectX convention", () => {
  assert.deepEqual(POSITION_TYPE_TO_DIRECTION, { 1: "long", 2: "short" });
});
