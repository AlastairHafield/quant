import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePromotionGate, DEFAULT_PROMOTION_CRITERIA } from '../src/engine/promotionGate.js';

function passingInputs() {
  return {
    walkForward: {
      aggregateOos: { sharpe: 1.2 },
      parameterStability: { unstable: false, distinctCombosSelected: 1, foldsWithSelection: 4 },
    },
    regime: { pass: true, concentrated: false, bucketsWithEnoughData: 3, positiveBuckets: 3 },
    deflated: { deflatedSharpe: 0.8, observedSharpe: 1.5, numTrialsN: 20 },
    shadowDays: Array.from({ length: 10 }, (_, i) => ({
      dayKey: `day-${i}`,
      drift: { comparable: true, drift: false },
    })),
  };
}

test('evaluatePromotionGate: approves when every check clears the default criteria', () => {
  const result = evaluatePromotionGate(passingInputs());
  assert.equal(result.approved, true);
  assert.deepEqual(result.reasons, []);
});

test('evaluatePromotionGate: rejects a walk-forward error result', () => {
  const inputs = passingInputs();
  inputs.walkForward = { error: 'Not enough trading days for 4 walk-forward folds.' };
  const result = evaluatePromotionGate(inputs);
  assert.equal(result.approved, false);
  assert.ok(result.reasons.some((r) => r.includes('walk-forward')));
});

test('evaluatePromotionGate: rejects a walk-forward OOS Sharpe below the minimum', () => {
  const inputs = passingInputs();
  inputs.walkForward.aggregateOos.sharpe = 0.1;
  const result = evaluatePromotionGate(inputs);
  assert.equal(result.approved, false);
  assert.ok(result.reasons.some((r) => r.includes('OOS Sharpe')));
});

test('evaluatePromotionGate: rejects unstable walk-forward parameter selection', () => {
  const inputs = passingInputs();
  inputs.walkForward.parameterStability.unstable = true;
  const result = evaluatePromotionGate(inputs);
  assert.equal(result.approved, false);
  assert.ok(result.reasons.some((r) => r.includes('unstable')));
});

test('evaluatePromotionGate: allowUnstableWalkForward criteria override lets it through', () => {
  const inputs = passingInputs();
  inputs.walkForward.parameterStability.unstable = true;
  const result = evaluatePromotionGate(inputs, { allowUnstableWalkForward: true });
  assert.equal(result.approved, true);
});

test('evaluatePromotionGate: rejects a failed regime-robustness check', () => {
  const inputs = passingInputs();
  inputs.regime = { pass: false, concentrated: true, bucketsWithEnoughData: 1, positiveBuckets: 1 };
  const result = evaluatePromotionGate(inputs);
  assert.equal(result.approved, false);
  assert.ok(result.reasons.some((r) => r.includes('concentrated')));
});

test('evaluatePromotionGate: rejects a deflated Sharpe that does not clear the haircut', () => {
  const inputs = passingInputs();
  inputs.deflated = { deflatedSharpe: -0.3, observedSharpe: 1.5, numTrialsN: 500 };
  const result = evaluatePromotionGate(inputs);
  assert.equal(result.approved, false);
  assert.ok(result.reasons.some((r) => r.includes('deflated Sharpe')));
});

test('evaluatePromotionGate: rejects too few consecutive shadow days', () => {
  const inputs = passingInputs();
  inputs.shadowDays = inputs.shadowDays.slice(0, 3);
  const result = evaluatePromotionGate(inputs);
  assert.equal(result.approved, false);
  assert.ok(result.reasons.some((r) => r.includes('shadow trading day')));
});

test('evaluatePromotionGate: rejects when too many shadow days show live-vs-backtest drift', () => {
  const inputs = passingInputs();
  inputs.shadowDays[0].drift = { comparable: true, drift: true };
  inputs.shadowDays[1].drift = { comparable: true, drift: true };
  const result = evaluatePromotionGate(inputs);
  assert.equal(result.approved, false);
  assert.ok(result.reasons.some((r) => r.includes('drift')));
});

test('evaluatePromotionGate: a non-comparable shadow day (too few live trades) does not count as drift', () => {
  const inputs = passingInputs();
  inputs.shadowDays[0].drift = { comparable: false, reason: 'not enough trades' };
  const result = evaluatePromotionGate(inputs);
  assert.equal(result.approved, true);
});

test('evaluatePromotionGate: custom maxShadowDaysWithDrift criteria is respected', () => {
  const inputs = passingInputs();
  inputs.shadowDays[0].drift = { comparable: true, drift: true };
  const strict = evaluatePromotionGate(inputs); // default maxShadowDaysWithDrift: 0
  const lenient = evaluatePromotionGate(inputs, { maxShadowDaysWithDrift: 1 });
  assert.equal(strict.approved, false);
  assert.equal(lenient.approved, true);
});

test('evaluatePromotionGate: missing inputs entirely is rejected, not crashed', () => {
  const result = evaluatePromotionGate({});
  assert.equal(result.approved, false);
  assert.ok(result.reasons.length >= 4); // one reason per missing check
});

test('evaluatePromotionGate: reports the effective criteria used, merging any overrides', () => {
  const result = evaluatePromotionGate(passingInputs(), { minShadowDays: 5 });
  assert.equal(result.criteria.minShadowDays, 5);
  assert.equal(result.criteria.minWalkForwardOosSharpe, DEFAULT_PROMOTION_CRITERIA.minWalkForwardOosSharpe);
});
