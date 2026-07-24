import { test } from "node:test";
import assert from "node:assert/strict";
import { timeCheck, regimeCheck, flowGradeCheck, runChecks } from "../src/checks.js";
import { CONFIG } from "../src/config.js";

test("timeCheck: before the cutoff passes, at/after fails", () => {
  const cutoff = { h: 15, m: 30 };
  assert.equal(timeCheck(new Date(2026, 6, 24, 15, 29), cutoff), true);
  assert.equal(timeCheck(new Date(2026, 6, 24, 15, 30), cutoff), false);
  assert.equal(timeCheck(new Date(2026, 6, 24, 16, 0), cutoff), false);
});

const posOverrideOff = { enabled: false, requireFlowGrade: "A" };
const posOverrideOn = { enabled: true, requireFlowGrade: "A" };

test("regimeCheck: NEG_GAMMA always passes regardless of flow grade", () => {
  const r = regimeCheck({
    regimeInfo: { baseRegime: "NEG_GAMMA", nearFlip: false },
    prevPrice: 5490,
    price: 5495,
    flipPointEs: 5500,
    posGammaOverride: posOverrideOff,
    flowGrade: "F",
  });
  assert.equal(r.pass, true);
});

test("regimeCheck: POS_GAMMA with no flip break and no override fails", () => {
  const r = regimeCheck({
    regimeInfo: { baseRegime: "POS_GAMMA", nearFlip: false },
    prevPrice: 5490,
    price: 5495,
    flipPointEs: 5500,
    posGammaOverride: posOverrideOff,
    flowGrade: "A",
  });
  assert.equal(r.pass, false);
});

test("regimeCheck: POS_GAMMA passes via a confirmed flip break while NEAR_FLIP", () => {
  const r = regimeCheck({
    regimeInfo: { baseRegime: "POS_GAMMA", nearFlip: true },
    prevPrice: 5498,
    price: 5503,
    flipPointEs: 5500,
    posGammaOverride: posOverrideOff,
    flowGrade: "B",
  });
  assert.equal(r.pass, true);
  assert.equal(r.viaFlipBreak, true);
});

test("regimeCheck: POS_GAMMA passes via override only when flow grade matches the requirement", () => {
  const passing = regimeCheck({
    regimeInfo: { baseRegime: "POS_GAMMA", nearFlip: false },
    prevPrice: 5490,
    price: 5495,
    flipPointEs: 5600,
    posGammaOverride: posOverrideOn,
    flowGrade: "A",
  });
  assert.equal(passing.pass, true);
  assert.equal(passing.viaOverride, true);

  const failing = regimeCheck({
    regimeInfo: { baseRegime: "POS_GAMMA", nearFlip: false },
    prevPrice: 5490,
    price: 5495,
    flipPointEs: 5600,
    posGammaOverride: posOverrideOn,
    flowGrade: "B",
  });
  assert.equal(failing.pass, false);
});

test("flowGradeCheck: A or B pass normally, F never passes", () => {
  const regular = {};
  assert.equal(flowGradeCheck("A", regular), true);
  assert.equal(flowGradeCheck("B", regular), true);
  assert.equal(flowGradeCheck("F", regular), false);
});

test("flowGradeCheck: via override requires A specifically, B is not enough", () => {
  const viaOverride = { viaOverride: true };
  assert.equal(flowGradeCheck("A", viaOverride), true);
  assert.equal(flowGradeCheck("B", viaOverride), false);
});

const walls = {
  aboveSpot: [{ strike: 5525, gex: 5e9, wallType: "POS_WALL" }],
  belowSpot: [{ strike: 5480, gex: -4e9, wallType: "NEG_WALL" }],
};

function baseArgs(overrides = {}) {
  return {
    nowET: new Date(2026, 6, 24, 10, 0),
    price: 5510,
    prevPrice: 5505,
    direction: "long",
    breakoutLevel: 5510,
    regimeInfo: { baseRegime: "NEG_GAMMA", nearFlip: false },
    flipPointEs: 5450,
    walls,
    flowGrade: "B",
    config: structuredClone(CONFIG),
    ...overrides,
  };
}

test("runChecks: passes end-to-end in NEG_GAMMA with open space and adequate flow", () => {
  const result = runChecks(baseArgs());
  assert.equal(result.pass, true);
  assert.equal(result.sizeMultiplier, 1);
});

test("runChecks: vetoes past the trading cutoff", () => {
  const result = runChecks(baseArgs({ nowET: new Date(2026, 6, 24, 15, 45) }));
  assert.equal(result.pass, false);
  assert.equal(result.vetoReason, "past_trading_cutoff");
});

test("runChecks: vetoes POS_GAMMA with no flip break or override", () => {
  const result = runChecks(
    baseArgs({ regimeInfo: { baseRegime: "POS_GAMMA", nearFlip: false } })
  );
  assert.equal(result.pass, false);
  assert.equal(result.vetoReason, "pos_gamma_no_confirmation");
});

test("runChecks: vetoes on flow grade F", () => {
  const result = runChecks(baseArgs({ flowGrade: "F" }));
  assert.equal(result.pass, false);
  assert.equal(result.vetoReason, "flow_grade_F");
});

test("runChecks: vetoes breaking into a near POS wall when wallFilter mode is skip", () => {
  const result = runChecks(baseArgs({ price: 5518, breakoutLevel: 5518 }));
  assert.equal(result.pass, false);
  assert.equal(result.vetoReason, "wall_too_close");
});

test("runChecks: takes the trade at half size at the wall when mode is half_at_wall", () => {
  const config = structuredClone(CONFIG);
  config.levels.wallFilter.mode = "half_at_wall";
  const result = runChecks(baseArgs({ price: 5518, breakoutLevel: 5518, config }));
  assert.equal(result.pass, true);
  assert.equal(result.sizeMultiplier, 0.5);
  assert.equal(result.targetCap, 5525);
});
