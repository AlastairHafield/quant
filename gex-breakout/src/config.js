// Standard CME contract multipliers, $ per index point.
export const POINT_VALUE = { MES: 5, ES: 50 };

export const CONFIG = {
  instrumentTrade: process.env.INSTRUMENT_TRADE || "MES",
  instrumentData: process.env.INSTRUMENT_DATA || "ES",

  sessionOpenET: { h: 9, m: 30 },
  // No new entries in the first 15 minutes of RTH (user's call, 2026-07-30):
  // the open is too volatile, easy to get stopped out on a wick — separate
  // from sessionOpenET itself, which stays the trading-day boundary for
  // isBarStreamStale/isDepthStreamStale's staleness watchdogs. Matches
  // mechanical-orb's own 15-min opening-range window, which already can't
  // enter before this time by construction.
  entryFloorET: { h: 9, m: 45 },
  // Widened to EOD (user's call, 2026-07-31) -- previously matched
  // mechanical-orb's noon entry cutoff, but that was borrowed from an
  // ORB-specific reason (opening-range strategies stop looking for entries
  // early) that never actually applied to Strategy B/the Order Flow Bot.
  // Set equal to flattenAtET so entries stay open right up until the forced
  // EOD flatten takes over.
  entryCutoffET: { h: 15, m: 55 },
  flattenAtET: { h: 15, m: 55 }, // matches mechanical-orb's EOD flatten time
  sessionEndET: { h: 16, m: 0 },
  logFlushET: { h: 16, m: 5 }, // dump the day's structured log to Discord once, shortly after close

  maxLossesPerStrategyPerDay: 2, // plus: a single winning trade also halts that strategy for the day (see riskSession.js)

  // If no bars arrive for this long during the trading day, worker.js's
  // watchdog forces a SignalR reconnect (see isBarStreamStale) — bars should
  // arrive roughly every minute, so 3x that comfortably absorbs a normal
  // brief lull without false-triggering on real quiet periods.
  barStaleThresholdMin: 3,
  // Depth's own version of the same watchdog — untested against a real
  // GatewayDepth cadence yet (that hub isn't live-connected until Phase 3b),
  // so this starts at the same threshold as bars and should be tuned once
  // real event frequency is observed.
  depthStaleThresholdMin: 3,

  // TopstepX-only regime signal for the Order Flow Bot (replaces net-GEX
  // NEG_GAMMA/POS_GAMMA classification, removed with GEX/FlashAlpha) — same
  // prior-day ADX filter gap-continuation and mechanical-orb already use.
  // See regime.js's classifyRegime.
  regime: {
    adxPeriod: 14,
    adxThreshold: 25,
    // Calendar days, not trading days — see the other two bots' identical
    // comment: a 40-day request only yielded 27 trading days live, one short
    // of adx(14)'s 28-bar minimum. 75 comfortably clears ~50 trading days.
    dailyLookbackDays: 75,
  },

  levels: {
    wallFilter: {
      nearPts: 15,
      // "skip" vetoes the trade outright; "half_at_wall" takes it at half size with target capped at the wall
      mode: "skip",
    },
  },

  orderFlow: {
    divergenceLookbackBars: 10,
    absorption: {
      touchBars: 3,
      volMultiple: 1.5,
      maxAdvancePts: 2,
      avgLookbackBars: 20,
    },
    flowGrade: {
      aDeltaMultiple: 1.5,
      avgLookbackBars: 20,
    },
  },

  // Trade-management defaults for the Order Flow Bot (orderFlowBot.js) —
  // breakevenAtR/takePartialFraction are applied unconditionally to every
  // open trade (worker.js's evaluateOpenTrades/actOnExitResult).
  tradeManagement: {
    stopCapPts: 12,
    breakevenAtR: 1,
    takePartialFraction: 0.5,
  },

  orderFlowBot: {
    triggerBufferPts: 1,
    // Macro/geopolitical bias is deliberately a manual on/off toggle, not coded
    // prediction logic (per the 2026-07-29 design discussion — monetary policy/
    // GDP/inflation/labor-market cycle phases move too slowly to be a useful
    // intraday signal, and geopolitical risk is inherently qualitative). Defaults
    // true so a missing env var can't silently halt trading; flip to "false" by
    // hand around known event risk (FOMC, CPI, major geopolitical headlines).
    macroOverrideEnabled: process.env.ORDER_FLOW_MACRO_ON !== "false",
    maxTradesPerDay: 3,
    cooldownMinPerZone: 60,
    // How often to log a diagnostic snapshot (why POLR/LOP didn't fire, plus
    // regime/zone/POC state) when a bar produces zero trigger at all — the
    // Order Flow Bot's own version of Strategy B's skip-visibility logging,
    // added 2026-07-30 after a full live session produced zero OF rows (real
    // or veto) with no way to tell "no trigger fired" from "something's
    // silently broken." Not per-bar (would flood the dashboard's recentLog
    // and bury real signals) — sampled on this interval instead.
    diagnosticHeartbeatMin: 15,
    volumeProfile: {
      bucketSizePts: 1,
      valueAreaPct: 0.7,
      minSessionBars: 30,
      compositeDays: 5,
      // How many trailing bars detectFailedAuction looks back across to find
      // a probe outside the value area — separate from minSessionBars (which
      // gates whether the whole session profile is trustworthy yet).
      probeLookbackBars: 5,
    },
    footprint: {
      bucketSizePts: 1,
      imbalanceRatio: 3,
      minStackedLevels: 3,
      bigTradeSizeThreshold: 50,
      // How many trailing bars detectTrappedParticipants looks across to
      // confirm price failed to continue past a big trade's price.
      reversalLookbackBars: 5,
    },
    depth: {
      sizeThreshold: 100, // resting-size floor to flag a candidate large order — tune live, no backtest possible
      heatmapDecay: 0.98,
      // Starts OFF: Level 2-derived signals are logged/observed, not load-bearing,
      // until separately proven live — isolates "is the core bot sound" from "does
      // the L2 addition actually help" as two separate go-live decisions.
      gateEntries: false,
    },
    // Trend-continuation trigger — see orderFlow.js's detectPathOfLeastResistance.
    pathOfLeastResistance: {
      lookbackBars: 4,
      volumeLightMultiple: 2,
      avgLookbackBars: 20,
    },
    // Exhaustion/fade trigger — see orderFlow.js's detectLackOfParticipation.
    lackOfParticipation: {
      lookbackBars: 4,
      volumeDeclineMultiple: 2,
    },
    exit: {
      trendTrailBufferPts: 2,
      // Only used if TopstepX's bracket API turns out to reject a null/omitted
      // take-profit for the trend-day "no fixed TP" design — verify live before
      // relying on this rather than assuming it's needed.
      placeholderTargetDistancePts: 500,
    },
    // Independent of the top-level executionEnabled/account switch — mirrors the
    // exact precedent the old Strategy A had: stays signal-only even once the
    // bot-wide flag and Strategy B are live, until the Order Flow Bot gets its own
    // separate go-live decision (see the plan's Phase 6 checklist).
    executionEnabled: process.env.STRATEGY_OF_EXECUTION_ENABLED === "true",
    // Trades its OWN account (the practice account) — same account-role ("A")
    // Strategy A used, just a new strategy tag ("OF"). See worker.js's
    // accountRoleFor/resolveAccountIdForRole.
    accountNameHint: process.env.STRATEGY_OF_ACCOUNT_NAME || null,
  },

  exit: {
    divergenceWithinBarsOfEntry: 5,
  },

  risk: {
    // Account-WIDE cap in $ on the real Combine (role "default", shared with
    // gap-continuation and mechanical-orb) — NOT applied to the Order Flow
    // Bot's practice account (role "A"), which isn't real money. See
    // shared/accountRisk.js. Not set = unenforced (worker.js logs a startup
    // warning so this can't silently be "off" without anyone noticing).
    dailyLossCapDollars: process.env.ACCOUNT_DAILY_LOSS_CAP_DOLLARS
      ? Number(process.env.ACCOUNT_DAILY_LOSS_CAP_DOLLARS)
      : null,
    // Order Flow Bot flow-grade sizing (strong-flow "A" vs weak-flow "B"
    // confirming order flow, unrelated to the old Strategy A/B strategy
    // identities) — see computeSizeMultiplier (riskSession.js). The
    // equity ladder that used to scale Strategy B's size on the real
    // Combine was removed with Strategy B itself (topstep-prop-firm-plan's
    // real-money ladder, and the class of bug it caused live on 2026-07-28,
    // is now moot — the Order Flow Bot trades the practice account flat,
    // see worker.js's handleSignal).
    sizing: {
      A: 4,
      B: 2,
    },
  },

  discord: {
    signalWebhook: process.env.DISCORD_WEBHOOK || null,
    logWebhook: process.env.LOG_WEBHOOK || process.env.DISCORD_WEBHOOK || null,
  },

  executionEnabled: process.env.EXECUTION_ENABLED === "true",
};
