const test = require('node:test');
const assert = require('node:assert/strict');
const { requiresApproval } = require('../src/roles');

test('only the agent role is ever gated', () => {
  const sensitiveType = 'deal.deleted';
  assert.equal(requiresApproval('agent', sensitiveType), true);
  for (const role of ['owner', 'admin', 'member']) {
    assert.equal(requiresApproval(role, sensitiveType), false);
  }
});

test('non-sensitive types are never gated, even for agent', () => {
  assert.equal(requiresApproval('agent', 'contact.created'), false);
  assert.equal(requiresApproval('agent', 'task.created'), false);
});

test('requiresApproval() itself returns false (not a throw) for an unrecognized role', () => {
  // This low-level helper fails open by design — it's a plain capability
  // lookup, not a validator. dispatch() (actions.js) is what refuses to
  // accept an unknown role at all, so this "false" is never reached with
  // a bad role in practice. See the "unknown actor role" test in
  // actions.test.js for the actual guard.
  assert.equal(requiresApproval('some_future_role', 'deal.deleted'), false);
});
