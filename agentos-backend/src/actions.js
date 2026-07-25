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
// Migration status: every mutating action with a REST + Agent duplicate is
// wired through dispatch() (step 4 complete) — sensitive ones are gated by
// dispatch()'s own requiresApproval() now, replacing pending_actions.
// Still not migrated (no REST duplicate to fix, so no urgency): list_*,
// report, generate_report (read-only). Also PATCH /api/tasks/:id, which is
// a multi-purpose "update" endpoint (status/title/due date/reassignment all
// in one call) that doesn't map cleanly onto the Agent's single-purpose
// delegate_task action — needs its own small design pass.
const { db, uid, now } = require('./db');
const { requiresApproval } = require('./roles');

const STAGES = ['سرنخ', 'در حال مذاکره', 'پیشنهاد ارسال‌شده', 'برنده', 'ازدست‌رفته'];

async function findDeal(tenantId, id, title) {
  if (id) return db.get('SELECT * FROM deals WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  if (!title) return null;
  return db.get('SELECT * FROM deals WHERE tenant_id = ? AND title LIKE ? ORDER BY created_at DESC LIMIT 1',
    [tenantId, `%${title}%`]);
}
async function findContact(tenantId, id, name) {
  if (id) return db.get('SELECT * FROM contacts WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  if (!name) return null;
  return db.get('SELECT * FROM contacts WHERE tenant_id = ? AND name LIKE ? ORDER BY created_at DESC LIMIT 1',
    [tenantId, `%${name}%`]);
}
async function findModule(tenantId, id, name) {
  if (id) return db.get('SELECT * FROM custom_modules WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  if (!name) return null;
  return db.get('SELECT * FROM custom_modules WHERE tenant_id = ? AND name LIKE ? ORDER BY created_at DESC LIMIT 1',
    [tenantId, `%${name}%`]);
}
async function findMarketItem(id, name) {
  if (id) return db.get('SELECT * FROM marketplace_modules WHERE id = ? AND enabled = TRUE', [id]);
  if (!name) return null;
  return db.get('SELECT * FROM marketplace_modules WHERE name LIKE ? AND enabled = TRUE ORDER BY created_at DESC LIMIT 1',
    [`%${name}%`]);
}
async function findTeamMember(tenantId, id, name) {
  if (id) return db.get(`SELECT * FROM users WHERE id = ? AND tenant_id = ? AND status = 'active'`, [id, tenantId]);
  if (!name) return null;
  return db.get(`SELECT * FROM users WHERE tenant_id = ? AND status = 'active' AND name LIKE ? LIMIT 1`,
    [tenantId, `%${name}%`]);
}

const registry = {
  'contact.created': {
    entityType: 'contact',
    async apply(tenantId, actorUserId, params) {
      const id = uid(); const t = now();
      await db.run('INSERT INTO contacts (id, tenant_id, name, phone, company, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
        [id, tenantId, params.name || 'بدون نام', params.phone || '', params.company || '', actorUserId, t]);
      return { entityId: id, data: await db.get('SELECT * FROM contacts WHERE id = ?', [id]) };
    },
  },
  'contact.deleted': {
    entityType: 'contact',
    async apply(tenantId, actorUserId, params) {
      const c = await findContact(tenantId, params.id, params.name);
      if (!c) return null;
      await db.run('DELETE FROM contacts WHERE id = ?', [c.id]);
      return { entityId: c.id, data: { label: c.name } };
    },
  },
  'deal.created': {
    entityType: 'deal',
    async apply(tenantId, actorUserId, params) {
      const id = uid(); const t = now();
      const stage = STAGES.includes(params.stage) ? params.stage : 'سرنخ';
      await db.run('INSERT INTO deals (id, tenant_id, title, contact_name, amount, stage, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, tenantId, params.title || 'معامله جدید', params.contactName || '', params.amount != null ? Number(params.amount) : null, stage, actorUserId, t, t]);
      return { entityId: id, data: await db.get('SELECT * FROM deals WHERE id = ?', [id]) };
    },
  },
  'deal.stage_changed': {
    entityType: 'deal',
    async apply(tenantId, actorUserId, params) {
      const stage = params.stage || params.newStage;
      const deal = await findDeal(tenantId, params.id, params.dealTitle);
      if (!deal || !STAGES.includes(stage)) return null;
      await db.run('UPDATE deals SET stage = ?, updated_at = ? WHERE id = ?', [stage, now(), deal.id]);
      return { entityId: deal.id, data: await db.get('SELECT * FROM deals WHERE id = ?', [deal.id]) };
    },
  },
  'deal.deleted': {
    entityType: 'deal',
    async apply(tenantId, actorUserId, params) {
      const deal = await findDeal(tenantId, params.id, params.dealTitle);
      if (!deal) return null;
      await db.run('DELETE FROM deals WHERE id = ?', [deal.id]);
      return { entityId: deal.id, data: { label: deal.title } };
    },
  },
  'invoice.issued': {
    entityType: 'invoice',
    async apply(tenantId, actorUserId, params) {
      const deal = await findDeal(tenantId, params.dealId, params.dealTitle);
      const amount = params.amount != null ? Number(params.amount) : (deal ? deal.amount : null);
      const id = uid(); const t = now();
      await db.run('INSERT INTO invoices (id, tenant_id, deal_title, amount, created_by, created_at) VALUES (?,?,?,?,?,?)',
        [id, tenantId, deal ? deal.title : (params.dealTitle || 'نامشخص'), amount, actorUserId, t]);
      return { entityId: id, data: await db.get('SELECT * FROM invoices WHERE id = ?', [id]) };
    },
  },
  'module.created': {
    entityType: 'module',
    async apply(tenantId, actorUserId, params) {
      const tenant = await db.get('SELECT plan_key FROM tenants WHERE id = ?', [tenantId]);
      const plan = await db.get('SELECT modules_limit FROM plans WHERE key = ?', [tenant.plan_key]);
      if (plan && plan.modules_limit != null) {
        const countRow = await db.get('SELECT COUNT(*) c FROM custom_modules WHERE tenant_id = ?', [tenantId]);
        if (Number(countRow.c) >= plan.modules_limit) {
          return { skipEvent: true, data: { type: 'plan_limit', data: { limit: plan.modules_limit, feature: 'modules' } } };
        }
      }
      const name = params.name || params.moduleName || 'ماژول جدید';
      const fields = Array.isArray(params.fields) && params.fields.length ? params.fields : [{ key: 'note', label: 'یادداشت', type: 'text' }];
      const id = uid(); const t = now();
      await db.run('INSERT INTO custom_modules (id, tenant_id, name, entity_label, fields_json, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
        [id, tenantId, name, params.entityLabel || name, JSON.stringify(fields), actorUserId, t]);
      return { entityId: id, data: await db.get('SELECT * FROM custom_modules WHERE id = ?', [id]) };
    },
  },
  'module.record_created': {
    entityType: 'module_record',
    async apply(tenantId, actorUserId, params) {
      const mod = await findModule(tenantId, params.moduleId, params.moduleName);
      if (!mod) return null;
      const id = uid(); const t = now();
      await db.run('INSERT INTO module_records (id, module_id, tenant_id, values_json, created_by, created_at) VALUES (?,?,?,?,?,?)',
        [id, mod.id, tenantId, JSON.stringify(params.values || {}), actorUserId, t]);
      return { entityId: id, data: { module: mod, record: await db.get('SELECT * FROM module_records WHERE id = ?', [id]) } };
    },
  },
  'marketplace.published': {
    entityType: 'marketplace',
    async apply(tenantId, actorUserId, params) {
      const mod = await findModule(tenantId, params.moduleId, params.moduleName);
      if (!mod) return null;
      const existing = await db.get('SELECT * FROM marketplace_modules WHERE name = ? AND published_by_tenant = ?', [mod.name, tenantId]);
      const id = existing ? existing.id : uid();
      if (existing) await db.run('UPDATE marketplace_modules SET fields_json = ? WHERE id = ?', [mod.fields_json, id]);
      else await db.run('INSERT INTO marketplace_modules (id, name, entity_label, fields_json, published_by_tenant, installs, created_at) VALUES (?,?,?,?,?,0,?)',
        [id, mod.name, mod.entity_label, mod.fields_json, tenantId, now()]);
      return { entityId: id, data: await db.get('SELECT * FROM marketplace_modules WHERE id = ?', [id]) };
    },
  },
  'module.installed': {
    entityType: 'module',
    async apply(tenantId, actorUserId, params) {
      const item = await findMarketItem(params.marketItemId, params.moduleName);
      if (!item) return null;
      const id = uid(); const t = now();
      await db.run('INSERT INTO custom_modules (id, tenant_id, name, entity_label, fields_json, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
        [id, tenantId, item.name, item.entity_label, item.fields_json, actorUserId, t]);
      await db.run('UPDATE marketplace_modules SET installs = installs + 1 WHERE id = ?', [item.id]);
      return { entityId: id, data: await db.get('SELECT * FROM custom_modules WHERE id = ?', [id]) };
    },
  },
  'module.deleted': {
    entityType: 'module',
    async apply(tenantId, actorUserId, params) {
      const mod = await findModule(tenantId, params.id, params.moduleName);
      if (!mod) return null;
      await db.run('DELETE FROM module_records WHERE module_id = ?', [mod.id]);
      await db.run('DELETE FROM custom_modules WHERE id = ?', [mod.id]);
      return { entityId: mod.id, data: { label: mod.name } };
    },
  },
  'task.created': {
    entityType: 'task',
    async apply(tenantId, actorUserId, params) {
      const assignee = params.assigneeId
        ? await findTeamMember(tenantId, params.assigneeId, null)
        : (params.assigneeName ? await findTeamMember(tenantId, null, params.assigneeName) : null);
      const dueAt = params.dueAt != null ? params.dueAt : (params.dueInDays != null ? now() + Number(params.dueInDays) * 86400000 : null);
      const id = uid(); const t = now();
      await db.run(`INSERT INTO tasks (id, tenant_id, title, description, assignee_id, created_by, related_entity, due_at, status, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, params.title || 'وظیفه جدید', params.description || '', (assignee ? assignee.id : actorUserId), actorUserId, params.relatedEntity || null, dueAt, 'open', t, t]);
      const row = await db.get('SELECT t.*, u.name as assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?', [id]);
      return { entityId: id, data: row };
    },
  },
};

async function insertEvent(actor, type, entityType, entityId, params, status) {
  const id = uid();
  await db.run(`INSERT INTO events (id, tenant_id, type, actor_type, actor_id, actor_role, entity_type, entity_id, payload_json, status, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, actor.tenantId, type, actor.role === 'agent' ? 'agent' : 'user', actor.userId, actor.role,
      entityType, entityId || null, JSON.stringify(params || {}), status, now()]);
  return id;
}

const VALID_ROLES = new Set(['owner', 'admin', 'member', 'agent']);

// actor: { tenantId, userId, role: 'owner'|'admin'|'member'|'agent' }
async function dispatch(actor, type, params) {
  const def = registry[type];
  if (!def) throw new Error('unknown_action:' + type);
  // requiresApproval() silently returns false for a role it doesn't recognize
  // (no entry in the capability matrix), which would fail OPEN — a sensitive
  // action skipping the approval gate — if some future bug ever passed a
  // garbage role through. Reject that here instead of trusting the default.
  if (!VALID_ROLES.has(actor.role)) throw new Error('unknown_actor_role:' + actor.role);

  if (requiresApproval(actor.role, type)) {
    const eventId = await insertEvent(actor, type, def.entityType, null, params, 'pending_approval');
    return { requiresApproval: true, eventId };
  }

  const applied = await def.apply(actor.tenantId, actor.userId, params);
  if (!applied) return { requiresApproval: false, eventId: null, data: null };
  if (applied.skipEvent) return { requiresApproval: false, eventId: null, data: applied.data };

  const eventId = await insertEvent(actor, type, def.entityType, applied.entityId, params, 'applied');
  return { requiresApproval: false, eventId, data: applied.data };
}

// Resolves a 'pending_approval' event created by dispatch(). Not wired into
// any endpoint yet — pending_actions/resolvePending in agent.js still owns
// the live approval flow until every sensitive action moves to this registry.
async function resolveEvent(tenantId, eventId, approve) {
  const ev = await db.get('SELECT * FROM events WHERE id = ? AND tenant_id = ?', [eventId, tenantId]);
  if (!ev) return { error: 'not_found' };
  if (ev.status !== 'pending_approval') return { error: 'already_resolved', status: ev.status };
  if (!approve) {
    await db.run('UPDATE events SET status = ?, resolved_at = ? WHERE id = ?', ['rejected', now(), eventId]);
    return { status: 'rejected' };
  }
  const def = registry[ev.type];
  const params = JSON.parse(ev.payload_json);
  const applied = await def.apply(ev.tenant_id, ev.actor_id, params);
  await db.run('UPDATE events SET status = ?, resolved_at = ?, entity_id = ? WHERE id = ?',
    ['applied', now(), applied ? applied.entityId : null, eventId]);
  return { status: applied ? 'applied' : 'failed', data: applied ? applied.data : null };
}

module.exports = { dispatch, resolveEvent, registry, STAGES, findDeal, findContact, findModule, findMarketItem, findTeamMember };
