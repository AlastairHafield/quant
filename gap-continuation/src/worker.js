import { pathToFileURL } from "node:url";
import { CONFIG, POINT_VALUE } from "./config.js";
import { priorDayAdxOk } from "./adx.js";
import {
  minutesOf,
  isAtOrAfterSessionOpen,
  shouldFlattenNow,
  priorRthCloseFromHistoricalBars,
  evaluateEntry,
} from "./strategy.js";
import { computeSize } from "./sizing.js";
import { SignalLogger, buildLogRow } from "./logger.js";
import { buildTradeTakenEmbed, postDiscordEmbed, flushLogBufferToDiscord } from "./discord.js";
import { startStatusReporter } from "./statusReporter.js";
import { updateMfeMae, computeRealizedPnl } from "./positionTracking.js";
import * as topstepx from "./dataSources/topstepx.js";
import * as tradeJournal from "./tradeJournal.js";

// ProjectX Gateway position type: 1 = Long, 2 = Short — confirmed live on the
// other two bots by cross-checking a position's type against the direction
// of the signal that opened it.
const POSITION_TYPE_TO_DIRECTION = { 1: "long", 2: "short" };

// Pure half of reconcileUntrackedPosition — split out so it's directly
// testable without a live resolveFrontMonthContractId call (TopstepX's ESM
// named exports can't be mocked with node:test's mock.method, same
// non-configurable-module-namespace issue noted in the other two bots).
export function findUntrackedPosition(positions, contractId) {
  return positions.find((p) => p.contractId === contractId && POSITION_TYPE_TO_DIRECTION[p.type]) ?? null;
}

export function toET(d) {
  return new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
}

export function nowET() {
  return toET(new Date());
}

// Returns the day-key to flush for if it's at/past the scheduled flush time,
// else null. Whether that day has already been flushed is checked separately
// (asynchronously, against Mongo) by the caller — durable across restarts,
// same pattern as the other two bots.
export function shouldFlushLogNow(t, logFlushET) {
  const dayKey = t.toDateString();
  const isFlushTime = minutesOf(t) >= logFlushET.h * 60 + logFlushET.m;
  return isFlushTime ? dayKey : null;
}

