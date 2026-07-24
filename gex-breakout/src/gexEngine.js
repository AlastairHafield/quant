export function computeStrikeGex(option, spot, sign) {
  const raw = option.gamma * option.oi * 100 * spot * spot * 0.01;
  const mult = option.type === "call" ? sign.call : sign.put;
  return raw * mult;
}

export function effectiveOi(option, staleness) {
  if (!staleness?.useVolumeBlend || !option.isZeroDte) return option.oi;
  return option.oi + staleness.blendWeight * (option.volume || 0);
}

export function buildGexProfile(chain, spot, gexOpts) {
  const sign = gexOpts.sign;
  const staleness = gexOpts.staleness;
  const byStrike = new Map();
  for (const option of chain) {
    const oi = effectiveOi(option, staleness);
    const gex = computeStrikeGex({ ...option, oi }, spot, sign);
    byStrike.set(option.strike, (byStrike.get(option.strike) || 0) + gex);
  }
  return [...byStrike.entries()]
    .map(([strike, gex]) => ({ strike: Number(strike), gex }))
    .sort((a, b) => a.strike - b.strike);
}

export function computeNetGex(profile) {
  return profile.reduce((sum, p) => sum + p.gex, 0);
}

// A wide, real aggregated chain (many strikes out to deep OTM, each with tiny
// residual GEX) can wobble across zero more than once — caught live: scanning from
// the lowest strike and taking the first crossing picked a meaningless flip 4700+
// points from spot instead of the real one near the money. When `spot` is given,
// pick the crossing nearest to it; falls back to the first crossing without it
// (matches the original single-crossing behavior any small/synthetic profile has).
export function computeFlipPoint(profile, spot = null) {
  if (!profile.length) return null;
  const crossings = [];
  let runningTotal = 0;
  let prevStrike = null;
  let prevTotal = null;
  for (const { strike, gex } of profile) {
    runningTotal += gex;
    if (runningTotal === 0) {
      crossings.push(strike);
    } else if (prevTotal !== null && Math.sign(prevTotal) !== Math.sign(runningTotal)) {
      const frac = (0 - prevTotal) / (runningTotal - prevTotal);
      crossings.push(prevStrike + frac * (strike - prevStrike));
    }
    prevStrike = strike;
    prevTotal = runningTotal;
  }
  if (!crossings.length) return null;
  if (spot == null) return crossings[0];
  return crossings.reduce((closest, c) => (Math.abs(c - spot) < Math.abs(closest - spot) ? c : closest));
}

export function computeWalls(profile, spot, gexOpts) {
  const count = gexOpts.wallCount || 3;
  const tag = (p) => ({ ...p, wallType: p.gex >= 0 ? "POS_WALL" : "NEG_WALL" });
  const topByAbs = (arr) =>
    [...arr].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, count).map(tag);
  return {
    aboveSpot: topByAbs(profile.filter((p) => p.strike > spot)),
    belowSpot: topByAbs(profile.filter((p) => p.strike < spot)),
  };
}

export function staleConfidence(nowET, gexOpts) {
  if (gexOpts.staleness.useVolumeBlend) return "FULL";
  const cutoff = gexOpts.staleness.reducedConfidenceAfterET;
  const minutes = nowET.getHours() * 60 + nowET.getMinutes();
  return minutes >= cutoff.h * 60 + cutoff.m ? "REDUCED" : "FULL";
}

// flipPointOverride: a provider-computed flip point (e.g. FlashAlpha's own per-expiry
// gamma_flip, magnitude-weighted across expiries) preferred over the naive
// cumulative-crossing scan when the caller has one — see weightedFlipPoint in
// dataSources/flashalpha.js for why the naive scan breaks down on a real aggregated
// multi-expiry book.
export function computeGexSnapshotFromProfile(profile, spot, gexOpts, nowET = new Date(), flipPointOverride = null) {
  return {
    profile,
    netGex: computeNetGex(profile),
    flipPoint: flipPointOverride ?? computeFlipPoint(profile, spot),
    walls: computeWalls(profile, spot, gexOpts),
    confidence: staleConfidence(nowET, gexOpts),
    asOf: nowET.toISOString(),
  };
}

export function computeGexSnapshot(chain, spot, gexOpts, nowET = new Date()) {
  const profile = buildGexProfile(chain, spot, gexOpts);
  return computeGexSnapshotFromProfile(profile, spot, gexOpts, nowET);
}
