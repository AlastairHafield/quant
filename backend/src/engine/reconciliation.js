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
