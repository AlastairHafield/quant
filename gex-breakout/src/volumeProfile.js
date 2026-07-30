// Volume profile — the Order Flow Bot's mean-reversion Zones (POC, value
// area, business zone, failed auction). Only 1-min OHLCV is available here
// (no tick-level price-at-volume from either the live feed or Databento's
// ohlcv-1m schema), so this is an approximation: each bar's volume is spread
// evenly across the price buckets its [low,high] range spans, not a true
// trade-by-trade profile.

export function priceToBucket(price, bucketSizePts) {
  // Round the bucketed result too, not just divide/multiply — repeated
  // float division/multiplication on non-integer bucketSizePts drifts
  // (e.g. 100.30000000000001), which would silently split one real bucket
  // into two Map keys.
  return Number((Math.round(price / bucketSizePts) * bucketSizePts).toFixed(6));
}

export function buildSessionProfile(bars, { bucketSizePts }) {
  const volumeByBucket = new Map();
  for (const bar of bars) {
    const low = bar.low ?? bar.close;
    const high = bar.high ?? bar.close;
    const barVolume = bar.volume ?? (bar.buyVolume ?? 0) + (bar.sellVolume ?? 0);
    const lowBucket = priceToBucket(low, bucketSizePts);
    const highBucket = priceToBucket(high, bucketSizePts);
    const bucketCount = Math.round((highBucket - lowBucket) / bucketSizePts) + 1;
    const volumePerBucket = barVolume / bucketCount;
    for (let i = 0; i < bucketCount; i++) {
      const key = priceToBucket(lowBucket + i * bucketSizePts, bucketSizePts);
      volumeByBucket.set(key, (volumeByBucket.get(key) || 0) + volumePerBucket);
    }
  }
  return [...volumeByBucket.entries()]
    .map(([price, volume]) => ({ price, volume }))
    .sort((a, b) => a.price - b.price);
}

export function findPOC(profile) {
  if (!profile.length) return null;
  return profile.reduce((max, p) => (p.volume > max.volume ? p : max)).price;
}

// Standard market-profile Value Area expansion: starting from the POC row,
// repeatedly compare the next TWO rows above vs the next TWO rows below and
// add whichever pair holds more volume, until accumulated volume clears
// valueAreaPct of the session total (falls back to a single row when only
// one side has room left, at the edge of the profile).
export function computeValueArea(profile, poc, valueAreaPct) {
  if (!profile.length || poc == null) return null;
  const sorted = [...profile].sort((a, b) => a.price - b.price);
  const totalVolume = sorted.reduce((s, p) => s + p.volume, 0);
  const target = totalVolume * valueAreaPct;

  const pocIndex = sorted.findIndex((p) => p.price === poc);
  let loIndex = pocIndex;
  let hiIndex = pocIndex;
  let accumulated = sorted[pocIndex].volume;

  while (accumulated < target && (loIndex > 0 || hiIndex < sorted.length - 1)) {
    const canGoAbove = hiIndex < sorted.length - 1;
    const canGoBelow = loIndex > 0;
    const aboveVol = canGoAbove
      ? (sorted[hiIndex + 1]?.volume ?? 0) + (sorted[hiIndex + 2]?.volume ?? 0)
      : -Infinity;
    const belowVol = canGoBelow
      ? (sorted[loIndex - 1]?.volume ?? 0) + (sorted[loIndex - 2]?.volume ?? 0)
      : -Infinity;

    if (canGoAbove && (!canGoBelow || aboveVol >= belowVol)) {
      const steps = Math.min(2, sorted.length - 1 - hiIndex);
      for (let i = 0; i < steps; i++) {
        hiIndex += 1;
        accumulated += sorted[hiIndex].volume;
      }
    } else if (canGoBelow) {
      const steps = Math.min(2, loIndex);
      for (let i = 0; i < steps; i++) {
        loIndex -= 1;
        accumulated += sorted[loIndex].volume;
      }
    } else {
      break;
    }
  }

  return { high: sorted[hiIndex].price, low: sorted[loIndex].price, volume: accumulated };
}

export function isInBusinessZone(price, valueArea) {
  if (!valueArea) return false;
  return price >= valueArea.low && price <= valueArea.high;
}

// Groups bars by their `date` field (Databento's parsed bars carry this;
// live TopstepX bars don't, so this is only ever called with historical
// bars — the multi-day composite profile and the manual sanity-check
// script's per-day breakdown).
export function groupBarsByDay(bars) {
  const byDay = new Map();
  for (const bar of bars) {
    const key = bar.date;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(bar);
  }
  return byDay;
}

// Merges the last `compositeDays` days' individual session profiles into one
// deep profile — a longer-lookback POC/value area tends to be more stable
// than any single day's, per the design doc's "composite/deep profile" zone.
export function buildCompositeProfile(bars, { bucketSizePts, compositeDays }) {
  const byDay = groupBarsByDay(bars);
  const recentDays = [...byDay.keys()].sort().slice(-compositeDays);

  const mergedVolumeByBucket = new Map();
  for (const day of recentDays) {
    const dayProfile = buildSessionProfile(byDay.get(day), { bucketSizePts });
    for (const { price, volume } of dayProfile) {
      mergedVolumeByBucket.set(price, (mergedVolumeByBucket.get(price) || 0) + volume);
    }
  }
  return [...mergedVolumeByBucket.entries()]
    .map(([price, volume]) => ({ price, volume }))
    .sort((a, b) => a.price - b.price);
}

// A failed auction: within the trailing lookback window, price pushed
// outside the value area but the auction failed to hold — the CURRENT bar's
// close is already back inside. Retrospective, like the Order Flow Bot's
// other triggers (no forward-looking confirmation bar) — the close being
// back inside IS the live trigger, evaluated at that bar.
export function detectFailedAuction(bars, index, valueArea, { probeLookbackBars }) {
  if (!valueArea) return null;
  const bar = bars[index];
  const insideNow = bar.close >= valueArea.low && bar.close <= valueArea.high;
  if (!insideNow) return null;

  const start = Math.max(0, index - probeLookbackBars + 1);
  const window = bars.slice(start, index + 1);
  const windowHigh = Math.max(...window.map((b) => b.high ?? b.close));
  const windowLow = Math.min(...window.map((b) => b.low ?? b.close));

  const probedAbove = windowHigh > valueArea.high;
  const probedBelow = windowLow < valueArea.low;
  if (!probedAbove && !probedBelow) return null;

  // A whipsaw that probed both sides within the same window: prefer whichever
  // extreme pushed further past the value area — the more decisive failed push.
  if (probedAbove && probedBelow) {
    const aboveDist = windowHigh - valueArea.high;
    const belowDist = valueArea.low - windowLow;
    return aboveDist >= belowDist
      ? { direction: "short", probePrice: windowHigh }
      : { direction: "long", probePrice: windowLow };
  }
  return probedAbove
    ? { direction: "short", probePrice: windowHigh }
    : { direction: "long", probePrice: windowLow };
}

// The mean-reversion take-profit: fade back toward the OPPOSITE edge of the
// value area from the side that failed (a long entry, from a failed push
// below value, targets the value area high, and vice versa).
export function computeContrarianTarget(valueArea, direction) {
  if (!valueArea) return null;
  return direction === "long" ? valueArea.high : valueArea.low;
}
