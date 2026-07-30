import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDelta,
  withCumDelta,
  rollingAvg,
  detectDeltaDivergence,
  detectAbsorption,
  buildAbsorptionWindow,
  gradeFlow,
  evaluateBreakoutFlow,
  detectPathOfLeastResistance,
  detectLackOfParticipation,
} from "../src/orderFlow.js";

test("computeDelta is buy-aggressor minus sell-aggressor volume", () => {
  assert.equal(computeDelta({ buyVolume: 120, sellVolume: 80 }), 40);
});

test("withCumDelta computes a running total across bars", () => {
  const bars = [
    { buyVolume: 60, sellVolume: 40 }, // +20
    { buyVolume: 30, sellVolume: 50 }, // -20
    { buyVolume: 70, sellVolume: 20 }, // +50
  ];
  const out = withCumDelta(bars);
  assert.deepEqual(out.map((b) => b.delta), [20, -20, 50]);
  assert.deepEqual(out.map((b) => b.cumDelta), [20, 0, 50]);
});

test("rollingAvg averages only the trailing window, clamped at the array start", () => {
  const values = [1, 2, 3, 4, 5];
  assert.equal(rollingAvg(values, 4, 2), 4.5); // avg of [4,5]
  assert.equal(rollingAvg(values, 1, 10), 1.5); // window bigger than available history
  assert.equal(rollingAvg([], 0, 5), 0);
});

function priceBar({ high, low, close, cumDelta }) {
  return { high, low, close, cumDelta };
}

test("detectDeltaDivergence: price new high with cum_delta NOT confirming is divergence", () => {
  const bars = [
    priceBar({ high: 100, low: 99, close: 100, cumDelta: 50 }),
    priceBar({ high: 101, low: 100, close: 101, cumDelta: 80 }),
    priceBar({ high: 102, low: 101, close: 102, cumDelta: 60 }), // new price high, cumDelta fell back
  ];
  assert.equal(detectDeltaDivergence(bars, 2, { lookbackBars: 3 }), true);
});

test("detectDeltaDivergence: price and cum_delta both making new highs together is not divergence", () => {
  const bars = [
    priceBar({ high: 100, low: 99, close: 100, cumDelta: 50 }),
    priceBar({ high: 101, low: 100, close: 101, cumDelta: 80 }),
    priceBar({ high: 102, low: 101, close: 102, cumDelta: 90 }),
  ];
  assert.equal(detectDeltaDivergence(bars, 2, { lookbackBars: 3 }), false);
});

test("detectDeltaDivergence: no new price extreme means no divergence regardless of cum_delta", () => {
  const bars = [
    priceBar({ high: 102, low: 101, close: 101, cumDelta: 90 }),
    priceBar({ high: 101, low: 100, close: 100, cumDelta: 10 }),
  ];
  assert.equal(detectDeltaDivergence(bars, 1, { lookbackBars: 2 }), false);
});

const absorptionCfg = { volMultiple: 1.5, maxAdvancePts: 2, avgLookbackBars: 20 };

test("detectAbsorption: high volume + stalled price at the level is absorption", () => {
  const priorBars = Array.from({ length: 20 }, () => ({ volume: 100 }));
  const touchWindow = [
    { high: 5501, low: 5499.5, volume: 200 },
    { high: 5501.5, low: 5500, volume: 220 },
    { high: 5501, low: 5500, volume: 210 },
  ]; // total 630 vs avgTouchVolume = 100*3=300, 1.5x=450 -> 630>450 high volume; max high 5501.5, level 5500 -> advance 1.5 < 2
  assert.equal(detectAbsorption(touchWindow, priorBars, 5500, "long", absorptionCfg), true);
});

test("detectAbsorption: normal volume is not absorption even if price stalls", () => {
  const priorBars = Array.from({ length: 20 }, () => ({ volume: 100 }));
  const touchWindow = [
    { high: 5500.5, low: 5499.5, volume: 90 },
    { high: 5501, low: 5500, volume: 95 },
    { high: 5501, low: 5500, volume: 100 },
  ];
  assert.equal(detectAbsorption(touchWindow, priorBars, 5500, "long", absorptionCfg), false);
});

