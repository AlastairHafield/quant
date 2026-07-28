// Aggregates a day's persisted Mongo data (trades, in-trade management
// actions, and every evaluated signal including vetoes) into the numbers the
// user actually asked for: win rate, R-multiple, $ P&L, and how much the
// dynamic-exit machinery saved or gained — computed here as pure functions so
// they're testable without touching Mongo, then queried and posted once daily
// by worker.js's existing scheduled-flush interval.

export function computeTradeStats(trades) {
  // excludedFromStats: a manual, one-off tag for a trade that's a data-quality
  // incident, not real strategy performance (e.g. the 2026-07-28 ladder-sizing
  // bug's two 30-contract Strategy B trades) — the doc stays in Mongo as an
  // accurate historical record (still visible in the raw Trade Journal table),
  // but is left out of every aggregate below entirely, byStrategy included,
  // since including it would still misrepresent the strategy's real behavior.
  const closed = trades.filter((t) => t.status === "closed" && t.realizedPnl != null && !t.excludedFromStats);

  // Strategy A trades on its own practice account (see worker.js's
  // accountRoleFor) — real broker fills, but not real money. Excluded from
  // every headline figure below so a good or bad day on the practice account
  // never gets silently blended into the $ P&L this number is supposed to
  // represent; still visible via byStrategy (all trades) and the separate
  // `practice` breakdown below.
  const real = closed.filter((t) => (t.accountRole ?? "default") !== "A");
  const practice = closed.filter((t) => (t.accountRole ?? "default") === "A");

  const wins = real.filter((t) => t.realizedPnl > 0);
  const losses = real.filter((t) => t.realizedPnl < 0);
  const totalRealizedPnl = real.reduce((sum, t) => sum + t.realizedPnl, 0);

  const rMultiples = real
    .map((t) => {
      if (t.originalStopPrice == null || t.exitPrice == null) return null;
      const risk = Math.abs(t.entryPrice - t.originalStopPrice);
      if (risk === 0) return null;
      const pts = t.direction === "long" ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice;
      return pts / risk;
    })
    .filter((r) => r != null);
  const avgRMultiple = rMultiples.length ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : null;

  const byStrategy = {};
  for (const t of closed) {
    byStrategy[t.strategy] ??= { count: 0, pnl: 0 };
    byStrategy[t.strategy].count += 1;
    byStrategy[t.strategy].pnl += t.realizedPnl;
  }

  // Manual closes (user-initiated, outside the bot's own bracket orders — see
  // worker.js's classifyPassiveClose) broken out separately so it's possible to
  // see, over time, whether stepping in helps or hurts vs. leaving the bracket
  // alone. Scoped to `real` for the same reason as the headline figures above.
  const manualClosed = real.filter((t) => t.outcome === "manual_close");
  const manualCloses = {
    count: manualClosed.length,
    wins: manualClosed.filter((t) => t.realizedPnl > 0).length,
    losses: manualClosed.filter((t) => t.realizedPnl < 0).length,
    pnl: manualClosed.reduce((sum, t) => sum + t.realizedPnl, 0),
  };

  const practiceStats = {
    count: practice.length,
    wins: practice.filter((t) => t.realizedPnl > 0).length,
    losses: practice.filter((t) => t.realizedPnl < 0).length,
    pnl: practice.reduce((sum, t) => sum + t.realizedPnl, 0),
  };

  return {
    totalTrades: real.length,
    wins: wins.length,
    losses: losses.length,
    winRate: real.length ? wins.length / real.length : null,
    totalRealizedPnl,
    avgRMultiple,
    byStrategy,
    manualCloses,
    practice: practiceStats,
  };
}

export function computeVetoBreakdown(signals) {
  const byReason = {};
  for (const s of signals) {
    if (!s.veto_reason) continue;
    byReason[s.veto_reason] = (byReason[s.veto_reason] || 0) + 1;
  }
  return byReason;
}

export function computeDynamicExitStats(exitActions) {
  const byAction = {};
  let totalValueImpact = 0;
  for (const a of exitActions) {
    const impact = a.valueImpact || 0;
    totalValueImpact += impact;
    byAction[a.action] ??= { count: 0, valueImpact: 0 };
    byAction[a.action].count += 1;
    byAction[a.action].valueImpact += impact;
  }
  return { totalValueImpact, byAction };
}

export function computeDailySummary(trades, exitActions, signals) {
  return {
    trades: computeTradeStats(trades),
    vetoes: computeVetoBreakdown(signals),
    dynamicExits: computeDynamicExitStats(exitActions),
  };
}
