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

  maxLossesPerStrategyPerDay: 2, // plus: a single winning trade also halts that strategy for the day (see riskSession.js)

  gexRecalcMin: 15,
  basisRecalcMin: 5,
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

  // Shared trade-management defaults — read by Strategy B (strategyB.js) AND the
  // Order Flow Bot (orderFlowBot.js). breakevenAtR/takePartialFraction are applied
  // unconditionally to EVERY open trade regardless of which strategy opened it
  // (worker.js's evaluateOpenTrades/actOnExitResult), not just one strategy's —
  // this used to live under the (removed) strategyA config block despite that.
  tradeManagement: {
    stopCapPts: 12,
    targetMaxDistancePts: 30,
    fixedTargetR: 2,
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
