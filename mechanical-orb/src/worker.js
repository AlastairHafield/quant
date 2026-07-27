import { pathToFileURL } from "node:url";
import { CONFIG, POINT_VALUE } from "./config.js";
import { priorDayAdxOk } from "./adx.js";
import {
  orbWindowBounds,
  isWithinOrbWindow,
  updateOrbRange,
  computeOrbFromHistoricalBars,
  evaluateEntry,
  shouldFlattenNow,
  minutesOf,
} from "./strategy.js";
import { computeSize } from "./sizing.js";
import { SignalLogger, buildLogRow } from "./logger.js";
import { buildTradeTakenEmbed, postDiscordEmbed, flushLogBufferToDiscord } from "./discord.js";
import { startStatusReporter } from "./statusReporter.js";
import { updateMfeMae, computeRealizedPnl } from "./positionTracking.js";
import * as topstepx from "./dataSources/topstepx.js";
import * as tradeJournal from "./tradeJournal.js";

export function toET(d) {
  return new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
}

export function nowET() {
  return toET(new Date());
}

// Returns the day-key to flush for if it's at/past the scheduled flush time,
// else null. Whether that day has already been flushed is checked separately
// (asynchronously, against Mongo) by the caller — this used to take a
// lastFlushedDay parameter backed by an in-memory variable, which reset on
// every restart and could double-flush a day already flushed before it.
export function shouldFlushLogNow(t, logFlushET) {
  const dayKey = t.toDateString();
  const isFlushTime = minutesOf(t) >= logFlushET.h * 60 + logFlushET.m;
  return isFlushTime ? dayKey : null;
}

export class Worker {
  constructor() {
    this.logger = new SignalLogger();
    this.bars = [];
    this.orbHigh = null;
    this.orbLow = null;
    this.orbLocked = false;
    this.orbBackfillInFlight = false;
    this.priorDayAdx = null;
    this.priorDayAdxOk = false;
    this.dayState = { tradedToday: false };
    this.currentDay = null;
    this.openPosition = null; // { direction, entryPrice, stopPrice, size, contractId }
    this.account = null;
    this.openPositions = [];
    this.accountAsOf = null;
  }

  async refreshAdx() {
    const dailyBars = await topstepx.fetchDailyBars(CONFIG.instrument, CONFIG.regime.dailyLookbackDays);
    const result = priorDayAdxOk(dailyBars, {
      adxPeriod: CONFIG.regime.adxPeriod,
      adxThreshold: CONFIG.regime.adxThreshold,
    });
    this.priorDayAdx = result.adx;
    this.priorDayAdxOk = result.ok;
  }

  async pollAccount() {
    const accountId = await topstepx.resolveAccountId();
    const { account, positions } = await topstepx.fetchAccountSnapshot(accountId);
    this.account = account;
    this.openPositions = positions;
    this.accountAsOf = new Date();
    this.detectClosedTrade();
  }

  // The stop-loss order filling is the only way a position disappears without us
  // calling flatten() ourselves (this strategy has no take-profit) — detected via
  // the broker no longer reporting it, since we're polling REST rather than
  // trusting the unverified user-hub push stream.
  detectClosedTrade() {
    if (!this.openPosition) return;
    const stillOpen = this.openPositions.some((p) => p.contractId === this.openPosition.contractId);
    if (stillOpen) return;
    this.logClosedTrade(this.openPosition, "stopped_out");
    this.openPosition = null;
  }

  logClosedTrade(trade, reason) {
    const lastBar = this.bars.length ? this.bars[this.bars.length - 1] : null;
    const row = buildLogRow({
      ts: new Date().toISOString(),
      direction: trade.direction,
      adx: this.priorDayAdx,
      orbHigh: this.orbHigh,
      orbLow: this.orbLow,
      entryPrice: trade.entryPrice,
      stopPrice: trade.stopPrice,
      outcome: reason,
      mfe: trade.mfe,
      mae: trade.mae,
    });
    row.approx_exit_price = lastBar?.close ?? null;
    row.realized_pnl =
      row.approx_exit_price != null
        ? computeRealizedPnl(trade.entryPrice, row.approx_exit_price, trade.direction, POINT_VALUE[CONFIG.instrument], trade.size)
        : null;
    this.logger.log(row);
    tradeJournal.logSignal(row, nowET().toDateString()).catch((e) => console.error("Mongo log failed:", e.message));

    tradeJournal
      .closeTrade(trade.mongoId, {
        closedAt: new Date().toISOString(),
        exitPrice: row.approx_exit_price,
        outcome: reason,
        mfe: trade.mfe,
        mae: trade.mae,
        realizedPnl: row.realized_pnl,
      })
      .catch((e) => console.error("Mongo closeTrade failed:", e.message));
  }

