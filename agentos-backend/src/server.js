// server.js — real HTTP API. No framework: node:http + a tiny hand-rolled
// router. This keeps the project runnable with zero external dependencies
// (useful here; swap in Express/Fastify freely once you have registry access).

require('./env-loader');
const http = require('node:http');
const { buildXlsx } = require('./xlsx-writer');
const { db, uid, now } = require('./db');
const { hashPassword, verifyPassword, signToken, authenticate } = require('./auth');
const { act, resolvePending, audit, resolveProvider } = require('./agent');
const { createPaymentRequest, verifyPayment } = require('./billing');

const PORT = process.env.PORT || 8787;

// ---------- tiny in-memory rate limiter for auth endpoints ----------
const rateBuckets = new Map();
function rateLimited(ip, limit = 20, windowMs = 60_000) {
  const t = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  const fresh = bucket.filter(ts => t - ts < windowMs);
  fresh.push(t);
  rateBuckets.set(ip, fresh);
  return fresh.length > limit;
}

// ---------- helpers ----------
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(); // 1MB guard
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function requireAuth(req, res) {
  const auth = authenticate(req);
  if (!auth) { send(res, 401, { error: 'unauthorized' }); return null; }
  const tenant = db.prepare('SELECT status FROM tenants WHERE id = ?').get(auth.tenantId);
  if (!tenant) { send(res, 401, { error: 'invalid_session', message: 'نشست شما دیگر معتبر نیست (Tenant پیدا نشد) — لطفاً دوباره وارد شوید.' }); return null; }
  if (tenant.status === 'suspended') { send(res, 403, { error: 'tenant_suspended' }); return null; }
  return auth;
}

function requireSuperAdmin(req, res) {
  const auth = authenticate(req);
  if (!auth || !auth.isSuperAdmin) { send(res, 403, { error: 'forbidden', message: 'super admin access required' }); return null; }
  return auth;
}

// Promotes a user to super admin if their email matches SUPER_ADMIN_EMAIL.
// Called after register/login so the very first matching signup becomes admin.
function maybePromoteSuperAdmin(user) {
  const adminEmail = process.env.SUPER_ADMIN_EMAIL;
  if (adminEmail && user.email.toLowerCase() === adminEmail.toLowerCase() && !user.is_super_admin) {
    db.prepare('UPDATE users SET is_super_admin = 1 WHERE id = ?').run(user.id);
    return true;
  }
  return !!user.is_super_admin;
}

function isValidEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

// owner can do everything; admin can manage team/tasks but not billing-level tenant settings; member is restricted.
function requireRole(auth, res, roles) {
  if (!roles.includes(auth.role)) { send(res, 403, { error: 'insufficient_role', message: `نیاز به نقش: ${roles.join('/')}` }); return false; }
  return true;
}

function randomPassword() {
  return require('node:crypto').randomBytes(6).toString('base64url');
}

// ---------- route table ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler });
}

