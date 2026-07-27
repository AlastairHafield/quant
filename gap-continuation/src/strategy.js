export function minutesOf(t) {
  return t.getHours() * 60 + t.getMinutes();
}

export function isAtOrAfterSessionOpen(t, config) {
  return minutesOf(t) >= config.sessionOpenET.h * 60 + config.sessionOpenET.m;
}

export function shouldFlattenNow(nowET, config) {
  return minutesOf(nowET) >= config.flattenAtET.h * 60 + config.flattenAtET.m;
}

// Reduces already-fetched historical bars (real UTC timestamps, ascending) down
// to the close of the LAST bar of the most recent COMPLETED RTH session — not
// "calendar yesterday" specifically, since that could be a weekend/holiday with
// no RTH bars at all (a Monday's prior session is Friday's, not Sunday's).
// Excludes today's own date so a bar or two of today's partial session (if this
// runs slightly late) can't get mistaken for "prior." Same RTH definition
// (930-1600 ET) the backtest used, not the daily-bar API's own close (which may
// reflect a different session boundary). Returns null if no RTH bars are found
// in the lookback window at all (contract too new, or lookback too short).
export function priorRthCloseFromHistoricalBars(bars, todayKey, toET) {
  const rthBars = bars.filter((b) => {
    const bt = toET(new Date(b.timestamp));
    if (bt.toDateString() === todayKey) return false;
    const m = minutesOf(bt);
    return m >= 9 * 60 + 30 && m < 16 * 60;
  });
  if (!rthBars.length) return null;
  return rthBars[rthBars.length - 1].close;
}

// Gap-CONTINUATION (gap-fill-findings memory): direction follows the gap's
// own sign — betting it keeps extending, not that it reverts. Stop is a
// fraction of the gap's own size; target is a multiple of the stop distance
// (1:1 R:R in the validated config). Evaluated exactly once per day, at the
// first bar at/after the session open — `bar` here IS that first bar, and
// entry fills at its close (matching the backtest's dayBars[0].close
// convention) while the gap itself is measured off its open.
export function evaluateEntry({ bar, priorClose, adxOk, config }) {
  if (priorClose == null) return { veto: "no_prior_close" };
  if (!adxOk) return { veto: "adx_below_threshold" };

  const gap = bar.open - priorClose;
  const gapPct = (gap / priorClose) * 100;
  if (Math.abs(gapPct) < config.gapMinPct) return { veto: "gap_too_small", gapPct };

  const direction = gap > 0 ? "long" : "short";
  const entryPrice = bar.close;
  const gapSize = Math.abs(gap);
  const stopDistance = config.stopParam * gapSize;
  if (stopDistance <= 0) return { direction, veto: "zero_stop_distance", gapPct };

  const stopPrice = direction === "long" ? entryPrice - stopDistance : entryPrice + stopDistance;
  const targetDistance = config.targetParam * stopDistance;
  const targetPrice = direction === "long" ? entryPrice + targetDistance : entryPrice - targetDistance;

  return { direction, entryPrice, stopPrice, targetPrice, stopDistance, gapPct, veto: null };
}
