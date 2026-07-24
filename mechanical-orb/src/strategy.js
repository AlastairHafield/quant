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