test("detectAbsorption: high volume but price advances well beyond the level is not absorption", () => {
  const priorBars = Array.from({ length: 20 }, () => ({ volume: 100 }));
  const touchWindow = [
    { high: 5505, low: 5500, volume: 200 },
    { high: 5506, low: 5501, volume: 220 },
    { high: 5507, low: 5502, volume: 210 },
  ]; // advance = 7 pts, well beyond maxAdvancePts=2
  assert.equal(detectAbsorption(touchWindow, priorBars, 5500, "long", absorptionCfg), false);
});

function volBar(buyVolume, sellVolume) {
  return { high: 5500, low: 5499, close: 5500, buyVolume, sellVolume };
}

test("buildAbsorptionWindow: slices touch/prior windows and derives volume from buy+sell", () => {
  const bars = [
    ...Array.from({ length: 20 }, () => volBar(60, 40)), // prior window, volume 100 each
    volBar(150, 50), // touch window starts here (index 20)
    volBar(140, 60),
    volBar(130, 70), // currentIndex 22
  ];
  const result = buildAbsorptionWindow(bars, 22, { touchBars: 3, avgLookbackBars: 20 });
  assert.equal(result.touchWindow.length, 3);
  assert.equal(result.priorBars.length, 20);
  assert.equal(result.touchWindow[0].volume, 200); // 150+50
  assert.equal(result.priorBars[0].volume, 100); // 60+40
});

test("buildAbsorptionWindow: null when there isn't enough bar history yet to fill both windows", () => {
  const bars = Array.from({ length: 10 }, () => volBar(60, 40));
  assert.equal(buildAbsorptionWindow(bars, 9, { touchBars: 3, avgLookbackBars: 20 }), null);
});

const aDeltaMultiple = 1.5;

test("gradeFlow: A requires strong agreeing delta, new cum_delta extreme, no absorption/divergence", () => {
  const grade = gradeFlow({
    breakoutBar: { delta: 250 },
    confirmBar: { delta: 50 },
    direction: "long",
    avgAbsDelta: 10,
    cumDeltaNewExtreme: true,
    divergence: false,
    absorbed: false,
    aDeltaMultiple,
  });
  assert.equal(grade, "A");
});

test("gradeFlow: B when delta agrees but is below the A threshold", () => {
  const grade = gradeFlow({
    breakoutBar: { delta: 12 },
    confirmBar: { delta: 5 },
    direction: "long",
    avgAbsDelta: 10,
    cumDeltaNewExtreme: true,
    divergence: false,
    absorbed: false,
    aDeltaMultiple,
  });
  assert.equal(grade, "B");
});

test("gradeFlow: F when the breakout bar's delta disagrees with direction", () => {
  const grade = gradeFlow({
    breakoutBar: { delta: -20 },
    confirmBar: { delta: 5 },
    direction: "long",
    avgAbsDelta: 10,
    cumDeltaNewExtreme: true,
    divergence: false,
    absorbed: false,
    aDeltaMultiple,
  });
  assert.equal(grade, "F");
});

test("gradeFlow: F when the confirmation bar disagrees even if the breakout bar agreed", () => {
  const grade = gradeFlow({
    breakoutBar: { delta: 250 },
    confirmBar: { delta: -10 },
    direction: "long",
    avgAbsDelta: 10,
    cumDeltaNewExtreme: true,
    divergence: false,
    absorbed: false,
    aDeltaMultiple,
  });
  assert.equal(grade, "F");
});

test("gradeFlow: F on divergence regardless of delta strength", () => {
  const grade = gradeFlow({
    breakoutBar: { delta: 250 },
    confirmBar: { delta: 50 },
    direction: "long",
    avgAbsDelta: 10,
    cumDeltaNewExtreme: true,
    divergence: true,
    absorbed: false,
    aDeltaMultiple,
  });
  assert.equal(grade, "F");
});

test("gradeFlow: F on absorption regardless of delta strength", () => {
  const grade = gradeFlow({
    breakoutBar: { delta: 250 },
    confirmBar: { delta: 50 },
    direction: "long",
    avgAbsDelta: 10,
    cumDeltaNewExtreme: true,
    divergence: false,
    absorbed: true,
    aDeltaMultiple,
  });
  assert.equal(grade, "F");
});

const orderFlowCfg = {
  divergenceLookbackBars: 10,
  absorption: { touchBars: 3, volMultiple: 1.5, maxAdvancePts: 2, avgLookbackBars: 20 },
  flowGrade: { aDeltaMultiple: 1.5, avgLookbackBars: 20 },
};

