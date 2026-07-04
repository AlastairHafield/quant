// ─── Pure indicator functions over bar arrays ────────────────────────────────
// All functions return arrays aligned to input index; null until enough data.

export function sma(values, len) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

export function ema(values, len) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (len + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (prev === null) {
      // Seed with SMA of first `len` values
      if (i === len - 1) {
        prev = values.slice(0, len).reduce((a, b) => a + b, 0) / len;
        out[i] = prev;
      }
    } else {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Wilder RSI
export function rsi(closes, len) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= len) {
      avgGain += gain / len;
      avgLoss += loss / len;
      if (i === len) out[i] = toRsi(avgGain, avgLoss);
    } else {
      avgGain = (avgGain * (len - 1) + gain) / len;
      avgLoss = (avgLoss * (len - 1) + loss) / len;
      out[i] = toRsi(avgGain, avgLoss);
    }
  }
  return out;
}

function toRsi(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function bollinger(closes, len, numStd) {
  const mid = sma(closes, len);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = len - 1; i < closes.length; i++) {
    const window = closes.slice(i - len + 1, i + 1);
    const sd = stdDev(window);
    upper[i] = mid[i] + numStd * sd;
    lower[i] = mid[i] - numStd * sd;
  }
  return { mid, upper, lower };
}

// Wilder ATR over OHLC bars
export function atr(bars, len) {
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].high - bars[i].low
      : Math.max(
          bars[i].high - bars[i].low,
          Math.abs(bars[i].high - bars[i - 1].close),
          Math.abs(bars[i].low - bars[i - 1].close),
        );
    if (prev === null) {
      if (i === len - 1) {
        let sum = 0;
        for (let j = 0; j <= i; j++) {
          sum += j === 0
            ? bars[j].high - bars[j].low
            : Math.max(
                bars[j].high - bars[j].low,
                Math.abs(bars[j].high - bars[j - 1].close),
                Math.abs(bars[j].low - bars[j - 1].close),
              );
        }
        prev = sum / len;
        out[i] = prev;
      }
    } else {
      prev = (prev * (len - 1) + tr) / len;
      out[i] = prev;
    }
  }
  return out;
}

// Wilder ADX over OHLC bars
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
      Math.abs(bars[i].low - bars[i - 1].close),
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

// Session-anchored VWAP + z-score of close vs VWAP.
// `bars` must be a single session (one day), chronological.
export function sessionVWAP(bars) {
  const vwap = new Array(bars.length).fill(null);
  const zscore = new Array(bars.length).fill(null);
  let cumPV = 0, cumV = 0;
  const devs = [];

  for (let i = 0; i < bars.length; i++) {
    const typical = (bars[i].high + bars[i].low + bars[i].close) / 3;
    const vol = bars[i].volume || 1;
    cumPV += typical * vol;
    cumV += vol;
    vwap[i] = cumPV / cumV;

    devs.push(bars[i].close - vwap[i]);
    if (devs.length >= 5) {
      const sd = stdDev(devs);
      zscore[i] = sd > 0 ? (bars[i].close - vwap[i]) / sd : 0;
    }
  }
  return { vwap, zscore };
}

export function rollingZScore(values, len) {
  const out = new Array(values.length).fill(null);
  for (let i = len - 1; i < values.length; i++) {
    const window = values.slice(i - len + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / len;
    const sd = stdDev(window);
    out[i] = sd > 0 ? (values[i] - mean) / sd : 0;
  }
  return out;
}

export function percentileRank(values, idx, lookback) {
  const start = Math.max(0, idx - lookback + 1);
  const window = values.slice(start, idx + 1).filter(v => v != null);
  if (window.length < 2) return null;
  const v = values[idx];
  const below = window.filter(x => x < v).length;
  return (below / (window.length - 1)) * 100;
}

export function stdDev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}
