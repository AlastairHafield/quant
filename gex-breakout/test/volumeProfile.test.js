import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priceToBucket,
  buildSessionProfile,
  findPOC,
  computeValueArea,
  isInBusinessZone,
  groupBarsByDay,
  buildCompositeProfile,
  detectFailedAuction,
  computeContrarianTarget,
} from "../src/volumeProfile.js";

test("priceToBucket rounds to the nearest bucket without float drift", () => {
  assert.equal(priceToBucket(100.3, 1), 100);
  assert.equal(priceToBucket(100.6, 1), 101);
  assert.equal(priceToBucket(100.25, 0.5), 100.5);
});

test("buildSessionProfile spreads a bar's volume evenly across its bucket range", () => {
  const bars = [{ low: 100, high: 102, volume: 30 }];
  const profile = buildSessionProfile(bars, { bucketSizePts: 1 });
  assert.deepEqual(profile, [
    { price: 100, volume: 10 },
    { price: 101, volume: 10 },
    { price: 102, volume: 10 },
  ]);
});

test("buildSessionProfile accumulates overlapping bars across buckets", () => {
  const bars = [
    { low: 100, high: 101, volume: 20 },
    { low: 101, high: 102, volume: 10 },
  ];
  const profile = buildSessionProfile(bars, { bucketSizePts: 1 });
  const byPrice = Object.fromEntries(profile.map((p) => [p.price, p.volume]));
  assert.equal(byPrice[100], 10);
  assert.equal(byPrice[101], 15);
  assert.equal(byPrice[102], 5);
});

test("buildSessionProfile falls back to close when high/low are missing", () => {
  const bars = [{ close: 100, volume: 12 }];
  const profile = buildSessionProfile(bars, { bucketSizePts: 1 });
  assert.deepEqual(profile, [{ price: 100, volume: 12 }]);
});

test("buildSessionProfile derives volume from buyVolume/sellVolume for live-shaped bars", () => {
  const bars = [{ low: 100, high: 100, buyVolume: 7, sellVolume: 3 }];
  const profile = buildSessionProfile(bars, { bucketSizePts: 1 });
  assert.deepEqual(profile, [{ price: 100, volume: 10 }]);
});

test("findPOC returns the price with the most volume", () => {
  const profile = [
    { price: 100, volume: 5 },
    { price: 101, volume: 30 },
    { price: 102, volume: 20 },
  ];
  assert.equal(findPOC(profile), 101);
});

test("findPOC returns null for an empty profile", () => {
  assert.equal(findPOC([]), null);
});

test("computeValueArea expands one-sided when the above pair dominates", () => {
  // prices 100..105, volumes 5,10,30(POC),20,8,2 — total 75, target 70% = 52.5
  const profile = [100, 101, 102, 103, 104, 105].map((price, i) => ({
    price,
    volume: [5, 10, 30, 20, 8, 2][i],
  }));
  const va = computeValueArea(profile, 102, 0.7);
  // above pair (103+104=28) beats below pair (101+100=15): expands fully
  // above and clears target (30+28=58) before ever touching the low side.
  assert.deepEqual(va, { high: 104, low: 102, volume: 58 });
});

test("computeValueArea expands on both sides across iterations", () => {
  // prices 100..106, volumes 2,5,9,20(POC),9,5,2 — total 52, target 70% = 36.4
  const profile = [100, 101, 102, 103, 104, 105, 106].map((price, i) => ({
    price,
    volume: [2, 5, 9, 20, 9, 5, 2][i],
  }));
  const va = computeValueArea(profile, 103, 0.7);
  // iter1: above(104+105=14) ties below(102+101=14) -> goes above (34 total)
  // iter2: remaining above(106+0=2) < below(102+101=14) -> goes below (48 total)
  assert.deepEqual(va, { high: 105, low: 101, volume: 48 });
});

test("computeValueArea stops at the profile edge when it runs out of room on one side", () => {
  const profile = [
    { price: 100, volume: 10 },
    { price: 101, volume: 5 },
  ];
  const va = computeValueArea(profile, 100, 0.7);
  assert.deepEqual(va, { high: 101, low: 100, volume: 15 });
});

test("computeValueArea returns null with no profile or no POC", () => {
  assert.equal(computeValueArea([], 100, 0.7), null);
  assert.equal(computeValueArea([{ price: 100, volume: 5 }], null, 0.7), null);
});

