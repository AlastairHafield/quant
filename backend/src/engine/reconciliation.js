// Live-vs-backtest reconciliation — the mechanism that catches "this
// strategy stopped working in the real market even though nothing about its
// code changed," by comparing a strategy's actual recent live trade outcomes
// (from tradeJournalMongo.js's unified ledger) against what a backtest of
// its CURRENT live configuration would have predicted over that same window.
//
// Deliberately does NOT try to auto-map a live bot's config.js onto a
// backtest engine's own param names here — that mapping is specific to each
// strategy (see each bot's own config.js comments for what was actually
// validated, e.g. mechanical-orb's orb-alpaca-1m-findings /
// gap-continuation's gap-fill-findings memory references) and getting it
// silently wrong here would produce a confidently-wrong drift report, worse
// than having none. Call the matching backtest engine (orbBacktest.js for
// mechanical-orb, gapFillBacktest.js for gap-continuation) yourself with the
// live bot's actual parameters over the same date range, and pass its
// `metrics.full` (or `.oos`) straight in as backtestStats — the field names
// below (winRate, expectancy) are exactly computeBacktestMetrics's own.

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Reduces an array of CLOSED live trade docs (tradeJournalMongo.js's
// fetchLedgerTrades — needs realizedPnl, not the sized backtest pnl_dollars,
// but the same shape a backtest's expectancy/winRate already summarize) into
// the same {totalTrades, winRate, expectancy, totalPnlDollars} shape
// computeBacktestMetrics's metricSet produces, so the two are directly
// comparable without any unit conversion.
export function summarizeLiveTrades(trades) {
  const closed = trades.filter((t) => t.status === 'closed' && typeof t.realizedPnl === 'number');
  const wins = closed.filter((t) => t.realizedPnl > 0).length;
  const totalPnlDollars = closed.reduce((s, t) => s + t.realizedPnl, 0);
  return {
    totalTrades: closed.length,
    winRate: closed.length ? round2((wins / closed.length) * 100) : 0,
    expectancy: closed.length ? round2(totalPnlDollars / closed.length) : 0,
    totalPnlDollars: round2(totalPnlDollars),
  };
}

// Compares in $ terms (win rate + expectancy, i.e. avg $ per trade) rather
// than % return — a futures trade's dollar P&L doesn't have a clean, stable
// "% of notional" the way a stock trade does (position sizing, margin, and
// contract multiplier all get in the way), so $ per trade is the more
// robust, unit-consistent comparison for these bots.
export function computeLiveVsBacktestDrift(liveStats, backtestStats, tolerances = {}) {
  const { winRatePts = 15, expectancyRelative = 0.5, minLiveTrades = 5 } = tolerances;

  if (!liveStats || liveStats.totalTrades < minLiveTrades) {
    return { comparable: false, reason: `Fewer than ${minLiveTrades} live trades in this window — not enough to compare.` };
  }
  if (!backtestStats || !backtestStats.totalTrades) {
    return { comparable: false, reason: 'No backtest trades to compare against for this window.' };
  }

  const winRateDeltaPts = round2(liveStats.winRate - backtestStats.winRate);
  const expectancyDeltaPct = backtestStats.expectancy !== 0
    ? round2(((liveStats.expectancy - backtestStats.expectancy) / Math.abs(backtestStats.expectancy)) * 100)
    : null;

  const winRateDrift = Math.abs(winRateDeltaPts) > winRatePts;
  const expectancyDrift = expectancyDeltaPct != null && Math.abs(expectancyDeltaPct) / 100 > expectancyRelative;

  return {
    comparable: true,
    liveTrades: liveStats.totalTrades,
    backtestTrades: backtestStats.totalTrades,
    winRateDeltaPts,
    expectancyDeltaPct,
    drift: winRateDrift || expectancyDrift,
    driftReasons: [
      winRateDrift ? `win rate off by ${winRateDeltaPts}pts (tolerance ${winRatePts}pts)` : null,
      expectancyDrift ? `expectancy off by ${expectancyDeltaPct}% relative (tolerance ${Math.round(expectancyRelative * 100)}%)` : null,
    ].filter(Boolean),
  };
}

// ─── Shadow-day reports for the promotion gate ───────────────────────────
//
// promotionGate.js needs one { dayKey, drift } per consecutive practice-
// account trading day. The naive reading — compare THAT day's own trades
// against the backtest — silently defeats the whole check for a low-
// frequency strategy: gap-continuation and mechanical-orb each trade only a
// handful of times a MONTH, so a single day almost never reaches
// computeLiveVsBacktestDrift's default minLiveTrades:5, and an
// always-"not comparable" day never counts as drift. The gate would then
// approve promotion having never actually been able to check for drift —
// not because the strategy passed, but because it was never really tested.
//
// Fixed here by making each day's comparison CUMULATIVE: day N's drift
// compares every shadow trade from day 1 through day N (inclusive) against
// the backtest, not day N alone. This is also a better match for what
// "N consecutive clean shadow days" is actually meant to establish — that
// live behavior hasn't drifted over the course of the shadow period, not
// that any single arbitrary day was individually representative.
//
// dailyTradeGroups: chronologically-sorted array of { dayKey, trades }
// (trades = that day's own CLOSED live trade docs only) — build with
// groupTradesByDay below.
export function buildShadowDayReports(dailyTradeGroups, backtestStats, tolerances = {}) {
  const cumulative = [];
  const reports = [];
  for (const { dayKey, trades } of dailyTradeGroups) {
    cumulative.push(...trades);
    const liveStats = summarizeLiveTrades(cumulative);
    reports.push({ dayKey, cumulativeLiveTrades: liveStats.totalTrades, drift: computeLiveVsBacktestDrift(liveStats, backtestStats, tolerances) });
  }
  return reports;
}

// Buckets a flat trade list (tradeJournalMongo.js's fetchLedgerTrades — any
// shape carrying closedAt/status/realizedPnl) into chronologically-sorted
// per-day groups of CLOSED trades, keyed by the calendar-date portion of
// closedAt (an ISO string) — NOT the trades' own dayKey field, which is a
// Date.prototype.toDateString() string ("Www Mon DD YYYY") that does not
// sort chronologically (see tradeJournalMongo.js's fetchDailySummaries
// comment for the same trap caught there before).
export function groupTradesByDay(trades) {
  const closed = trades.filter((t) => t.status === 'closed' && typeof t.realizedPnl === 'number' && t.closedAt);
  const byDate = new Map();
  for (const t of closed) {
    const date = t.closedAt.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(t);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dayKey, dayTrades]) => ({ dayKey, trades: dayTrades }));
}