// ---- auth ----
route('POST', '/api/auth/register', async (req, res, params, ip) => {
  if (rateLimited('reg:' + ip)) return send(res, 429, { error: 'too_many_requests' });
  const body = await readBody(req);
  const { tenantName, name, email, password } = body;
  if (!tenantName || !name || !isValidEmail(email) || !password || password.length < 8) {
    return send(res, 400, { error: 'invalid_input', message: 'tenantName, name, email و password (حداقل ۸ کاراکتر) الزامی است.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return send(res, 409, { error: 'email_taken' });

  const tenantId = uid();
  const userId = uid();
  const { hash, salt } = hashPassword(password);
  const t = now();
  db.prepare('INSERT INTO tenants (id, name, plan, plan_key, status, ai_provider, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(tenantId, tenantName, 'trial', 'free', 'active', 'anthropic', t);
  db.prepare('INSERT INTO users (id, tenant_id, name, email, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(userId, tenantId, name, email, hash, salt, 'owner', t);
  audit(tenantId, 'user', userId, 'tenant_registered', 'tenant:' + tenantId, { tenantName });

  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const isSuperAdmin = maybePromoteSuperAdmin(userRow);
  const token = signToken({ tenantId, userId, role: 'owner', email, isSuperAdmin });
  send(res, 201, { token, tenant: { id: tenantId, name: tenantName }, user: { id: userId, name, email, role: 'owner', isSuperAdmin } });
});

route('POST', '/api/auth/login', async (req, res, params, ip) => {
  if (rateLimited('login:' + ip)) return send(res, 429, { error: 'too_many_requests' });
  const { email, password } = await readBody(req);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email || '');
  if (!user || !verifyPassword(password || '', user.salt, user.password_hash)) {
    return send(res, 401, { error: 'invalid_credentials' });
  }
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(user.tenant_id);
  if (tenant && tenant.status === 'suspended') return send(res, 403, { error: 'tenant_suspended' });
  const isSuperAdmin = maybePromoteSuperAdmin(user);
  const token = signToken({ tenantId: user.tenant_id, userId: user.id, role: user.role, email: user.email, isSuperAdmin });
  send(res, 200, { token, tenant: { id: tenant.id, name: tenant.name }, user: { id: user.id, name: user.name, email: user.email, role: user.role, isSuperAdmin } });
});

route('GET', '/api/me', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const user = db.prepare('SELECT id, name, email, role, is_super_admin, agent_name, agent_persona FROM users WHERE id = ?').get(auth.userId);
  const tenant = db.prepare('SELECT id, name, plan_key, status, trial_start, ai_provider FROM tenants WHERE id = ?').get(auth.tenantId);
  send(res, 200, { user, tenant });
});

// ---- personal Agent customization (each team member personalizes their own Agent) ----
route('PATCH', '/api/me/agent', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const { agentName, agentPersona } = await readBody(req);
  const tenant = db.prepare('SELECT plan_key FROM tenants WHERE id = ?').get(auth.tenantId);
  const plan = db.prepare('SELECT features_json FROM plans WHERE key = ?').get(tenant.plan_key);
  const features = plan ? JSON.parse(plan.features_json) : {};
  if (agentPersona && !features.customAgentPersona) {
    return send(res, 402, { error: 'plan_feature_locked', message: 'شخصی‌سازی شخصیت Agent فقط در پلن‌های Starter به بالاست.' });
  }
  db.prepare('UPDATE users SET agent_name = ?, agent_persona = ? WHERE id = ?')
    .run((agentName || 'Agent').slice(0, 40), (agentPersona || '').slice(0, 300), auth.userId);
  audit(auth.tenantId, 'user', auth.userId, 'update_agent_persona', 'user:' + auth.userId, { agentName });
  send(res, 200, db.prepare('SELECT id, agent_name, agent_persona FROM users WHERE id = ?').get(auth.userId));
});

// ---- team / personnel management (RBAC) ----
route('GET', '/api/team', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  send(res, 200, db.prepare('SELECT id, name, email, role, status, agent_name, created_at FROM users WHERE tenant_id = ? ORDER BY created_at ASC').all(auth.tenantId));
});

route('POST', '/api/team/invite', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  if (!requireRole(auth, res, ['owner', 'admin'])) return;
  const { name, email, role } = await readBody(req);
  if (!name || !isValidEmail(email)) return send(res, 400, { error: 'invalid_input' });
  const finalRole = ['admin', 'member'].includes(role) ? role : 'member';
  if (finalRole === 'admin' && auth.role !== 'owner') return send(res, 403, { error: 'only_owner_can_grant_admin' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return send(res, 409, { error: 'email_taken' });

  const tenant = db.prepare('SELECT plan_key FROM tenants WHERE id = ?').get(auth.tenantId);
  const plan = db.prepare('SELECT seats_limit FROM plans WHERE key = ?').get(tenant.plan_key);
  if (plan && plan.seats_limit != null) {
    const count = db.prepare(`SELECT COUNT(*) c FROM users WHERE tenant_id = ? AND status = 'active'`).get(auth.tenantId).c;
    if (count >= plan.seats_limit) return send(res, 402, { error: 'seat_limit_reached', message: `پلن فعلی حداکثر ${plan.seats_limit} کاربر اجازه می‌ده.` });
  }

  const tempPassword = randomPassword();
  const { hash, salt } = hashPassword(tempPassword);
  const id = uid(); const t = now();
  db.prepare('INSERT INTO users (id, tenant_id, name, email, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, auth.tenantId, name, email, hash, salt, finalRole, t);
  audit(auth.tenantId, 'user', auth.userId, 'invite_team_member', 'user:' + id, { email, role: finalRole });
  // NOTE: no email sending in this environment — temp password is returned directly so the
  // inviter can share it. In production this becomes an emailed invite link instead.
  send(res, 201, { id, name, email, role: finalRole, tempPassword });
});

route('PATCH', '/api/team/:id/role', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  if (!requireRole(auth, res, ['owner'])) return;
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(params.id, auth.tenantId);
  if (!target) return send(res, 404, { error: 'not_found' });
  const { role } = await readBody(req);
  if (!['owner', 'admin', 'member'].includes(role)) return send(res, 400, { error: 'invalid_role' });
  if (target.role === 'owner' && role !== 'owner') {
    const ownerCount = db.prepare(`SELECT COUNT(*) c FROM users WHERE tenant_id = ? AND role = 'owner'`).get(auth.tenantId).c;
    if (ownerCount <= 1) return send(res, 400, { error: 'cannot_demote_last_owner' });
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
  audit(auth.tenantId, 'user', auth.userId, 'change_team_role', 'user:' + target.id, { role });
  send(res, 200, db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(target.id));
});

route('DELETE', '/api/team/:id', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  if (!requireRole(auth, res, ['owner', 'admin'])) return;
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(params.id, auth.tenantId);
  if (!target) return send(res, 404, { error: 'not_found' });
  if (target.role === 'owner') return send(res, 400, { error: 'cannot_remove_owner' });
  if (target.id === auth.userId) return send(res, 400, { error: 'cannot_remove_self' });
  db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(target.id);
  db.prepare(`UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ?`).run(target.id);
  audit(auth.tenantId, 'user', auth.userId, 'remove_team_member', 'user:' + target.id, {});
  send(res, 200, { removed: true });
});

// ---- tasks: reminders, follow-ups, delegation between personnel ----
route('GET', '/api/tasks', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const rows = db.prepare(`
    SELECT t.*, u1.name as assignee_name, u2.name as creator_name
    FROM tasks t
    LEFT JOIN users u1 ON u1.id = t.assignee_id
    LEFT JOIN users u2 ON u2.id = t.created_by
    WHERE t.tenant_id = ? ORDER BY (t.due_at IS NULL), t.due_at ASC, t.created_at DESC
  `).all(auth.tenantId);
  send(res, 200, rows);
});

route('POST', '/api/tasks', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const { title, description, assigneeId, dueAt, relatedEntity } = await readBody(req);
  if (!title) return send(res, 400, { error: 'title_required' });
  if (assigneeId) {
    const assignee = db.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').get(assigneeId, auth.tenantId);
    if (!assignee) return send(res, 400, { error: 'invalid_assignee' });
  }
  const id = uid(); const t = now();
  db.prepare(`INSERT INTO tasks (id, tenant_id, title, description, assignee_id, created_by, related_entity, due_at, status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, auth.tenantId, title, description || '', assigneeId || auth.userId, auth.userId, relatedEntity || null, dueAt || null, 'open', t, t);
  audit(auth.tenantId, 'user', auth.userId, 'create_task', 'task:' + id, { title, assigneeId });
  send(res, 201, db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
});

route('PATCH', '/api/tasks/:id', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(params.id, auth.tenantId);
  if (!task) return send(res, 404, { error: 'not_found' });
  const { status, dueAt, assigneeId, title, description } = await readBody(req);
  const wasDelegated = assigneeId && assigneeId !== task.assignee_id;
  db.prepare(`UPDATE tasks SET
      status = COALESCE(?, status), due_at = COALESCE(?, due_at), assignee_id = COALESCE(?, assignee_id),
      title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ? WHERE id = ?`)
    .run(status || null, dueAt != null ? dueAt : null, assigneeId || null, title || null, description || null, now(), task.id);
  audit(auth.tenantId, 'user', auth.userId, wasDelegated ? 'delegate_task' : 'update_task', 'task:' + task.id, { status, assigneeId });
  send(res, 200, db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id));
});

route('DELETE', '/api/tasks/:id', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(params.id, auth.tenantId);
  if (!task) return send(res, 404, { error: 'not_found' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  audit(auth.tenantId, 'user', auth.userId, 'delete_task', 'task:' + task.id, {});
  send(res, 200, { deleted: true });
});

// ---- contacts ----
route('GET', '/api/contacts', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  send(res, 200, db.prepare('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC').all(auth.tenantId));
});
route('POST', '/api/contacts', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const { name, phone, company } = await readBody(req);
  if (!name) return send(res, 400, { error: 'name_required' });
  const id = uid(); const t = now();
  db.prepare('INSERT INTO contacts (id, tenant_id, name, phone, company, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, auth.tenantId, name, phone || '', company || '', auth.userId, t);
  audit(auth.tenantId, 'user', auth.userId, 'create_contact', 'contact:' + id, { name });
  send(res, 201, db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
});
route('DELETE', '/api/contacts/:id', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const c = db.prepare('SELECT * FROM contacts WHERE id = ? AND tenant_id = ?').get(params.id, auth.tenantId);
  if (!c) return send(res, 404, { error: 'not_found' });
  db.prepare('DELETE FROM contacts WHERE id = ?').run(c.id);
  audit(auth.tenantId, 'user', auth.userId, 'delete_contact', 'contact:' + c.id, {});
  send(res, 200, { deleted: true });
});

// ---- deals ----
route('GET', '/api/deals', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  send(res, 200, db.prepare('SELECT * FROM deals WHERE tenant_id = ? ORDER BY created_at DESC').all(auth.tenantId));
});
route('POST', '/api/deals', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const { title, contactName, amount, stage } = await readBody(req);
  if (!title) return send(res, 400, { error: 'title_required' });
  const id = uid(); const t = now();
  db.prepare('INSERT INTO deals (id, tenant_id, title, contact_name, amount, stage, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, auth.tenantId, title, contactName || '', amount != null ? Number(amount) : null, stage || 'سرنخ', auth.userId, t, t);
  audit(auth.tenantId, 'user', auth.userId, 'create_deal', 'deal:' + id, { title });
  send(res, 201, db.prepare('SELECT * FROM deals WHERE id = ?').get(id));
});
route('PATCH', '/api/deals/:id/stage', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const { stage } = await readBody(req);
  const deal = db.prepare('SELECT * FROM deals WHERE id = ? AND tenant_id = ?').get(params.id, auth.tenantId);
  if (!deal) return send(res, 404, { error: 'not_found' });
  db.prepare('UPDATE deals SET stage = ?, updated_at = ? WHERE id = ?').run(stage, now(), deal.id);
  audit(auth.tenantId, 'user', auth.userId, 'update_deal_stage', 'deal:' + deal.id, { stage });
  send(res, 200, db.prepare('SELECT * FROM deals WHERE id = ?').get(deal.id));
});
route('DELETE', '/api/deals/:id', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const deal = db.prepare('SELECT * FROM deals WHERE id = ? AND tenant_id = ?').get(params.id, auth.tenantId);
  if (!deal) return send(res, 404, { error: 'not_found' });
  db.prepare('DELETE FROM deals WHERE id = ?').run(deal.id);
  audit(auth.tenantId, 'user', auth.userId, 'delete_deal', 'deal:' + deal.id, {});
  send(res, 200, { deleted: true });
});

// ---- invoices ----
route('GET', '/api/invoices', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  send(res, 200, db.prepare('SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC').all(auth.tenantId));
});
route('POST', '/api/invoices', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const { dealTitle, amount } = await readBody(req);
  const id = uid(); const t = now();
  db.prepare('INSERT INTO invoices (id, tenant_id, deal_title, amount, created_by, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, auth.tenantId, dealTitle || '', amount != null ? Number(amount) : null, auth.userId, t);
  audit(auth.tenantId, 'user', auth.userId, 'issue_invoice', 'invoice:' + id, { dealTitle });
  send(res, 201, db.prepare('SELECT * FROM invoices WHERE id = ?').get(id));
});

// ---- custom modules (Module Builder) ----
route('GET', '/api/modules', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const rows = db.prepare('SELECT * FROM custom_modules WHERE tenant_id = ? ORDER BY created_at DESC').all(auth.tenantId)
    .map(m => ({ ...m, fields: JSON.parse(m.fields_json) }));
  send(res, 200, rows);
});
route('POST', '/api/modules', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const { name, entityLabel, fields } = await readBody(req);
  if (!name || !Array.isArray(fields) || !fields.length) return send(res, 400, { error: 'name_and_fields_required' });

  const tenant = db.prepare('SELECT plan_key FROM tenants WHERE id = ?').get(auth.tenantId);
  const plan = db.prepare('SELECT modules_limit FROM plans WHERE key = ?').get(tenant.plan_key);
  if (plan && plan.modules_limit != null) {
    const count = db.prepare('SELECT COUNT(*) c FROM custom_modules WHERE tenant_id = ?').get(auth.tenantId).c;
    if (count >= plan.modules_limit) return send(res, 402, { error: 'plan_limit_reached', message: `پلن فعلی حداکثر ${plan.modules_limit} ماژول اجازه می‌ده.` });
  }

  const id = uid(); const t = now();
  db.prepare('INSERT INTO custom_modules (id, tenant_id, name, entity_label, fields_json, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, auth.tenantId, name, entityLabel || name, JSON.stringify(fields), auth.userId, t);
  audit(auth.tenantId, 'user', auth.userId, 'build_module', 'module:' + id, { name });
  send(res, 201, { ...db.prepare('SELECT * FROM custom_modules WHERE id = ?').get(id), fields });
});
route('POST', '/api/modules/:id/records', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const mod = db.prepare('SELECT * FROM custom_modules WHERE id = ? AND tenant_id = ?').get(params.id, auth.tenantId);
  if (!mod) return send(res, 404, { error: 'not_found' });
  const { values } = await readBody(req);
  const id = uid(); const t = now();
  db.prepare('INSERT INTO module_records (id, module_id, tenant_id, values_json, created_by, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, mod.id, auth.tenantId, JSON.stringify(values || {}), auth.userId, t);
  audit(auth.tenantId, 'user', auth.userId, 'module_create_record', 'module_record:' + id, { module: mod.name });
  send(res, 201, db.prepare('SELECT * FROM module_records WHERE id = ?').get(id));
});
route('GET', '/api/modules/:id/records', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const mod = db.prepare('SELECT * FROM custom_modules WHERE id = ? AND tenant_id = ?').get(params.id, auth.tenantId);
  if (!mod) return send(res, 404, { error: 'not_found' });
  send(res, 200, db.prepare('SELECT * FROM module_records WHERE module_id = ? ORDER BY created_at DESC').all(mod.id));
});

// ---- marketplace ----
route('GET', '/api/marketplace', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return; // still requires login, but not tenant-scoped by design
  send(res, 200, db.prepare('SELECT * FROM marketplace_modules WHERE enabled = 1 ORDER BY created_at DESC').all());
});
route('POST', '/api/marketplace/publish', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const { moduleId } = await readBody(req);
  const mod = db.prepare('SELECT * FROM custom_modules WHERE id = ? AND tenant_id = ?').get(moduleId, auth.tenantId);
  if (!mod) return send(res, 404, { error: 'not_found' });
  const existing = db.prepare('SELECT * FROM marketplace_modules WHERE name = ? AND published_by_tenant = ?').get(mod.name, auth.tenantId);
  const id = existing ? existing.id : uid();
  if (existing) db.prepare('UPDATE marketplace_modules SET fields_json = ? WHERE id = ?').run(mod.fields_json, id);
  else db.prepare('INSERT INTO marketplace_modules (id, name, entity_label, fields_json, published_by_tenant, installs, created_at) VALUES (?,?,?,?,?,0,?)')
    .run(id, mod.name, mod.entity_label, mod.fields_json, auth.tenantId, now());
  audit(auth.tenantId, 'user', auth.userId, 'publish_module', 'marketplace:' + id, { name: mod.name });
  send(res, 200, db.prepare('SELECT * FROM marketplace_modules WHERE id = ?').get(id));
});
route('POST', '/api/marketplace/:id/install', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const item = db.prepare('SELECT * FROM marketplace_modules WHERE id = ?').get(params.id);
  if (!item || !item.enabled) return send(res, 404, { error: 'not_found' });
  const id = uid(); const t = now();
  db.prepare('INSERT INTO custom_modules (id, tenant_id, name, entity_label, fields_json, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, auth.tenantId, item.name, item.entity_label, item.fields_json, auth.userId, t);
  db.prepare('UPDATE marketplace_modules SET installs = installs + 1 WHERE id = ?').run(item.id);
  audit(auth.tenantId, 'user', auth.userId, 'install_module', 'module:' + id, { name: item.name });
  send(res, 201, { ...db.prepare('SELECT * FROM custom_modules WHERE id = ?').get(id), fields: JSON.parse(item.fields_json) });
});

// ---- agent (chat-first entrypoint) ----
route('POST', '/api/agent/act', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const { text, history } = await readBody(req);
  if (!text || !text.trim()) return send(res, 400, { error: 'text_required' });
  try {
    const result = await act(auth.tenantId, auth.userId, text.trim(), Array.isArray(history) ? history : []);
    send(res, 200, result);
  } catch (e) {
    console.error('[agent/act]', e);
    const isDbError = /FOREIGN KEY|SQLITE|constraint/i.test(e.message || '');
    send(res, isDbError ? 500 : 502, { error: isDbError ? 'internal_error' : 'ai_gateway_error', message: e.message });
  }
});
route('POST', '/api/agent/pending/:id/approve', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  send(res, 200, resolvePending(auth.tenantId, auth.userId, params.id, true));
});
route('POST', '/api/agent/pending/:id/reject', async (req, res, params) => {
  const auth = requireAuth(req, res); if (!auth) return;
  send(res, 200, resolvePending(auth.tenantId, auth.userId, params.id, false));
});
route('GET', '/api/agent/pending', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  send(res, 200, db.prepare(`SELECT * FROM pending_actions WHERE tenant_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(auth.tenantId));
});

