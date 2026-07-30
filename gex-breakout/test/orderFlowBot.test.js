import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runOrderFlowChecks,
  zoneKeyFor,
  isZoneOnCooldown,
  buildActiveZones,
  computeZoneStop,
  evaluateZoneAbsorption,
  nearestZoneOrSynthetic,
  evaluateOrderFlowBot,
} from "../src/orderFlowBot.js";

const config = {
  entryCutoffET: { h: 12, m: 0 },
  orderFlowBot: {
    triggerBufferPts: 1,
    macroOverrideEnabled: true,
    maxTradesPerDay: 3,
    cooldownMinPerZone: 60,
    volumeProfile: { probeLookbackBars: 2 },
    pathOfLeastResistance: { lookbackBars: 4, volumeLightMultiple: 2, avgLookbackBars: 3 },
    lackOfParticipation: { lookbackBars: 4, volumeDeclineMultiple: 2 },
    exit: { placeholderTargetDistancePts: 500 },
  },
  orderFlow: { absorption: { volMultiple: 1.5, maxAdvancePts: 2, avgLookbackBars: 20 } },
  tradeManagement: { stopCapPts: 12 },
  levels: { wallFilter: { nearPts: 15, mode: "skip" } },
};
const noWalls = { aboveSpot: [], belowSpot: [] };
const freshDayState = () => ({ orderFlowTradesToday: 0, zoneCooldowns: new Map() });
const before = new Date(2026, 6, 24, 10, 0); // 10am ET, before the noon cutoff

test("runOrderFlowChecks: vetoes past the entry cutoff", () => {
  const afterCutoff = new Date(2026, 6, 24, 13, 0);
  assert.deepEqual(runOrderFlowChecks({ nowET: afterCutoff, config }), {
    pass: false,
    vetoReason: "past_trading_cutoff",
  });
});

test("runOrderFlowChecks: vetoes when the macro override is manually switched off", () => {
  assert.deepEqual(
    runOrderFlowChecks({ nowET: before, config: { ...config, orderFlowBot: { ...config.orderFlowBot, macroOverrideEnabled: false } } }),
    { pass: false, vetoReason: "macro_override_off" }
  );
});

test("runOrderFlowChecks: passes otherwise", () => {
  assert.deepEqual(runOrderFlowChecks({ nowET: before, config }), { pass: true });
});

test("zoneKeyFor: distinguishes by side and bounds; value-area zones (side:null) key as VA", () => {
  assert.equal(zoneKeyFor({ side: "buy", low: 5498, high: 5500 }), "buy:5498.00-5500.00");
  assert.equal(zoneKeyFor({ side: null, low: 100, high: 105 }), "VA:100.00-105.00");
});

test("isZoneOnCooldown: true within the window, false after it, false if never traded", () => {
  const cooldowns = new Map([["z1", 1000]]);
  assert.equal(isZoneOnCooldown("z1", cooldowns, 1000 + 30 * 60_000, 60), true);
  assert.equal(isZoneOnCooldown("z1", cooldowns, 1000 + 90 * 60_000, 60), false);
  assert.equal(isZoneOnCooldown("z2", cooldowns, 1000, 60), false);
});

test("buildActiveZones: footprint zones as-is on NEG_GAMMA (trend) days", () => {
  const footprintZones = [{ side: "buy", low: 100, high: 102 }];
  assert.equal(buildActiveZones({ baseRegime: "NEG_GAMMA" }, { footprintZones, valueArea: null }), footprintZones);
});

test("buildActiveZones: the value area as a single zone on POS_GAMMA (mean-reversion) days", () => {
  const valueArea = { high: 105, low: 100 };
  assert.deepEqual(buildActiveZones({ baseRegime: "POS_GAMMA" }, { footprintZones: [], valueArea }), [
    { side: null, low: 100, high: 105 },
  ]);
});

test("buildActiveZones: no zones on a POS_GAMMA day with no value area yet", () => {
  assert.deepEqual(buildActiveZones({ baseRegime: "POS_GAMMA" }, { footprintZones: [], valueArea: null }), []);
});

