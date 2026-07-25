// Automated coverage for the phase 1 migration (docs/phase1-event-schema-agent-roles.md):
// the single dispatch() registry, the events-based approval gate, and
// multi-tenant isolation. Everything here was verified by hand with curl
// during that migration — this locks it in so future changes can't quietly
// break it. Zero test-framework dependency: node:test is built into Node 22.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Must be set before requiring ../src/db (it opens the DB at module load).
const dbPath = path.join(os.tmpdir(), `agentos-test-actions-${process.pid}-${Date.now()}.sqlite`);
process.env.AGENTOS_DB_PATH = dbPath;
process.env.AGENTOS_TOKEN_SECRET = 'test-secret';

const { db, uid, now } = require('../src/db');
const { dispatch, resolveEvent } = require('../src/actions');

test.after(() => {
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

function makeTenant() {
  const tenantId = uid();
  const userId = uid();
  const t = now();
  db.prepare('INSERT INTO tenants (id, name, plan, plan_key, status, ai_provider, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(tenantId, 'Test Co', 'trial', 'free', 'active', 'anthropic', t);
  db.prepare('INSERT INTO users (id, tenant_id, name, email, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(userId, tenantId, 'Test User', `${userId}@test.local`, 'x', 'x', 'owner', t);
  return { tenantId, userId };
}

test('dispatch() applies a non-sensitive action immediately regardless of caller role', () => {
  const { tenantId, userId } = makeTenant();

  const asOwner = dispatch({ tenantId, userId, role: 'owner' }, 'contact.created', { name: 'Ali' });
  assert.equal(asOwner.requiresApproval, false);
  assert.equal(asOwner.data.name, 'Ali');

  const asAgent = dispatch({ tenantId, userId, role: 'agent' }, 'contact.created', { name: 'Reza' });
  assert.equal(asAgent.requiresApproval, false);
  assert.equal(asAgent.data.name, 'Reza');

  const events = db.prepare('SELECT type, actor_role, status FROM events WHERE tenant_id = ? ORDER BY created_at').all(tenantId);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.actor_role), ['owner', 'agent']);
  assert.ok(events.every(e => e.type === 'contact.created' && e.status === 'applied'));
});

test('dispatch() queues a sensitive action for the agent role instead of applying it', () => {
  const { tenantId, userId } = makeTenant();
  const deal = dispatch({ tenantId, userId, role: 'owner' }, 'deal.created', { title: 'Big Deal' }).data;

  const result = dispatch({ tenantId, userId, role: 'agent' }, 'deal.deleted', { id: deal.id });
  assert.equal(result.requiresApproval, true);
  assert.ok(result.eventId);

  // Not actually deleted yet.
  const stillThere = db.prepare('SELECT id FROM deals WHERE id = ?').get(deal.id);
  assert.ok(stillThere, 'deal should still exist until the pending event is approved');

  const ev = db.prepare('SELECT status FROM events WHERE id = ?').get(result.eventId);
  assert.equal(ev.status, 'pending_approval');
});

test('dispatch() does NOT gate the same sensitive action for a human role (owner/admin/member)', () => {
  const { tenantId, userId } = makeTenant();
  const deal = dispatch({ tenantId, userId, role: 'owner' }, 'deal.created', { title: 'Direct Delete' }).data;

  const result = dispatch({ tenantId, userId, role: 'owner' }, 'deal.deleted', { id: deal.id });
  assert.equal(result.requiresApproval, false);

  const gone = db.prepare('SELECT id FROM deals WHERE id = ?').get(deal.id);
  assert.equal(gone, undefined, 'owner-initiated delete should be immediate, no approval queue');
});

test('resolveEvent(): reject leaves the underlying data untouched', () => {
  const { tenantId, userId } = makeTenant();
  const deal = dispatch({ tenantId, userId, role: 'owner' }, 'deal.created', { title: 'Reject Me' }).data;
  const { eventId } = dispatch({ tenantId, userId, role: 'agent' }, 'deal.deleted', { id: deal.id });

  const outcome = resolveEvent(tenantId, eventId, false);
  assert.equal(outcome.status, 'rejected');

  const stillThere = db.prepare('SELECT id FROM deals WHERE id = ?').get(deal.id);
  assert.ok(stillThere, 'rejected delete must not touch the row');
});

test('resolveEvent(): approve applies the action exactly once', () => {
  const { tenantId, userId } = makeTenant();
  const deal = dispatch({ tenantId, userId, role: 'owner' }, 'deal.created', { title: 'Approve Me' }).data;
  const { eventId } = dispatch({ tenantId, userId, role: 'agent' }, 'deal.deleted', { id: deal.id });

  const outcome = resolveEvent(tenantId, eventId, true);
  assert.equal(outcome.status, 'applied');
  const gone = db.prepare('SELECT id FROM deals WHERE id = ?').get(deal.id);
  assert.equal(gone, undefined);

  // Re-resolving the same event must be a no-op, not a second delete attempt.
  const second = resolveEvent(tenantId, eventId, true);
  assert.equal(second.error, 'already_resolved');
  assert.equal(second.status, 'applied');
});

test('events are strictly tenant-scoped (no cross-tenant leakage)', () => {
  const a = makeTenant();
  const b = makeTenant();
  dispatch({ tenantId: a.tenantId, userId: a.userId, role: 'owner' }, 'contact.created', { name: 'Only in A' });
  dispatch({ tenantId: b.tenantId, userId: b.userId, role: 'owner' }, 'contact.created', { name: 'Only in B' });

  const aEvents = db.prepare('SELECT payload_json FROM events WHERE tenant_id = ?').all(a.tenantId);
  const bEvents = db.prepare('SELECT payload_json FROM events WHERE tenant_id = ?').all(b.tenantId);
  assert.equal(aEvents.length, 1);
  assert.equal(bEvents.length, 1);
  assert.ok(aEvents[0].payload_json.includes('Only in A'));
  assert.ok(bEvents[0].payload_json.includes('Only in B'));

  const aContacts = db.prepare('SELECT name FROM contacts WHERE tenant_id = ?').all(a.tenantId);
  assert.deepEqual(aContacts.map(c => c.name), ['Only in A']);
});

test('dispatch() rejects an unknown event type', () => {
  const { tenantId, userId } = makeTenant();
  assert.throws(
    () => dispatch({ tenantId, userId, role: 'owner' }, 'not.a.real.type', {}),
    /unknown_action/
  );
});

test('dispatch() rejects an unrecognized actor role instead of silently skipping approval', () => {
  const { tenantId, userId } = makeTenant();
  assert.throws(
    () => dispatch({ tenantId, userId, role: 'totally_made_up' }, 'deal.deleted', { id: 'whatever' }),
    /unknown_actor_role/
  );
});
