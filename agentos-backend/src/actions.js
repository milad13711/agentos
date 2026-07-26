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

// ---------------------------------------------------------------------------
// Module automation engine — modules used to be pure forms with nothing
// behind them. This is a small, real workflow layer: a module can have any
// number of `module_automations` rows, each one "when <trigger> happens on
// this module, run <action_type> with <config_json>". Only the
// 'record_created' trigger exists today; the `trigger` column exists so more
// (e.g. 'record_updated') can be added later without a schema change.
// ---------------------------------------------------------------------------
const AUTOMATION_ACTION_TYPES = new Set(['create_task', 'webhook']);
const WEBHOOK_TIMEOUT_MS = 8000;

// Fills {{fieldKey}} placeholders in a template with the record's values —
// e.g. titleTemplate "پیگیری {{name}}" + {name: "رضا"} -> "پیگیری رضا".
function interpolate(template, values) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => (values[key] != null ? String(values[key]) : ''));
}

// Resolves a task's due_at with hour/minute precision, not just a day count.
// - params.dueAt (absolute ms) always wins if given.
// - params.dueHour/dueMinute set a specific wall-clock time on the target
//   day (dueInDays from today, default today) — e.g. "امروز ساعت ۱۷" ->
//   dueHour=17, no dueInDays. If that time has already passed today and no
//   explicit day offset was given, it rolls to tomorrow instead of firing
//   immediately (a reminder for "5pm" said at 6pm means tomorrow, not now).
// - Otherwise falls back to the original day-count-only behavior.
function computeDueAt(params, nowMs) {
  if (params.dueAt != null) return params.dueAt;
  if (params.dueHour != null || params.dueMinute != null) {
    const base = new Date(nowMs + (params.dueInDays != null ? Number(params.dueInDays) : 0) * 86400000);
    base.setHours(params.dueHour != null ? Number(params.dueHour) : base.getHours(), params.dueMinute != null ? Number(params.dueMinute) : 0, 0, 0);
    let ts = base.getTime();
    if (params.dueInDays == null && ts <= nowMs) ts += 86400000;
    return ts;
  }
  if (params.dueInDays != null) return nowMs + Number(params.dueInDays) * 86400000;
  return null;
}

