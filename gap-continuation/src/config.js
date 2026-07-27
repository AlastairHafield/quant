// Standard CME contract multipliers, $ per index point.
export const POINT_VALUE = { MES: 5, ES: 50 };

export const CONFIG = {
  instrument: process.env.INSTRUMENT || "MES",
  tickSize: 0.25,

  sessionOpenET: { h: 9, m: 30 },
  flattenAtET: { h: 15, m: 55 }, // a few minutes before the 16:00 close, to ensure the fill lands in RTH
  logFlushET: { h: 16, m: 5 }, // dump the day's structured log to Discord once, shortly after close

  // Validated config (gap-fill-findings memory, 2026-07-27 refinement, 502
  // trades / 187 OOS on real 16yr ES data): gap = today's first RTH bar's
  // OPEN vs yesterday's last RTH bar's CLOSE, entry fills at that first bar's
  // CLOSE. Direction follows the gap's own sign (CONTINUATION, not fade).
  gapMinPct: 0.5, // minimum |gap| % (vs prior close) required to trade at all
  stopParam: 0.5, // stop distance = stopParam x the gap's own size, placed on the adverse side of entry
  targetParam: 1.0, // target distance = targetParam x the stop distance (1:1 R:R)

  // Yesterday's RTH close is read from recent historical bars, not the daily-bar
  // API's own "close" (which may reflect the full Globex session, not RTH
  // specifically) — same RTH-session definition the backtest used. Calendar
  // minutes, not trading minutes, so this needs to comfortably span a weekend
  // (Friday RTH close -> Monday's evaluation) or a long holiday weekend.
  priorCloseLookbackMin: 4320, // 3 calendar days

  regime: {
    adxPeriod: 14,
    adxThreshold: 25, // prior-day ADX >= 25 required to arm the strategy that day
    // Calendar days, not trading days — a 40-day request only yielded 27 trading
    // days live (one short of adx(14)'s 28-bar minimum) on mechanical-orb's
    // identical filter. 75 calendar days comfortably clears ~50 trading days.
    dailyLookbackDays: 75,
  },

  sizing: {
    mode: "FLAT", // "FLAT" | "LADDER" — pinned to FLAT for this initial live run
    flatContracts: 1,
    ladder: {
      // Reusable for an eventual real-money phase (topstep-prop-firm-plan): start
      // at 1 contract, +1 per $2,000 of equity growth, capped at 15. Not active
      // while sizing.mode is "FLAT". Backtested (gap-fill-findings): this specific
      // edge is small enough in $ terms that the ladder barely outgrows flat
      // sizing over a realistic window — contract count matters more than
      // compounding here.
      baseContracts: 1,
      perContractEquityStep: 2000,
      startingEquity: 2000,
      cap: 15,
    },
  },

  accountNameHint: process.env.GAP_CONTINUATION_ACCOUNT_NAME || null,

  discord: {
    webhook: process.env.DISCORD_WEBHOOK || null,
    logWebhook: process.env.LOG_WEBHOOK || null,
  },

  backendUrl: process.env.BACKEND_URL || "http://localhost:3001",
  statusSecret: process.env.GAP_CONTINUATION_STATUS_SECRET || null,

  executionEnabled: process.env.GAP_CONTINUATION_EXECUTION_ENABLED === "true",
};
