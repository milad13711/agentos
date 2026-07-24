// actions.js — Phase 1: single write path shared by server.js (REST) and
// agent.js (Agent). Each registry entry's apply() is the ONLY place that
// action's SQL lives — this is what eliminates the create_contact/
// create_deal-style duplication described in
// docs/phase1-event-schema-agent-roles.md.
//
// Lookup convention: REST callers already have a precise row id (from the
// URL); the Agent only has a natural-language title/name. Every apply()
// that mutates an existing row accepts BOTH `params.id` (exact, preferred)
// and a fuzzy name/title fallback (LIKE match, used only by the Agent path)
// so neither caller has to fake the other's input shape.
//
// Migration status:
// - Wired into dispatch() from both server.js and agent.js: contact.created,
//   deal.created, deal.stage_changed, module.record_created, task.created.
// - Defined here but NOT wired yet: contact.deleted, deal.deleted,
//   invoice.issued, module.created, marketplace.published, module.installed.
//   These are all sensitive actions currently gated by the OLD
//   pending_actions queue in agent.js (act() inserts into pending_actions
//   BEFORE executeAction ever runs; executeAction only runs post-approval).
//   Wiring them through dispatch() today would double-gate: roles.js would
//   see actor.role='agent' and requeue an already-approved action as
//   'pending_approval' again. They get wired together with the step-4
//   cutover, when pending_actions is retired and dispatch()'s own
//   requiresApproval() becomes the only gate.
// - Not migrated (no REST duplicate to fix, so no urgency): delete_module,
//   list_*, report, generate_report. Also PATCH /api/tasks/:id, which is a
//   multi-purpose "update" endpoint (status/title/due date/reassignment all
//   in one call) that doesn't map cleanly onto the Agent's single-purpose
//   delegate_task action — needs its own small design pass.
const { db, uid, now } = require('./db');
const { requiresApproval } = require('./roles');

const STAGES = ['سرنخ', 'در حال مذاکره', 'پیشنهاد ارسال‌شده', 'برنده', 'ازدست‌رفته'];

