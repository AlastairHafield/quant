// Trade-print footprint — the Order Flow Bot's trend-day Zones, plus
// big-trade/trapped-participant triggers. Fed by
// dataSources/topstepx.js's FootprintBarAggregator, which buckets the same
// GatewayTrade stream TradeBarAggregator already consumes (no new
// subscription) at exact traded-price granularity — this module does the
// coarser re-bucketing to orderFlowBot.footprint.bucketSizePts.

import { priceToBucket } from "./volumeProfile.js";

function mergeFootprintLevels(footprintBars, bucketSizePts) {
  const merged = new Map();
  for (const bar of footprintBars) {
    for (const level of bar) {
      const key = priceToBucket(level.price, bucketSizePts);
      const existing = merged.get(key) ?? { buyVolume: 0, sellVolume: 0 };
      existing.buyVolume += level.buyVolume;
      existing.sellVolume += level.sellVolume;
      merged.set(key, existing);
    }
  }
  return [...merged.entries()]
    .map(([price, v]) => ({ price, buyVolume: v.buyVolume, sellVolume: v.sellVolume }))
    .sort((a, b) => a.price - b.price);
}

function sideOf(level, imbalanceRatio) {
  if (level.buyVolume >= imbalanceRatio * Math.max(level.sellVolume, 1e-9)) return "buy";
  if (level.sellVolume >= imbalanceRatio * Math.max(level.buyVolume, 1e-9)) return "sell";
  return null;
}

function buildZone(run) {
  return {
    side: run[0].side,
    low: run[0].price,
    high: run[run.length - 1].price,
    buyVolume: run.reduce((s, l) => s + l.buyVolume, 0),
    sellVolume: run.reduce((s, l) => s + l.sellVolume, 0),
  };
}

// Finds stacked buy/sell imbalance zones: minStackedLevels+ CONSECUTIVE price
// buckets where one side's volume exceeds imbalanceRatio times the other,
// merged across however many footprint bars the caller passes in (the
// window is the caller's choice — e.g. the whole session, or a trailing N
// bars, same as detectConsolidation's caller-chosen lookback).
export function buildFootprintZones(footprintBars, { bucketSizePts, imbalanceRatio, minStackedLevels }) {
  const levels = mergeFootprintLevels(footprintBars, bucketSizePts);

  const zones = [];
  let run = [];
  for (const level of levels) {
    const side = sideOf(level, imbalanceRatio);
    if (side && (run.length === 0 || run[0].side === side)) {
      run.push({ ...level, side });
    } else {
      if (run.length >= minStackedLevels) zones.push(buildZone(run));
      run = side ? [{ ...level, side }] : [];
    }
  }
  if (run.length >= minStackedLevels) zones.push(buildZone(run));
  return zones;
}

export function detectBigTrade(trade, { bigTradeSizeThreshold }) {
  return trade.volume >= bigTradeSizeThreshold;
}

// A large print in one direction that price then fails to follow through on
// and instead reverses — the aggressive participant getting trapped rather
// than starting a real move. Retrospective (bars up to and including
// `index` only), like the Order Flow Bot's other triggers, matching the
// plan's no-forward-confirmation-bar design. `bigTrade` is `{price, type}`
// (type 0 = buy aggressor, 1 = sell aggressor, same convention as
// FootprintBarAggregator's raw trades) already identified via detectBigTrade.
export function detectTrappedParticipants(bars, index, bigTrade, { reversalLookbackBars }) {
  if (!bigTrade) return null;
  const direction = bigTrade.type === 0 ? "long" : "short";
  const bar = bars[index];

  const reversedAlready = direction === "long" ? bar.close < bigTrade.price : bar.close > bigTrade.price;
  if (!reversedAlready) return null;

  const start = Math.max(0, index - reversalLookbackBars + 1);
  const window = bars.slice(start, index + 1);
  const extreme =
    direction === "long"
      ? Math.max(...window.map((b) => b.high ?? b.close))
      : Math.min(...window.map((b) => b.low ?? b.close));
  const failedToContinue = direction === "long" ? extreme <= bigTrade.price : extreme >= bigTrade.price;
  if (!failedToContinue) return null;

  return { direction: direction === "long" ? "short" : "long", trappedPrice: bigTrade.price };
}
