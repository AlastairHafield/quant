export function minutesOf(t) {
  return t.getHours() * 60 + t.getMinutes();
}

export function orbWindowBounds(config) {
  const start = config.sessionOpenET.h * 60 + config.sessionOpenET.m;
  return { startMin: start, endMin: start + config.orWindowMin };
}

export function isWithinOrbWindow(t, bounds) {
  const m = minutesOf(t);
  return m >= bounds.startMin && m < bounds.endMin;
}

export function updateOrbRange(current, bar) {
  return {
    orbHigh: current.orbHigh == null ? bar.high : Math.max(current.orbHigh, bar.high),
    orbLow: current.orbLow == null ? bar.low : Math.min(current.orbLow, bar.low),
  };
}

// Reduces already-fetched historical bars (real UTC timestamps) down to the
// high/low of whatever ET calendar day + window they actually fall in. Used to
// backfill the ORB from history when a worker restarts after today's window
// has already closed and the live bar stream has no memory of it. Takes the
// ET-conversion function as a parameter to keep this module free of
// timezone-specific logic (worker.js owns toET). Returns null if no bars fall
// in the window (e.g. contract too new, or a holiday).
export function computeOrbFromHistoricalBars(bars, dayKey, bounds, toET) {
  const windowBars = bars.filter((b) => {
    const bt = toET(new Date(b.timestamp));
    return bt.toDateString() === dayKey && minutesOf(bt) >= bounds.startMin && minutesOf(bt) < bounds.endMin;
  });
  if (!windowBars.length) return null;
  return {
    high: Math.max(...windowBars.map((b) => b.high)),
    low: Math.min(...windowBars.map((b) => b.low)),
  };
}

// Validated LONG-only (orb-alpaca-1m-findings: SHORT loses outright, BOTH dilutes
// the edge) — a plain CLOSE trigger beyond the OR high, no extra buffer.
export function checkTrigger(price, orbHigh, bufferPts, direction) {
  if (direction !== "long" || orbHigh == null) return null;
  return price > orbHigh + bufferPts ? "long" : null;
}

// stop = entry - 1.5x the OR range (validated OR_FRAC config), not tied to the OR
// boundaries themselves.
export function computeStop({ entryPrice, orbHigh, orbLow, fracOfOrRange }) {
  const stopDistance = fracOfOrRange * (orbHigh - orbLow);
  return { stopPrice: entryPrice - stopDistance, stopDistance };
}

export function shouldFlattenNow(nowET, config) {
  return minutesOf(nowET) >= config.flattenAtET.h * 60 + config.flattenAtET.m;
}

export function evaluateEntry({ bar, orbHigh, orbLow, nowET, adxOk, config, dayState }) {
  const direction = checkTrigger(bar.close, orbHigh, config.triggerBufferPts, config.direction);
  if (!direction) return null;

  if (dayState.tradedToday) return { direction, veto: "already_traded_today" };
  if (minutesOf(nowET) >= config.entryCutoffET.h * 60 + config.entryCutoffET.m) {
    return { direction, veto: "past_entry_cutoff" };
  }
  if (!adxOk) return { direction, veto: "adx_below_threshold" };

  const entryPrice = bar.close;
  const { stopPrice, stopDistance } = computeStop({
    entryPrice,
    orbHigh,
    orbLow,
    fracOfOrRange: config.stop.fracOfOrRange,
  });

  return { direction, entryPrice, stopPrice, stopDistance, veto: null };
}