  checkDayRollover(t) {
    const dayKey = t.toDateString();
    if (this.currentDay === dayKey) return;
    this.currentDay = dayKey;
    this.orbHigh = null;
    this.orbLow = null;
    this.orbLocked = false;
    this.dayState = { tradedToday: false };
    this.refreshAdx().catch((e) => console.error("ADX refresh failed:", e.message));
  }

  // Only ever populated by live streamed bars during the window (see onBar) —
  // a worker that starts or restarts after today's window has already closed
  // has no memory of it and would otherwise never lock an ORB for the rest of
  // the day. No-ops (and stays retriable) until the window has actually
  // ended; self-resolves once it does, without needing a permanent "already
  // tried" flag.
  async backfillOrbIfPastWindow(t) {
    const bounds = orbWindowBounds(CONFIG);
    if (minutesOf(t) < bounds.endMin) return;
    const bars = await topstepx.fetchRecentBars(CONFIG.instrument, 720);
    const range = computeOrbFromHistoricalBars(bars, t.toDateString(), bounds, toET);
    if (!range) return;
    this.orbHigh = range.high;
    this.orbLow = range.low;
    this.orbLocked = true;
  }

  onBar(rawBar, t = nowET()) {
    this.checkDayRollover(t);
    this.bars.push(rawBar);

    if (this.openPosition) {
      Object.assign(
        this.openPosition,
        updateMfeMae(this.openPosition, this.openPosition.entryPrice, this.openPosition.direction, rawBar)
      );
    }

    if (isWithinOrbWindow(t, orbWindowBounds(CONFIG))) {
      Object.assign(this, updateOrbRange(this, rawBar));
      return;
    }
    if (!this.orbLocked && this.orbHigh != null) {
      this.orbLocked = true;
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

    if (this.openPosition && shouldFlattenNow(t, CONFIG)) {
      this.flatten(rawBar.close).catch((e) => console.error("EOD flatten failed:", e.message));
      return;
    }
    if (this.openPosition) return; // one trade at a time, nothing else to evaluate

    const result = evaluateEntry({
      bar: rawBar,
      orbHigh: this.orbHigh,
      orbLow: this.orbLow,
      nowET: t,
      adxOk: this.priorDayAdxOk,
      config: CONFIG,
      dayState: this.dayState,
    });
    if (!result) return;

    this.handleSignal(result);
  }

  handleSignal(result) {
    // Shared with GEX Breakout and Gap Continuation on the same real account/
    // MES contract, with no coordination between them on position sizing —
    // stacking a second position on top of an already-open one (this bot's own,
    // or another bot's) compounds risk beyond what any single strategy was
    // sized for. this.openPositions is the real broker account state (refreshed
    // every poll), so this catches a position opened by another bot too, not
    // just this one's own (which onBar's `if (this.openPosition) return`
    // already short-circuits before evaluateEntry is even called).
    const vetoReason = this.openPositions.length > 0 ? "position_already_open" : result.veto;

    const row = buildLogRow({
      ts: new Date().toISOString(),
      direction: result.direction,
      adx: this.priorDayAdx,
      orbHigh: this.orbHigh,
      orbLow: this.orbLow,
      vetoReason,
      entryPrice: result.entryPrice,
      stopPrice: result.stopPrice,
    });
    this.logger.log(row);
    tradeJournal.logSignal(row, nowET().toDateString()).catch((e) => console.error("Mongo log failed:", e.message));

    if (vetoReason) return; // vetoes are logged only, no alert noise

    this.executeEntry(result).catch((e) => console.error("Entry execution failed:", e.message));
  }

  async executeEntry(result) {
    const size = computeSize(CONFIG, this.account?.balance ?? CONFIG.sizing.ladder.startingEquity);
    let orderId = null;
    let contractId = null;

    if (CONFIG.executionEnabled) {
      const accountId = await topstepx.resolveAccountId();
      contractId = await topstepx.resolveFrontMonthContractId(CONFIG.instrument);
      // Throws on a broker rejection (bad size/ticks/etc) — nothing below runs,
      // so a rejected order leaves openPosition/dayState untouched and a
      // legitimate retry later today isn't permanently blocked.
      orderId = await topstepx.placeStopOnlyOrder({
        accountId,
        contractId,
        direction: result.direction,
        size,
        entryPrice: result.entryPrice,
        stopPrice: result.stopPrice,
        tickSize: CONFIG.tickSize,
        customTag: `morb-${result.direction}-${Date.now()}`,
      });
    } else {
      console.log(`[EXECUTION-DISABLED] would place ${result.direction} ${size}x @ ${result.entryPrice}`);
    }

    // Set together, right after order confirmation (or signal-only mode) and
    // before the Discord post below, so a Discord hiccup can't leave a real
    // fill untracked. The "one trade per day" guard in onBar() depends on
    // dayState.tradedToday being set here even in signal-only mode, otherwise
    // every subsequent qualifying bar re-evaluates and spams re-entry attempts.
    this.openPosition = { ...result, size, contractId, mfe: 0, mae: 0, mongoId: null };
    this.dayState.tradedToday = true;

    // A Mongo hiccup must never block tracking a real fill — best-effort,
    // openPosition stays tracked with mongoId left null if this fails.
    try {
      this.openPosition.mongoId = await tradeJournal.openTrade(this.openPosition, nowET().toDateString());
    } catch (e) {
      console.error("Mongo openTrade failed:", e.message);
    }

    await postDiscordEmbed(
      CONFIG.discord.webhook,
      buildTradeTakenEmbed({
        system: "Mechanical ORB",
        strategy: null,
        direction: result.direction,
        size,
        entryPrice: result.entryPrice,
        stopPrice: result.stopPrice,
        targetPrice: null,
        reasonFields: [
          ["ADX", this.priorDayAdx?.toFixed(1) ?? "n/a"],
          ["ORB high/low", `${this.orbHigh?.toFixed(2)} / ${this.orbLow?.toFixed(2)}`],
          ["Mode", CONFIG.executionEnabled ? "LIVE" : "SIGNAL-ONLY"],
        ],
        orderId,
      })
    );
  }

  async flatten(lastPrice) {
    if (!this.openPosition) return;
    if (CONFIG.executionEnabled) {
      const accountId = await topstepx.resolveAccountId();
      await topstepx.closePositionAndCancelOrders(accountId, this.openPosition.contractId);
    }
    console.log(`Flattening EOD: ${this.openPosition.direction} @ ~${lastPrice}`);
    this.logClosedTrade(this.openPosition, "eod_flatten");
    this.openPosition = null;
  }
}

export function createWorker() {
  return new Worker();
}

async function startWorker() {
  const worker = createWorker();
  console.log(`mechanical-orb worker starting — signal-only mode: ${!CONFIG.executionEnabled}`);

  startStatusReporter(worker, {
    backendUrl: CONFIG.backendUrl,
    secret: CONFIG.statusSecret,
    intervalMs: 3000,
  });

  worker.checkDayRollover(nowET());
  worker.pollAccount().catch((e) => console.error("Initial account poll failed:", e.message));

  setInterval(() => worker.pollAccount().catch((e) => console.error("Account poll failed:", e.message)), 5000);

  await topstepx.subscribeBars(CONFIG.instrument, (bar) => worker.onBar(bar));

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
        const rows = await tradeJournal.fetchDayRows(dayKey);
        await flushLogBufferToDiscord(CONFIG.discord.logWebhook, rows, dayKey, "scheduled");
      })
      .catch((e) => console.error("Scheduled log flush failed:", e.message));
  }, 60_000);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startWorker();
}
