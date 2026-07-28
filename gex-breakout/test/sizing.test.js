import { test } from "node:test";
import assert from "node:assert/strict";
import { ladderContracts, ladderRatio } from "../src/sizing.js";

const ladder = { baseContracts: 1, perContractEquityStep: 2000, startingEquity: 2000, cap: 15 };

test("ladderContracts: 1 contract at the starting equity, +1 per $2000 growth", () => {
  assert.equal(ladderContracts({ equity: 2000, ladder }), 1);
  assert.equal(ladderContracts({ equity: 3999, ladder }), 1);
  assert.equal(ladderContracts({ equity: 4000, ladder }), 2);
  assert.equal(ladderContracts({ equity: 10000, ladder }), 5);
});

test("ladderContracts: caps at the configured maximum", () => {
  assert.equal(ladderContracts({ equity: 1_000_000, ladder }), 15);
});

test("ladderContracts: never drops below the base even if equity is below starting (drawdown)", () => {
  assert.equal(ladderContracts({ equity: 500, ladder }), 1);
});

test("ladderRatio: 1x at the starting rung, scales up as equity grows", () => {
  assert.equal(ladderRatio(2000, ladder), 1);
  assert.equal(ladderRatio(10000, ladder), 5);
  assert.equal(ladderRatio(1_000_000, ladder), 15);
});

// Regression guard for the live incident 2026-07-28: startingEquity must match
// THIS account's actual nominal starting balance, or the ladder reads the
// account's whole balance as "growth" and maxes out immediately. The real
// Combine is named "50KTC" (a $50,000 Combine) — with startingEquity
// correctly set to 50000, its real balance at the time (~$49,586.83, down
// slightly from two losing trades) must land at 1x, not the 15x cap.
test("ladderRatio: a real Combine's own balance lands near 1x when startingEquity matches its actual starting size", () => {
  const combineLadder = { baseContracts: 1, perContractEquityStep: 2000, startingEquity: 50000, cap: 15 };
  assert.equal(ladderRatio(49586.83, combineLadder), 1);
});

test("ladderRatio: the same real balance against the WRONG (too-small) startingEquity is exactly the bug that shipped live", () => {
  const wrongLadder = { baseContracts: 1, perContractEquityStep: 2000, startingEquity: 2000, cap: 15 };
  assert.equal(ladderRatio(49586.83, wrongLadder), 15); // maxed out — this is what actually happened
});
