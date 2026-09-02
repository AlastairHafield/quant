// Standard CME contract multipliers, $ per index point.
export const POINT_VALUE = { MES: 5, ES: 50 };

export const CONFIG = {
  instrument: process.env.INSTRUMENT || "MES",
  tickSize: 0.25,

  sessionOpenET: { h: 9, m: 30 },
  orWindowMin: 15,
  entryCutoffET: { h: 12, m: 0 },
  flattenAtET: { h: 15, m: 55 }, // a few minutes before the 16:00 close, to ensure the fill lands in RTH
  logFlushET: { h: 16, m: 5 }, // dump the day's structured log to Discord once, shortly after close

  direction: "long", // validated LONG-only — SHORT loses outright, BOTH dilutes the edge (orb-alpaca-1m-findings)
  triggerBufferPts: 0, // validated config used a plain CLOSE trigger, no extra buffer beyond the OR itself

  stop: {
    fracOfOrRange: 1.5, // stopDistance = 1.5 * (orHigh - orLow), placed below entry for a long
  },

  regime: {
    adxPeriod: 14,
    adxThreshold: 25, // prior-day ADX >= 25 required to arm the strategy that day
    // Calendar days, not trading days — a 40-day request only yielded 27 trading
    // days live (one short of adx(14)'s 28-bar minimum). 75 calendar days comfortably
    // clears ~50 trading days even accounting for weekends/holidays, giving the ADX
    // series real room to stabilize past the bare minimum.
    dailyLookbackDays: 75,
  },

  sizing: {
    mode: "FLAT", // "FLAT" | "LADDER" — pinned to FLAT for this practice-account monitoring run
    flatContracts: 1,
    ladder: {
      // Reusable for the eventual real-money phase (topstep-prop-firm-plan): start
      // at 1 contract, +1 per $2,000 of equity growth, capped at 15. Not active
      // while sizing.mode is "FLAT".
      baseContracts: 1,
      perContractEquityStep: 2000,
      startingEquity: 2000,
      cap: 15,
    },
  },

  accountNameHint: process.env.MECHANICAL_ORB_ACCOUNT_NAME || null,

  // Practice-account shadow mode (topstep-prop-firm-plan Phase 4): when
  // ACCOUNT_MODE=practice, this bot instance trades a TopstepX practice/eval
  // account instead of the real Combine — same account-selection mechanism
  // gex-breakout's Order Flow Bot already uses (topstepx.resolveAccountId
  // takes an explicit hint), just applied to the whole bot rather than
  // per-strategy since this bot only ever runs one strategy. Defaults to
  // "live" — a bot must be EXPLICITLY told to run in practice mode, never
  // silently switched by an unset env var.
  accountMode: process.env.ACCOUNT_MODE === "practice" ? "practice" : "live",
  practiceAccountNameHint: process.env.MECHANICAL_ORB_PRACTICE_ACCOUNT_NAME || null,

  risk: {
    // Account-WIDE cap in $, shared across every bot trading this same real
    // Combine (mechanical-orb, gap-continuation) — see shared/accountRisk.js.
    // Not set = unenforced (worker.js logs a startup warning so this can't
    // silently be "off" without anyone noticing). Only applies in "live"
    // accountMode — a practice account isn't real money.
    dailyLossCapDollars: process.env.ACCOUNT_DAILY_LOSS_CAP_DOLLARS
      ? Number(process.env.ACCOUNT_DAILY_LOSS_CAP_DOLLARS)
      : null,
  },

  discord: {
    webhook: process.env.DISCORD_WEBHOOK || null,
    logWebhook: process.env.LOG_WEBHOOK || null,
  },

  backendUrl: process.env.BACKEND_URL || "http://localhost:3001",
  statusSecret: process.env.MECHANICAL_ORB_STATUS_SECRET || null,

  executionEnabled: process.env.MECHANICAL_ORB_EXECUTION_ENABLED === "true",
};
