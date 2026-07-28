import { pathToFileURL } from "node:url";
import { CONFIG, POINT_VALUE } from "./config.js";
import { computeGexSnapshotFromProfile } from "./gexEngine.js";
import { computeBasis, toEsLevels } from "./basis.js";
import { classifyRegime } from "./regime.js";
import {
  buildOrbLevels,
  buildGexLevels,
  buildDailyLevels,
  detectConsolidation,
  consolidationLevels,
  isInOpenSpace,
} from "./levelEngine.js";
import { evaluateBreakoutFlow, buildAbsorptionWindow } from "./orderFlow.js";
import { checkOrbTrigger, evaluateStrategyA } from "./strategyA.js";
import {
  checkBreakoutTrigger,
  checkProximity,
  levelKeyFor,
  isLevelOnCooldown,
  evaluateStrategyB,
} from "./strategyB.js";
import { SessionRiskManager, checkDataHealth, checkRecalcSettle, computeSizeMultiplier } from "./riskSession.js";
import { ladderRatio } from "./sizing.js";
import { evaluateExit } from "./exitRules.js";
import { startStatusReporter } from "./statusReporter.js";
import { SignalLogger, buildLogRow } from "./logger.js";
import {
  postDiscordEmbed,
  buildTradeTakenEmbed,
  buildSignalEmbed,
  buildDailySummaryEmbed,
  flushLogBufferToDiscord,
} from "./discord.js";
import { computeDailySummary } from "./dailySummary.js";
import {
  updateMfeMae,
  computeRealizedPnl,
  computeExitNowValueSaved,
  computeTightenTrailValueSaved,
  computeTakePartialValueGained,
  clampStopDistance,
} from "./positionTracking.js";
import * as topstepx from "./dataSources/topstepx.js";
import * as flashalpha from "./dataSources/flashalpha.js";
import * as tradeJournal from "./tradeJournal.js";

export function toET(d) {
  return new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
}

export function nowET() {
  return toET(new Date());
}

export function minutesOf(t) {
  return t.getHours() * 60 + t.getMinutes();
}

// Strategy A (the 15-min ORB variant) has its own independent go-live gate on
// top of the bot-wide executionEnabled/account switch — see config.js's
// strategyA.executionEnabled comment. Every other strategy just follows the
// bot-wide flag, same as before this existed.
export function isLiveExecutionAllowed(strategy, config) {
  if (!config.executionEnabled) return false;
  if (strategy === "A") return config.strategyA.executionEnabled;
  return true;
}

// Strategy A trades its own account (the practice account) — everything else
// ("default") trades whatever TOPSTEPX_ACCOUNT_NAME points at (the real
// Combine). Only two roles exist today; this is the one place that decision
// is made, so every account-facing method below routes off it consistently
// instead of re-deriving "is this Strategy A" locally.
export function accountRoleFor(strategy) {
  return strategy === "A" ? "A" : "default";
}

export function orbWindowBounds(config) {
  const start = config.sessionOpenET.h * 60 + config.sessionOpenET.m;
  return { startMin: start, endMin: start + config.orbWindowMin };
}

export function isWithinOrbWindow(t, bounds) {
  const m = minutesOf(t);
  return m >= bounds.startMin && m < bounds.endMin;
}

export function shouldFlattenNow(t, config) {
  return minutesOf(t) >= config.flattenAtET.h * 60 + config.flattenAtET.m;
}

// Returns the day-key to flush for if it's at/past the scheduled flush time,
// else null — pure, so the "is it time" logic is testable separately from
// the setInterval wiring that calls it. Whether that day has already been
// flushed is checked separately (asynchronously, against Mongo) by the
// caller — this used to take a lastFlushedDay parameter backed by an
// in-memory variable, which reset on every restart and could double-flush a
// day already flushed before the restart.
export function shouldFlushLogNow(t, logFlushET) {
  const dayKey = t.toDateString();
  const isFlushTime = minutesOf(t) >= logFlushET.h * 60 + logFlushET.m;
  return isFlushTime ? dayKey : null;
}

export function updateOrbRange(current, bar) {
  return {
    orbHigh: current.orbHigh == null ? bar.high : Math.max(current.orbHigh, bar.high),
    orbLow: current.orbLow == null ? bar.low : Math.min(current.orbLow, bar.low),
  };
}

// ProjectX Gateway position type: 1 = Long, 2 = Short — confirmed live
// 2026-07-24 by cross-checking a position's type against the direction of
// the signal that opened it.
export const POSITION_TYPE_TO_DIRECTION = { 1: "long", 2: "short" };

// Broker-reported positions with no matching contractId in trackedTrades —
// either a fresh restart (see reconcileUntrackedPositions) or a position this
// process never placed itself. Skips anything with an unrecognized type
// rather than guess a direction.
export function untrackedPositions(openPositions, trackedTrades) {
  const trackedContractIds = new Set(trackedTrades.map((t) => t.contractId));
  return openPositions.filter((p) => !trackedContractIds.has(p.contractId) && POSITION_TYPE_TO_DIRECTION[p.type]);
}

// A contract only ever has one real net position at the broker, so flipping
// direction requires closing EVERY currently tracked trade on that contract,
// not just the literal opposite-direction one — even a same-direction trade
// would get wiped out by the same close call, so it has to come off our own
// tracking too. Returns [] (nothing to close) when every tracked trade on
// this contract already agrees with newDirection.
export function tradesRequiringCloseOnFlip(trackedTrades, contractId, newDirection) {
  const contractTrades = trackedTrades.filter((t) => t.contractId === contractId);
  const flipping = contractTrades.some((t) => t.direction !== newDirection);
  return flipping ? contractTrades : [];
}