// ---- billing (tenant-scoped) ----
route('POST', '/api/billing/trial/activate', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(auth.tenantId);
  if (tenant.plan_key !== 'free') return send(res, 400, { error: 'not_on_free_plan' });
  if (tenant.trial_start) return send(res, 400, { error: 'trial_already_used' });
  db.prepare('UPDATE tenants SET trial_start = ? WHERE id = ?').run(now(), auth.tenantId);
  audit(auth.tenantId, 'user', auth.userId, 'trial_activated', 'tenant:' + auth.tenantId, {});
  send(res, 200, { trialStart: now(), trialDays: 7 });
});

route('POST', '/api/billing/subscribe', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  if (!requireRole(auth, res, ['owner', 'admin'])) return;
  const { planKey, billingCycle } = await readBody(req);
  if (!planKey || !['monthly', 'yearly'].includes(billingCycle)) {
    return send(res, 400, { error: 'invalid_input', message: 'planKey و billingCycle (monthly|yearly) الزامی است.' });
  }
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(auth.userId);
  try {
    const result = await createPaymentRequest({
      tenantId: auth.tenantId, userId: auth.userId, planKey, billingCycle, email: user?.email
    });
    audit(auth.tenantId, 'user', auth.userId, 'subscription_payment_requested', 'plan:' + planKey, { billingCycle });
    send(res, 200, result);
  } catch (e) {
    send(res, 502, { error: 'payment_gateway_error', message: e.message });
  }
});

