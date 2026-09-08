import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePromotionAction, executePromotionAction } from '../src/engine/promotionAction.js';

async function withMockedFetch(response, fn) {
  const originalFetch = global.fetch;
  const originalKey = process.env.HEROKU_PLATFORM_API_KEY;
  process.env.HEROKU_PLATFORM_API_KEY = 'test-key';
  global.fetch = async () => response;
  try { await fn(); }
  finally { global.fetch = originalFetch; process.env.HEROKU_PLATFORM_API_KEY = originalKey; }
}

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

test('executePromotionAction: an unapproved gate result executes nothing', async () => {
  const result = await executePromotionAction('gap-continuation', { approved: false });
  assert.equal(result.action, 'none');
  assert.equal(result.executed, false);
});

test('executePromotionAction: throws if HEROKU_PLATFORM_API_KEY is unset', async () => {
  const originalKey = process.env.HEROKU_PLATFORM_API_KEY;
  delete process.env.HEROKU_PLATFORM_API_KEY;
  try {
    await assert.rejects(() => executePromotionAction('gap-continuation', { approved: true }));
  } finally {
    process.env.HEROKU_PLATFORM_API_KEY = originalKey;
  }
});

test('executePromotionAction: PATCHes the Heroku config-vars API and reports executed:true on success', async () => {
  await withMockedFetch(
    { ok: true, json: async () => ({ GAP_CONTINUATION_EXECUTION_ENABLED: 'true' }) },
    async () => {
      const result = await executePromotionAction('gap-continuation', { approved: true });
      assert.equal(result.executed, true);
      assert.deepEqual(result.data, { GAP_CONTINUATION_EXECUTION_ENABLED: 'true' });
    },
  );
});

test('executePromotionAction: reports executed:false with the error, not a throw, on a Heroku API failure', async () => {
  await withMockedFetch(
    { ok: false, status: 401, text: async () => 'Unauthorized' },
    async () => {
      const result = await executePromotionAction('gap-continuation', { approved: true });
      assert.equal(result.executed, false);
      assert.match(result.error, /401/);
    },
  );
});
