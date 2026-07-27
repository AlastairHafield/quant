// Aggregates a day's persisted Mongo data (trades, in-trade management
// actions, and every evaluated signal including vetoes) into the numbers the
// user actually asked for: win rate, R-multiple, $ P&L, and how much the
// dynamic-exit machinery saved or gained — computed here as pure functions so
// they're testable without touching Mongo, then queried and posted once daily
// by worker.js's existing scheduled-flush interval.

export function computeTradeStats(trades) {
  const closed = trades.filter((t) => t.status === "closed" && t.realizedPnl != null);
  const wins = closed.filter((t) => t.realizedPnl > 0);
  const losses = closed.filter((t) => t.realizedPnl < 0);
  const totalRealizedPnl = closed.reduce((sum, t) => sum + t.realizedPnl, 0);

  const rMultiples = closed
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
  // see, over time, whether stepping in helps or hurts vs. leaving the bracket alone.
  const manualClosed = closed.filter((t) => t.outcome === "manual_close");
  const manualCloses = {
    count: manualClosed.length,
    wins: manualClosed.filter((t) => t.realizedPnl > 0).length,
    losses: manualClosed.filter((t) => t.realizedPnl < 0).length,
    pnl: manualClosed.reduce((sum, t) => sum + t.realizedPnl, 0),
  };

  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    totalRealizedPnl,
    avgRMultiple,
    byStrategy,
    manualCloses,
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