route('POST', '/api/billing/verify', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const { authority, status } = await readBody(req);
  if (!authority) return send(res, 400, { error: 'authority_required' });
  try {
    const result = await verifyPayment({ tenantId: auth.tenantId, authority, status });
    send(res, result.ok ? 200 : 402, result);
  } catch (e) {
    send(res, 502, { error: 'payment_gateway_error', message: e.message });
  }
});

route('GET', '/api/billing/history', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  send(res, 200, db.prepare('SELECT id, plan_key, billing_cycle, amount_toman, status, ref_id, created_at, paid_at FROM subscription_payments WHERE tenant_id = ? ORDER BY created_at DESC').all(auth.tenantId));
});

// ---- Super Admin Dashboard API ----
route('GET', '/api/admin/kpis', async (req, res) => {
  const auth = requireSuperAdmin(req, res); if (!auth) return;
  const totalTenants = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;
  const activeTenants = db.prepare(`SELECT COUNT(*) c FROM tenants WHERE status = 'active'`).get().c;
  const suspendedTenants = totalTenants - activeTenants;
  const totalUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const byPlan = db.prepare('SELECT plan_key, COUNT(*) c FROM tenants GROUP BY plan_key').all();
  const dayAgo = now() - 86400000;
  const sevenDaysAgo = now() - 7 * 86400000;
  const activeTrials = db.prepare(`SELECT COUNT(*) c FROM tenants WHERE trial_start IS NOT NULL AND trial_start > ?`).get(sevenDaysAgo).c;
  const agentActionsToday = db.prepare(`SELECT COUNT(*) c FROM audit_logs WHERE actor_type = 'agent' AND created_at > ?`).get(dayAgo).c;
  const pendingApprovals = db.prepare(`SELECT COUNT(*) c FROM pending_actions WHERE status = 'pending'`).get().c;
  const totalContacts = db.prepare('SELECT COUNT(*) c FROM contacts').get().c;
  const totalDeals = db.prepare('SELECT COUNT(*) c FROM deals').get().c;
  const totalInvoices = db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
  const marketplaceModules = db.prepare('SELECT COUNT(*) c FROM marketplace_modules').get().c;

  const plans = db.prepare('SELECT key, price_monthly_toman FROM plans').all();
  const priceByKey = Object.fromEntries(plans.map(p => [p.key, p.price_monthly_toman]));
  const estimatedMRRToman = byPlan.reduce((sum, row) => sum + (priceByKey[row.plan_key] || 0) * row.c, 0);

  send(res, 200, {
    totalTenants, activeTenants, suspendedTenants, totalUsers, byPlan, activeTrials,
    agentActionsToday, pendingApprovals, totalContacts, totalDeals, totalInvoices,
    marketplaceModules, estimatedMRRToman,
    aiGatewayLive: resolveProvider() !== 'mock',
    aiGatewayProvider: resolveProvider()
  });
});

