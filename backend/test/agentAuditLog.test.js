import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDebateId } from '../src/data/agentAuditLog.js';

test('resolveDebateId: a proposal with no debateId gets a freshly generated one', () => {
  const id = resolveDebateId({ type: 'proposal', strategy: 'gap-continuation' });
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
});

test('resolveDebateId: two proposals with no debateId get DIFFERENT ids', () => {
  const a = resolveDebateId({ type: 'proposal' });
  const b = resolveDebateId({ type: 'proposal' });
  assert.notEqual(a, b);
});

test('resolveDebateId: an explicit debateId is always preserved, even on a proposal', () => {
  const id = resolveDebateId({ type: 'proposal', debateId: 'existing-id' });
  assert.equal(id, 'existing-id');
});

test('resolveDebateId: a grade/promotion/demotion/watch/error entry does NOT get one auto-generated', () => {
  for (const type of ['grade', 'promotion', 'demotion', 'watch', 'error']) {
    assert.equal(resolveDebateId({ type }), undefined);
  }
});

test('resolveDebateId: a non-proposal entry keeps whatever debateId it was given (threading a critique to its proposal)', () => {
  assert.equal(resolveDebateId({ type: 'grade', debateId: 'abc-123' }), 'abc-123');
});