function findDeal(tenantId, id, title) {
  if (id) return db.prepare('SELECT * FROM deals WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!title) return null;
  return db.prepare('SELECT * FROM deals WHERE tenant_id = ? AND title LIKE ? ORDER BY created_at DESC LIMIT 1')
    .get(tenantId, `%${title}%`);
}
function findContact(tenantId, id, name) {
  if (id) return db.prepare('SELECT * FROM contacts WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!name) return null;
  return db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND name LIKE ? ORDER BY created_at DESC LIMIT 1')
    .get(tenantId, `%${name}%`);
}
function findModule(tenantId, id, name) {
  if (id) return db.prepare('SELECT * FROM custom_modules WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!name) return null;
  return db.prepare('SELECT * FROM custom_modules WHERE tenant_id = ? AND name LIKE ? ORDER BY created_at DESC LIMIT 1')
    .get(tenantId, `%${name}%`);
}
function findMarketItem(id, name) {
  if (id) return db.prepare('SELECT * FROM marketplace_modules WHERE id = ? AND enabled = 1').get(id);
  if (!name) return null;
  return db.prepare('SELECT * FROM marketplace_modules WHERE name LIKE ? AND enabled = 1 ORDER BY created_at DESC LIMIT 1')
    .get(`%${name}%`);
}
function findTeamMember(tenantId, id, name) {
  if (id) return db.prepare(`SELECT * FROM users WHERE id = ? AND tenant_id = ? AND status = 'active'`).get(id, tenantId);
  if (!name) return null;
  return db.prepare(`SELECT * FROM users WHERE tenant_id = ? AND status = 'active' AND name LIKE ? LIMIT 1`)
    .get(tenantId, `%${name}%`);
}

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
  'contact.deleted': {
    entityType: 'contact',
    apply(tenantId, actorUserId, params) {
      const c = findContact(tenantId, params.id, params.name);
      if (!c) return null;
      db.prepare('DELETE FROM contacts WHERE id = ?').run(c.id);
      return { entityId: c.id, data: { label: c.name } };
    },
  },
  'deal.created': {
    entityType: 'deal',
    apply(tenantId, actorUserId, params) {
      const id = uid(); const t = now();
      const stage = STAGES.includes(params.stage) ? params.stage : 'سرنخ';
      db.prepare('INSERT INTO deals (id, tenant_id, title, contact_name, amount, stage, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, tenantId, params.title || 'معامله جدید', params.contactName || '', params.amount != null ? Number(params.amount) : null, stage, actorUserId, t, t);
      return { entityId: id, data: db.prepare('SELECT * FROM deals WHERE id = ?').get(id) };
    },
  },
  'deal.stage_changed': {
    entityType: 'deal',
    apply(tenantId, actorUserId, params) {
      const stage = params.stage || params.newStage;
      const deal = findDeal(tenantId, params.id, params.dealTitle);
      if (!deal || !STAGES.includes(stage)) return null;
      db.prepare('UPDATE deals SET stage = ?, updated_at = ? WHERE id = ?').run(stage, now(), deal.id);
      return { entityId: deal.id, data: db.prepare('SELECT * FROM deals WHERE id = ?').get(deal.id) };
    },
  },
  'deal.deleted': {
    entityType: 'deal',
    apply(tenantId, actorUserId, params) {
      const deal = findDeal(tenantId, params.id, params.dealTitle);
      if (!deal) return null;
      db.prepare('DELETE FROM deals WHERE id = ?').run(deal.id);
      return { entityId: deal.id, data: { label: deal.title } };
    },
  },
  'invoice.issued': {
    entityType: 'invoice',
    apply(tenantId, actorUserId, params) {
      const deal = findDeal(tenantId, params.dealId, params.dealTitle);
      const amount = params.amount != null ? Number(params.amount) : (deal ? deal.amount : null);
      const id = uid(); const t = now();
      db.prepare('INSERT INTO invoices (id, tenant_id, deal_title, amount, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, tenantId, deal ? deal.title : (params.dealTitle || 'نامشخص'), amount, actorUserId, t);
      return { entityId: id, data: db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) };
    },
  },
  'module.created': {
    entityType: 'module',
    apply(tenantId, actorUserId, params) {
      const tenant = db.prepare('SELECT plan_key FROM tenants WHERE id = ?').get(tenantId);
      const plan = db.prepare('SELECT modules_limit FROM plans WHERE key = ?').get(tenant.plan_key);
      if (plan && plan.modules_limit != null) {
        const count = db.prepare('SELECT COUNT(*) c FROM custom_modules WHERE tenant_id = ?').get(tenantId).c;
        if (count >= plan.modules_limit) {
          return { skipEvent: true, data: { type: 'plan_limit', data: { limit: plan.modules_limit, feature: 'modules' } } };
        }
      }
      const name = params.name || params.moduleName || 'ماژول جدید';
      const fields = Array.isArray(params.fields) && params.fields.length ? params.fields : [{ key: 'note', label: 'یادداشت', type: 'text' }];
      const id = uid(); const t = now();
      db.prepare('INSERT INTO custom_modules (id, tenant_id, name, entity_label, fields_json, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, tenantId, name, params.entityLabel || name, JSON.stringify(fields), actorUserId, t);
      return { entityId: id, data: db.prepare('SELECT * FROM custom_modules WHERE id = ?').get(id) };
    },
  },
  'module.record_created': {
    entityType: 'module_record',
    apply(tenantId, actorUserId, params) {
      const mod = findModule(tenantId, params.moduleId, params.moduleName);
      if (!mod) return null;
      const id = uid(); const t = now();
      db.prepare('INSERT INTO module_records (id, module_id, tenant_id, values_json, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, mod.id, tenantId, JSON.stringify(params.values || {}), actorUserId, t);
      return { entityId: id, data: { module: mod, record: db.prepare('SELECT * FROM module_records WHERE id = ?').get(id) } };
    },
  },
  'marketplace.published': {
    entityType: 'marketplace',
    apply(tenantId, actorUserId, params) {
      const mod = findModule(tenantId, params.moduleId, params.moduleName);
      if (!mod) return null;
      const existing = db.prepare('SELECT * FROM marketplace_modules WHERE name = ? AND published_by_tenant = ?').get(mod.name, tenantId);
      const id = existing ? existing.id : uid();
      if (existing) db.prepare('UPDATE marketplace_modules SET fields_json = ? WHERE id = ?').run(mod.fields_json, id);
      else db.prepare('INSERT INTO marketplace_modules (id, name, entity_label, fields_json, published_by_tenant, installs, created_at) VALUES (?,?,?,?,?,0,?)')
        .run(id, mod.name, mod.entity_label, mod.fields_json, tenantId, now());
      return { entityId: id, data: db.prepare('SELECT * FROM marketplace_modules WHERE id = ?').get(id) };
    },
  },
  'module.installed': {
    entityType: 'module',
    apply(tenantId, actorUserId, params) {
      const item = findMarketItem(params.marketItemId, params.moduleName);
      if (!item) return null;
      const id = uid(); const t = now();
      db.prepare('INSERT INTO custom_modules (id, tenant_id, name, entity_label, fields_json, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, tenantId, item.name, item.entity_label, item.fields_json, actorUserId, t);
      db.prepare('UPDATE marketplace_modules SET installs = installs + 1 WHERE id = ?').run(item.id);
      return { entityId: id, data: db.prepare('SELECT * FROM custom_modules WHERE id = ?').get(id), fields: JSON.parse(item.fields_json) };
    },
  },
  'task.created': {
    entityType: 'task',
    apply(tenantId, actorUserId, params) {
      const assignee = params.assigneeId
        ? findTeamMember(tenantId, params.assigneeId, null)
        : (params.assigneeName ? findTeamMember(tenantId, null, params.assigneeName) : null);
      const dueAt = params.dueAt != null ? params.dueAt : (params.dueInDays != null ? now() + Number(params.dueInDays) * 86400000 : null);
      const id = uid(); const t = now();
      db.prepare(`INSERT INTO tasks (id, tenant_id, title, description, assignee_id, created_by, related_entity, due_at, status, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, tenantId, params.title || 'وظیفه جدید', params.description || '', (assignee ? assignee.id : actorUserId), actorUserId, params.relatedEntity || null, dueAt, 'open', t, t);
      const row = db.prepare('SELECT t.*, u.name as assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?').get(id);
      return { entityId: id, data: row };
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

  const applied = def.apply(actor.tenantId, actor.userId, params);
  if (!applied) return { requiresApproval: false, eventId: null, data: null };
  if (applied.skipEvent) return { requiresApproval: false, eventId: null, data: applied.data };

  const eventId = insertEvent(actor, type, def.entityType, applied.entityId, params, 'applied');
  return { requiresApproval: false, eventId, data: applied.data };
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
  const applied = def.apply(ev.tenant_id, ev.actor_id, params);
  db.prepare('UPDATE events SET status = ?, resolved_at = ?, entity_id = ? WHERE id = ?')
    .run('applied', now(), applied ? applied.entityId : null, eventId);
  return { status: applied ? 'applied' : 'failed', data: applied ? applied.data : null };
}

module.exports = { dispatch, resolveEvent, registry, STAGES, findDeal, findContact, findModule, findMarketItem, findTeamMember };