route('GET', '/api/admin/tenants', async (req, res) => {
  const auth = requireSuperAdmin(req, res); if (!auth) return;
  const tenants = db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
  const rows = tenants.map(t => {
    const userCount = db.prepare('SELECT COUNT(*) c FROM users WHERE tenant_id = ?').get(t.id).c;
    const contactCount = db.prepare('SELECT COUNT(*) c FROM contacts WHERE tenant_id = ?').get(t.id).c;
    const dealCount = db.prepare('SELECT COUNT(*) c FROM deals WHERE tenant_id = ?').get(t.id).c;
    const lastActivity = db.prepare('SELECT created_at FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1').get(t.id);
    const trialLeft = t.trial_start ? Math.max(0, 7 - Math.floor((now() - t.trial_start) / 86400000)) : null;
    return {
      id: t.id, name: t.name, planKey: t.plan_key, status: t.status, aiProvider: t.ai_provider,
      createdAt: t.created_at, userCount, contactCount, dealCount,
      trialActive: trialLeft != null && trialLeft > 0, trialDaysLeft: trialLeft,
      lastActivityAt: lastActivity ? lastActivity.created_at : null
    };
  });
  send(res, 200, rows);
});

route('GET', '/api/admin/tenants/:id', async (req, res, params) => {
  const auth = requireSuperAdmin(req, res); if (!auth) return;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(params.id);
  if (!tenant) return send(res, 404, { error: 'not_found' });
  const users = db.prepare('SELECT id, name, email, role, is_super_admin, created_at FROM users WHERE tenant_id = ?').all(tenant.id);
  const modules = db.prepare('SELECT id, name, entity_label, created_at FROM custom_modules WHERE tenant_id = ?').all(tenant.id);
  const recentAudit = db.prepare('SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 25').all(tenant.id);
  send(res, 200, { tenant, users, modules, recentAudit });
});