test("computeZoneStop: long stop sits triggerBufferPts below the zone low", () => {
  const zone = { low: 100, high: 105 };
  const stop = computeZoneStop({ zone, entryPrice: 100.5, direction: "long", stopCapPts: 12, triggerBufferPts: 1 });
  assert.deepEqual(stop, { valid: true, distance: 1.5, stopPrice: 99 });
});

test("computeZoneStop: short stop sits triggerBufferPts above the zone high", () => {
  const zone = { low: 100, high: 105 };
  const stop = computeZoneStop({ zone, entryPrice: 104.5, direction: "short", stopCapPts: 12, triggerBufferPts: 1 });
  assert.deepEqual(stop, { valid: true, distance: 1.5, stopPrice: 106 });
});

test("computeZoneStop: invalid once total distance exceeds stopCapPts", () => {
  const zone = { low: 100, high: 105 };
  const stop = computeZoneStop({ zone, entryPrice: 100, direction: "short", stopCapPts: 3, triggerBufferPts: 1 });
  assert.equal(stop.valid, false);
  assert.equal(stop.distance, 6);
});

test("evaluateZoneAbsorption: absorption at the nearest zone edge fires", () => {
  const zone = { side: "buy", low: 5498, high: 5500 };
  const priorBars = Array.from({ length: 20 }, () => ({ volume: 100 }));
  const touchWindow = [
    { high: 5501, low: 5499.5, volume: 200 },
    { high: 5501.5, low: 5500, volume: 220 },
    { high: 5501, low: 5500, volume: 210 },
  ];
  const bars = [{ close: 5500 }];
  const result = evaluateZoneAbsorption(zone, { bars, index: 0, touchWindow, priorBars, config });
  assert.deepEqual(result, { direction: "short", trigger: "absorption", entryPrice: 5500 });
});

test("evaluateZoneAbsorption: null with no touch window — genuinely zone-specific, no fallthrough to other triggers", () => {
  const zone = { side: "buy", low: 90, high: 95 };
  // Bars that WOULD trigger path-of-least-resistance if this function still
  // fell through to it (it no longer does — that's evaluateOrderFlowBot's
  // job now, checked independent of any zone; see the regression test below).
  const bars = [
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 100, buyVolume: 5, sellVolume: 1, cumDelta: 10 },
    { close: 101, buyVolume: 5, sellVolume: 1, cumDelta: 14 },
    { close: 102, buyVolume: 5, sellVolume: 1, cumDelta: 18 },
    { close: 103, buyVolume: 5, sellVolume: 1, cumDelta: 22 },
  ];
  const result = evaluateZoneAbsorption(zone, { bars, index: 6, touchWindow: null, priorBars: null, config });
  assert.equal(result, null);
});

test("evaluateZoneAbsorption: null when the touch window doesn't show absorption either", () => {
  const zone = { side: "buy", low: 5498, high: 5500 };
  const priorBars = Array.from({ length: 20 }, () => ({ volume: 100 }));
  const touchWindow = [{ high: 5500.25, low: 5499.75, volume: 50 }]; // normal volume, no stall
  const bars = [{ close: 5500 }];
  const result = evaluateZoneAbsorption(zone, { bars, index: 0, touchWindow, priorBars, config });
  assert.equal(result, null);
});

test("nearestZoneOrSynthetic: picks the real zone with the closest midpoint to entryPrice", () => {
  const zones = [{ low: 90, high: 92 }, { low: 100, high: 102 }, { low: 150, high: 152 }];
  // midpoints 91/101/151 — entryPrice 103 is closest to 101
  assert.deepEqual(nearestZoneOrSynthetic(zones, 103, 12, 1), { low: 100, high: 102 });
});