export class Worker {
  constructor() {
    this.logger = new SignalLogger();
    this.bars = [];
    this.currentDay = null;
    this.priorClose = null;
    this.priorCloseInFlight = false;
    this.todayGapChecked = false;
    this.priorDayAdx = null;
    this.priorDayAdxOk = false;
    this.openPosition = null; // { direction, entryPrice, stopPrice, targetPrice, size, contractId, gapPct }
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

  async refreshPriorClose(t) {
    if (this.priorCloseInFlight) return;
    this.priorCloseInFlight = true;
    try {
      const bars = await topstepx.fetchRecentBars(CONFIG.instrument, CONFIG.priorCloseLookbackMin);
      this.priorClose = priorRthCloseFromHistoricalBars(bars, t.toDateString(), toET);
    } finally {
      this.priorCloseInFlight = false;
    }
  }

  async pollAccount() {
    const accountId = await topstepx.resolveAccountId();
    const { account, positions } = await topstepx.fetchAccountSnapshot(accountId);
    this.account = account;
    this.openPositions = positions;
    this.accountAsOf = new Date();
    await this.reconcileUntrackedPosition().catch((e) => console.error("Reconcile failed:", e.message));
    this.detectClosedTrade();
  }

  // this.openPosition only ever exists in this process's memory, built up by
  // executeEntry() as a real order is placed — a worker restart (like the
  // uncaught subscribeBars crash confirmed live 2026-07-27) wipes it even
  // though the broker-side position is still there. Without this, a restart
  // mid-trade would leave a real position with no bot tracking it at all —
  // no MFE/MAE, and critically, no EOD-flatten safety net (shouldFlattenNow
  // only ever fires against a tracked this.openPosition). Best-effort:
  // direction/entry/size come straight from the broker; the original
  // stop/target levels aren't recoverable from a bare position record, so
  // they're left null (detectClosedTrade degrades to a generic "closed"
  // label rather than guessing target-vs-stop for a reconciled position).
  async reconcileUntrackedPosition() {
    if (this.openPosition) return;
    const contractId = await topstepx.resolveFrontMonthContractId(CONFIG.instrument);
    const untracked = findUntrackedPosition(this.openPositions, contractId);
    if (!untracked) return;

    const direction = POSITION_TYPE_TO_DIRECTION[untracked.type];
    console.error(`Reconciling untracked position: ${direction} ${untracked.size}x @ ${untracked.averagePrice}`);
    const trade = {
      direction,
      entryPrice: untracked.averagePrice,
      stopPrice: null,
      targetPrice: null,
      gapPct: null,
      size: untracked.size,
      contractId: untracked.contractId,
      mfe: 0,
      mae: 0,
      mongoId: null,
    };
    try {
      trade.mongoId = await tradeJournal.openTrade(trade, nowET().toDateString());
    } catch (e) {
      console.error("Mongo openTrade (reconciled) failed:", e.message);
    }
    this.openPosition = trade;
  }

  // The bracket's stop OR target filling is the only way a position disappears
  // without us calling flatten() ourselves — detected via the broker no longer
  // reporting it, since we're polling REST rather than trusting the unverified
  // user-hub push stream. Exit price/outcome are approximated from the last
  // known bar close (detection lag up to the poll interval), and the outcome
  // label picks whichever of stop/target that approx price landed closer to —
  // a logging nicety, not exact (real fill price may differ slightly). A
  // reconciled position (see above) has no known stop/target, so it degrades
  // to a generic "closed" label instead of guessing.
  detectClosedTrade() {
    if (!this.openPosition) return;
    const stillOpen = this.openPositions.some((p) => p.contractId === this.openPosition.contractId);
    if (stillOpen) return;
    const lastBar = this.bars.length ? this.bars[this.bars.length - 1] : null;
    const approxExitPrice = lastBar?.close ?? null;
    let outcome = "closed";
    if (approxExitPrice != null && this.openPosition.stopPrice != null && this.openPosition.targetPrice != null) {
      const distToStop = Math.abs(approxExitPrice - this.openPosition.stopPrice);
      const distToTarget = Math.abs(approxExitPrice - this.openPosition.targetPrice);
      outcome = distToTarget <= distToStop ? "target_hit" : "stopped_out";
    }
    this.logClosedTrade(this.openPosition, outcome);
    this.openPosition = null;
  }

  logClosedTrade(trade, outcome) {
    const lastBar = this.bars.length ? this.bars[this.bars.length - 1] : null;
    const row = buildLogRow({
      ts: new Date().toISOString(),
      direction: trade.direction,
      adx: this.priorDayAdx,
      priorClose: this.priorClose,
      gapPct: trade.gapPct,
      entryPrice: trade.entryPrice,
      stopPrice: trade.stopPrice,
      targetPrice: trade.targetPrice,
      outcome,
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
        outcome,
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
    this.todayGapChecked = false;
    this.priorClose = null;
    this.refreshAdx().catch((e) => console.error("ADX refresh failed:", e.message));
    this.refreshPriorClose(t).catch((e) => console.error("Prior close refresh failed:", e.message));
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

    if (this.openPosition && shouldFlattenNow(t, CONFIG)) {
      this.flatten(rawBar.close).catch((e) => console.error("EOD flatten failed:", e.message));
      return;
    }
    if (this.openPosition) return; // one trade at a time, nothing else to evaluate

    if (this.todayGapChecked) return; // already attempted (taken or vetoed) today
    if (!isAtOrAfterSessionOpen(t, CONFIG)) return; // wait for the first bar at/after 9:30 ET

    // This IS that first bar — evaluate exactly once, then never again today,
    // regardless of the outcome (taken or vetoed). Set before evaluating (not
    // after) so a slow/failed evaluation can't cause a second bar to re-enter
    // this branch and double-evaluate.
    this.todayGapChecked = true;

    const result = evaluateEntry({
      bar: rawBar,
      priorClose: this.priorClose,
      adxOk: this.priorDayAdxOk,
      config: CONFIG,
    });
    this.handleSignal(result);
  }

  handleSignal(result) {
    // Shared with GEX Breakout and Mechanical ORB on the same real account/
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
      priorClose: this.priorClose,
      gapPct: result.gapPct,
      vetoReason,
      entryPrice: result.entryPrice,
      stopPrice: result.stopPrice,
      targetPrice: result.targetPrice,
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
      // so a rejected order leaves openPosition/todayGapChecked untouched...
      // actually todayGapChecked is already set (see onBar), which is correct:
      // a rejected order should NOT trigger a retry later the same bar/day,
      // since the gap itself doesn't change intraday and a legitimate retry
      // isn't meaningful here the way it is for ORB's "wait for the next
      // breakout" pattern.
      orderId = await topstepx.placeBracketOrder({
        accountId,
        contractId,
        direction: result.direction,
        size,
        entryPrice: result.entryPrice,
        stopPrice: result.stopPrice,
        targetPrice: result.targetPrice,
        tickSize: topstepx.tickSizeFor(CONFIG.instrument),
        customTag: `gapcont-${result.direction}-${Date.now()}`,
      });
    } else {
      console.log(`[EXECUTION-DISABLED] would place ${result.direction} ${size}x @ ${result.entryPrice} (stop ${result.stopPrice}, target ${result.targetPrice})`);
    }

    // Set right after order confirmation (or signal-only mode) and before the
    // Discord post below, so a Discord hiccup can't leave a real fill untracked.
    this.openPosition = { ...result, size, contractId, mfe: 0, mae: 0, mongoId: null };

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
        system: "Gap Continuation",
        strategy: null,
        direction: result.direction,
        size,
        entryPrice: result.entryPrice,
        stopPrice: result.stopPrice,
        targetPrice: result.targetPrice,
        reasonFields: [
          ["Gap %", result.gapPct?.toFixed(3) ?? "n/a"],
          ["ADX", this.priorDayAdx?.toFixed(1) ?? "n/a"],
          ["Prior close", this.priorClose?.toFixed(2) ?? "n/a"],
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

// A rejected subscribeBars() (e.g. a WebSocket transport failure on the
// initial connect) is an unhandled rejection if awaited directly in
// startWorker() — confirmed live 2026-07-27: crashed the whole process on
// the very first restart after real execution was enabled, right as this bot
// started managing a real account. subscribeBars() already has
// .withAutomaticReconnect() for drops AFTER a successful connect; this
// wrapper is specifically for the initial-connect failure case, retrying
// with capped backoff instead of ever letting a connection hiccup take the
// whole worker down (the status reporter and account poller keep running
// independently either way — only the bar stream that drives new entries is
// affected while this retries).
async function subscribeBarsWithRetry(worker, attempt = 1) {
  try {
    await topstepx.subscribeBars(CONFIG.instrument, (bar) => worker.onBar(bar));
  } catch (e) {
    const waitMs = Math.min(5000 * attempt, 60000);
    console.error(`subscribeBars failed (attempt ${attempt}): ${e.message} — retrying in ${waitMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return subscribeBarsWithRetry(worker, attempt + 1);
  }
}

async function startWorker() {
  const worker = createWorker();
  console.log(`gap-continuation worker starting — signal-only mode: ${!CONFIG.executionEnabled}`);

  startStatusReporter(worker, {
    backendUrl: CONFIG.backendUrl,
    secret: CONFIG.statusSecret,
    intervalMs: 3000,
  });

  worker.checkDayRollover(nowET());
  worker.pollAccount().catch((e) => console.error("Initial account poll failed:", e.message));

  setInterval(() => worker.pollAccount().catch((e) => console.error("Account poll failed:", e.message)), 5000);

  await subscribeBarsWithRetry(worker);

  // Reads "already flushed today" from Mongo rather than an in-memory flag —
  // durable across restarts, same pattern as the other two bots.
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

// Hand-rolled file:// construction doesn't match on Windows (drive-letter paths need
// a third slash: file:///C:/... not file://C:/...) — the other two bots hit this
// live, using pathToFileURL from the start here.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startWorker();
}