route('PATCH', '/api/admin/tenants/:id', async (req, res, params) => {
  const auth = requireSuperAdmin(req, res); if (!auth) return;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(params.id);
  if (!tenant) return send(res, 404, { error: 'not_found' });
  const { planKey, status } = await readBody(req);
  if (planKey) {
    const plan = db.prepare('SELECT key FROM plans WHERE key = ?').get(planKey);
    if (!plan) return send(res, 400, { error: 'invalid_plan_key' });
    db.prepare('UPDATE tenants SET plan_key = ? WHERE id = ?').run(planKey, tenant.id);
  }
  if (status) {
    if (!['active', 'suspended'].includes(status)) return send(res, 400, { error: 'invalid_status' });
    db.prepare('UPDATE tenants SET status = ? WHERE id = ?').run(status, tenant.id);
  }
  audit(tenant.id, 'user', auth.userId, 'admin_update_tenant', 'tenant:' + tenant.id, { planKey, status, by: 'super_admin' });
  send(res, 200, db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id));
});

route('GET', '/api/admin/plans', async (req, res) => {
  const auth = requireSuperAdmin(req, res); if (!auth) return;
  const plans = db.prepare('SELECT * FROM plans ORDER BY price_monthly_toman ASC').all();
  send(res, 200, plans.map(p => ({ ...p, features: JSON.parse(p.features_json) })));
});