test("nearestZoneOrSynthetic: synthetic zone half-width is stopCapPts minus triggerBufferPts, not the full stopCapPts", () => {
  // Sized so computeZoneStop's own triggerBufferPts-beyond-the-edge margin
  // still totals stopCapPts exactly, not more — a full-stopCapPts-wide
  // synthetic zone would push every resulting stop past the cap.
  assert.deepEqual(nearestZoneOrSynthetic([], 5500, 12, 1), { side: null, low: 5489, high: 5511 });
});

test("evaluateOrderFlowBot: POS_GAMMA failed-auction produces a full contrarian signal", () => {
  const bars = [
    { close: 103, high: 104, low: 102 },
    { close: 106.5, high: 107, low: 105.5 }, // probes above value
    { close: 104, high: 106, low: 103.5 }, // reverts back inside — trigger bar
  ];
  const result = evaluateOrderFlowBot({
    nowET: before,
    bars,
    index: 2,
    regimeInfo: { baseRegime: "POS_GAMMA", regime: "POS_GAMMA" },
    footprintZones: [],
    valueArea: { high: 105, low: 100 },
    touchWindow: null,
    priorBars: null,
    walls: noWalls,
    config,
    dayState: freshDayState(),
  });
  assert.deepEqual(result, {
    strategy: "OF",
    direction: "short",
    trigger: "failed_auction",
    zone: { side: null, low: 100, high: 105 },
    zoneKey: "VA:100.00-105.00",
    level: { type: "FAILED_AUCTION", price: 104 },
    entryPrice: 104,
    stopPrice: 106,
    stopDistance: 2,
    targetPrice: 100,
    targetMode: "contrarian_value_area",
    sizeMultiplier: 1,
    isTrendDay: false,
    regime: "POS_GAMMA",
    veto: null,
  });
});

test("evaluateOrderFlowBot: NEG_GAMMA absorption on a footprint zone produces a trend-day placeholder-target signal", () => {
  const priorBars = Array.from({ length: 20 }, () => ({ volume: 100 }));
  const touchWindow = [
    { high: 5501, low: 5499.5, volume: 200 },
    { high: 5501.5, low: 5500, volume: 220 },
    { high: 5501, low: 5500, volume: 210 },
  ];
  const bars = [{ close: 5500 }];
  const result = evaluateOrderFlowBot({
    nowET: before,
    bars,
    index: 0,
    regimeInfo: { baseRegime: "NEG_GAMMA", regime: "NEG_GAMMA" },
    footprintZones: [{ side: "buy", low: 5498, high: 5500 }],
    valueArea: null,
    touchWindow,
    priorBars,
    walls: noWalls,
    config,
    dayState: freshDayState(),
  });
  assert.deepEqual(result, {
    strategy: "OF",
    direction: "short",
    trigger: "absorption",
    zone: { side: "buy", low: 5498, high: 5500 },
    zoneKey: "buy:5498.00-5500.00",
    level: { type: "ABSORPTION", price: 5500 },
    entryPrice: 5500,
    stopPrice: 5501,
    stopDistance: 1,
    targetPrice: 5000,
    targetMode: "trend_trail_placeholder",
    sizeMultiplier: 1,
    isTrendDay: true,
    regime: "NEG_GAMMA",
    veto: null,
  });
});

// Regression test for the real live gap caught 2026-07-30 (first live
// session): with zero footprint zones formed yet, path-of-least-resistance
// used to never even get checked, despite not needing a zone at all.
test("evaluateOrderFlowBot: path-of-least-resistance fires even with ZERO footprint zones (the exact live bug)", () => {
  const bars = [
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 100, buyVolume: 5, sellVolume: 1, cumDelta: 10 },
    { close: 101, buyVolume: 5, sellVolume: 1, cumDelta: 14 },
    { close: 102, buyVolume: 5, sellVolume: 1, cumDelta: 18 },
    { close: 103, buyVolume: 5, sellVolume: 1, cumDelta: 22 },
  ];
  const result = evaluateOrderFlowBot({
    nowET: before,
    bars,
    index: 6,
    regimeInfo: { baseRegime: "NEG_GAMMA", regime: "NEG_GAMMA" },
    footprintZones: [], // <- the exact live state that silently blocked everything before this fix
    valueArea: null,
    touchWindow: null,
    priorBars: null,
    walls: noWalls,
    config,
    dayState: freshDayState(),
  });
  assert.deepEqual(result, {
    strategy: "OF",
    direction: "long",
    trigger: "path_of_least_resistance",
    zone: { side: null, low: 92, high: 114 }, // synthetic: 103 ± (stopCapPts(12) - triggerBufferPts(1))
    zoneKey: "VA:92.00-114.00",
    level: { type: "PATH_OF_LEAST_RESISTANCE", price: 103 },
    entryPrice: 103,
    stopPrice: 91,
    stopDistance: 12,
    targetPrice: 603,
    targetMode: "trend_trail_placeholder",
    sizeMultiplier: 1,
    isTrendDay: true,
    regime: "NEG_GAMMA",
    veto: null,
  });
});

