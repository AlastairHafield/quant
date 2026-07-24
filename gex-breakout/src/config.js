export const CONFIG = {
  instrumentTrade: process.env.INSTRUMENT_TRADE || "MES",
  instrumentData: process.env.INSTRUMENT_DATA || "ES",
  underlyingOptions: process.env.UNDERLYING_OPTIONS || "SPX",
  includeWeeklies: true,
  maxDte: 5,

  sessionOpenET: { h: 9, m: 30 },
  tradingCutoffET: { h: 15, m: 30 },
  sessionEndET: { h: 16, m: 0 },
  logFlushET: { h: 16, m: 5 }, // dump the day's structured log to Discord once, shortly after close

  orbWindowMin: 15,
  maxConsecLosses: 2,

  gexRecalcMin: 15,
  basisRecalcMin: 5,

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
