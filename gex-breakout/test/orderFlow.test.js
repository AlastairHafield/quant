import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDelta,
  withCumDelta,
  rollingAvg,
  detectDeltaDivergence,
  detectAbsorption,
  gradeFlow,
  evaluateBreakoutFlow,
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
