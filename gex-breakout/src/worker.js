import "dotenv/config";
import { pathToFileURL } from "node:url";
import { CONFIG } from "./config.js";
import { computeGexSnapshotFromProfile } from "./gexEngine.js";
import { computeBasis, toEsLevels } from "./basis.js";
import { classifyRegime } from "./regime.js";
import {
  buildOrbLevels,
  buildGexLevels,
  buildDailyLevels,
  detectConsolidation,
  consolidationLevels,
} from "./levelEngine.js";
import { evaluateBreakoutFlow } from "./orderFlow.js";
import { checkOrbTrigger, evaluateStrategyA } from "./strategyA.js";
import {
  checkBreakoutTrigger,
  checkProximity,
  levelKeyFor,
  isLevelOnCooldown,
  evaluateStrategyB,
} from "./strategyB.js";
import { SessionRiskManager, checkDataHealth, checkRecalcSettle, computeSizeMultiplier } from "./riskSession.js";
import { startStatusReporter } from "./statusReporter.js";
import { SignalLogger, buildLogRow } from "./logger.js";
import { postDiscordEmbed, buildSignalEmbed, flushLogBufferToDiscord } from "./discord.js";
import * as topstepx from "./dataSources/topstepx.js";
import * as flashalpha from "./dataSources/flashalpha.js";

export function nowET() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

export function minutesOf(t) {
  return t.getHours() * 60 + t.getMinutes();
}

export function orbWindowBounds(config) {
  const start = config.sessionOpenET.h * 60 + config.sessionOpenET.m;
  return { startMin: start, endMin: start + config.orbWindowMin };
}

export function isWithinOrbWindow(t, bounds) {
  const m = minutesOf(t);
  return m >= bounds.startMin && m < bounds.endMin;
}

export function updateOrbRange(current, bar) {
  return {
    orbHigh: current.orbHigh == null ? bar.high : Math.max(current.orbHigh, bar.high),
    orbLow: current.orbLow == null ? bar.low : Math.min(current.orbLow, bar.low),
  };
}

export function shiftWalls(walls, basis) {
  const shift = (arr) => arr.map((w) => ({ ...w, strike: w.strike + basis }));
  return { aboveSpot: shift(walls.aboveSpot), belowSpot: shift(walls.belowSpot) };
}

export function buildLevelState({ gexSnapshot, basis, orbHigh, orbLow, orbLocked, dailyLevels, consolRange }) {
  if (!gexSnapshot || basis == null) {
    return { levels: [], triggerLevelsB: [], flipPointEs: null, wallsEs: { aboveSpot: [], belowSpot: [] } };
  }
  const gexLevelsEs = toEsLevels(buildGexLevels(gexSnapshot), basis);
  const flipPointEs = gexLevelsEs.find((l) => l.type === "FLIP")?.price ?? null;
  const wallsEs = shiftWalls(gexSnapshot.walls, basis);
  const orbLevelsEs = orbLocked ? buildOrbLevels(orbHigh, orbLow) : [];
  const consolLevelsEs = consolidationLevels(consolRange);

  const levels = [...gexLevelsEs, ...orbLevelsEs, ...dailyLevels, ...consolLevelsEs];
  const triggerLevelsB = [
    ...gexLevelsEs.filter((l) => l.type === "FLIP" || l.type === "GEX_WALL"),
    ...dailyLevels,
    ...consolLevelsEs,
  ];
  return { levels, triggerLevelsB, flipPointEs, wallsEs };
}

// ---- Stateful orchestration below. Not unit-tested directly (it's IO glue around
// the pure helpers above and the strategy modules) — exercise it against the
// Topstep Practice Account once real data adapters are wired up (Task 7). ----

