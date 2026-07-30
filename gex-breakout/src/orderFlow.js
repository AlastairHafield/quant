export function computeDelta(bar) {
  return bar.buyVolume - bar.sellVolume;
}

export function withCumDelta(bars) {
  let cum = 0;
  return bars.map((b) => {
    const delta = b.delta ?? computeDelta(b);
    cum += delta;
    return { ...b, delta, cumDelta: cum };
  });
}

export function rollingAvg(values, endIndex, window) {
  const start = Math.max(0, endIndex - window + 1);
  const slice = values.slice(start, endIndex + 1);
  if (!slice.length) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function detectDeltaDivergence(bars, index, { lookbackBars }) {
  const start = Math.max(0, index - lookbackBars + 1);
  const window = bars.slice(start, index + 1);
  const bar = bars[index];

  const maxHigh = Math.max(...window.map((b) => b.high ?? b.close));
  const minLow = Math.min(...window.map((b) => b.low ?? b.close));
  const priceNewHigh = (bar.high ?? bar.close) >= maxHigh;
  const priceNewLow = (bar.low ?? bar.close) <= minLow;
  if (!priceNewHigh && !priceNewLow) return false;

  const cumDeltas = window.map((b) => b.cumDelta);
  const maxCum = Math.max(...cumDeltas);
  const minCum = Math.min(...cumDeltas);
  if (priceNewHigh && bar.cumDelta < maxCum) return true;
  if (priceNewLow && bar.cumDelta > minCum) return true;
  return false;
}

export function detectAbsorption(touchWindow, priorBars, levelPrice, direction, cfg) {
  const totalVolume = touchWindow.reduce((s, b) => s + (b.volume || 0), 0);

  const avgWindow = priorBars.slice(-cfg.avgLookbackBars);
  const avgBarVolume = avgWindow.length
    ? avgWindow.reduce((s, b) => s + (b.volume || 0), 0) / avgWindow.length
    : 0;
  const avgTouchVolume = avgBarVolume * touchWindow.length;

  const extreme =
    direction === "long"
      ? Math.max(...touchWindow.map((b) => b.high ?? b.close))
      : Math.min(...touchWindow.map((b) => b.low ?? b.close));
  const advance = direction === "long" ? extreme - levelPrice : levelPrice - extreme;

  const highVolume = avgTouchVolume > 0 && totalVolume > cfg.volMultiple * avgTouchVolume;
  const stalledPrice = advance < cfg.maxAdvancePts;

  return highVolume && stalledPrice;
}

// Slices the two windows detectAbsorption needs straight out of an open
// trade's live bar history — the "touch" window (most recent bars) and a
// baseline window before it for the average-volume comparison. Live bars
// only carry buyVolume/sellVolume (see TradeBarAggregator in
// dataSources/topstepx.js), not a combined volume field, so this also
// derives that. Returns null when there isn't yet enough bar history since
// entry to fill both windows — evaluateOpenTrades just skips the absorption
// check for that bar rather than running it against a truncated window.
export function buildAbsorptionWindow(bars, currentIndex, { touchBars, avgLookbackBars }) {
  if (currentIndex - touchBars - avgLookbackBars + 1 < 0) return null;
  const withVolume = (b) => ({ ...b, volume: (b.buyVolume ?? 0) + (b.sellVolume ?? 0) });
  const touchWindow = bars.slice(currentIndex - touchBars + 1, currentIndex + 1).map(withVolume);
  const priorBars = bars.slice(currentIndex - touchBars - avgLookbackBars + 1, currentIndex - touchBars + 1).map(withVolume);
  return { touchWindow, priorBars };
}

export function gradeFlow({
  breakoutBar,
  confirmBar,
  direction,
  avgAbsDelta,
  cumDeltaNewExtreme,
  divergence,
  absorbed,
  aDeltaMultiple,
}) {
  if (absorbed || divergence) return "F";

  const deltaAgrees = direction === "long" ? breakoutBar.delta > 0 : breakoutBar.delta < 0;
  const confirmAgrees = direction === "long" ? confirmBar.delta > 0 : confirmBar.delta < 0;
  if (!deltaAgrees || !confirmAgrees) return "F";

  const strong = Math.abs(breakoutBar.delta) > aDeltaMultiple * avgAbsDelta;
  return strong && cumDeltaNewExtreme ? "A" : "B";
}

export function evaluateBreakoutFlow(bars, breakoutIndex, direction, levelPrice, cfg) {
  const breakoutBar = bars[breakoutIndex];
  const confirmBar = bars[breakoutIndex + 1];
  if (!confirmBar) return { grade: "PENDING" };

  const priorAbsDeltas = bars.slice(0, breakoutIndex).map((b) => Math.abs(b.delta));
  const avgAbsDelta = rollingAvg(priorAbsDeltas, priorAbsDeltas.length - 1, cfg.flowGrade.avgLookbackBars);

  const divergence = detectDeltaDivergence(bars, breakoutIndex, {
    lookbackBars: cfg.divergenceLookbackBars,
  });

  const extremeWindow = bars.slice(
    Math.max(0, breakoutIndex - cfg.divergenceLookbackBars + 1),
    breakoutIndex + 1
  );
  const cumDeltas = extremeWindow.map((b) => b.cumDelta);
  const cumDeltaNewExtreme =
    direction === "long"
      ? breakoutBar.cumDelta >= Math.max(...cumDeltas)
      : breakoutBar.cumDelta <= Math.min(...cumDeltas);

  const touchWindow = bars.slice(
    Math.max(0, breakoutIndex - cfg.absorption.touchBars + 1),
    breakoutIndex + 1
  );
  const priorBars = bars.slice(0, Math.max(0, breakoutIndex - cfg.absorption.touchBars + 1));
  const absorbed = detectAbsorption(touchWindow, priorBars, levelPrice, direction, cfg.absorption);

  const grade = gradeFlow({
    breakoutBar,
    confirmBar,
    direction,
    avgAbsDelta,
    cumDeltaNewExtreme,
    divergence,
    absorbed,
    aDeltaMultiple: cfg.flowGrade.aDeltaMultiple,
  });

  return { grade, avgAbsDelta, cumDeltaNewExtreme, divergence, absorbed };
}

// "Path of least resistance": price advances CLEANLY in one direction (every
// bar's close at least matches the bar before it, not chopping back and
// forth) on unusually LIGHT volume — no one's fighting the move — while
// cumulative delta agrees. The opposite signature from absorption (heavy
// volume, stalled price). A trend-CONTINUATION trigger, not a fade — returns
// the direction the tape is already moving, not the opposite. Retrospective
// over the trailing `lookbackBars` ending at `index`, like this module's
// other triggers (no forward-looking confirmation bar).
//
// describePathOfLeastResistance carries the same logic but always returns a
// diagnostic object (matched + reason + the raw numbers behind the decision)
// instead of collapsing every non-match into a bare null — built for the
// Order Flow Bot's no-trigger heartbeat (see worker.js), which needs to show
// WHY nothing fired, not just that nothing did. detectPathOfLeastResistance
// is a thin wrapper so every existing caller/test keeps its original
// null-or-{direction} contract unchanged.
export function describePathOfLeastResistance(bars, index, { lookbackBars, volumeLightMultiple, avgLookbackBars }) {
  const start = Math.max(0, index - lookbackBars + 1);
  const window = bars.slice(start, index + 1);
  if (window.length < lookbackBars) return { matched: false, reason: "insufficient_bars" };

  const netMove = window[window.length - 1].close - window[0].close;
  if (netMove === 0) return { matched: false, reason: "no_net_move" };
  const direction = netMove > 0 ? "long" : "short";

  const cleanProgress = window.every((b, i) => {
    if (i === 0) return true;
    return direction === "long" ? b.close >= window[i - 1].close : b.close <= window[i - 1].close;
  });
  if (!cleanProgress) return { matched: false, reason: "choppy", direction, netMove };

  const barVolume = (b) => (b.volume ?? (b.buyVolume ?? 0) + (b.sellVolume ?? 0));
  const windowVolume = window.reduce((s, b) => s + barVolume(b), 0);
  const avgWindow = bars.slice(Math.max(0, start - avgLookbackBars), start);
  const avgBarVolume = avgWindow.length ? avgWindow.reduce((s, b) => s + barVolume(b), 0) / avgWindow.length : 0;
  const expectedVolume = avgBarVolume * window.length;
  const lightVolume = expectedVolume > 0 && windowVolume < expectedVolume / volumeLightMultiple;
  if (!lightVolume) return { matched: false, reason: "volume_not_light", direction, netMove, windowVolume, expectedVolume };

  const deltaAgrees =
    direction === "long"
      ? window[window.length - 1].cumDelta > window[0].cumDelta
      : window[window.length - 1].cumDelta < window[0].cumDelta;
  if (!deltaAgrees) return { matched: false, reason: "delta_disagrees", direction, netMove, windowVolume, expectedVolume };

  return { matched: true, direction, netMove, windowVolume, expectedVolume };
}

export function detectPathOfLeastResistance(bars, index, cfg) {
  const d = describePathOfLeastResistance(bars, index, cfg);
  return d.matched ? { direction: d.direction } : null;
}

// Exhaustion signal: volume DECLINING across the trailing window (interest
// drying up) while cumulative delta's slope flattens or reverses (the crowd
// pushing the move is backing off). Returns the FADE direction — opposite
// the prior move — matching this trigger's role as a mean-reversion signal,
// unlike path-of-least-resistance above. Retrospective, same convention as
// this module's other triggers.
//
// describeLackOfParticipation mirrors describePathOfLeastResistance above:
// same logic, always returns a diagnostic object instead of a bare null.
// detectLackOfParticipation wraps it so its existing callers/tests are
// unaffected.
export function describeLackOfParticipation(bars, index, { lookbackBars, volumeDeclineMultiple }) {
  const start = Math.max(0, index - lookbackBars + 1);
  const window = bars.slice(start, index + 1);
  if (window.length < lookbackBars || window.length < 2) return { matched: false, reason: "insufficient_bars" };

  const half = Math.floor(window.length / 2);
  const firstHalf = window.slice(0, half);
  const secondHalf = window.slice(half);
  const barVolume = (b) => (b.volume ?? (b.buyVolume ?? 0) + (b.sellVolume ?? 0));
  const vol = (w) => w.reduce((s, b) => s + barVolume(b), 0);
  const firstVol = vol(firstHalf);
  const secondVol = vol(secondHalf);
  if (!(firstVol > 0 && secondVol < firstVol / volumeDeclineMultiple)) {
    return { matched: false, reason: "volume_not_declining", firstVol, secondVol };
  }

  const firstDeltaSlope = firstHalf[firstHalf.length - 1].cumDelta - firstHalf[0].cumDelta;
  const secondDeltaSlope = secondHalf[secondHalf.length - 1].cumDelta - secondHalf[0].cumDelta;
  if (firstDeltaSlope === 0) return { matched: false, reason: "no_prior_delta_slope", firstVol, secondVol };
  const priorDirection = firstDeltaSlope > 0 ? "long" : "short";
  const flattenedOrReversed =
    priorDirection === "long" ? secondDeltaSlope < firstDeltaSlope : secondDeltaSlope > firstDeltaSlope;
  if (!flattenedOrReversed) {
    return { matched: false, reason: "delta_not_flattening", firstVol, secondVol, firstDeltaSlope, secondDeltaSlope };
  }

  return {
    matched: true,
    direction: priorDirection === "long" ? "short" : "long",
    firstVol,
    secondVol,
    firstDeltaSlope,
    secondDeltaSlope,
  };
}

export function detectLackOfParticipation(bars, index, cfg) {
  const d = describeLackOfParticipation(bars, index, cfg);
  return d.matched ? { direction: d.direction } : null;
}
