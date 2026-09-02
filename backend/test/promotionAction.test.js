import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePromotionAction } from '../src/engine/promotionAction.js';

test('describePromotionAction: unknown strategy produces no action', () => {
  const result = describePromotionAction('not-a-real-strategy', { approved: true });
  assert.equal(result.action, 'none');
});

test('describePromotionAction: an unapproved gate result produces no action, with reasons carried through', () => {
  const result = describePromotionAction('gap-continuation', { approved: false, reasons: ['walk-forward Sharpe too low'] });
  assert.equal(result.action, 'none');
  assert.deepEqual(result.gateReasons, ['walk-forward Sharpe too low']);
});

test('describePromotionAction: no gate result at all produces no action rather than crashing', () => {
  const result = describePromotionAction('gap-continuation', undefined);
  assert.equal(result.action, 'none');
});

test('describePromotionAction: an approved gate result produces the exact env var + command for gap-continuation', () => {
  const result = describePromotionAction('gap-continuation', { approved: true, reasons: [] });
  assert.equal(result.action, 'set_execution_enabled');
  assert.equal(result.envVar, 'GAP_CONTINUATION_EXECUTION_ENABLED');
  assert.match(result.command, /GAP_CONTINUATION_EXECUTION_ENABLED=true/);
});

test('describePromotionAction: mechanical-orb maps to its own execution flag', () => {
  const result = describePromotionAction('mechanical-orb', { approved: true });
  assert.equal(result.envVar, 'MECHANICAL_ORB_EXECUTION_ENABLED');
});

test('describePromotionAction: gex-breakout maps to the Order Flow Bot\'s own separate flag, not the bot-wide switch', () => {
  const result = describePromotionAction('gex-breakout', { approved: true });
  assert.equal(result.envVar, 'STRATEGY_OF_EXECUTION_ENABLED');
});

test('describePromotionAction: never actually executes anything — the command is a string, not a side effect', () => {
  const result = describePromotionAction('gap-continuation', { approved: true });
  assert.equal(typeof result.command, 'string');
  assert.ok(result.note.toLowerCase().includes('not executed'));
});