// Public plan catalogue for the pricing page — no auth required.
route('GET', '/api/plans', async (req, res) => {
  const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY price_monthly_toman ASC').all();
  send(res, 200, plans.map(p => ({
    key: p.key, name: p.name,
    priceMonthlyToman: p.price_monthly_toman, priceYearlyToman: p.price_yearly_toman,
    priceMonthlyUsd: p.price_monthly, priceYearlyUsd: p.price_yearly,
    seatsLimit: p.seats_limit, agentActionsLimit: p.agent_actions_limit, modulesLimit: p.modules_limit,
    marketplaceAccess: !!p.marketplace_access, supportLevel: p.support_level,
    features: JSON.parse(p.features_json)
  })));
});

route('PATCH', '/api/admin/plans/:key', async (req, res, params) => {
  const auth = requireSuperAdmin(req, res); if (!auth) return;
  const plan = db.prepare('SELECT * FROM plans WHERE key = ?').get(params.key);
  if (!plan) return send(res, 404, { error: 'not_found' });
  const body = await readBody(req);
  const camelToSnake = {
    name:'name', priceMonthly:'price_monthly', priceYearly:'price_yearly',
    priceMonthlyToman:'price_monthly_toman', priceYearlyToman:'price_yearly_toman',
    seatsLimit:'seats_limit', agentActionsLimit:'agent_actions_limit', modulesLimit:'modules_limit',
    marketplaceAccess:'marketplace_access', supportLevel:'support_level', isActive:'is_active'
  };
  const updates = {};
  Object.keys(camelToSnake).forEach(camel => { if (body[camel] !== undefined) updates[camelToSnake[camel]] = body[camel]; });
  if (body.features && typeof body.features === 'object') updates.features_json = JSON.stringify(body.features);
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  if (setSql) {
    db.prepare(`UPDATE plans SET ${setSql}, updated_at = ? WHERE key = ?`).run(...Object.values(updates), now(), params.key);
  }
  audit('platform', 'user', auth.userId, 'admin_update_plan', 'plan:' + params.key, updates);
  const updated = db.prepare('SELECT * FROM plans WHERE key = ?').get(params.key);
  send(res, 200, { ...updated, features: JSON.parse(updated.features_json) });
});

route('GET', '/api/admin/marketplace', async (req, res) => {
  const auth = requireSuperAdmin(req, res); if (!auth) return;
  const items = db.prepare('SELECT * FROM marketplace_modules ORDER BY created_at DESC').all();
  const withPublisher = items.map(it => {
    const tenant = db.prepare('SELECT name FROM tenants WHERE id = ?').get(it.published_by_tenant);
    return { ...it, publisherName: tenant ? tenant.name : it.published_by_tenant };
  });
  send(res, 200, withPublisher);
});