export class Worker {
  constructor() {
    this.riskManager = new SessionRiskManager(CONFIG);
    this.logger = new SignalLogger();
    this.bars = [];
    this.orbHigh = null;
    this.orbLow = null;
    this.orbLocked = false;
    this.gexSnapshot = null;
    this.basis = null;
    this.basisAsOf = null;
    this.lastRecalcAt = null;
    this.lastFlipMovePts = null;
    this.priorDayHigh = null;
    this.priorDayLow = null;
    this.overnightHigh = null;
    this.overnightLow = null;
    this.levelState = {
      levels: [],
      triggerLevelsB: [],
      flipPointEs: null,
      wallsEs: { aboveSpot: [], belowSpot: [] },
    };
    this.pendingA = null;
    this.pendingB = null;
    this.lastRegimeInfo = null;
  }

  rebuildLevels() {
    const dailyLevels = buildDailyLevels({
      priorDayHigh: this.priorDayHigh,
      priorDayLow: this.priorDayLow,
      overnightHigh: this.overnightHigh,
      overnightLow: this.overnightLow,
    });
    const consolRange = detectConsolidation(this.bars, CONFIG.levels.consolidation);
    this.levelState = buildLevelState({
      gexSnapshot: this.gexSnapshot,
      basis: this.basis,
      orbHigh: this.orbHigh,
      orbLow: this.orbLow,
      orbLocked: this.orbLocked,
      dailyLevels,
      consolRange,
    });
  }

  async recalcGex() {
    const { profile, spot, flipPoint } = await flashalpha.fetchGexProfile(
      CONFIG.underlyingOptions,
      CONFIG.maxDte,
      nowET()
    );
    const prevFlip = this.levelState.flipPointEs;
    this.gexSnapshot = computeGexSnapshotFromProfile(profile, spot, CONFIG.gex, nowET(), flipPoint);
    this.lastRecalcAt = new Date();
    this.rebuildLevels();
    if (prevFlip != null && this.levelState.flipPointEs != null) {
      this.lastFlipMovePts = this.levelState.flipPointEs - prevFlip;
    }
  }

  async recalcBasis() {
    const esPrice = await topstepx.fetchLastPrice(CONFIG.instrumentData);
    const spxPrice = await flashalpha.fetchUnderlyingPrice(CONFIG.underlyingOptions);
    this.basis = computeBasis(esPrice, spxPrice);
    this.basisAsOf = new Date();
    this.rebuildLevels();
  }

  onBar(rawBar, t = nowET()) {
    const prevCum = this.bars.length ? this.bars[this.bars.length - 1].cumDelta : 0;
    const delta = rawBar.buyVolume - rawBar.sellVolume;
    const bar = { ...rawBar, delta, cumDelta: prevCum + delta };
    this.bars.push(bar);

    if (isWithinOrbWindow(t, orbWindowBounds(CONFIG))) {
      Object.assign(this, updateOrbRange(this, bar));
      return;
    }
    if (!this.orbLocked && this.orbHigh != null) {
      this.orbLocked = true;
      this.rebuildLevels();
    }
    if (!this.orbLocked) return;

    this.evaluateSignals(bar, t);
  }

  evaluateSignals(bar, t) {
    if (!this.riskManager.canTrade()) return;
    if (minutesOf(t) >= CONFIG.tradingCutoffET.h * 60 + CONFIG.tradingCutoffET.m) return;

    if (this.basisAsOf) {
      const health = checkDataHealth({
        basisAsOf: this.basisAsOf,
        deltaFeedLastBarAt: new Date(),
        now: new Date(),
        haltCfg: CONFIG.risk.halt,
      });
      if (!health.healthy) {
        this.logger.log(buildLogRow({ ts: new Date().toISOString(), vetoReason: health.reason }));
        return;
      }
    }

    if (this.lastRecalcAt && this.lastFlipMovePts != null) {
      const blocked = checkRecalcSettle({
        flipMovedPts: this.lastFlipMovePts,
        recalcAt: this.lastRecalcAt,
        now: new Date(),
        settleCfg: CONFIG.risk.recalcSettle,
      });
      if (blocked) return;
    }

    if (!this.gexSnapshot) return;
    const regimeInfo = classifyRegime({
      netGex: this.gexSnapshot.netGex,
      price: bar.close,
      flipPointEs: this.levelState.flipPointEs,
      nearFlipPts: CONFIG.regime.nearFlipPts,
    });
    this.lastRegimeInfo = regimeInfo;

    const idx = this.bars.length - 1;
    const prevBar = this.bars[idx - 1] ?? bar;

    this.tryStrategyA(bar, prevBar, idx, t, regimeInfo);
    this.tryStrategyB(bar, prevBar, idx, t, regimeInfo);
  }

