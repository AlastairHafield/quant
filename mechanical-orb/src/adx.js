// Ported from backend/src/engine/indicators.js (Wilder ADX over OHLC bars) — same
// pure function, no dependencies, so it's duplicated here rather than shared across
// these separate self-contained modules.
export function adx(bars, len) {
  const n = bars.length;
  const out = new Array(n).fill(null);
  if (n < len * 2) return out;

  let smTR = 0, smPlusDM = 0, smMinusDM = 0;
  let adxVal = null;
  const dxs = [];

  for (let i = 1; i < n; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );

    if (i <= len) {
      smTR += tr; smPlusDM += plusDM; smMinusDM += minusDM;
      if (i < len) continue;
    } else {
      smTR = smTR - smTR / len + tr;
      smPlusDM = smPlusDM - smPlusDM / len + plusDM;
      smMinusDM = smMinusDM - smMinusDM / len + minusDM;
    }

    const plusDI = smTR > 0 ? (smPlusDM / smTR) * 100 : 0;
    const minusDI = smTR > 0 ? (smMinusDM / smTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxs.push(dx);

    if (adxVal === null) {
      if (dxs.length === len) {
        adxVal = dxs.reduce((a, b) => a + b, 0) / len;
        out[i] = adxVal;
      }
    } else {
      adxVal = (adxVal * (len - 1) + dx) / len;
      out[i] = adxVal;
    }
  }
  return out;
}

// dailyBars must be completed days only (no in-progress "today" bar) — the last
// element is then "yesterday," matching the strategy's prior-day ADX filter.
export function latestAdx(dailyBars, len) {
  const series = adx(dailyBars, len);
  return series.length ? series[series.length - 1] : null;
}

export function priorDayAdxOk(dailyBars, { adxPeriod, adxThreshold }) {
  const value = latestAdx(dailyBars, adxPeriod);
  return { adx: value, ok: value != null && value >= adxThreshold };
}
