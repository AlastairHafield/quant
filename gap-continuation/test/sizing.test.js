import { test } from "node:test";
import assert from "node:assert/strict";
import { ladderContracts, computeSize } from "../src/sizing.js";

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

test("computeSize: FLAT mode ignores equity and returns the fixed contract count", () => {
  const config = { sizing: { mode: "FLAT", flatContracts: 1, ladder } };
  assert.equal(computeSize(config, 2000), 1);
  assert.equal(computeSize(config, 50000), 1);
});

test("computeSize: LADDER mode scales with equity", () => {
  const config = { sizing: { mode: "LADDER", flatContracts: 1, ladder } };
  assert.equal(computeSize(config, 10000), 5);
});