  // Flow grading needs the breakout bar PLUS one confirmation bar (spec §7). A live
  // stream never has "the next bar" yet at the moment the breakout bar itself is
  // processed, so triggering arms a pending breakout snapshotted at that bar; it's
  // graded and evaluated one bar later, once the confirmation bar exists.
  tryStrategyA(bar, prevBar, idx, t, regimeInfo) {
    if (this.pendingA && this.pendingA.breakoutIndex === idx - 1) {
      const pending = this.pendingA;
      this.pendingA = null;
      const flow = evaluateBreakoutFlow(
        this.bars,
        pending.breakoutIndex,
        pending.direction,
        pending.breakoutLevel,
        CONFIG.orderFlow
      );
      if (flow.grade !== "PENDING") {
        const result = evaluateStrategyA({
          price: pending.entryPrice,
          prevPrice: pending.prevPrice,
          orbHigh: this.orbHigh,
          orbLow: this.orbLow,
          regimeInfo: pending.regimeInfo,
          flipPointEs: pending.flipPointEs,
          walls: pending.walls,
          flowGrade: flow.grade,
          levels: pending.levels,
          nowET: pending.nowET,
          config: CONFIG,
          dayState: this.riskManager.dayState,
        });
        if (result) {
          this.handleSignal(result, pending.regimeInfo, flow);
          if (!result.veto) this.riskManager.recordOrbTrade(result.direction);
        }
      }
    }

    if (!this.pendingA) {
      const direction = checkOrbTrigger({
        price: bar.close,
        orbHigh: this.orbHigh,
        orbLow: this.orbLow,
        triggerBufferPts: CONFIG.strategyA.triggerBufferPts,
      });
      if (direction && !this.riskManager.dayState.orbTradedDirections.has(direction)) {
        this.pendingA = {
          direction,
          breakoutLevel: direction === "long" ? this.orbHigh : this.orbLow,
          breakoutIndex: idx,
          entryPrice: bar.close,
          prevPrice: prevBar.close,
          regimeInfo,
          flipPointEs: this.levelState.flipPointEs,
          walls: this.levelState.wallsEs,
          levels: this.levelState.levels,
          nowET: t,
        };
      }
    }
  }

  tryStrategyB(bar, prevBar, idx, t, regimeInfo) {
    if (this.pendingB && this.pendingB.breakoutIndex === idx - 1) {
      const pending = this.pendingB;
      this.pendingB = null;
      const flow = evaluateBreakoutFlow(
        this.bars,
        pending.breakoutIndex,
        pending.direction,
        pending.level.price,
        CONFIG.orderFlow
      );
      if (flow.grade !== "PENDING") {
        const result = evaluateStrategyB({
          price: pending.entryPrice,
          prevPrice: pending.prevPrice,
          priorBars: pending.priorBars,
          triggerLevels: pending.triggerLevels,
          regimeInfo: pending.regimeInfo,
          flipPointEs: pending.flipPointEs,
          walls: pending.walls,
          flowGrade: flow.grade,
          levels: pending.levels,
          nowET: pending.nowET,
          nowMs: pending.nowMs,
          config: CONFIG,
          dayState: this.riskManager.dayState,
        });
        if (result) {
          this.handleSignal(result, pending.regimeInfo, flow);
          if (!result.veto) this.riskManager.recordStrategyBTrade(result.levelKey, Date.now());
        }
      }
    }

    if (!this.pendingB && idx >= 1) {
      const priorBars = this.bars.slice(0, idx);
      for (const level of this.levelState.triggerLevelsB) {
        const direction = checkBreakoutTrigger(bar.close, level, CONFIG.strategyB.triggerBufferPts);
        if (!direction) continue;
        const levelKey = levelKeyFor(level);
        if (isLevelOnCooldown(levelKey, this.riskManager.dayState.levelCooldowns, Date.now(), CONFIG.strategyB.cooldownMinPerLevel)) {
          continue;
        }
        if (!checkProximity(priorBars, level.price, CONFIG.strategyB.proximity)) continue;

        this.pendingB = {
          direction,
          level,
          breakoutIndex: idx,
          entryPrice: bar.close,
          prevPrice: prevBar.close,
          priorBars,
          triggerLevels: this.levelState.triggerLevelsB,
          regimeInfo,
          flipPointEs: this.levelState.flipPointEs,
          walls: this.levelState.wallsEs,
          levels: this.levelState.levels,
          nowET: t,
          nowMs: Date.now(),
        };
        break;
      }
    }
  }