function buildQuietBars(n) {
  const raw = Array.from({ length: n }, () => ({
    high: 5500.1,
    low: 5499.9,
    close: 5500,
    volume: 100,
    buyVolume: 55,
    sellVolume: 45,
  }));
  return withCumDelta(raw);
}

test("evaluateBreakoutFlow: end-to-end grade A on a clean, strongly-confirmed breakout", () => {
  const bars = buildQuietBars(20);
  const last = bars[bars.length - 1];
  const breakout = withCumDelta([
    { high: 5502, low: 5500, close: 5501.5, volume: 350, buyVolume: 300, sellVolume: 50 },
  ]).map((b) => ({ ...b, cumDelta: b.cumDelta + last.cumDelta }))[0];
  const confirm = { high: 5502.5, low: 5501, close: 5502, volume: 150, buyVolume: 100, sellVolume: 50, delta: 50, cumDelta: breakout.cumDelta + 50 };

  const allBars = [...bars, breakout, confirm];
  const result = evaluateBreakoutFlow(allBars, allBars.length - 2, "long", 5500, orderFlowCfg);
  assert.equal(result.grade, "A");
  assert.equal(result.divergence, false);
  assert.equal(result.absorbed, false);
});

test("evaluateBreakoutFlow: PENDING with no confirmation bar yet", () => {
  const bars = buildQuietBars(5);
  const result = evaluateBreakoutFlow(bars, bars.length - 1, "long", 5500, orderFlowCfg);
  assert.equal(result.grade, "PENDING");
});

test("evaluateBreakoutFlow: F when absorption fires at the breakout level", () => {
  const bars = buildQuietBars(20);
  const last = bars[bars.length - 1];
  // Three heavy-volume, stalled-price bars right at the level (touchBars=3) followed by a weak breakout attempt.
  const touch = withCumDelta([
    { high: 5501, low: 5499.5, close: 5500.5, volume: 220, buyVolume: 130, sellVolume: 90 },
    { high: 5501.2, low: 5500, close: 5500.8, volume: 230, buyVolume: 135, sellVolume: 95 },
    { high: 5501, low: 5500, close: 5500.5, volume: 210, buyVolume: 120, sellVolume: 90 },
  ]).map((b) => ({ ...b, cumDelta: b.cumDelta + last.cumDelta }));
  const confirm = {
    high: 5501.3,
    low: 5500.5,
    close: 5501,
    volume: 100,
    buyVolume: 60,
    sellVolume: 40,
    delta: 20,
    cumDelta: touch[touch.length - 1].cumDelta + 20,
  };
  const allBars = [...bars, ...touch, confirm];
  const breakoutIndex = allBars.length - 2;
  const result = evaluateBreakoutFlow(allBars, breakoutIndex, "long", 5500, orderFlowCfg);
  assert.equal(result.absorbed, true);
  assert.equal(result.grade, "F");
});

const polrCfg = { lookbackBars: 4, volumeLightMultiple: 2, avgLookbackBars: 3 };

test("detectPathOfLeastResistance: clean light-volume advance with agreeing delta is a long trigger", () => {
  const bars = [
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 }, // avg window: 20 vol/bar
    { close: 100, buyVolume: 5, sellVolume: 1, cumDelta: 10 },
    { close: 101, buyVolume: 5, sellVolume: 1, cumDelta: 14 },
    { close: 102, buyVolume: 5, sellVolume: 1, cumDelta: 18 },
    { close: 103, buyVolume: 5, sellVolume: 1, cumDelta: 22 },
  ];
  assert.deepEqual(detectPathOfLeastResistance(bars, 6, polrCfg), { direction: "long" });
});

test("detectPathOfLeastResistance: a dip breaks 'clean' progress", () => {
  const bars = [
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 100, buyVolume: 5, sellVolume: 1, cumDelta: 10 },
    { close: 99, buyVolume: 5, sellVolume: 1, cumDelta: 8 }, // dip
    { close: 102, buyVolume: 5, sellVolume: 1, cumDelta: 18 },
    { close: 103, buyVolume: 5, sellVolume: 1, cumDelta: 22 },
  ];
  assert.equal(detectPathOfLeastResistance(bars, 6, polrCfg), null);
});