async function runCreateTaskAction(tenantId, config, values, actorUserId) {
  const title = interpolate(config.titleTemplate, values) || 'وظیفه خودکار';
  const dueAt = config.dueInDays != null ? now() + Number(config.dueInDays) * 86400000 : null;
  const assignee = config.assigneeId ? await findTeamMember(tenantId, config.assigneeId, null) : null;
  const id = uid(); const t = now();
  await db.run(`INSERT INTO tasks (id, tenant_id, title, description, assignee_id, created_by, related_entity, due_at, status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, title, 'ساخته‌شده خودکار توسط اتوماسیون ماژول', (assignee ? assignee.id : actorUserId), actorUserId, null, dueAt, 'open', t, t]);
}

async function runWebhookAction(config, values) {
  if (!config.url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'record_created', values }),
      signal: controller.signal,
    });
  } catch (e) {
    // Best-effort: a broken/unreachable webhook must not fail the record
    // creation it's attached to. Failures are visible via server logs only
    // for now — see docs for a future "automation run log" if that's not enough.
    console.error('[automation webhook] failed:', config.url, e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function runAutomations(tenantId, moduleId, trigger, values, actorUserId) {
  const rules = await db.all(
    'SELECT * FROM module_automations WHERE tenant_id = ? AND module_id = ? AND trigger = ? AND enabled = TRUE',
    [tenantId, moduleId, trigger]
  );
  for (const rule of rules) {
    const config = JSON.parse(rule.config_json || '{}');
    if (rule.action_type === 'create_task') await runCreateTaskAction(tenantId, config, values, actorUserId);
    else if (rule.action_type === 'webhook') await runWebhookAction(config, values);
  }
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
      const values = params.values || {};
      await db.run('INSERT INTO module_records (id, module_id, tenant_id, values_json, created_by, created_at) VALUES (?,?,?,?,?,?)',
        [id, mod.id, tenantId, JSON.stringify(values), actorUserId, t]);
      await runAutomations(tenantId, mod.id, 'record_created', values, actorUserId);
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
      const existing = await db.get('SELECT * FROM custom_modules WHERE tenant_id = ? AND source_market_id = ?', [tenantId, item.id]);
      if (existing) {
        return { skipEvent: true, data: { type: 'already_installed', data: existing } };
      }
      const id = uid(); const t = now();
      await db.run('INSERT INTO custom_modules (id, tenant_id, name, entity_label, fields_json, created_by, source_market_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, tenantId, item.name, item.entity_label, item.fields_json, actorUserId, item.id, t]);
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
      const t = now();
      const dueAt = computeDueAt(params, t);
      const id = uid();
      await db.run(`INSERT INTO tasks (id, tenant_id, title, description, assignee_id, created_by, related_entity, due_at, status, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, params.title || 'وظیفه جدید', params.description || '', (assignee ? assignee.id : actorUserId), actorUserId, params.relatedEntity || null, dueAt, 'open', t, t]);
      const row = await db.get('SELECT t.*, u.name as assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?', [id]);
      return { entityId: id, data: row };
    },
  },
  'interaction.logged': {
    entityType: 'interaction',
    async apply(tenantId, actorUserId, params) {
      // Either a contact or a deal ("لید") can be logged against — whichever
      // name/id the caller gave resolves. entityType/entityId is fixed by
      // whichever one actually matched, not by which field the caller passed.
      let entityType = null, entityId = null;
      if (params.entityType === 'deal' || (!params.entityType && (params.dealTitle || params.dealId))) {
        const deal = await findDeal(tenantId, params.dealId || params.entityId, params.dealTitle);
        if (deal) { entityType = 'deal'; entityId = deal.id; }
      }
      if (!entityId) {
        const contact = await findContact(tenantId, params.contactId || params.entityId, params.contactName || params.name);
        if (contact) { entityType = 'contact'; entityId = contact.id; }
      }
      if (!entityId || !params.note) return null;
      const id = uid(); const t = now();
      await db.run('INSERT INTO interactions (id, tenant_id, entity_type, entity_id, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
        [id, tenantId, entityType, entityId, params.note, actorUserId, t]);
      return { entityId: id, data: await db.get('SELECT * FROM interactions WHERE id = ?', [id]) };
    },
  },
  // Sends a message to a customer/lead through the Telegram bot (requires
  // the contact to already have linked their Telegram chat — see
  // contact_link_codes / telegram.js). The send itself is also logged as an
  // interaction note automatically, so it shows up in the same history as
  // manually-logged calls/meetings.
  'contact.messaged': {
    entityType: 'contact',
    async apply(tenantId, actorUserId, params) {
      const contact = await findContact(tenantId, params.contactId || params.id, params.contactName || params.name);
      if (!contact || !params.message) return null;
      if (!contact.telegram_chat_id) {
        return { skipEvent: true, data: { type: 'telegram_not_linked', data: { label: contact.name } } };
      }
      // Required here, not at module load — telegram.js requires agent.js
      // which requires this module, so a top-level require would be circular.
      const telegram = require('./telegram');
      await telegram.sendMessage(contact.telegram_chat_id, params.message);
      const id = uid(); const t = now();
      await db.run('INSERT INTO interactions (id, tenant_id, entity_type, entity_id, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
        [id, tenantId, 'contact', contact.id, `پیام تلگرام ارسال شد: ${params.message}`, actorUserId, t]);
      return { entityId: contact.id, data: { type: 'message_sent', data: { label: contact.name, message: params.message } } };
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

module.exports = { dispatch, resolveEvent, registry, STAGES, findDeal, findContact, findModule, findMarketItem, findTeamMember, AUTOMATION_ACTION_TYPES };
