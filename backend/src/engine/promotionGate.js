// The mechanical gate that decides whether a candidate strategy change may
// flip from practice-account shadow trading to the real funded Combine —
// this is what makes "full autonomy, hard caps" actually mean something:
// promotion is decided by these checks, not by an agent's own
// self-assessment or by trusting one good-looking backtest number in
// isolation. Every input here is exactly the shape the corresponding Phase
// 2/3 function already returns:
//   walkForward — robustness.js's runWalkForward() return value
//   regime      — robustness.js's regimeRobustnessCheck() return value
//   deflated    — robustness.js's deflatedSharpe() return value
//   shadowDays  — an array of { dayKey, drift } built by calling
//                 reconciliation.js's computeLiveVsBacktestDrift() once per
//                 consecutive practice-account trading day

export const DEFAULT_PROMOTION_CRITERIA = {
  minWalkForwardOosSharpe: 0.5,
  allowUnstableWalkForward: false, // walkForward.parameterStability.unstable must be false
  requireRegimeRobustnessPass: true,
  minDeflatedSharpe: 0, // must exceed this after the multiple-testing haircut
  minShadowDays: 10, // consecutive practice-account trading days required
  maxShadowDaysWithDrift: 0, // how many of those days may show live-vs-backtest drift
};

export function evaluatePromotionGate({ walkForward, regime, deflated, shadowDays } = {}, criteria = {}) {
  const c = { ...DEFAULT_PROMOTION_CRITERIA, ...criteria };
  const reasons = [];

  if (!walkForward || walkForward.error) {
    reasons.push(`walk-forward validation has no usable result${walkForward?.error ? `: ${walkForward.error}` : ''}`);
  } else {
    const oosSharpe = walkForward.aggregateOos?.sharpe ?? -Infinity;
    if (oosSharpe < c.minWalkForwardOosSharpe) {
      reasons.push(`walk-forward aggregate OOS Sharpe ${oosSharpe} is below the minimum ${c.minWalkForwardOosSharpe}`);
    }
    if (!c.allowUnstableWalkForward && walkForward.parameterStability?.unstable) {
      reasons.push('walk-forward parameter selection is unstable across folds (a different combo wins almost every fold)');
    }
  }

  if (!regime) {
    reasons.push('no regime-robustness result');
  } else if (c.requireRegimeRobustnessPass && !regime.pass) {
    reasons.push(regime.concentrated
      ? 'regime-robustness check failed: the edge is concentrated in a single regime bucket'
      : 'regime-robustness check failed: not enough regime buckets have sufficient trade data');
  }

  if (!deflated || deflated.deflatedSharpe == null) {
    reasons.push('no deflated-Sharpe result');
  } else if (deflated.deflatedSharpe <= c.minDeflatedSharpe) {
    reasons.push(`deflated Sharpe ${deflated.deflatedSharpe} does not clear the multiple-testing haircut (minimum ${c.minDeflatedSharpe})`);
  }

  if (!Array.isArray(shadowDays) || shadowDays.length < c.minShadowDays) {
    reasons.push(`only ${shadowDays?.length ?? 0} consecutive practice-account shadow trading day(s) recorded, need ${c.minShadowDays}`);
  } else {
    const driftDays = shadowDays.filter((d) => d.drift?.comparable && d.drift.drift === true);
    if (driftDays.length > c.maxShadowDaysWithDrift) {
      reasons.push(`${driftDays.length} of ${shadowDays.length} shadow days showed live-vs-backtest drift (maximum allowed ${c.maxShadowDaysWithDrift})`);
    }
  }

  return { approved: reasons.length === 0, reasons, criteria: c };
}