test("isInBusinessZone checks inclusive bounds", () => {
  const va = { high: 105, low: 100 };
  assert.equal(isInBusinessZone(100, va), true);
  assert.equal(isInBusinessZone(105, va), true);
  assert.equal(isInBusinessZone(102, va), true);
  assert.equal(isInBusinessZone(99.9, va), false);
  assert.equal(isInBusinessZone(105.1, va), false);
});

test("isInBusinessZone is false with no value area", () => {
  assert.equal(isInBusinessZone(100, null), false);
});

test("groupBarsByDay groups by the date field", () => {
  const bars = [
    { date: "2026-07-28", close: 100 },
    { date: "2026-07-29", close: 101 },
    { date: "2026-07-28", close: 102 },
  ];
  const byDay = groupBarsByDay(bars);
  assert.equal(byDay.size, 2);
  assert.equal(byDay.get("2026-07-28").length, 2);
  assert.equal(byDay.get("2026-07-29").length, 1);
});

test("buildCompositeProfile only merges the most recent compositeDays", () => {
  const bars = [
    { date: "2026-07-27", low: 90, high: 90, volume: 100 }, // excluded — 3rd most recent of 3
    { date: "2026-07-28", low: 100, high: 100, volume: 10 },
    { date: "2026-07-29", low: 100, high: 100, volume: 5 },
  ];
  const profile = buildCompositeProfile(bars, { bucketSizePts: 1, compositeDays: 2 });
  assert.deepEqual(profile, [{ price: 100, volume: 15 }]);
});

test("detectFailedAuction finds no signal when price never left the value area", () => {
  const va = { high: 105, low: 100 };
  const bars = [
    { close: 102, high: 103, low: 101 },
    { close: 103, high: 104, low: 102 },
  ];
  assert.equal(detectFailedAuction(bars, 1, va, { probeLookbackBars: 3 }), null);
});

test("detectFailedAuction finds no signal while still outside the value area", () => {
  const va = { high: 105, low: 100 };
  const bars = [
    { close: 103, high: 104, low: 102 },
    { close: 106, high: 107, low: 105 }, // probed above, hasn't come back yet
  ];
  assert.equal(detectFailedAuction(bars, 1, va, { probeLookbackBars: 3 }), null);
});

test("detectFailedAuction flags a failed push above value as a short trigger", () => {
  const va = { high: 105, low: 100 };
  const bars = [
    { close: 103, high: 104, low: 102 },
    { close: 106.5, high: 107, low: 105.5 }, // probes above
    { close: 104, high: 106, low: 103.5 }, // reverts back inside — trigger bar
  ];
  assert.deepEqual(detectFailedAuction(bars, 2, va, { probeLookbackBars: 3 }), {
    direction: "short",
    probePrice: 107,
  });
});

test("detectFailedAuction flags a failed push below value as a long trigger", () => {
  const va = { high: 105, low: 100 };
  const bars = [
    { close: 102, high: 103, low: 101 },
    { close: 98.5, high: 99, low: 97 }, // probes below
    { close: 101, high: 101.5, low: 98.5 }, // reverts back inside — trigger bar
  ];
  assert.deepEqual(detectFailedAuction(bars, 2, va, { probeLookbackBars: 3 }), {
    direction: "long",
    probePrice: 97,
  });
});

test("detectFailedAuction prefers the more decisive side on a whipsaw", () => {
  const va = { high: 105, low: 100 };
  const bars = [
    { close: 103, high: 110, low: 101 }, // probes above by 5
    { close: 102, high: 103, low: 96 }, // probes below by 4
    { close: 103, high: 104, low: 102 }, // back inside — trigger bar
  ];
  assert.deepEqual(detectFailedAuction(bars, 2, va, { probeLookbackBars: 3 }), {
    direction: "short",
    probePrice: 110,
  });
});

test("detectFailedAuction returns null with no value area", () => {
  assert.equal(detectFailedAuction([{ close: 100 }], 0, null, { probeLookbackBars: 3 }), null);
});

test("computeContrarianTarget targets the opposite value-area edge", () => {
  const va = { high: 105, low: 100 };
  assert.equal(computeContrarianTarget(va, "long"), 105);
  assert.equal(computeContrarianTarget(va, "short"), 100);
});

test("computeContrarianTarget returns null with no value area", () => {
  assert.equal(computeContrarianTarget(null, "long"), null);
});
