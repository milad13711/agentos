// actions.js — Phase 1: single write path shared by server.js (REST) and
// agent.js (Agent). Each registry entry's apply() is the ONLY place that
// action's SQL lives — this is what eliminates the create_contact/
// create_deal duplication described in docs/phase1-event-schema-agent-roles.md.
//
// Migration status: only 'contact.created' is wired through dispatch() so
// far (step 2 of the checklist). Everything else still runs the old way in
// agent.js/server.js until migrated one action at a time (step 3).
const { db, uid, now } = require('./db');
const { requiresApproval } = require('./roles');

const registry = {
  'contact.created': {
    entityType: 'contact',
    apply(tenantId, actorUserId, params) {
      const id = uid(); const t = now();
      db.prepare('INSERT INTO contacts (id, tenant_id, name, phone, company, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, tenantId, params.name || 'بدون نام', params.phone || '', params.company || '', actorUserId, t);
      return { entityId: id, data: db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) };
    },
  },
};

function insertEvent(actor, type, entityType, entityId, params, status) {
  const id = uid();
  db.prepare(`INSERT INTO events (id, tenant_id, type, actor_type, actor_id, actor_role, entity_type, entity_id, payload_json, status, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, actor.tenantId, type, actor.role === 'agent' ? 'agent' : 'user', actor.userId, actor.role,
      entityType, entityId || null, JSON.stringify(params || {}), status, now());
  return id;
}

// actor: { tenantId, userId, role: 'owner'|'admin'|'member'|'agent' }
function dispatch(actor, type, params) {
  const def = registry[type];
  if (!def) throw new Error('unknown_action:' + type);

  if (requiresApproval(actor.role, type)) {
    const eventId = insertEvent(actor, type, def.entityType, null, params, 'pending_approval');
    return { requiresApproval: true, eventId };
  }

  const { entityId, data } = def.apply(actor.tenantId, actor.userId, params);
  const eventId = insertEvent(actor, type, def.entityType, entityId, params, 'applied');
  return { requiresApproval: false, eventId, data };
}

// Resolves a 'pending_approval' event created by dispatch(). Not wired into
// any endpoint yet — pending_actions/resolvePending in agent.js still owns
// the live approval flow until every sensitive action moves to this registry.
function resolveEvent(tenantId, eventId, approve) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ? AND tenant_id = ?').get(eventId, tenantId);
  if (!ev) return { error: 'not_found' };
  if (ev.status !== 'pending_approval') return { error: 'already_resolved', status: ev.status };
  if (!approve) {
    db.prepare('UPDATE events SET status = ?, resolved_at = ? WHERE id = ?').run('rejected', now(), eventId);
    return { status: 'rejected' };
  }
  const def = registry[ev.type];
  const params = JSON.parse(ev.payload_json);
  const { entityId, data } = def.apply(ev.tenant_id, ev.actor_id, params);
  db.prepare('UPDATE events SET status = ?, resolved_at = ?, entity_id = ? WHERE id = ?').run('applied', now(), entityId, eventId);
  return { status: 'applied', data };
}

module.exports = { dispatch, resolveEvent, registry };