test("detectPathOfLeastResistance: heavy volume disqualifies it (that's absorption's signature, not this one's)", () => {
  const bars = [
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 100, buyVolume: 20, sellVolume: 20, cumDelta: 10 },
    { close: 101, buyVolume: 20, sellVolume: 20, cumDelta: 14 },
    { close: 102, buyVolume: 20, sellVolume: 20, cumDelta: 18 },
    { close: 103, buyVolume: 20, sellVolume: 20, cumDelta: 22 },
  ];
  assert.equal(detectPathOfLeastResistance(bars, 6, polrCfg), null);
});

test("detectPathOfLeastResistance: delta disagreeing with price disqualifies it", () => {
  const bars = [
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 100, buyVolume: 5, sellVolume: 1, cumDelta: 20 },
    { close: 101, buyVolume: 5, sellVolume: 1, cumDelta: 18 },
    { close: 102, buyVolume: 5, sellVolume: 1, cumDelta: 16 },
    { close: 103, buyVolume: 5, sellVolume: 1, cumDelta: 14 }, // price up, cumDelta down
  ];
  assert.equal(detectPathOfLeastResistance(bars, 6, polrCfg), null);
});

test("detectPathOfLeastResistance: not enough bars yet", () => {
  const bars = [
    { close: 100, buyVolume: 5, sellVolume: 1, cumDelta: 10 },
    { close: 101, buyVolume: 5, sellVolume: 1, cumDelta: 14 },
  ];
  assert.equal(detectPathOfLeastResistance(bars, 1, polrCfg), null);
});

const lopCfg = { lookbackBars: 4, volumeDeclineMultiple: 2 };

test("detectLackOfParticipation: declining volume + flattening delta after an up-move is a short (fade) trigger", () => {
  const bars = [
    { buyVolume: 20, sellVolume: 5, cumDelta: 0 },
    { buyVolume: 20, sellVolume: 5, cumDelta: 15 },
    { buyVolume: 5, sellVolume: 5, cumDelta: 20 },
    { buyVolume: 5, sellVolume: 5, cumDelta: 22 },
  ];
  assert.deepEqual(detectLackOfParticipation(bars, 3, lopCfg), { direction: "short" });
});

test("detectLackOfParticipation: declining volume + reversing delta after a down-move is a long (fade) trigger", () => {
  const bars = [
    { buyVolume: 20, sellVolume: 5, cumDelta: 0 },
    { buyVolume: 20, sellVolume: 5, cumDelta: -15 },
    { buyVolume: 5, sellVolume: 5, cumDelta: -18 },
    { buyVolume: 5, sellVolume: 5, cumDelta: -16 },
  ];
  assert.deepEqual(detectLackOfParticipation(bars, 3, lopCfg), { direction: "long" });
});

test("detectLackOfParticipation: no signal when volume hasn't meaningfully declined", () => {
  const bars = [
    { buyVolume: 20, sellVolume: 5, cumDelta: 0 },
    { buyVolume: 20, sellVolume: 5, cumDelta: 15 },
    { buyVolume: 15, sellVolume: 15, cumDelta: 20 },
    { buyVolume: 15, sellVolume: 15, cumDelta: 22 },
  ];
  assert.equal(detectLackOfParticipation(bars, 3, lopCfg), null);
});

test("detectLackOfParticipation: no signal when delta keeps accelerating in the same direction", () => {
  const bars = [
    { buyVolume: 20, sellVolume: 5, cumDelta: 0 },
    { buyVolume: 20, sellVolume: 5, cumDelta: 15 },
    { buyVolume: 5, sellVolume: 5, cumDelta: 25 },
    { buyVolume: 5, sellVolume: 5, cumDelta: 40 }, // second-half slope (20) exceeds first-half (15)
  ];
  assert.equal(detectLackOfParticipation(bars, 3, lopCfg), null);
});

test("detectLackOfParticipation: no signal with an ambiguous (flat) first-half delta slope", () => {
  const bars = [
    { buyVolume: 20, sellVolume: 5, cumDelta: 10 },
    { buyVolume: 20, sellVolume: 5, cumDelta: 10 },
    { buyVolume: 5, sellVolume: 5, cumDelta: 12 },
    { buyVolume: 5, sellVolume: 5, cumDelta: 14 },
  ];
  assert.equal(detectLackOfParticipation(bars, 3, lopCfg), null);
});

test("detectLackOfParticipation: not enough bars yet", () => {
  const bars = [{ buyVolume: 20, sellVolume: 5, cumDelta: 0 }];
  assert.equal(detectLackOfParticipation(bars, 0, lopCfg), null);
});