test("evaluateOrderFlowBot: path-of-least-resistance attaches to a real nearby zone instead of a synthetic one when one exists", () => {
  const bars = [
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 90, buyVolume: 10, sellVolume: 10, cumDelta: 0 },
    { close: 100, buyVolume: 5, sellVolume: 1, cumDelta: 10 },
    { close: 101, buyVolume: 5, sellVolume: 1, cumDelta: 14 },
    { close: 102, buyVolume: 5, sellVolume: 1, cumDelta: 18 },
    { close: 103, buyVolume: 5, sellVolume: 1, cumDelta: 22 },
  ];
  const result = evaluateOrderFlowBot({
    nowET: before,
    bars,
    index: 6,
    regimeInfo: { baseRegime: "NEG_GAMMA", regime: "NEG_GAMMA" },
    footprintZones: [{ side: "sell", low: 100, high: 104 }], // midpoint 102, nearest to entry 103
    valueArea: null,
    touchWindow: null, // no absorption data, so this zone's own absorption check is a no-op
    priorBars: null,
    walls: noWalls,
    config,
    dayState: freshDayState(),
  });
  assert.deepEqual(result, {
    strategy: "OF",
    direction: "long",
    trigger: "path_of_least_resistance",
    zone: { side: "sell", low: 100, high: 104 },
    zoneKey: "sell:100.00-104.00",
    level: { type: "PATH_OF_LEAST_RESISTANCE", price: 103 },
    entryPrice: 103,
    stopPrice: 99,
    stopDistance: 4,
    targetPrice: 603,
    targetMode: "trend_trail_placeholder",
    sizeMultiplier: 1,
    isTrendDay: true,
    regime: "NEG_GAMMA",
    veto: null,
  });
});

test("evaluateOrderFlowBot: vetoes past the entry cutoff before evaluating anything else", () => {
  const result = evaluateOrderFlowBot({
    nowET: new Date(2026, 6, 24, 13, 0),
    bars: [{ close: 100 }],
    index: 0,
    regimeInfo: { baseRegime: "POS_GAMMA", regime: "POS_GAMMA" },
    footprintZones: [],
    valueArea: null,
    touchWindow: null,
    priorBars: null,
    walls: noWalls,
    config,
    dayState: freshDayState(),
  });
  assert.deepEqual(result, { strategy: "OF", veto: "past_trading_cutoff" });
});

test("evaluateOrderFlowBot: vetoes once maxTradesPerDay is reached", () => {
  const result = evaluateOrderFlowBot({
    nowET: before,
    bars: [{ close: 100 }],
    index: 0,
    regimeInfo: { baseRegime: "POS_GAMMA", regime: "POS_GAMMA" },
    footprintZones: [],
    valueArea: null,
    touchWindow: null,
    priorBars: null,
    walls: noWalls,
    config,
    dayState: { orderFlowTradesToday: 3, zoneCooldowns: new Map() },
  });
  assert.deepEqual(result, { strategy: "OF", veto: "max_trades_per_day_reached" });
});