  handleSignal(result, regimeInfo, flow) {
    const row = buildLogRow({
      ts: new Date().toISOString(),
      strategy: result.strategy,
      direction: result.direction,
      level: result.level ?? null,
      regime: regimeInfo?.regime ?? null,
      netGex: this.gexSnapshot?.netGex ?? null,
      flipPoint: this.levelState.flipPointEs,
      flowGrade: flow.grade,
      vetoReason: result.veto,
      entryPrice: result.entryPrice ?? null,
      stopPrice: result.stopPrice ?? null,
      targetPrice: result.targetPrice ?? null,
    });
    this.logger.log(row);

    if (result.veto) return; // signal-only mode: vetoes are logged only, no alert noise

    const sizeMultiplier = computeSizeMultiplier(flow.grade, result.sizeMultiplier, CONFIG.risk.sizing);
    const embed = buildSignalEmbed({
      title: `${result.direction === "long" ? "LONG" : "SHORT"} — Strategy ${result.strategy}`,
      description: `Entry ${result.entryPrice} / Stop ${result.stopPrice} / Target ${result.targetPrice} (${result.targetMode})`,
      color: result.direction === "long" ? 0x2ecc71 : 0xe74c3c,
      fields: [
        ["Regime", regimeInfo.regime],
        ["Flow grade", flow.grade],
        ["Size", sizeMultiplier],
      ],
      footerText: `${CONFIG.instrumentTrade} · signal-only · ${new Date().toISOString()}`,
    });
    postDiscordEmbed(CONFIG.discord.signalWebhook, embed).catch((e) =>
      console.error("Discord post failed:", e.message)
    );

    if (CONFIG.executionEnabled) {
      console.warn("EXECUTION_ENABLED is set but no execution layer exists yet — running signal-only regardless.");
    }
  }
}

export function createWorker() {
  return new Worker();
}

async function startWorker() {
  const worker = createWorker();
  console.log(`gex-breakout worker starting — signal-only mode: ${!CONFIG.executionEnabled}`);

  startStatusReporter(worker, {
    backendUrl: process.env.BACKEND_URL || "http://localhost:3001",
    secret: process.env.GEX_STATUS_SECRET,
    intervalMs: 3000,
  });

  worker.recalcGex().catch((e) => console.error("Initial GEX recalc failed:", e.message));
  worker.recalcBasis().catch((e) => console.error("Initial basis recalc failed:", e.message));

  setInterval(
    () => worker.recalcGex().catch((e) => console.error("GEX recalc failed:", e.message)),
    CONFIG.gexRecalcMin * 60_000
  );
  setInterval(
    () => worker.recalcBasis().catch((e) => console.error("Basis recalc failed:", e.message)),
    CONFIG.basisRecalcMin * 60_000
  );
  await topstepx.subscribeBars(CONFIG.instrumentData, (bar) => worker.onBar(bar));

  process.on("SIGTERM", async () => {
    const rows = worker.logger.drain();
    const day = new Date().toISOString().slice(0, 10);
    await flushLogBufferToDiscord(CONFIG.discord.logWebhook, rows, day, "sigterm");
    process.exit(0);
  });
}

// Hand-rolled file:// construction doesn't match on Windows (drive-letter paths need
// a third slash: file:///C:/... not file://C:/...) — caught by an actual local run
// where the worker silently exited immediately instead of starting.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startWorker();
}
