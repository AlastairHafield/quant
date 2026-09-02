import { pathToFileURL } from "node:url";
import { CONFIG, POINT_VALUE } from "./config.js";
import { priorDayAdxOk } from "./adx.js";
import { classifyRegime } from "./regime.js";
import { buildOrderFlowWalls } from "./levelEngine.js";
import { buildAbsorptionWindow, describePathOfLeastResistance, describeLackOfParticipation } from "./orderFlow.js";
import { SessionRiskManager, computeSizeMultiplier } from "./riskSession.js";
import { evaluateOrderFlowExit, nearestZonePriceFor } from "./orderFlowExits.js";
import { evaluateOrderFlowBot } from "./orderFlowBot.js";
import { buildFootprintZones } from "./footprint.js";
import { buildSessionProfile, findPOC, computeValueArea } from "./volumeProfile.js";
import * as depthBook from "./depthBook.js";
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
import * as tradeJournal from "./tradeJournal.js";
import { isKillSwitchActive } from "../../shared/killSwitch.js";
import { computeDailyPnl, isDailyLossCapBreached } from "../../shared/accountRisk.js";
import { clampToMaxContracts } from "../../shared/protectedLimits.js";

export function toET(d) {
  return new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
}

export function nowET() {
  return toET(new Date());
}

export function minutesOf(t) {
  return t.getHours() * 60 + t.getMinutes();
}

// The Order Flow Bot ("OF") has its own independent go-live gate on top of
// the bot-wide executionEnabled/account switch — see config.js's
// orderFlowBot.executionEnabled comment. Every other strategy just follows
// the bot-wide flag, same precedent Strategy A (the strategy OF replaced) had.
export function isLiveExecutionAllowed(strategy, config) {
  if (!config.executionEnabled) return false;
  if (strategy === "OF") return config.orderFlowBot.executionEnabled;
  return true;
}

// The Order Flow Bot trades its own account (the practice account, same role
// Strategy A used before it) — everything else ("default") trades whatever
// TOPSTEPX_ACCOUNT_NAME points at (the real Combine). Only two roles exist
// today; this is the one place that decision is made, so every
// account-facing method below routes off it consistently instead of
// re-deriving "is this the practice strategy" locally.
export function accountRoleFor(strategy) {
  return strategy === "OF" ? "A" : "default";
}

export function shouldFlattenNow(t, config) {
  return minutesOf(t) >= config.flattenAtET.h * 60 + config.flattenAtET.m;
}

// Bars should arrive roughly every minute during the trading day — if none
// have for a while, the SignalR bar subscription may have gone "zombie"
// (technically still connected but no longer delivering data), which
// .withAutomaticReconnect() can't detect on its own since it only reacts to
// an actual disconnect event, not a lack of messages. Confirmed live
// 2026-07-29: bars silently stopped for over an hour while the separate
// REST-based account polling kept working fine, masking the failure — the
// bot wasn't evaluating anything that whole stretch, not just missing
// Strategy B's narrower trigger. Only checked during the trading day itself;
// a long quiet gap overnight/on weekends is normal, not a failure.
function isStreamStale(lastReceivedAt, now, config, thresholdMin) {
  const withinTradingDay =
    minutesOf(now) >= config.sessionOpenET.h * 60 + config.sessionOpenET.m &&
    minutesOf(now) < config.sessionEndET.h * 60 + config.sessionEndET.m;
  if (!withinTradingDay) return false;
  if (lastReceivedAt == null) return false; // never connected yet — the retry wrapper's own retry covers this
  const staleMs = now.getTime() - lastReceivedAt.getTime();
  return staleMs > thresholdMin * 60_000;
}

export function isBarStreamStale(lastBarReceivedAt, now, config) {
  return isStreamStale(lastBarReceivedAt, now, config, config.barStaleThresholdMin);
}

// Depth's own twin of the bar-staleness watchdog — the same live incident
// risk (a SignalR subscription that's technically still connected but
// silently stopped delivering messages, only caught because a separate
// REST poll kept working and masked it) applies equally here, on a wholly
// separate hub subscription from the bar/trade one.
export function isDepthStreamStale(lastDepthEventAt, now, config) {
  return isStreamStale(lastDepthEventAt, now, config, config.depthStaleThresholdMin);
}