route('PATCH', '/api/admin/marketplace/:id', async (req, res, params) => {
  const auth = requireSuperAdmin(req, res); if (!auth) return;
  const item = db.prepare('SELECT * FROM marketplace_modules WHERE id = ?').get(params.id);
  if (!item) return send(res, 404, { error: 'not_found' });
  const { enabled } = await readBody(req);
  db.prepare('UPDATE marketplace_modules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, params.id);
  audit('platform', 'user', auth.userId, 'admin_toggle_marketplace_module', 'marketplace:' + params.id, { enabled });
  send(res, 200, db.prepare('SELECT * FROM marketplace_modules WHERE id = ?').get(params.id));
});

route('GET', '/api/admin/audit', async (req, res) => {
  const auth = requireSuperAdmin(req, res); if (!auth) return;
  send(res, 200, db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 150').all());
});

// ---- reports (real file downloads — Excel-compatible CSV with UTF-8 BOM for Persian text) ----
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function sendCsv(res, filename, columns, rows) {
  const header = columns.map(c => csvEscape(c.label)).join(',');
  const body = rows.map(r => columns.map(c => csvEscape(r[c.key])).join(',')).join('\n');
  const csv = '\uFEFF' + header + '\n' + body; // BOM so Excel opens Persian text correctly
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(csv);
}
route('GET', '/api/reports/contacts.csv', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const rows = db.prepare('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC').all(auth.tenantId);
  sendCsv(res, 'contacts.csv', [{key:'name',label:'نام'},{key:'phone',label:'تلفن'},{key:'company',label:'شرکت'}], rows);
});
route('GET', '/api/reports/deals.csv', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const rows = db.prepare('SELECT * FROM deals WHERE tenant_id = ? ORDER BY created_at DESC').all(auth.tenantId);
  sendCsv(res, 'deals.csv', [{key:'title',label:'عنوان'},{key:'contact_name',label:'مخاطب'},{key:'amount',label:'مبلغ'},{key:'stage',label:'مرحله'}], rows);
});
route('GET', '/api/reports/invoices.csv', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const rows = db.prepare('SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC').all(auth.tenantId);
  sendCsv(res, 'invoices.csv', [{key:'deal_title',label:'معامله'},{key:'amount',label:'مبلغ'}], rows);
});
route('GET', '/api/reports/tasks.csv', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const rows = db.prepare(`SELECT t.title, u.name as assignee_name, t.status, t.due_at FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.tenant_id = ? ORDER BY t.created_at DESC`).all(auth.tenantId);
  sendCsv(res, 'tasks.csv', [{key:'title',label:'عنوان'},{key:'assignee_name',label:'مسئول'},{key:'status',label:'وضعیت'},{key:'due_at',label:'موعد'}], rows);
});

// Real .xlsx (OOXML) reports — genuine Excel files, not CSV-with-an-extension.
function sendXlsx(res, filename, sheetName, headers, rows) {
  const buf = buildXlsx(sheetName, headers, rows);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(buf);
}
route('GET', '/api/reports/contacts.xlsx', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const rows = db.prepare('SELECT name, phone, company FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC').all(auth.tenantId);
  sendXlsx(res, 'contacts.xlsx', 'مخاطبین', ['نام','تلفن','شرکت'], rows.map(r => [r.name, r.phone, r.company]));
});
route('GET', '/api/reports/deals.xlsx', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const rows = db.prepare('SELECT title, contact_name, amount, stage FROM deals WHERE tenant_id = ? ORDER BY created_at DESC').all(auth.tenantId);
  sendXlsx(res, 'deals.xlsx', 'معاملات', ['عنوان','مخاطب','مبلغ','مرحله'], rows.map(r => [r.title, r.contact_name, r.amount, r.stage]));
});
route('GET', '/api/reports/invoices.xlsx', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const rows = db.prepare('SELECT deal_title, amount FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC').all(auth.tenantId);
  sendXlsx(res, 'invoices.xlsx', 'فاکتورها', ['معامله','مبلغ'], rows.map(r => [r.deal_title, r.amount]));
});
route('GET', '/api/reports/tasks.xlsx', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const rows = db.prepare(`SELECT t.title, u.name as assignee_name, t.status, t.due_at FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.tenant_id = ? ORDER BY t.created_at DESC`).all(auth.tenantId);
  sendXlsx(res, 'tasks.xlsx', 'وظایف', ['عنوان','مسئول','وضعیت','موعد'], rows.map(r => [r.title, r.assignee_name, r.status, r.due_at ? new Date(r.due_at).toLocaleDateString('fa-IR') : '']));
});

// ---- audit ----
route('GET', '/api/audit', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  send(res, 200, db.prepare('SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100').all(auth.tenantId));
});

// ---- health ----
route('GET', '/api/health', async (req, res) => send(res, 200, { ok: true, time: now() }));

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ip = req.socket.remoteAddress || 'unknown';

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.regex);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      await r.handler(req, res, params, ip);
    } catch (e) {
      if (e.message === 'invalid_json') send(res, 400, { error: 'invalid_json' });
      else { console.error(e); send(res, 500, { error: 'internal_error' }); }
    }
    return;
  }
  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`AgentOS backend listening on http://localhost:${PORT}`);
  const provider = resolveProvider();
  console.log(provider === 'mock' ? 'AI Gateway: DEV_MOCK (set ANTHROPIC_API_KEY or OPENAI_API_KEY for real agent parsing)' : `AI Gateway: LIVE (${provider})`);
});

module.exports = server;
