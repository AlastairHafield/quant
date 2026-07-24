import { test } from "node:test";
import assert from "node:assert/strict";
import { daysToExpiry, aggregateStrikesAcrossExpiries, weightedFlipPoint } from "../src/dataSources/flashalpha.js";

test("daysToExpiry: 0 for today, positive for future dates, ignoring time-of-day", () => {
  const nowET = new Date(2026, 6, 24, 14, 45); // 2026-07-24 14:45 local
  assert.equal(daysToExpiry("2026-07-24", nowET), 0);
  assert.equal(daysToExpiry("2026-07-27", nowET), 3);
  assert.equal(daysToExpiry("2026-08-01", nowET), 8);
});

test("daysToExpiry: negative for a date already in the past", () => {
  const nowET = new Date(2026, 6, 24);
  assert.equal(daysToExpiry("2026-07-20", nowET), -4);
});

test("aggregateStrikesAcrossExpiries: sums net_gex per strike across multiple expiry responses", () => {
  const responses = [
    {
      strikes: [
        { strike: 5500, net_gex: 100 },
        { strike: 5525, net_gex: -50 },
      ],
    },
    {
      strikes: [
        { strike: 5500, net_gex: 30 }, // same strike, different expiry -> summed
        { strike: 5550, net_gex: 20 },
      ],
    },
  ];
  const profile = aggregateStrikesAcrossExpiries(responses);
  assert.deepEqual(profile, [
    { strike: 5500, gex: 130 },
    { strike: 5525, gex: -50 },
    { strike: 5550, gex: 20 },
  ]);
});

test("aggregateStrikesAcrossExpiries: tolerates a response with no strikes field", () => {
  const profile = aggregateStrikesAcrossExpiries([{ strikes: [{ strike: 100, net_gex: 5 }] }, {}]);
  assert.deepEqual(profile, [{ strike: 100, gex: 5 }]);
});

test("weightedFlipPoint: weights each expiry's own gamma_flip by |net_gex| magnitude", () => {
  const responses = [
    { gamma_flip: 7436, net_gex: -12_101_311_746 }, // 0DTE, dominant weight
    { gamma_flip: 7486, net_gex: -4_072_795_730 },
    { gamma_flip: 7497, net_gex: -2_312_987_646 },
  ];
  const flip = weightedFlipPoint(responses);
  // Should land closer to the 0DTE flip (7436) than a plain average (~7473) would,
  // since 0DTE's much larger net_gex magnitude dominates the weighting.
  assert.ok(flip > 7436 && flip < 7460, `expected weighted toward 0DTE, got ${flip}`);
});

test("weightedFlipPoint: a single expiry's flip passes through unchanged", () => {
  assert.equal(weightedFlipPoint([{ gamma_flip: 7486, net_gex: -4e9 }]), 7486);
});

test("weightedFlipPoint: null when no response has usable gamma_flip/net_gex", () => {
  assert.equal(weightedFlipPoint([{ gamma_flip: null, net_gex: -4e9 }, {}]), null);
});
