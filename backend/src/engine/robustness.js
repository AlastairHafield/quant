import { DEFAULT_ACCOUNT, sizeTrades, metricSet, groupMetrics, round, stdDev } from './backtestMetrics.js';

// Robustness checks for backtest results — built because a daily agent
// proposing strategy changes is effectively running a large, repeated
// parameter search, which is exactly the setup that produces
// overfit-but-great-looking-in-backtest results if validation stays at a
// single fixed IS/OOS split. Nothing here replaces that split (still done in
// backtestMetrics.js); these are additional, independent gates.

// ─── Normal distribution helpers (for deflatedSharpe below) ──────────────────

// Abramowitz & Stegun 7.1.26 approximation, max error ~1.5e-7 — plenty for a
// Sharpe-ratio significance check, not a statistics library.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCDF(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// Acklam's rational approximation for the standard normal inverse CDF
// (quantile function) — accurate to ~1.15e-9 relative error.
export function inverseNormalCDF(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// ─── Deflated Sharpe (multiple-testing haircut) ──────────────────────────────

// Simplified Bailey & Lopez de Prado-style haircut: once N variants are tried
// (a sweep grid, or N days of an agent proposing tweaks), the best-of-N
// Sharpe is biased upward even if every variant were pure noise — this
// estimates how much of the observed Sharpe is explained by that selection
// effect alone, and returns the excess ("deflated") Sharpe plus a rough
// probability the true edge is non-zero. Deliberately ignores the full PSR
// formula's skewness/kurtosis terms (this is an approximation, not the
// published statistic) — good enough to flag "this is likely just the best
// of many noisy tries," not precise enough to certify significance.
export function deflatedSharpe(returnsPct, numTrialsN) {
  const T = returnsPct.length;
  if (T < 2) return { observedSharpe: 0, benchmarkSharpe: 0, deflatedSharpe: 0, probabilitySkillNotLuck: null, numTrialsN, sampleSize: T };

  const mean = returnsPct.reduce((a, b) => a + b, 0) / T;
  const sd = stdDev(returnsPct);
  const srPerTrade = sd > 0 ? mean / sd : 0;
  const annualize = Math.sqrt(252);
  const observedSharpe = round(srPerTrade * annualize);

  const n = Math.max(1, Math.floor(numTrialsN || 1));
  if (n <= 1) {
    return { observedSharpe, benchmarkSharpe: 0, deflatedSharpe: observedSharpe, probabilitySkillNotLuck: null, numTrialsN: n, sampleSize: T };
  }

  // Standard asymptotic SE of an estimated (non-annualized) Sharpe ratio,
  // ignoring skew/kurtosis correction terms.
  const se = Math.sqrt((1 + 0.5 * srPerTrade * srPerTrade) / T);
  const gamma = 0.5772156649; // Euler-Mascheroni constant
  const z1 = inverseNormalCDF(1 - 1 / n);
  const z2 = inverseNormalCDF(1 - 1 / (n * Math.E));
  const expectedMaxZ = (1 - gamma) * z1 + gamma * z2;
  const benchmarkPerTrade = expectedMaxZ * se;
  const deflatedPerTrade = srPerTrade - benchmarkPerTrade;
  const probabilitySkillNotLuck = se > 0 ? normalCDF(deflatedPerTrade / se) : null;

  return {
    observedSharpe,
    benchmarkSharpe: round(benchmarkPerTrade * annualize),
    deflatedSharpe: round(deflatedPerTrade * annualize),
    probabilitySkillNotLuck: probabilitySkillNotLuck != null ? round(probabilitySkillNotLuck * 100) : null,
    numTrialsN: n,
    sampleSize: T,
  };
}

// ─── Regime-robustness gate ──────────────────────────────────────────────────

// Flags an edge that only holds up in one regime bucket rather than across
// several — reuses the existing groupMetrics grouping (byTrend/byDow/etc, the
// same buckets already shown in the dashboard) rather than inventing a new
// notion of "regime."
export function regimeRobustnessCheck(trades, keyFn, { minTradesPerBucket = 10, minPositiveBuckets = 2 } = {}) {
  const groups = groupMetrics(trades, keyFn);
  const entries = Object.entries(groups);
  const eligible = entries.filter(([, g]) => g.trades >= minTradesPerBucket);
  const positiveEligible = eligible.filter(([, g]) => g.avgReturnPct > 0);

  const eligiblePositivePnl = eligible.reduce((s, [, g]) => s + Math.max(g.totalPnl, 0), 0);
  const maxBucketPnl = eligible.length ? Math.max(...eligible.map(([, g]) => Math.max(g.totalPnl, 0))) : 0;
  const concentrated = eligiblePositivePnl > 0 && maxBucketPnl / eligiblePositivePnl > 0.8;

  return {
    totalBuckets: entries.length,
    bucketsWithEnoughData: eligible.length,
    positiveBuckets: positiveEligible.length,
    concentrated,
    pass: eligible.length >= minPositiveBuckets && positiveEligible.length >= minPositiveBuckets && !concentrated,
    buckets: groups,
  };
}

// ─── Monte Carlo / bootstrap drawdown ────────────────────────────────────────

// Deterministic PRNG (mulberry32) rather than Math.random() — a backtest
// report should give the same Monte Carlo numbers on every refresh of the
// same trade set, not a new answer each time.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bootstrap-resamples the trade SEQUENCE (with replacement) to get a
// confidence range on max drawdown and a probability of ruin — a single
// realized equity curve's max drawdown is one draw from a distribution, not
// the distribution itself.
export function monteCarloDrawdown(sizedTrades, accountSize = DEFAULT_ACCOUNT, { iterations = 1000, ruinThresholdPct = 50, seed = 42 } = {}) {
  const n = sizedTrades.length;
  if (n === 0) return null;
  const pnls = sizedTrades.map(t => t.pnl_dollars);
  const rng = mulberry32(seed);
  const drawdowns = new Array(iterations);
  let ruinCount = 0;

  for (let iter = 0; iter < iterations; iter++) {
    let equity = accountSize, peak = accountSize, maxDD = 0, ruined = false;
    for (let i = 0; i < n; i++) {
      const pnl = pnls[Math.floor(rng() * n)];
      equity += pnl;
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
      if (((accountSize - equity) / accountSize) * 100 >= ruinThresholdPct) ruined = true;
    }
    drawdowns[iter] = maxDD;
    if (ruined) ruinCount++;
  }

  drawdowns.sort((a, b) => a - b);
  const pct = p => drawdowns[Math.min(drawdowns.length - 1, Math.floor(p * drawdowns.length))];

  return {
    iterations,
    medianMaxDrawdownPct: round(pct(0.50)),
    p95MaxDrawdownPct: round(pct(0.95)),
    worstMaxDrawdownPct: round(drawdowns[drawdowns.length - 1]),
    probabilityOfRuinPct: round((ruinCount / iterations) * 100),
    ruinThresholdPct,
  };
}

// ─── Walk-forward validation ─────────────────────────────────────────────────

const MAX_WF_COMBOS = 500;
const MIN_TRADES_PER_FOLD_SELECTION = 5;

// Anchored folds: fold i's in-sample window always starts at the very first
// date and grows; each fold's out-of-sample window is the next chunk right
// after it — "how would you actually have traded this, re-optimizing
// periodically on everything seen so far." Returns [] if there isn't enough
// history for the requested fold count.
export function buildAnchoredFolds(sortedDates, numFolds = 4) {
  const n = sortedDates.length;
  if (numFolds < 1 || n < numFolds + 1) return [];
  const chunkSize = Math.floor(n / (numFolds + 1));
  if (chunkSize < 1) return [];
  const folds = [];
  for (let i = 1; i <= numFolds; i++) {
    const isEndIdx = chunkSize * i;
    const oosEndIdx = i === numFolds ? n : chunkSize * (i + 1);
    folds.push({
      isStart: sortedDates[0],
      isEnd: sortedDates[isEndIdx - 1],
      oosStart: sortedDates[isEndIdx],
      oosEnd: sortedDates[oosEndIdx - 1],
    });
  }
  return folds;
}

// Engine-agnostic — takes the engine's own pure core function (orbBacktest's
// backtestCore / gapFillBacktest's gapFillCore, both `(bars, regimeMap,
// params) => { trades, ... }`) so this file has no dependency on either
// engine. Runs each grid combo's FULL backtest exactly once (not once per
// fold — the trades are sliced by date per fold afterward), then for each
// fold picks whichever combo had the best in-sample Sharpe within that
// fold's IS window and reports its OOS performance in the following window.
// parameterStability flags when a different combo wins almost every fold —
// that instability is itself the overfitting signal, separate from whether
// any single split looks good.
export function runWalkForward({ coreFn, bars, regimeMap, baseParams = {}, grid = {}, dateFrom, dateTo, numFolds = 4, accountSize }) {
  const gridKeys = Object.keys(grid).filter(k => Array.isArray(grid[k]) && grid[k].length > 0);
  if (gridKeys.length === 0) return { error: 'Walk-forward grid is empty.' };

  let combos = [{}];
  for (const key of gridKeys) {
    const next = [];
    for (const combo of combos) for (const v of grid[key]) next.push({ ...combo, [key]: v });
    combos = next;
    if (combos.length > MAX_WF_COMBOS) return { error: `Walk-forward grid too large (${combos.length}, max ${MAX_WF_COMBOS}).` };
  }

  const acct = accountSize || baseParams.accountSize || DEFAULT_ACCOUNT;
  const comboResults = combos.map(combo => {
    const merged = { ...baseParams, ...combo, dateFrom, dateTo, accountSize: acct };
    const { trades } = coreFn(bars, regimeMap, merged);
    return { combo, trades: sizeTrades(trades, merged) };
  });

  const sortedTradeDates = [...new Set(bars.map(b => b.date).filter(d => d >= dateFrom && d <= dateTo))].sort();
  const folds = buildAnchoredFolds(sortedTradeDates, numFolds);
  if (folds.length === 0) return { error: `Not enough trading days for ${numFolds} walk-forward folds.` };

  const foldReports = [];
  const aggregatedOosTrades = [];
  for (const fold of folds) {
    let best = null;
    for (const cr of comboResults) {
      const isTrades = cr.trades.filter(t => t.trade_date >= fold.isStart && t.trade_date <= fold.isEnd);
      if (isTrades.length < MIN_TRADES_PER_FOLD_SELECTION) continue;
      const isMetrics = metricSet(isTrades, acct);
      if (!best || isMetrics.sharpe > best.isMetrics.sharpe) best = { combo: cr.combo, isMetrics, trades: cr.trades };
    }
    if (!best) {
      foldReports.push({ ...fold, selectedCombo: null, isMetrics: null, oosMetrics: null, oosTradeCount: 0 });
      continue;
    }
    const oosTrades = best.trades.filter(t => t.trade_date >= fold.oosStart && t.trade_date <= fold.oosEnd);
    const oosMetrics = metricSet(oosTrades, acct);
    aggregatedOosTrades.push(...oosTrades);
    foldReports.push({ ...fold, selectedCombo: best.combo, isMetrics: best.isMetrics, oosMetrics, oosTradeCount: oosTrades.length });
  }

  const selectedFolds = foldReports.filter(f => f.selectedCombo);
  const distinctCombos = new Set(selectedFolds.map(f => JSON.stringify(f.selectedCombo)));

  return {
    numFolds: folds.length,
    comboCount: combos.length,
    folds: foldReports,
    aggregateOos: metricSet(aggregatedOosTrades, acct),
    parameterStability: {
      distinctCombosSelected: distinctCombos.size,
      foldsWithSelection: selectedFolds.length,
      // >=75% of folds picking a different combo means the "best" params
      // aren't converging on anything stable — that instability is itself
      // the overfitting signal.
      unstable: selectedFolds.length > 0 && distinctCombos.size >= Math.ceil(folds.length * 0.75),
    },
  };
}
