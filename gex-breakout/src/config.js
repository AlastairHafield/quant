// Standard CME contract multipliers, $ per index point.
export const POINT_VALUE = { MES: 5, ES: 50 };

export const CONFIG = {
  instrumentTrade: process.env.INSTRUMENT_TRADE || "MES",
  instrumentData: process.env.INSTRUMENT_DATA || "ES",
  underlyingOptions: process.env.UNDERLYING_OPTIONS || "SPX",
  includeWeeklies: true,
  maxDte: 5,

  sessionOpenET: { h: 9, m: 30 },
  entryCutoffET: { h: 12, m: 0 }, // matches mechanical-orb's entry window
  flattenAtET: { h: 15, m: 55 }, // matches mechanical-orb's EOD flatten time
  sessionEndET: { h: 16, m: 0 },
  logFlushET: { h: 16, m: 5 }, // dump the day's structured log to Discord once, shortly after close

  orbWindowMin: 15,
  maxLossesPerStrategyPerDay: 2, // plus: a single winning trade also halts that strategy for the day (see riskSession.js)

  gexRecalcMin: 15,
  basisRecalcMin: 5,
  // If no bars arrive for this long during the trading day, worker.js's
  // watchdog forces a SignalR reconnect (see isBarStreamStale) — bars should
  // arrive roughly every minute, so 3x that comfortably absorbs a normal
  // brief lull without false-triggering on real quiet periods.
  barStaleThresholdMin: 3,

  gex: {
    // GEX_strike = gamma * OI * 100 * spot^2 * 0.01
    sign: { call: 1, put: -1 },
    // 0DTE same-day volume blended in as an OI staleness proxy: effectiveOI = OI + blendWeight * volume
    staleness: {
      blendWeight: 0.5,
      useVolumeBlend: false,
      reducedConfidenceAfterET: { h: 12, m: 0 },
    },
    wallCount: 3,
  },

  regime: {
    nearFlipPts: 10,
  },

  levels: {
    consolidation: {
      lookbackBars: 20,
      maxRangePts: 8,
    },
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

  strategyA: {
    triggerBufferPts: 1,
    entryMode: "trigger_close", // "trigger_close" | "pullback"
    stopCapPts: 12,
    targetMaxDistancePts: 30,
    fixedTargetR: 2,
    breakevenAtR: 1,
    runner: {
      enabled: true,
      offFractionAtTarget: 0.5,
      trailBars: 2,
    },
    // Independent of the top-level executionEnabled/account switch — Strategy A
    // (the 15-min ORB variant) stays signal-only even once the account points at
    // the real Combine and Strategy B is live there, until A gets its own
    // separate go-live decision (2026-07-27: moved Strategy B, the general
    // level-breakout, to the real Combine; A explicitly held back).
    executionEnabled: process.env.STRATEGY_A_EXECUTION_ENABLED === "true",
    // Strategy A trades its OWN account (the practice account), separate from
    // everything else's TOPSTEPX_ACCOUNT_NAME (the real Combine) — worker.js
    // routes orders/position-polling/closes per-strategy using this. Required
    // once STRATEGY_A_EXECUTION_ENABLED is true and more than one tradable
    // account exists — resolveAccountId refuses to guess rather than risk
    // placing a real practice-vs-Combine order on the wrong one.
    accountNameHint: process.env.STRATEGY_A_ACCOUNT_NAME || null,
  },

  strategyB: {
    triggerBufferPts: 1,
    proximity: {
      withinPts: 10,
      forMinutes: 15,
    },
    cooldownMinPerLevel: 60,
    maxTradesPerDay: 3,
  },

  exit: {
    failedBreakoutPts: 2,
    divergenceWithinBarsOfEntry: 5,
    posGammaTrailBars: 1,
  },

  risk: {
    recalcSettle: {
      flipMoveThresholdPts: 5,
      noEntryMinutesAfterRecalc: 1,
    },
    halt: {
      basisStaleMaxMin: 10,
      deltaFeedGapMaxMin: 2,
    },
    sizing: {
      A: 4,
      B: 2,
      // Scales Strategy B's base size above by ladderContracts(equity)/ladder.baseContracts
      // as account equity grows, preserving the wall-proximity multiplier rather than
      // replacing it with a flat count (topstep-prop-firm-plan Phase 3: 1 contract base,
      // +1 per $2,000 of equity growth, capped at 15).
      // startingEquity MUST be this specific account's actual nominal starting balance,
      // not a generic reference value — the Phase 3 plan's $2,000 figure was written for
      // an eventual real PERSONAL account, not this $50K Combine (account name "50KTC").
      // Bug caught live 2026-07-28: with startingEquity left at $2,000 against a real
      // ~$49,587 Combine balance, the ladder read that as "grown from $2K to $50K" and
      // instantly maxed out at the 15x cap — two real Strategy B trades fired at 30
      // contracts (2 base x 15x) instead of ~2. Only Strategy B uses this; Strategy A
      // trades the practice account (an arbitrary, not-necessarily-stable balance) and
      // stays flat (ratio 1x, see worker.js's handleSignal) until practice-account
      // sizing gets its own deliberate calibration.
      ladder: {
        baseContracts: 1,
        perContractEquityStep: 2000,
        startingEquity: 50000,
        cap: 15,
      },
    },
  },

  discord: {
    signalWebhook: process.env.DISCORD_WEBHOOK || null,
    logWebhook: process.env.LOG_WEBHOOK || process.env.DISCORD_WEBHOOK || null,
  },

  posGammaOverride: {
    enabled: false,
    requireFlowGrade: "A",
  },

  executionEnabled: process.env.EXECUTION_ENABLED === "true",
};