// Reduces already-fetched historical bars (real UTC timestamps) down to the
// high/low of whatever ET calendar day + window they actually fall in — the
// pure half of backfillOrbIfPastWindow, split out so it's testable without a
// live TopstepX call. Takes the ET-conversion function as a parameter so
// tests can inject a deterministic stand-in instead of the real timezone
// round-trip. Returns null if no bars fall in the window (e.g. the contract
// is too new, or it's a holiday) — the caller just leaves the ORB unlocked
// and tries again on the next bar.
export function computeOrbFromHistoricalBars(bars, dayKey, bounds, toETFn = toET) {
  const windowBars = bars.filter((b) => {
    const bt = toETFn(new Date(b.timestamp));
    return bt.toDateString() === dayKey && minutesOf(bt) >= bounds.startMin && minutesOf(bt) < bounds.endMin;
  });
  if (!windowBars.length) return null;
  return {
    high: Math.max(...windowBars.map((b) => b.high)),
    low: Math.min(...windowBars.map((b) => b.low)),
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
    this.currentDay = null;
    this.orbHigh = null;
    this.orbLow = null;
    this.orbLocked = false;
    this.orbBackfillInFlight = false;
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
    this.account = null; // "default" role — everything except Strategy A
    this.openPositions = [];
    this.accountA = null; // Strategy A's own (practice) account
    this.openPositionsA = [];
    this.accountAsOf = null;
    this.trackedTrades = []; // locally-tracked open trades, for MFE/MAE + closure detection
  }

  async resolveAccountIdForRole(role) {
    return topstepx.resolveAccountId(role === "A" ? CONFIG.strategyA.accountNameHint : undefined);
  }

  // Polls both accounts independently — a failure resolving/fetching one
  // (e.g. STRATEGY_A_ACCOUNT_NAME misconfigured) must never block the other,
  // since Strategy B's real-account trading has to keep working regardless of
  // Strategy A's practice-account health.
  async pollAccount() {
    await Promise.all([this.pollAccountForRole("default"), this.pollAccountForRole("A")]);
    this.accountAsOf = new Date();
    await this.detectClosedTrades();
    await this.reconcileUntrackedPositions();
  }

  async pollAccountForRole(role) {
    try {
      const accountId = await this.resolveAccountIdForRole(role);
      const { account, positions } = await topstepx.fetchAccountSnapshot(accountId);
      if (role === "A") {
        this.accountA = account;
        this.openPositionsA = positions;
      } else {
        this.account = account;
        this.openPositions = positions;
      }
    } catch (e) {
      console.error(`pollAccountForRole(${role}) failed:`, e.message);
    }
  }

  // trackedTrades only ever exists in this process's memory, built up as
  // executeSignal places real orders — a worker restart wipes it even though
  // the broker-side position is still there (caught live 2026-07-24 in the
  // same incident as closeOnDirectionFlip below: a restart right after a real
  // fill would make that fix blind to the position it most needs to protect,
  // reproducing the hedging risk via a different path). Best-effort: entry
  // price and direction come straight from the broker, but stop/target and
  // any MFE/MAE accrued before the restart can't be recovered, so those start
  // over from this reconciliation point.
  async reconcileUntrackedPositions() {
    await this.reconcileUntrackedPositionsForRole("default", this.openPositions);
    await this.reconcileUntrackedPositionsForRole("A", this.openPositionsA);
  }

  // Scoped to trackedTrades from the SAME role before checking for untracked
  // positions — both accounts trade the same MES contract, so matching by
  // contractId alone across the whole (unscoped) trackedTrades list could
  // treat Strategy A's practice position as "already tracked" because of an
  // unrelated Strategy B trade on the real account sharing that contractId,
  // or vice versa.
  async reconcileUntrackedPositionsForRole(role, openPositions) {
    const roleTrackedTrades = this.trackedTrades.filter((t) => t.accountRole === role);
    for (const pos of untrackedPositions(openPositions, roleTrackedTrades)) {
      const trade = {
        strategy: "reconciled",
        accountRole: role,
        direction: POSITION_TYPE_TO_DIRECTION[pos.type],
        entryPrice: pos.averagePrice,
        stopPrice: null,
        originalStopPrice: null,
        targetPrice: null,
        originalTargetPrice: null,
        brokenLevel: null,
        entryIndex: null, // unknown — evaluateOpenTrades skips dynamic management for reconciled trades
        lastRegimeBase: null,
        movedToBreakeven: true, // no known stop to move; don't attempt it
        actionInFlight: false,
        contractId: pos.contractId,
        size: pos.size,
        orderId: null,
        mfe: 0,
        mae: 0,
        openedAt: new Date().toISOString(),
        mongoId: null,
      };
      try {
        trade.mongoId = await tradeJournal.openTrade(trade, nowET().toDateString());
      } catch (e) {
        console.error("Mongo openTrade (reconciled) failed:", e.message);
      }
      this.trackedTrades.push(trade);
      this.notifyManualTradeDetected(trade);
    }
  }

  // Flags a manually-placed trade (opened directly on the TopstepX platform,
  // outside this bot's own code) as soon as the next poll picks it up —
  // requested live 2026-07-28 after the user manually opened a trade to make
  // back that morning's bug-caused losses: wants visibility into manual
  // activity in Discord while the bot is still being smoothed out, without
  // the bot trying to stop it.
  notifyManualTradeDetected(trade) {
    postDiscordEmbed(
      CONFIG.discord.signalWebhook,
      buildSignalEmbed({
        title: `✋ Manual trade detected — GEX Breakout (${trade.accountRole === "A" ? "practice" : "real"})`,
        description: `${trade.direction === "long" ? "LONG" : "SHORT"} ${trade.size}x @ ${trade.entryPrice} — opened outside the bot, now tracked for MFE/MAE and EOD flatten`,
        color: 0xf5c842,
        fields: [
          ["Direction", trade.direction],
          ["Size", trade.size],
          ["Entry", trade.entryPrice],
        ],
        footerText: `GEX Breakout · manual trade · ${new Date().toISOString()}`,
      })
    ).catch((e) => console.error("Discord post failed:", e.message));
  }

  // The broker no longer reporting a position for a contract we're tracking means
  // it closed (stop or target filled) — there's no other live signal for this given
  // we're polling REST rather than trusting the unverified user-hub push stream.
  // Exit price is approximated as the last known bar close (detection lag up to the
  // 5s poll interval) — good enough for MFE/MAE, not exact realized P&L.
  async detectClosedTrades() {
    const stillOpenByRole = {
      default: new Set(this.openPositions.map((p) => p.contractId)),
      A: new Set(this.openPositionsA.map((p) => p.contractId)),
    };
    const remaining = [];
    for (const trade of this.trackedTrades) {
      if (stillOpenByRole[trade.accountRole ?? "default"].has(trade.contractId)) {
        remaining.push(trade);
      } else {
        const outcome = await this.classifyPassiveClose(trade);
        this.logClosedTrade(trade, outcome);
      }
    }
    this.trackedTrades = remaining;
  }

  // A genuine bracket fill (stop or target) triggers TopstepX's own OCO
  // logic, which auto-cancels the sibling leg the instant one side fills —
  // so after a real fill, nothing should be left resting on that contract.
  // If the position disappeared but its bracket orders are STILL open, that
  // means neither leg actually filled — something OUTSIDE this bot's own
  // code closed the position (a manual close via the TopstepX platform UI,
  // confirmed live 2026-07-27: user closed a trade $260 up, a few ticks
  // short of target, specifically wanting manual intervention tracked
  // separately from bracket-driven closes so its effect can be judged later).
  // Every code path THIS bot uses to close a position on purpose
  // (closeOnDirectionFlip, flatten, actOnExitResult's EXIT_NOW/reopenAt)
  // already calls closePositionAndCancelOrders itself, so a leftover bracket
  // here can't be this bot's own doing — cancel it as cleanup either way.
  // client defaults to the real topstepx module; tests pass a fake so this can
  // be verified without a live account (this file's namespace import can't be
  // monkey-patched from outside — ESM namespace objects are read-only).
  async classifyPassiveClose(trade, client = topstepx) {
    try {
      const role = trade.accountRole ?? "default";
      const accountId = await client.resolveAccountId(role === "A" ? CONFIG.strategyA.accountNameHint : undefined);
      const openOrders = await client.searchOpenOrders(accountId);
      const orphaned = openOrders.filter((o) => o.contractId === trade.contractId);
      if (orphaned.length === 0) return "closed"; // real bracket fill, nothing left to explain
      await Promise.all(orphaned.map((o) => client.cancelOrder(accountId, o.id))).catch((e) =>
        console.error("Failed to cancel orphaned bracket order after a manual close:", e.message)
      );
      return "manual_close";
    } catch (e) {
      console.error("classifyPassiveClose order check failed:", e.message);
      return "closed"; // fail safe to the existing generic label rather than block the close
    }
  }

  logClosedTrade(trade, outcome = "closed") {
    const lastBar = this.bars.length ? this.bars[this.bars.length - 1] : null;
    const approxExitPrice = lastBar?.close ?? null;
    const row = buildLogRow({
      ts: new Date().toISOString(),
      strategy: trade.strategy,
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      stopPrice: trade.stopPrice,
      targetPrice: trade.targetPrice,
      outcome,
      mfe: trade.mfe,
      mae: trade.mae,
    });
    const realizedPnl =
      approxExitPrice != null
        ? computeRealizedPnl(trade.entryPrice, approxExitPrice, trade.direction, POINT_VALUE[CONFIG.instrumentTrade], trade.size)
        : null;
    row.approx_exit_price = approxExitPrice; // not part of the base schema, tacked on for this analysis
    row.realized_pnl = realizedPnl;
    this.logger.log(row);
    tradeJournal.logSignal(row, nowET().toDateString()).catch((e) => console.error("Mongo log failed:", e.message));

    // Feeds the per-strategy win/loss halt (config.maxLossesPerStrategyPerDay,
    // plus the one-winner-and-done rule) — this was never wired to any real
    // trade closure before, so the old bot-wide consecutive-loss counter
    // stayed at 0 forever and the kill switch could never trip no matter how
    // many real losses happened (caught live 2026-07-24: the dashboard's
    // counter was still 0 right after a real losing trade closed).
    // approxExitPrice carries the same detection-lag imprecision noted above,
    // so this is a win/loss determination, not an exact realized PnL figure.
    if (approxExitPrice != null) {
      const approxPnlPts =
        trade.direction === "long" ? approxExitPrice - trade.entryPrice : trade.entryPrice - approxExitPrice;
      this.riskManager.recordTradeResult(trade.strategy, approxPnlPts);
    }

    tradeJournal
      .closeTrade(trade.mongoId, {
        closedAt: new Date().toISOString(),
        exitPrice: approxExitPrice,
        outcome,
        mfe: trade.mfe,
        mae: trade.mae,
        realizedPnl,
      })
      .catch((e) => console.error("Mongo closeTrade failed:", e.message));

    if (outcome === "manual_close") {
      this.notifyManualClose(trade, approxExitPrice, realizedPnl);
    }
  }

  // Flags a manual close (detected via classifyPassiveClose: the position
  // disappeared but its bracket orders were still resting, so something
  // outside this bot's own code closed it) — same request/reasoning as
  // notifyManualTradeDetected above, so intervention is visible in Discord
  // in real time, not just in the daily summary's manualCloses breakdown.
  notifyManualClose(trade, exitPrice, realizedPnl) {
    const pnlText = realizedPnl != null ? `${realizedPnl >= 0 ? "+" : "-"}$${Math.abs(realizedPnl).toFixed(2)}` : "—";
    postDiscordEmbed(
      CONFIG.discord.signalWebhook,
      buildSignalEmbed({
        title: `✋ Manual close detected — GEX Breakout · Strategy ${trade.strategy}`,
        description: `Closed outside the bot's own bracket orders — approx exit ${exitPrice ?? "—"}, ${pnlText}`,
        color: 0xf5c842,
        fields: [
          ["Direction", trade.direction],
          ["Entry", trade.entryPrice],
          ["Size", trade.size],
        ],
        footerText: `GEX Breakout · manual close · ${new Date().toISOString()}`,
      })
    ).catch((e) => console.error("Discord post failed:", e.message));
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

  // Only ever populated by live streamed bars during the window (see onBar) —
  // a worker that starts or restarts after today's window has already closed
  // has no memory of it and would otherwise never lock an ORB for the rest of
  // the day. That matters beyond Strategy A: onBar gates Strategy B behind
  // orbLocked too even though B doesn't itself need the ORB. No-ops (and
  // stays retriable) until the window has actually ended; self-resolves once
  // it does, without needing a permanent "already tried" flag.
  async backfillOrbIfPastWindow(t) {
    const bounds = orbWindowBounds(CONFIG);
    if (minutesOf(t) < bounds.endMin) return;
    const bars = await topstepx.fetchRecentBars(CONFIG.instrumentData, 720);
    const range = computeOrbFromHistoricalBars(bars, t.toDateString(), bounds);
    if (!range) return;
    this.orbHigh = range.high;
    this.orbLow = range.low;
    this.orbLocked = true;
    this.rebuildLevels();
  }

  // Nothing previously reset orbHigh/orbLow/orbLocked/pendingA/pendingB/
  // riskManager's day-state (win/loss halts, ORB-traded directions, level
  // cooldowns) at a new day — once locked, orbLocked stayed true forever, so
  // a worker that started late one day (backfilling that day's already-
  // completed ORB) would carry orbLocked=true straight through the night,
  // letting evaluateSignals run on pre-market bars the next calendar day
  // using yesterday's stale ORB range (confirmed live 2026-07-28: two real
  // Strategy B trades fired around 04:06/04:38 UTC, hours before the real
  // 9:30 ET session open, on an account that hadn't restarted since before
  // midnight). SessionRiskManager.resetDay() already existed for exactly
  // this but was never actually called anywhere after construction.
  checkDayRollover(t) {
    const dayKey = t.toDateString();
    if (this.currentDay === dayKey) return;
    this.currentDay = dayKey;
    this.orbHigh = null;
    this.orbLow = null;
    this.orbLocked = false;
    this.orbBackfillInFlight = false;
    this.pendingA = null;
    this.pendingB = null;
    this.riskManager.resetDay();
  }

  onBar(rawBar, t = nowET()) {
    this.checkDayRollover(t);
    const prevCum = this.bars.length ? this.bars[this.bars.length - 1].cumDelta : 0;
    const delta = rawBar.buyVolume - rawBar.sellVolume;
    const bar = { ...rawBar, delta, cumDelta: prevCum + delta };
    this.bars.push(bar);

    for (const trade of this.trackedTrades) {
      Object.assign(trade, updateMfeMae(trade, trade.entryPrice, trade.direction, bar));
    }

    // Managing an already-open position runs independently of whether new
    // entries are currently allowed (trading cutoff, risk halt, etc.) — an
    // early-exit or a tighter stop should still fire during a halt, if
    // anything especially then. trackedTrades is only ever populated when
    // CONFIG.executionEnabled is true (see executeSignal), so this is a
    // no-op in signal-only mode without needing its own separate gate.
    this.evaluateOpenTrades(bar);

    if (isWithinOrbWindow(t, orbWindowBounds(CONFIG))) {
      Object.assign(this, updateOrbRange(this, bar));
      return;
    }
    if (!this.orbLocked && this.orbHigh != null) {
      this.orbLocked = true;
      this.rebuildLevels();
    }
    if (!this.orbLocked && !this.orbBackfillInFlight) {
      this.orbBackfillInFlight = true;
      this.backfillOrbIfPastWindow(t)
        .catch((e) => console.error("ORB backfill failed:", e.message))
        .finally(() => {
          this.orbBackfillInFlight = false;
        });
    }
    if (!this.orbLocked) return;

    // Matches mechanical-orb's window: no new entries past entryCutoffET, and
    // any position still open past flattenAtET gets force-closed rather than
    // left to ride its bracket to stop/target/session end.
    if (shouldFlattenNow(t, CONFIG) && this.trackedTrades.length) {
      this.flattenAll().catch((e) => console.error("EOD flatten failed:", e.message));
      return;
    }

    this.evaluateSignals(bar, t);
  }

  // Closes every open trade at once (Strategy A and B can legitimately be
  // open concurrently) — dedupes by (accountRole, contractId) since a shared
  // contract only ever has one real net position PER ACCOUNT at the broker
  // (see closeOnDirectionFlip); calling closePositionAndCancelOrders twice
  // for the same already-closed account+contract would just be a
  // wasted/erroring call. Strategy A (practice) and everything else (real
  // Combine) are different accounts now, so contractId alone isn't unique.
  async flattenAll() {
    const roles = [...new Set(this.trackedTrades.map((t) => t.accountRole ?? "default"))];
    for (const role of roles) {
      const accountId = await this.resolveAccountIdForRole(role);
      const contractIds = [
        ...new Set(
          this.trackedTrades.filter((t) => (t.accountRole ?? "default") === role).map((t) => t.contractId)
        ),
      ];
      for (const contractId of contractIds) {
        await topstepx.closePositionAndCancelOrders(accountId, contractId);
      }
    }
    for (const trade of this.trackedTrades) {
      this.logClosedTrade(trade, "eod_flatten");
    }
    this.trackedTrades = [];
  }

  evaluateSignals(bar, t) {
    if (minutesOf(t) >= CONFIG.entryCutoffET.h * 60 + CONFIG.entryCutoffET.m) return;

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
    if (!this.riskManager.canTrade("A")) return;

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
    if (!this.riskManager.canTrade("B")) return;

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
    // Strategy A (practice account) and everything else (real Combine, shared
    // with Mechanical ORB and Gap Continuation) are on different accounts now
    // — each checks only ITS OWN account's real position state (refreshed
    // every poll), not just this bot's own local view, so this still catches
    // a position opened by another bot on the real account, without Strategy
    // A's practice-account activity ever blocking (or being blocked by) it.
    const role = accountRoleFor(result.strategy);
    const relevantPositions = role === "A" ? this.openPositionsA : this.openPositions;
    const vetoReason = relevantPositions.length > 0 ? "position_already_open" : result.veto;

    const row = buildLogRow({
      ts: new Date().toISOString(),
      strategy: result.strategy,
      direction: result.direction,
      level: result.level ?? null,
      regime: regimeInfo?.regime ?? null,
      netGex: this.gexSnapshot?.netGex ?? null,
      flipPoint: this.levelState.flipPointEs,
      flowGrade: flow.grade,
      vetoReason,
      entryPrice: result.entryPrice ?? null,
      stopPrice: result.stopPrice ?? null,
      targetPrice: result.targetPrice ?? null,
    });
    this.logger.log(row);
    tradeJournal.logSignal(row, nowET().toDateString()).catch((e) => console.error("Mongo log failed:", e.message));

    if (vetoReason) return; // vetoes are logged only, no alert noise

    // Ladder only applies to Strategy B (the real Combine, whose actual
    // starting balance is known and calibrated — see config.js's
    // sizing.ladder.startingEquity comment). Strategy A's practice account
    // balance is arbitrary and not calibrated against this ladder, so it
    // stays flat (ratio 1x, i.e. just its own base x wall multiplier) rather
    // than risk the exact same class of oversizing bug against an unverified
    // number.
    let ratio = 1;
    if (role === "default") {
      const equity = this.account?.balance ?? CONFIG.risk.sizing.ladder.startingEquity;
      ratio = ladderRatio(equity, CONFIG.risk.sizing.ladder);
    }
    const size = computeSizeMultiplier(flow.grade, result.sizeMultiplier, CONFIG.risk.sizing) * ratio;
    this.executeSignal(result, regimeInfo, flow, size).catch((e) =>
      console.error("Signal execution failed:", e.message)
    );
  }

  markTraded(result) {
    if (result.strategy === "A") this.riskManager.recordOrbTrade(result.direction);
    else if (result.strategy === "B") this.riskManager.recordStrategyBTrade(result.levelKey, Date.now());
  }

  // Dynamic in-trade management: evaluateExit's four conditions
  // (failed-breakout, delta-divergence, absorption, regime-flip) plus
  // breakeven-at-1R, run against every open trade each bar. One action per
  // trade per bar (actionInFlight guards against a slow-resolving broker
  // call overlapping with the next bar's evaluation of the same trade).
  // Trades from reconcileUntrackedPositions (entryIndex/brokenLevel unknown)
  // are skipped — there isn't enough context to evaluate them safely.
  evaluateOpenTrades(bar) {
    const currentIndex = this.bars.length - 1;
    for (const trade of [...this.trackedTrades]) {
      if (trade.actionInFlight) continue;
      if (trade.entryIndex == null || currentIndex <= trade.entryIndex) continue;

      if (
        !trade.movedToBreakeven &&
        trade.stopPrice != null &&
        trade.originalStopPrice != null &&
        trade.mfe >= Math.abs(trade.entryPrice - trade.originalStopPrice) * CONFIG.strategyA.breakevenAtR
      ) {
        trade.movedToBreakeven = true;
        trade.actionInFlight = true;
        this.moveStop(trade, trade.entryPrice, bar.close, "breakeven_at_1r")
          .catch((e) => console.error("Breakeven move failed:", e.message))
          .finally(() => {
            trade.actionInFlight = false;
          });
        continue;
      }

      if (trade.brokenLevel == null) continue;

      const currentRegimeBase = this.lastRegimeInfo?.baseRegime ?? null;
      const absorption = buildAbsorptionWindow(this.bars, currentIndex, CONFIG.orderFlow.absorption);
      const result = evaluateExit({
        direction: trade.direction,
        currentBar: bar,
        brokenLevel: trade.brokenLevel,
        entryIndex: trade.entryIndex,
        currentIndex,
        bars: this.bars,
        inOpenSpace: isInOpenSpace(bar.close, trade.direction, this.levelState.wallsEs, CONFIG.levels.wallFilter),
        prevRegimeBase: trade.lastRegimeBase,
        currentRegimeBase,
        touchWindow: absorption?.touchWindow ?? null,
        priorBars: absorption?.priorBars ?? [],
        levelPriceForAbsorption: trade.targetPrice,
        config: CONFIG,
      });
      trade.lastRegimeBase = currentRegimeBase;
      if (result.action === "HOLD") continue;

      trade.actionInFlight = true;
      this.actOnExitResult(trade, result, bar)
        .catch((e) => console.error("Dynamic exit action failed:", e.message))
        .finally(() => {
          trade.actionInFlight = false;
        });
    }
  }

  async actOnExitResult(trade, result, bar) {
    if (result.action === "EXIT_NOW") {
      const pointValue = POINT_VALUE[CONFIG.instrumentTrade];
      const valueSaved = computeExitNowValueSaved(bar.close, trade.originalStopPrice, pointValue, trade.size);
      const accountId = await this.resolveAccountIdForRole(trade.accountRole ?? "default");
      await topstepx.closePositionAndCancelOrders(accountId, trade.contractId);
      this.trackedTrades = this.trackedTrades.filter((t) => t !== trade);
      this.logClosedTrade(trade, result.reason);
      this.logDynamicExitAction(trade, "EXIT_NOW", result.reason, valueSaved, {
        exitPrice: bar.close,
        originalStopPrice: trade.originalStopPrice,
      });
      return;
    }

    if (result.action === "TIGHTEN_TRAIL") {
      const trailBars = result.trailBars ?? 1;
      const window = this.bars.slice(Math.max(0, this.bars.length - trailBars));
      const newStopPrice =
        trade.direction === "long" ? Math.min(...window.map((b) => b.low)) : Math.max(...window.map((b) => b.high));
      const tighter = trade.direction === "long" ? newStopPrice > trade.stopPrice : newStopPrice < trade.stopPrice;
      if (!tighter) return; // never loosens the stop
      await this.moveStop(trade, newStopPrice, bar.close, result.reason);
      return;
    }

    if (result.action === "TAKE_PARTIAL") {
      const fraction = CONFIG.strategyA.runner.offFractionAtTarget;
      const reduceSize = Math.round(trade.size * fraction);
      const remainingSize = trade.size - reduceSize;
      if (reduceSize <= 0 || remainingSize <= 0) return; // nothing sensible to reduce
      const pointValue = POINT_VALUE[CONFIG.instrumentTrade];
      const tickSize = topstepx.tickSizeFor(CONFIG.instrumentTrade);
      const clampedStopPrice = clampStopDistance(trade.stopPrice, bar.close, trade.direction, topstepx.MIN_STOP_TICKS * tickSize);
      const valueGained = computeTakePartialValueGained(trade.entryPrice, bar.close, trade.direction, pointValue, reduceSize);
      await this.reopenAt(trade, remainingSize, clampedStopPrice, bar.close);
      trade.stopPrice = clampedStopPrice;
      trade.size = remainingSize;
      this.logDynamicExitAction(trade, "TAKE_PARTIAL", result.reason, valueGained, {
        reduceSize,
        remainingSize,
        atPrice: bar.close,
      });
    }
  }

  // Closes the whole position and re-opens it at newSize/newStopPrice with
  // the same target, built entirely from closePositionAndCancelOrders and
  // placeBracketOrder (both already live-verified) rather than a new
  // "modify a resting order" or "attach a bracket to an existing position"
  // capability — there's no evidence anywhere in this adapter that either
  // exists on this broker, and guessing at one live, in the automatic loop,
  // isn't worth the risk. Ticks for the new bracket are computed relative to
  // currentPrice (where the re-entry market order will actually fill), not
  // the original entry, since this genuinely is a new order.
  async reopenAt(trade, newSize, newStopPrice, currentPrice) {
    const accountId = await this.resolveAccountIdForRole(trade.accountRole ?? "default");
    await topstepx.closePositionAndCancelOrders(accountId, trade.contractId);
    const orderId = await topstepx.placeBracketOrder({
      accountId,
      contractId: trade.contractId,
      direction: trade.direction,
      size: newSize,
      entryPrice: currentPrice,
      stopPrice: newStopPrice,
      targetPrice: trade.targetPrice,
      tickSize: topstepx.tickSizeFor(CONFIG.instrumentTrade),
      customTag: `gex-${trade.strategy}-${trade.direction}-reopen-${Date.now()}`,
    });
    trade.orderId = orderId;
    return orderId;
  }

  async moveStop(trade, newStopPrice, currentPrice, reason) {
    const pointValue = POINT_VALUE[CONFIG.instrumentTrade];
    const tickSize = topstepx.tickSizeFor(CONFIG.instrumentTrade);
    const clampedStopPrice = clampStopDistance(newStopPrice, currentPrice, trade.direction, topstepx.MIN_STOP_TICKS * tickSize);
    const oldStopPrice = trade.stopPrice;
    await this.reopenAt(trade, trade.size, clampedStopPrice, currentPrice);
    trade.stopPrice = clampedStopPrice;
    const valueSaved = computeTightenTrailValueSaved(oldStopPrice, clampedStopPrice, pointValue, trade.size);
    this.logDynamicExitAction(trade, reason === "breakeven_at_1r" ? "BREAKEVEN" : "TIGHTEN_TRAIL", reason, valueSaved, {
      oldStopPrice,
      newStopPrice: clampedStopPrice,
    });
  }

  // Records an in-trade management action both for the real-time Discord ping
  // (reasoning fields, same pattern as buildTradeTakenEmbed) and durably in
  // Mongo (exitActions collection) so it shows up in the trade journal and
  // daily summary — closeTrade/logClosedTrade only ever capture a trade's
  // full close, so without this, TIGHTEN_TRAIL/TAKE_PARTIAL/breakeven would
  // leave no queryable record of why a stop moved or what it was worth.
  logDynamicExitAction(trade, action, reason, valueImpact, extra) {
    const dayKey = nowET().toDateString();
    tradeJournal
      .logExitAction(
        {
          tradeMongoId: trade.mongoId,
          system: "gex-breakout",
          strategy: trade.strategy,
          direction: trade.direction,
          action,
          reason,
          valueImpact,
          size: trade.size,
          ...extra,
        },
        dayKey
      )
      .catch((e) => console.error("Mongo logExitAction failed:", e.message));

    const description =
      action === "EXIT_NOW"
        ? `Exited early — $${valueImpact.toFixed(2)} of stop risk removed`
        : action === "TAKE_PARTIAL"
          ? `Took partial (${extra.reduceSize} of ${extra.reduceSize + extra.remainingSize}) — $${valueImpact.toFixed(2)} locked in, ${extra.remainingSize} still running`
          : `Stop moved ${extra.oldStopPrice.toFixed(2)} → ${extra.newStopPrice.toFixed(2)} — $${valueImpact.toFixed(2)} of risk reduced`;

    postDiscordEmbed(
      CONFIG.discord.signalWebhook,
      buildSignalEmbed({
        title: `⚙️ Dynamic exit — GEX Breakout · Strategy ${trade.strategy} (${reason})`,
        description,
        color: 0xf39c12,
        fields: [
          ["Direction", trade.direction],
          ["Size", trade.size],
        ],
        footerText: `GEX Breakout · dynamic management · ${new Date().toISOString()}`,
      })
    ).catch((e) => console.error("Discord post failed:", e.message));
  }

  // Never hold opposite-direction exposure on the same contract at once —
  // hedging isn't allowed on this account. Strategy A and B can legitimately
  // both be long (or both short) at once, that's untouched; but a live SHORT
  // immediately followed by an opposite LONG signal used to just fire a
  // second bracket order on top of the first. The two market legs net flat
  // at the broker, but each trade's own stop/target bracket doesn't cancel
  // just because a *different* order zeroed the net position — both stayed
  // resting, and one filled on its own a minute later, leaving a naked,
  // untracked position with no stop or target (caught live 2026-07-24,
  // manually flattened).
  // Scoped to trackedTrades from the SAME account role as the incoming
  // signal — Strategy A (practice) and everything else (real Combine) are on
  // different accounts entirely now, so a direction flip on one account must
  // never touch a same-contract position that's actually sitting on the
  // other account.
  async closeOnDirectionFlip(accountId, contractId, newDirection, accountRole) {
    const roleTrackedTrades = this.trackedTrades.filter((t) => (t.accountRole ?? "default") === accountRole);
    const toClose = tradesRequiringCloseOnFlip(roleTrackedTrades, contractId, newDirection);
    if (!toClose.length) return;
    await topstepx.closePositionAndCancelOrders(accountId, contractId);
    for (const trade of toClose) this.logClosedTrade(trade);
    const toCloseSet = new Set(toClose);
    this.trackedTrades = this.trackedTrades.filter((t) => !toCloseSet.has(t));
  }

  // entryPrice on a freshly-opened trade is the strategy's theoretical trigger-bar
  // close (see strategyA/strategyB's `entryPrice = price`) — the entry itself is a
  // MARKET order, so TopstepX's Order/place response never confirms what it actually
  // filled at, only an orderId. In a fast-moving breakout this can diverge from the
  // real fill by more than a few ticks (confirmed live 2026-07-27: a real Strategy B
  // short filled 15 ticks/~$75-of-underlying better than its trigger price, which had
  // been overstating that trade's tracked $ P&L by $90 — reconciled trades, which
  // already use the broker's own averagePrice via reconcileUntrackedPositions, didn't
  // have this problem, which is what exposed the gap). Once the real position shows
  // up with the broker's own averagePrice, correct entry/stop/target to it — client
  // defaults to the real topstepx module; tests inject a fake, same pattern as
  // classifyPassiveClose.
  async confirmRealEntryPrice(trade, accountId, contractId, client = topstepx, attempts = 5, delayMs = 400) {
    for (let i = 0; i < attempts; i++) {
      let positions;
      try {
        positions = await client.searchOpenPositions(accountId);
      } catch (e) {
        console.error("confirmRealEntryPrice position lookup failed:", e.message);
        return;
      }
      const pos = positions.find((p) => p.contractId === contractId);
      if (pos?.averagePrice != null) {
        // Preserve the same point distance from entry to stop/target rather than
        // resending anything to the broker — TopstepX's bracket was already placed
        // as tick OFFSETS from the theoretical entry, and standard bracket-order
        // behavior resolves those ticks against the real fill, so this recovers
        // what the broker's own absolute stop/target already are, not a new value.
        const stopOffset = trade.stopPrice - trade.entryPrice;
        const targetOffset = trade.targetPrice - trade.entryPrice;
        trade.entryPrice = pos.averagePrice;
        trade.stopPrice = pos.averagePrice + stopOffset;
        trade.originalStopPrice = trade.stopPrice;
        trade.targetPrice = pos.averagePrice + targetOffset;
        trade.originalTargetPrice = trade.targetPrice;
        if (trade.mongoId) {
          tradeJournal
            .correctEntryPrice(trade.mongoId, {
              entryPrice: trade.entryPrice,
              stopPrice: trade.stopPrice,
              originalStopPrice: trade.originalStopPrice,
              targetPrice: trade.targetPrice,
              originalTargetPrice: trade.originalTargetPrice,
            })
            .catch((e) => console.error("Mongo correctEntryPrice failed:", e.message));
        }
        return;
      }
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    console.error(`confirmRealEntryPrice: no fill confirmed for ${contractId} after ${attempts} attempts, keeping theoretical entry`);
  }

  async executeSignal(result, regimeInfo, flow, size) {
    let orderId = null;

    if (isLiveExecutionAllowed(result.strategy, CONFIG)) {
      const accountRole = accountRoleFor(result.strategy);
      const accountId = await this.resolveAccountIdForRole(accountRole);
      const contractId = await topstepx.resolveFrontMonthContractId(CONFIG.instrumentTrade);
      await this.closeOnDirectionFlip(accountId, contractId, result.direction, accountRole);
      // Throws on a broker rejection (bad size/ticks/etc) — nothing below runs,
      // so a rejected order leaves trackedTrades/day-state untouched and a
      // legitimate retry later today isn't permanently blocked.
      orderId = await topstepx.placeBracketOrder({
        accountId,
        contractId,
        direction: result.direction,
        size,
        entryPrice: result.entryPrice,
        stopPrice: result.stopPrice,
        targetPrice: result.targetPrice,
        tickSize: topstepx.tickSizeFor(CONFIG.instrumentTrade),
        customTag: `gex-${result.strategy}-${result.direction}-${Date.now()}`,
      });
      // Tracked only once there's a real position to eventually detect the close
      // of — MFE/MAE and closure detection both depend on polling a real broker
      // position, which doesn't exist in signal-only mode.
      const trade = {
        strategy: result.strategy,
        accountRole,
        direction: result.direction,
        entryPrice: result.entryPrice,
        stopPrice: result.stopPrice,
        originalStopPrice: result.stopPrice,
        targetPrice: result.targetPrice,
        originalTargetPrice: result.targetPrice,
        brokenLevel: result.breakoutLevel ?? result.level?.price ?? null,
        entryIndex: this.bars.length - 1,
        lastRegimeBase: this.lastRegimeInfo?.baseRegime ?? null,
        movedToBreakeven: false,
        actionInFlight: false,
        contractId,
        size,
        orderId,
        mfe: 0,
        mae: 0,
        openedAt: new Date().toISOString(),
        mongoId: null,
      };
      // A Mongo hiccup must never block tracking a real fill — best-effort,
      // trade stays tracked (and MFE/MAE/closure detection keep working)
      // with mongoId left null if this fails.
      try {
        trade.mongoId = await tradeJournal.openTrade(trade, nowET().toDateString());
      } catch (e) {
        console.error("Mongo openTrade failed:", e.message);
      }
      // Pushed before the fill-price confirmation below starts, not after —
      // otherwise the next account poll's reconcileUntrackedPositions would see
      // this same real position with nothing in trackedTrades yet and adopt it
      // a second time as "reconciled", duplicating this trade.
      this.trackedTrades.push(trade);
      this.confirmRealEntryPrice(trade, accountId, contractId).catch((e) =>
        console.error("confirmRealEntryPrice failed:", e.message)
      );
    } else {
      console.log(
        `[EXECUTION-DISABLED] would place ${result.direction} ${size}x Strategy ${result.strategy} @ ${result.entryPrice}`
      );
    }

    // Set here, right after order confirmation (or signal-only mode) and before
    // the Discord post below, so a Discord hiccup can't leave a real fill's
    // day-state untracked (one ORB direction per day / per-level cooldown).
    this.markTraded(result);

    const embed = buildTradeTakenEmbed({
      system: "GEX Breakout",
      strategy: result.strategy,
      direction: result.direction,
      size,
      entryPrice: result.entryPrice,
      stopPrice: result.stopPrice,
      targetPrice: result.targetPrice,
      reasonFields: [
        ["Regime", regimeInfo.regime],
        ["Flow grade", flow.grade],
        ["Target mode", result.targetMode],
        ["Mode", isLiveExecutionAllowed(result.strategy, CONFIG) ? `LIVE (${accountRoleFor(result.strategy)})` : "SIGNAL-ONLY"],
      ],
      orderId,
    });
    await postDiscordEmbed(CONFIG.discord.signalWebhook, embed);
  }
}

export function createWorker() {
  return new Worker();
}

// On a fresh dyno boot, the very first WebSocket handshake to TopstepX's
// SignalR market-data hub sometimes fails (FailedToStartTransportError) —
// looks like a brief networking-readiness race right at container startup.
// subscribeBars' own .withAutomaticReconnect() only covers reconnecting
// AFTER a previously-successful connection drops, not this initial handshake
// — an unretried failure here was an unhandled rejection that crashed the
// whole process, with Heroku's own crash-restart acting as the de facto
// (and much slower) retry mechanism (confirmed live 2026-07-28). Same fix as
// gap-continuation's subscribeBarsWithRetry — linear backoff, no attempt
// cap, since without market data this bot can't do anything anyway.
async function subscribeBarsWithRetry(worker, attempt = 1) {
  try {
    await topstepx.subscribeBars(CONFIG.instrumentData, (bar) => worker.onBar(bar));
  } catch (e) {
    const waitMs = Math.min(5000 * attempt, 60000);
    console.error(`subscribeBars failed (attempt ${attempt}): ${e.message} — retrying in ${waitMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return subscribeBarsWithRetry(worker, attempt + 1);
  }
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
  worker.pollAccount().catch((e) => console.error("Initial account poll failed:", e.message));

  setInterval(
    () => worker.recalcGex().catch((e) => console.error("GEX recalc failed:", e.message)),
    CONFIG.gexRecalcMin * 60_000
  );
  setInterval(
    () => worker.recalcBasis().catch((e) => console.error("Basis recalc failed:", e.message)),
    CONFIG.basisRecalcMin * 60_000
  );
  setInterval(
    () => worker.pollAccount().catch((e) => console.error("Account poll failed:", e.message)),
    5000
  );
  await subscribeBarsWithRetry(worker);

  // Reads "already flushed today" from Mongo rather than an in-memory flag —
  // a restart used to reset that flag to null and, if the restart happened
  // after logFlushET, immediately re-flush for a day already flushed before
  // the restart. Durable state fixes it regardless of how many times the
  // process restarts. This also replaces the old SIGTERM handler, which used
  // to flush the in-memory buffer to Discord on every restart/deploy as a
  // data-loss safety net — every event is now written to Mongo as it
  // happens, so that safety net (and the scattered Discord dumps it caused
  // on every deploy) isn't needed anymore.
  setInterval(() => {
    const dayKey = shouldFlushLogNow(nowET(), CONFIG.logFlushET);
    if (!dayKey) return;
    tradeJournal
      .isDayFlushed(dayKey)
      .then(async (alreadyFlushed) => {
        if (alreadyFlushed) return;
        await tradeJournal.markDayFlushed(dayKey);

        const [rows, trades, exitActions] = await Promise.all([
          tradeJournal.fetchDayRows(dayKey),
          tradeJournal.fetchDayTrades(dayKey),
          tradeJournal.fetchDayExitActions(dayKey),
        ]);
        const summary = computeDailySummary(trades, exitActions, rows);
        await tradeJournal.writeDailySummary(dayKey, summary);
        await postDiscordEmbed(CONFIG.discord.logWebhook, buildDailySummaryEmbed(summary, dayKey));
        await flushLogBufferToDiscord(CONFIG.discord.logWebhook, rows, dayKey, "scheduled");
      })
      .catch((e) => console.error("Scheduled log flush failed:", e.message));
  }, 60_000);
}

// Hand-rolled file:// construction doesn't match on Windows (drive-letter paths need
// a third slash: file:///C:/... not file://C:/...) — caught by an actual local run
// where the worker silently exited immediately instead of starting.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startWorker();
}