// Reduces a contract's real closing fills (see topstepx.js's
// fetchClosingTrades) into what logClosedTrade needs: the realized P&L is
// the SUM of every closing fill since the trade opened (a partial-profit
// take followed by a final stop/target exit both count, not just the last
// one), and the displayed exit price is the LAST (most recent) fill,
// standing in for "where it finally closed." Returns null for an empty
// list so the caller can fall back to the old bar-close approximation.
export function summarizeClosingFills(fills) {
  if (!fills.length) return null;
  const realizedPnl = fills.reduce((sum, f) => sum + f.profitAndLoss, 0);
  const exitPrice = fills[fills.length - 1].price;
  return { exitPrice, realizedPnl };
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

// ---- Stateful orchestration below. Not unit-tested directly (it's IO glue around
// the pure helpers above and the strategy modules) — exercise it against the
// Topstep Practice Account once real data adapters are wired up (Task 7). ----

export class Worker {
  constructor() {
    this.riskManager = new SessionRiskManager(CONFIG);
    this.logger = new SignalLogger();
    this.bars = [];
    this.currentDay = null;
    this.priorDayAdx = null;
    this.priorDayAdxOk = false;
    this.lastRegimeInfo = null;
    this.account = null; // "default" role — everything except the Order Flow Bot
    this.openPositions = [];
    this.accountA = null; // the Order Flow Bot's own (practice) account — role "A"
    this.openPositionsA = [];
    this.accountAsOf = null;
    this.riskDayKey = null;
    this.dayStartBalance = null; // "default" role (real Combine) only — see checkAccountRisk
    this.haltedForRisk = false;
    this.haltReason = null;
    this.trackedTrades = []; // locally-tracked open trades, for MFE/MAE + closure detection
    this.lastBarReceivedAt = null; // real wall-clock time — see isBarStreamStale
    this.footprintBars = []; // per-minute footprint levels, from FootprintBarAggregator — see onFootprintBar
    this.lastFootprintBarAt = null; // real wall-clock time — see isDepthStreamStale's depth-side twin
    this.depthBook = new depthBook.DepthBookAggregator(CONFIG.orderFlowBot.depth);
    this.lastFootprintZones = null; // recomputed each bar in tryOrderFlow, cached for visibility
    this.sessionVolumeProfile = null; // ditto
    this.lastPOC = null; // ditto — null until sessionBars clears minSessionBars
    this.lastValueArea = null; // ditto
    this.lastOFHeartbeatAt = null; // real wall-clock ms — throttles logOrderFlowHeartbeat, see tryOrderFlow
    // Index into this.bars where TODAY's bars start — this.bars itself is
    // never trimmed at day rollover (multi-day history is fine for most uses,
    // e.g. MFE/MAE on a trade spanning a restart), but the session volume
    // profile specifically needs to mean "today's session," not "every bar
    // since this process last started." Set in checkDayRollover.
    this.todaySessionStartIndex = 0;
  }

  // Same convention as onBar's trade-bar handling: just accumulates.
  // Consumed by tryOrderFlow to build this bar's footprint zones.
  onFootprintBar(levels) {
    this.lastFootprintBarAt = new Date();
    this.footprintBars.push(levels);
  }

  async resolveAccountIdForRole(role) {
    return topstepx.resolveAccountId(role === "A" ? CONFIG.orderFlowBot.accountNameHint : undefined);
  }

  // Polls both accounts independently — a failure resolving/fetching one
  // (e.g. STRATEGY_OF_ACCOUNT_NAME misconfigured) must never block the other,
  // since Strategy B's real-account trading has to keep working regardless of
  // the Order Flow Bot's practice-account health.
  async pollAccount() {
    await Promise.all([this.pollAccountForRole("default"), this.pollAccountForRole("A")]);
    this.accountAsOf = new Date();
    await this.checkAccountRisk(nowET()).catch((e) => console.error("Risk check failed:", e.message));
    await this.detectClosedTrades();
    await this.reconcileUntrackedPositions();
  }

  // Account-wide safety net, independent of Strategy B/OF's own signal logic —
  // checked every account poll (not just at entry time) so a breach mid-trade
  // still forces an immediate flatten rather than waiting for the next entry
  // attempt to notice. The kill switch halts BOTH strategies (both accounts);
  // the $ daily-loss cap only applies to the "default" role (the real Combine,
  // shared with gap-continuation/mechanical-orb) — the Order Flow Bot's
  // practice account isn't real money, so it has no $ cap of its own here.
  async checkAccountRisk(t) {
    const dayKey = t.toDateString();
    if (this.riskDayKey !== dayKey) {
      this.riskDayKey = dayKey;
      this.dayStartBalance = this.account?.balance ?? null;
      this.haltedForRisk = false;
      this.haltReason = null;
    }

    if (await isKillSwitchActive()) {
      await this.tripRiskHalt("kill_switch");
      return;
    }

    const dailyPnl = computeDailyPnl(this.account?.balance ?? null, this.dayStartBalance);
    if (isDailyLossCapBreached(dailyPnl, CONFIG.risk.dailyLossCapDollars)) {
      await this.tripRiskHalt(`daily_loss_cap (pnl ${dailyPnl?.toFixed(2)})`);
    }
  }

  async tripRiskHalt(reason) {
    const alreadyHalted = this.haltedForRisk;
    this.haltedForRisk = true;
    this.haltReason = reason;
    if (this.trackedTrades.length) {
      await this.flattenAll();
    }
    if (alreadyHalted) return; // alert once per trip, not every poll
    console.error(`RISK HALT (gex-breakout): ${reason}`);
    await postDiscordEmbed(
      CONFIG.discord.logWebhook,
      buildSignalEmbed({
        title: "🛑 RISK HALT — GEX Breakout",
        description: `All new entries (Strategy B and OF) blocked for the rest of the day: **${reason}**`,
        color: 0xe74c3c,
        fields: [["Day", this.riskDayKey]],
        footerText: `gex-breakout · ${new Date().toISOString()}`,
      })
    ).catch((e) => console.error("Risk-halt Discord post failed:", e.message));
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
  // treat the Order Flow Bot's practice position as "already tracked" because
  // of an unrelated Strategy B trade on the real account sharing that
  // contractId, or vice versa.
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
    }
  }

  // The broker no longer reporting a position for a contract we're tracking means
  // it closed (stop or target filled) — there's no other live signal for this given
  // we're polling REST rather than trusting the unverified user-hub push stream.
  // Exit price is approximated as the last known bar close (detection lag up to the
  // 5s poll interval) — good enough for MFE/MAE, not exact realized P&L.
  stillOpenContractsByRole() {
    return {
      default: new Set(this.openPositions.map((p) => p.contractId)),
      A: new Set(this.openPositionsA.map((p) => p.contractId)),
    };
  }

  // Startup-only safety net: a trade can go stuck at status:"open" in Mongo
  // forever if the worker restarts in the narrow window between a real fill
  // (any close — bracket, manual, EOD flatten, or a reopenAt-driven stop
  // tighten/partial) and the next detectClosedTrades poll that would have
  // noticed it. Confirmed live 2026-07-31: a reopenAt stop-tighten closed
  // and reopened a position, and a deploy's restart landed 4 seconds before
  // the reopened leg's own stop got hit — trackedTrades (in-memory) was
  // wiped by the restart, so by the time polling resumed the position was
  // already flat with nothing left to reconcile against. Runs once at
  // startup, after the first real position poll, and uses the same real-fill
  // lookup logClosedTrade relies on rather than any approximation.
  // journalClient/brokerClient default to the real modules; tests pass fakes
  // so this can be verified without a live Mongo/broker — same pattern as
  // classifyPassiveClose/logClosedTrade's own client param (this file's ESM
  // namespace imports can't be monkey-patched from outside).
  async reconcileOrphanedMongoTrades(journalClient = tradeJournal, brokerClient = topstepx) {
    const openDocs = await journalClient.fetchOpenTrades().catch((e) => {
      console.error("fetchOpenTrades failed:", e.message);
      return [];
    });
    if (!openDocs.length) return;
    const stillOpenByRole = this.stillOpenContractsByRole();
    for (const doc of openDocs) {
      if (stillOpenByRole[doc.accountRole ?? "default"].has(doc.contractId)) continue; // broker confirms it's genuinely still open

      try {
        const accountId = await brokerClient.resolveAccountId(
          doc.accountRole === "A" ? CONFIG.orderFlowBot.accountNameHint : undefined
        );
        const fills = await brokerClient.fetchClosingTrades(accountId, doc.contractId, doc.openedAt);
        const real = summarizeClosingFills(fills);
        if (!real) continue; // no closing fill found (yet) either — leave it for a later pass rather than guess
        await journalClient.closeTrade(doc._id, {
          closedAt: new Date().toISOString(),
          exitPrice: real.exitPrice,
          outcome: "closed",
          mfe: doc.mfe ?? 0,
          mae: doc.mae ?? 0,
          realizedPnl: real.realizedPnl,
        });
        console.log(`Reconciled orphaned trade ${doc._id} (${doc.strategy}): real P&L ${real.realizedPnl}`);
      } catch (e) {
        console.error(`reconcileOrphanedMongoTrades failed for ${doc._id}:`, e.message);
      }
    }
  }

  async detectClosedTrades() {
    const stillOpenByRole = this.stillOpenContractsByRole();
    const remaining = [];
    for (const trade of this.trackedTrades) {
      if (stillOpenByRole[trade.accountRole ?? "default"].has(trade.contractId)) {
        remaining.push(trade);
      } else {
        const outcome = await this.classifyPassiveClose(trade);
        await this.logClosedTrade(trade, outcome);
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
      const accountId = await client.resolveAccountId(role === "A" ? CONFIG.orderFlowBot.accountNameHint : undefined);
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

  async logClosedTrade(trade, outcome = "closed", client = topstepx) {
    // Real fills first — a bracket fill/manual close/EOD flatten/EXIT_NOW
    // all land here, and the broker always knows the true exit price/P&L
    // regardless of which path closed it. Falls back to the old bar-close
    // approximation only if the lookup itself fails (network hiccup, or the
    // account can't be resolved) — see fetchClosingTrades' own comment for
    // why the approximation alone isn't trustworthy.
    let real = null;
    try {
      const role = trade.accountRole ?? "default";
      const accountId = await client.resolveAccountId(role === "A" ? CONFIG.orderFlowBot.accountNameHint : undefined);
      const fills = await client.fetchClosingTrades(accountId, trade.contractId, trade.openedAt);
      real = summarizeClosingFills(fills);
    } catch (e) {
      console.error("fetchClosingTrades failed, falling back to bar-close approximation:", e.message);
    }

    const lastBar = this.bars.length ? this.bars[this.bars.length - 1] : null;
    const approxExitPrice = real?.exitPrice ?? lastBar?.close ?? null;
    const realizedPnl =
      real?.realizedPnl ??
      (approxExitPrice != null
        ? computeRealizedPnl(trade.entryPrice, approxExitPrice, trade.direction, POINT_VALUE[CONFIG.instrumentTrade], trade.size)
        : null);
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
    row.approx_exit_price = approxExitPrice; // not part of the base schema, tacked on for this analysis
    row.realized_pnl = realizedPnl;
    this.logger.log(row);
    tradeJournal.logSignal(row, nowET().toDateString()).catch((e) => console.error("Mongo log failed:", e.message));

    // Feeds the per-strategy win/loss halt (config.maxLossesPerStrategyPerDay,
    // plus the one-winner-and-done rule) — this was never wired to any real
    // trade closure before, so the old bot-wide consecutive-loss counter
    // stayed at 0 forever and the kill switch could never trip no matter how
    // many real losses happened (caught live 2026-07-24: the dashboard's
    // counter was still 0 right after a real losing trade closed). Only
    // recordTradeResult's SIGN matters (win/loss), so real.realizedPnl
    // (dollars) or the approxExitPrice-derived points both work — using
    // points keeps this consistent whether real fills came back or not.
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
    // outcome === "manual_close" used to also post a Discord alert here —
    // removed 2026-07-30 at the user's request (no longer wants manual
    // trade activity surfaced in Discord); still tagged manual_close in
    // Mongo and counted in the daily summary's manualCloses breakdown.
  }

  // TopstepX-only regime signal for the Order Flow Bot (replaces GEX/basis
  // recalcs, removed with FlashAlpha) — same prior-day ADX pattern
  // gap-continuation/mechanical-orb already use, computed off the ES data
  // feed (instrumentData) since that's where this bot's other technical
  // analysis (footprint, depth, volume profile) already lives.
  async refreshAdx() {
    const dailyBars = await topstepx.fetchDailyBars(CONFIG.instrumentData, CONFIG.regime.dailyLookbackDays);
    const result = priorDayAdxOk(dailyBars, {
      adxPeriod: CONFIG.regime.adxPeriod,
      adxThreshold: CONFIG.regime.adxThreshold,
    });
    this.priorDayAdx = result.adx;
    this.priorDayAdxOk = result.ok;
  }

  // Nothing previously reset riskManager's day-state (win/loss halts, zone
  // cooldowns) at a new day — a real live incident (2026-07-28: two real
  // Strategy B trades fired hours before the real 9:30 ET session open, on
  // an account that hadn't restarted since before midnight, because the
  // now-removed ORB-lock state stayed stuck true overnight) is why this
  // exists at all. SessionRiskManager.resetDay() already existed for exactly
  // this but was never actually called anywhere after construction.
  checkDayRollover(t) {
    const dayKey = t.toDateString();
    if (this.currentDay === dayKey) return;
    this.currentDay = dayKey;
    this.refreshAdx().catch((e) => console.error("ADX refresh failed:", e.message));
    this.riskManager.resetDay();
    // Called before this bar is pushed to this.bars — its current length is
    // exactly "every bar from prior days," so today's bars start right here.
    this.todaySessionStartIndex = this.bars.length;
    this.footprintBars = [];
    this.lastOFHeartbeatAt = null;
  }

  onBar(rawBar, t = nowET()) {
    this.lastBarReceivedAt = new Date(); // real wall-clock time, not `t` — see isBarStreamStale
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

    // Matches mechanical-orb's window: no new entries past entryCutoffET, and
    // any position still open past flattenAtET gets force-closed rather than
    // left to ride its bracket to stop/target/session end.
    if (shouldFlattenNow(t, CONFIG) && this.trackedTrades.length) {
      this.flattenAll().catch((e) => console.error("EOD flatten failed:", e.message));
      return;
    }

    this.evaluateSignals(bar, t);
  }

  // Closes every open trade at once (the Order Flow Bot and Strategy B can
  // legitimately be open concurrently) — dedupes by (accountRole, contractId)
  // since a shared contract only ever has one real net position PER ACCOUNT
  // at the broker (see closeOnDirectionFlip); calling
  // closePositionAndCancelOrders twice for the same already-closed
  // account+contract would just be a wasted/erroring call. The Order Flow Bot
  // (practice) and everything else (real Combine) are different accounts,
  // so contractId alone isn't unique.
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
      await this.logClosedTrade(trade, "eod_flatten");
    }
    this.trackedTrades = [];
  }

  evaluateSignals(bar, t) {
    // Lower bound restores what the old orbLocked gate used to provide as a
    // side effect (blocking pre-market entries until that day's ORB window
    // resolved) before Phase 1 of the Order Flow Bot removed it — reasoned at
    // the time as a harmless cleanup since Strategy B doesn't need the ORB,
    // but its real consequence was a live-money strategy trading hours it
    // never had before. Confirmed same-day: Strategy B took its first-ever
    // pre-market trade at 02:04 ET on 2026-07-30, the same morning that gate
    // shipped. Decided live to keep both strategies confined to
    // sessionOpenET-entryCutoffET rather than leave that window open.
    //
    // Floor later raised from sessionOpenET to entryFloorET (9:45, same day)
    // — user's call: no new entries in the first 15 minutes of RTH at all,
    // too volatile, easy to get stopped out on an opening wick. Matches
    // mechanical-orb's own opening-range window, which already can't enter
    // that early by construction.
    const minutes = minutesOf(t);
    if (minutes < CONFIG.entryFloorET.h * 60 + CONFIG.entryFloorET.m) return;
    if (minutes >= CONFIG.entryCutoffET.h * 60 + CONFIG.entryCutoffET.m) return;

    if (this.haltedForRisk) {
      this.logger.log(buildLogRow({ ts: new Date().toISOString(), vetoReason: `risk_halt:${this.haltReason}` }));
      return;
    }

    const regimeInfo = classifyRegime({ trendDayOk: this.priorDayAdxOk });
    this.lastRegimeInfo = regimeInfo;

    const idx = this.bars.length - 1;
    const prevBar = this.bars[idx - 1] ?? bar;

    this.tryOrderFlow(bar, prevBar, idx, t, regimeInfo);
  }

  // Unlike Strategy A/B, absorption/path-of-least-resistance/lack-of-
  // participation are all retrospective (computed off the trailing bar
  // window ending at the current bar), so this needs no pending-breakout-
  // then-confirm-bar scaffold the way tryStrategyB still has — it evaluates
  // synchronously.
  tryOrderFlow(bar, prevBar, idx, t, regimeInfo) {
    if (!this.riskManager.canTrade("OF")) return;

    // Recomputed fresh each bar — cheap at session-length bar/footprint-bar
    // counts, same reasoning detectConsolidation already relies on.
    this.lastFootprintZones = buildFootprintZones(this.footprintBars, CONFIG.orderFlowBot.footprint);

    const sessionBars = this.bars.slice(this.todaySessionStartIndex);
    // Below minSessionBars, a value area is just noise — no zone (and no
    // stale POC/value area left over from a moment ago) rather than an
    // untrustworthy one. lastPOC/lastValueArea are also read by
    // statusReporter.js for the dashboard's "forming..." state.
    if (sessionBars.length >= CONFIG.orderFlowBot.volumeProfile.minSessionBars) {
      this.sessionVolumeProfile = buildSessionProfile(sessionBars, CONFIG.orderFlowBot.volumeProfile);
      this.lastPOC = findPOC(this.sessionVolumeProfile);
      this.lastValueArea = computeValueArea(this.sessionVolumeProfile, this.lastPOC, CONFIG.orderFlowBot.volumeProfile.valueAreaPct);
    } else {
      this.lastPOC = null;
      this.lastValueArea = null;
    }
    const valueArea = this.lastValueArea;

    const absorptionWindow = buildAbsorptionWindow(this.bars, idx, CONFIG.orderFlow.absorption);
    // TopstepX-only substitute for GEX strike walls (removed with
    // FlashAlpha) — the session value area's edges and POC, recomputed fresh
    // every bar right alongside them above rather than on a separate 5/15-min
    // recalc timer the way GEX/basis used to be.
    const walls = buildOrderFlowWalls({ valueArea, poc: this.lastPOC });

    const result = evaluateOrderFlowBot({
      nowET: t,
      bars: this.bars,
      index: idx,
      regimeInfo,
      footprintZones: this.lastFootprintZones,
      valueArea,
      touchWindow: absorptionWindow?.touchWindow ?? null,
      priorBars: absorptionWindow?.priorBars ?? [],
      walls,
      config: CONFIG,
      dayState: this.riskManager.dayState,
    });
    if (result) {
      // No breakout-flow grading exists for the Order Flow Bot's own
      // triggers (absorption/path-of-least-resistance/lack-of-participation/
      // failed-auction ARE the confirmation, unlike Strategy A/B's separate
      // delta-confirmation grade) — a fixed grade "B" is a deliberate,
      // conservative default (the smaller of the two configured sizes,
      // risk.sizing.B) pending real observation of which triggers actually
      // deserve more size. Revisit once Phase 6's manual signal review has
      // real trades to judge against.
      this.handleSignal(result, regimeInfo, { grade: "B" });
    } else {
      // evaluateOrderFlowBot returned a bare null — genuinely no trigger at
      // all this bar (its own explicit vetoes, e.g. wall/stop/cutoff, always
      // return a truthy object and hit handleSignal above, so this is the
      // one path that used to leave zero trace).
      this.logOrderFlowHeartbeat(idx, regimeInfo, valueArea);
    }
  }

  // Order Flow Bot's version of logStrategyBSkip below: makes an otherwise
  // silent "no trigger fired" bar visible, throttled to
  // diagnosticHeartbeatMin so it samples state rather than logging every bar
  // (POLR/LOP run unconditionally every bar, unlike Strategy B's rarer level
  // crossings — logging every miss would flood recentLog and bury real
  // signals). See config.js's diagnosticHeartbeatMin comment for why this
  // exists at all.
  logOrderFlowHeartbeat(idx, regimeInfo, valueArea) {
    const nowMs = Date.now();
    const intervalMs = CONFIG.orderFlowBot.diagnosticHeartbeatMin * 60000;
    if (this.lastOFHeartbeatAt && nowMs - this.lastOFHeartbeatAt < intervalMs) return;
    this.lastOFHeartbeatAt = nowMs;

    const polr = describePathOfLeastResistance(this.bars, idx, CONFIG.orderFlowBot.pathOfLeastResistance);
    const lop = describeLackOfParticipation(this.bars, idx, CONFIG.orderFlowBot.lackOfParticipation);

    this.persistLogRow(
      buildLogRow({
        ts: new Date().toISOString(),
        strategy: "OF",
        regime: regimeInfo?.regime ?? null,
        vetoReason: "no_trigger_heartbeat",
        deltaStats: {
          baseRegime: regimeInfo?.baseRegime ?? null,
          zoneCount: this.lastFootprintZones?.length ?? 0,
          poc: this.lastPOC,
          valueArea,
          polr,
          lop,
        },
      })
    );
  }

  // Both the log buffer (for the dashboard's Recent Signals/Vetoes table)
  // and Mongo (durable, survives a restart) — same two writes handleSignal uses.
  persistLogRow(row) {
    this.logger.log(row);
    tradeJournal.logSignal(row, nowET().toDateString()).catch((e) => console.error("Mongo log failed:", e.message));
  }

  handleSignal(result, regimeInfo, flow) {
    // The Order Flow Bot (practice account) and everything else (real
    // Combine, shared with Mechanical ORB and Gap Continuation) are on
    // different accounts — each checks only ITS OWN account's real position
    // state (refreshed every poll), not just this bot's own local view, so
    // this still catches a position opened by another bot on the real
    // account, without the Order Flow Bot's practice-account activity ever
    // blocking (or being blocked by) it.
    const role = accountRoleFor(result.strategy);
    const relevantPositions = role === "A" ? this.openPositionsA : this.openPositions;
    const vetoReason = relevantPositions.length > 0 ? "position_already_open" : result.veto;

    const row = buildLogRow({
      ts: new Date().toISOString(),
      strategy: result.strategy,
      direction: result.direction,
      level: result.level ?? null,
      regime: regimeInfo?.regime ?? null,
      flowGrade: flow.grade,
      vetoReason,
      entryPrice: result.entryPrice ?? null,
      stopPrice: result.stopPrice ?? null,
      targetPrice: result.targetPrice ?? null,
    });
    this.persistLogRow(row);

    if (vetoReason) return; // vetoes are logged only, no alert noise

    // The Order Flow Bot is the only strategy left (Strategy B, the only one
    // ever calibrated against the real Combine's equity ladder, was removed
    // with GEX/FlashAlpha) — it trades its own practice account, whose
    // balance is arbitrary and not calibrated against any ladder, so size is
    // just its own base x wall multiplier, no equity scaling.
    // clampToMaxContracts is a hard ceiling independent of this bot's own
    // (agent-editable) sizing config — see shared/protectedLimits.js.
    const size = clampToMaxContracts(computeSizeMultiplier(flow.grade, result.sizeMultiplier, CONFIG.risk.sizing));
    this.executeSignal(result, regimeInfo, flow, size).catch((e) =>
      console.error("Signal execution failed:", e.message)
    );
  }

  markTraded(result) {
    if (result.strategy === "OF") this.riskManager.recordOrderFlowTrade(result.zoneKey, Date.now());
  }

  // Dynamic in-trade management: evaluateOrderFlowExit's conditions
  // (delta-divergence, absorption, trend-day trailing) plus breakeven-at-1R,
  // run against every open trade each bar. One action per trade per bar
  // (actionInFlight guards against a slow-resolving broker call overlapping
  // with the next bar's evaluation of the same trade). Trades from
  // reconcileUntrackedPositions (entryIndex/brokenLevel unknown) are skipped
  // — there isn't enough context to evaluate them safely.
  evaluateOpenTrades(bar) {
    const currentIndex = this.bars.length - 1;
    for (const trade of [...this.trackedTrades]) {
      if (trade.actionInFlight) continue;
      if (trade.entryIndex == null || currentIndex <= trade.entryIndex) continue;

      if (
        !trade.movedToBreakeven &&
        trade.stopPrice != null &&
        trade.originalStopPrice != null &&
        trade.mfe >= Math.abs(trade.entryPrice - trade.originalStopPrice) * CONFIG.tradeManagement.breakevenAtR
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

      // The Order Flow Bot is the only strategy that reaches here now
      // (Strategy B's evaluateExit was removed with GEX/FlashAlpha).
      const currentRegimeBase = this.lastRegimeInfo?.baseRegime ?? null;
      const absorption = buildAbsorptionWindow(this.bars, currentIndex, CONFIG.orderFlow.absorption);
      const result = evaluateOrderFlowExit({
        direction: trade.direction,
        entryIndex: trade.entryIndex,
        currentIndex,
        bars: this.bars,
        touchWindow: absorption?.touchWindow ?? null,
        priorBars: absorption?.priorBars ?? [],
        levelPriceForAbsorption: trade.targetPrice,
        isTrendDay: currentRegimeBase === "TREND",
        nearestZonePrice: nearestZonePriceFor(this.lastFootprintZones ?? [], trade.direction, bar.close),
        config: CONFIG,
      });
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
      await this.logClosedTrade(trade, result.reason);
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

    if (result.action === "TIGHTEN_TO_PRICE") {
      const newStopPrice = result.price;
      const tighter = trade.direction === "long" ? newStopPrice > trade.stopPrice : newStopPrice < trade.stopPrice;
      if (!tighter) return; // never loosens the stop
      await this.moveStop(trade, newStopPrice, bar.close, result.reason);
      return;
    }

    if (result.action === "TAKE_PARTIAL") {
      const fraction = CONFIG.tradeManagement.takePartialFraction;
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
  // hedging isn't allowed on this account. The Order Flow Bot and Strategy B
  // can legitimately both be long (or both short) at once, that's untouched;
  // but a live SHORT immediately followed by an opposite LONG signal used to
  // just fire a second bracket order on top of the first. The two market legs
  // net flat at the broker, but each trade's own stop/target bracket doesn't
  // cancel just because a *different* order zeroed the net position — both
  // stayed resting, and one filled on its own a minute later, leaving a
  // naked, untracked position with no stop or target (caught live 2026-07-24,
  // manually flattened).
  // Scoped to trackedTrades from the SAME account role as the incoming
  // signal — the Order Flow Bot (practice) and everything else (real
  // Combine) are on different accounts entirely, so a direction flip on one
  // account must never touch a same-contract position that's actually
  // sitting on the other account.
  async closeOnDirectionFlip(accountId, contractId, newDirection, accountRole) {
    const roleTrackedTrades = this.trackedTrades.filter((t) => (t.accountRole ?? "default") === accountRole);
    const toClose = tradesRequiringCloseOnFlip(roleTrackedTrades, contractId, newDirection);
    if (!toClose.length) return;
    await topstepx.closePositionAndCancelOrders(accountId, contractId);
    for (const trade of toClose) await this.logClosedTrade(trade);
    const toCloseSet = new Set(toClose);
    this.trackedTrades = this.trackedTrades.filter((t) => !toCloseSet.has(t));
  }

  // entryPrice on a freshly-opened trade is the strategy's theoretical trigger-bar
  // close (see strategyB.js's `entryPrice = price`) — the entry itself is a
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

    // Only the dynamic re-bracket paths (moveStop/TAKE_PARTIAL) used to clamp
    // to the broker's minimum stop distance (live-verified 2026-07-24:
    // rejected with "Invalid stop loss ticks... should be at least 4 ticks
    // away") — never the initial entry, because Strategy A/B's structural
    // stops were always comfortably wider than that in practice. The Order
    // Flow Bot's computeZoneStop isn't: it places the stop triggerBufferPts
    // (1pt = exactly 4 ticks on MES) beyond a zone edge, and entry often sits
    // right at that same edge — caught by code review before ever hitting it
    // live, not by a real rejection. Applied unconditionally (not just inside
    // the live-execution branch below) so a signal-only log/trade-taken embed
    // shows the stop a real order would actually use, not a theoretical one
    // that would've been rejected.
    result.stopPrice = clampStopDistance(
      result.stopPrice,
      result.entryPrice,
      result.direction,
      topstepx.MIN_STOP_TICKS * topstepx.tickSizeFor(CONFIG.instrumentTrade)
    );

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
// Returns the live connection so the staleness watchdog below can stop() it
// and reconnect if bars/depth ever go quiet mid-session. Bars, footprint, and
// depth all go through this ONE connection — confirmed live 2026-07-30 that a
// second separate connection to the same MARKET_HUB_URL (the original design,
// one function per subscription) gets its invoke repeatedly canceled by the
// server; see subscribeBars' own comment in topstepx.js.
async function subscribeBarsWithRetry(worker, attempt = 1) {
  try {
    return await topstepx.subscribeBars(
      CONFIG.instrumentData,
      (bar) => worker.onBar(bar),
      (levels) => worker.onFootprintBar(levels),
      (data) => worker.depthBook.onDepthEvent(data)
    );
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
  if (CONFIG.risk.dailyLossCapDollars == null) {
    console.error(
      "WARNING: ACCOUNT_DAILY_LOSS_CAP_DOLLARS is not set — the account-wide daily loss cap is NOT enforced."
    );
  }

  startStatusReporter(worker, {
    backendUrl: process.env.BACKEND_URL || "http://localhost:3001",
    secret: process.env.GEX_STATUS_SECRET,
    intervalMs: 3000,
  });

  worker.checkDayRollover(nowET()); // triggers the initial ADX refresh
  // Awaited (not fire-and-forget) — reconciliation needs a fresh read of real
  // open positions to know what's genuinely still open vs. orphaned, so it
  // must run after this specific poll resolves.
  await worker.pollAccount().catch((e) => console.error("Initial account poll failed:", e.message));
  await worker
    .reconcileOrphanedMongoTrades()
    .catch((e) => console.error("Orphaned trade reconciliation failed:", e.message));

  setInterval(
    () => worker.pollAccount().catch((e) => console.error("Account poll failed:", e.message)),
    5000
  );
  let barConnection = await subscribeBarsWithRetry(worker);

  // Forces a fresh SignalR connection if bars OR depth go quiet mid-session —
  // both ride the same connection (see subscribeBarsWithRetry), so either
  // staleness check reconnects the same one. .stop() before reconnecting so
  // the old (zombie) connection doesn't linger duplicating handlers.
  setInterval(async () => {
    const barsStale = isBarStreamStale(worker.lastBarReceivedAt, nowET(), CONFIG);
    const depthStale = isDepthStreamStale(worker.depthBook.lastEventAt, nowET(), CONFIG);
    if (!barsStale && !depthStale) return;
    console.error(
      `${barsStale ? "Bars" : "Depth"} stream stale during the trading day — forcing a SignalR reconnect`
    );
    try {
      await barConnection.stop();
    } catch (e) {
      console.error("Error stopping stale connection:", e.message);
    }
    barConnection = await subscribeBarsWithRetry(worker);
  }, 60_000);

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