test("evaluateOrderFlowBot: vetoes when a wall sits too close in the trade's direction", () => {
  const bars = [
    { close: 103, high: 104, low: 102 },
    { close: 106.5, high: 107, low: 105.5 },
    { close: 104, high: 106, low: 103.5 },
  ];
  const walls = { aboveSpot: [], belowSpot: [{ strike: 103, wallType: "POS_WALL", gex: -1 }] };
  const result = evaluateOrderFlowBot({
    nowET: before,
    bars,
    index: 2,
    regimeInfo: { baseRegime: "POS_GAMMA", regime: "POS_GAMMA" },
    footprintZones: [],
    valueArea: { high: 105, low: 100 },
    touchWindow: null,
    priorBars: null,
    walls,
    config,
    dayState: freshDayState(),
  });
  assert.deepEqual(result, {
    strategy: "OF",
    direction: "short",
    zone: { side: null, low: 100, high: 105 },
    zoneKey: "VA:100.00-105.00",
    veto: "wall_too_close",
  });
});

test("evaluateOrderFlowBot: vetoes when the stop would exceed stopCapPts", () => {
  const bars = [
    { close: 160, high: 210, low: 155 },
    { close: 150, high: 200, low: 145 },
  ];
  const result = evaluateOrderFlowBot({
    nowET: before,
    bars,
    index: 1,
    regimeInfo: { baseRegime: "POS_GAMMA", regime: "POS_GAMMA" },
    footprintZones: [],
    valueArea: { high: 200, low: 100 },
    touchWindow: null,
    priorBars: null,
    walls: noWalls,
    config,
    dayState: freshDayState(),
  });
  assert.deepEqual(result, {
    strategy: "OF",
    direction: "short",
    zone: { side: null, low: 100, high: 200 },
    zoneKey: "VA:100.00-200.00",
    veto: "stop_exceeds_cap",
  });
});

test("evaluateOrderFlowBot: vetoes when the target is closer than the stop", () => {
  const bars = [
    { close: 100.3, high: 100.8, low: 100.1 },
    { close: 100.4, high: 100.6, low: 100.2 },
  ];
  const result = evaluateOrderFlowBot({
    nowET: before,
    bars,
    index: 1,
    regimeInfo: { baseRegime: "POS_GAMMA", regime: "POS_GAMMA" },
    footprintZones: [],
    valueArea: { high: 100.5, low: 100 },
    touchWindow: null,
    priorBars: null,
    walls: noWalls,
    config,
    dayState: freshDayState(),
  });
  assert.deepEqual(result, {
    strategy: "OF",
    direction: "short",
    zone: { side: null, low: 100, high: 100.5 },
    zoneKey: "VA:100.00-100.50",
    veto: "stop_exceeds_target",
  });
});

test("evaluateOrderFlowBot: a zone on cooldown produces no signal at all, not even a veto", () => {
  const bars = [
    { close: 103, high: 104, low: 102 },
    { close: 106.5, high: 107, low: 105.5 },
    { close: 104, high: 106, low: 103.5 },
  ];
  const dayState = { orderFlowTradesToday: 0, zoneCooldowns: new Map([["VA:100.00-105.00", Date.now()]]) };
  const result = evaluateOrderFlowBot({
    nowET: before,
    bars,
    index: 2,
    regimeInfo: { baseRegime: "POS_GAMMA", regime: "POS_GAMMA" },
    footprintZones: [],
    valueArea: { high: 105, low: 100 },
    touchWindow: null,
    priorBars: null,
    walls: noWalls,
    config,
    dayState,
  });
  assert.equal(result, null);
});

test("evaluateOrderFlowBot: null when nothing triggers", () => {
  const result = evaluateOrderFlowBot({
    nowET: before,
    bars: [{ close: 100, buyVolume: 10, sellVolume: 10, cumDelta: 0 }],
    index: 0,
    regimeInfo: { baseRegime: "NEG_GAMMA", regime: "NEG_GAMMA" },
    footprintZones: [],
    valueArea: null,
    touchWindow: null,
    priorBars: null,
    walls: noWalls,
    config,
    dayState: freshDayState(),
  });
  assert.equal(result, null);
});
