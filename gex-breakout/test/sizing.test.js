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
