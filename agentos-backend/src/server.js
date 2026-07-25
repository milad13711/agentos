// server.js — real HTTP API. No framework: node:http + a tiny hand-rolled
// router. This keeps the project runnable with zero external dependencies
// (useful here; swap in Express/Fastify freely once you have registry access).

require('./env-loader');
const http = require('node:http');
const { buildXlsx } = require('./xlsx-writer');
const { db, uid, now } = require('./db');
const { hashPassword, verifyPassword, signToken, authenticate } = require('./auth');
const { act, resolvePending, audit, resolveProvider } = require('./agent');
const { dispatch } = require('./actions');
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

async function requireAuth(req, res) {
  const auth = authenticate(req);
  if (!auth) { send(res, 401, { error: 'unauthorized' }); return null; }
  const tenant = await db.get('SELECT status FROM tenants WHERE id = ?', [auth.tenantId]);
  if (!tenant) { send(res, 401, { error: 'invalid_session', message: 'نشست شما دیگر معتبر نیست (Tenant پیدا نشد) — لطفاً دوباره وارد شوید.' }); return null; }
  if (tenant.status === 'suspended') { send(res, 403, { error: 'tenant_suspended' }); return null; }
  // Session tokens are stateless (no server-side revocation list — see README
  // "باقی‌مونده"), so a removed/disabled team member's existing token would
  // otherwise keep working until it naturally expires (up to 12h). Checking
  // the live user status here closes that window down to this request.
  // Role/isSuperAdmin are likewise read from the DB (not trusted from the
  // token claims) so a role change or super-admin demotion also takes effect
  // immediately instead of waiting out the token's remaining lifetime.
  const user = await db.get('SELECT status, role, is_super_admin FROM users WHERE id = ?', [auth.userId]);
  if (!user || user.status !== 'active') { send(res, 401, { error: 'invalid_session', message: 'حساب شما دیگر فعال نیست — لطفاً دوباره وارد شوید.' }); return null; }
  auth.role = user.role;
  auth.isSuperAdmin = !!user.is_super_admin;
  return auth;
}

async function requireSuperAdmin(req, res) {
  const auth = authenticate(req);
  if (!auth) { send(res, 401, { error: 'unauthorized' }); return null; }
  const user = await db.get('SELECT status, is_super_admin FROM users WHERE id = ?', [auth.userId]);
  if (!user || user.status !== 'active' || !user.is_super_admin) { send(res, 403, { error: 'forbidden', message: 'super admin access required' }); return null; }
  auth.isSuperAdmin = true;
  return auth;
}

// Promotes a user to super admin if their email matches SUPER_ADMIN_EMAIL.
// Called after register/login so the very first matching signup becomes admin.
async function maybePromoteSuperAdmin(user) {
  const adminEmail = process.env.SUPER_ADMIN_EMAIL;
  if (adminEmail && user.email.toLowerCase() === adminEmail.toLowerCase() && !user.is_super_admin) {
    await db.run('UPDATE users SET is_super_admin = TRUE WHERE id = ?', [user.id]);
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
  const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return send(res, 409, { error: 'email_taken' });

  const tenantId = uid();
  const userId = uid();
  const { hash, salt } = hashPassword(password);
  const t = now();
  await db.run('INSERT INTO tenants (id, name, plan, plan_key, status, ai_provider, created_at) VALUES (?,?,?,?,?,?,?)',
    [tenantId, tenantName, 'trial', 'free', 'active', 'anthropic', t]);
  await db.run('INSERT INTO users (id, tenant_id, name, email, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [userId, tenantId, name, email, hash, salt, 'owner', t]);
  await audit(tenantId, 'user', userId, 'tenant_registered', 'tenant:' + tenantId, { tenantName });

  const userRow = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  const isSuperAdmin = await maybePromoteSuperAdmin(userRow);
  const token = signToken({ tenantId, userId, role: 'owner', email, isSuperAdmin });
  send(res, 201, { token, tenant: { id: tenantId, name: tenantName }, user: { id: userId, name, email, role: 'owner', isSuperAdmin } });
});

route('POST', '/api/auth/login', async (req, res, params, ip) => {
  if (rateLimited('login:' + ip)) return send(res, 429, { error: 'too_many_requests' });
  const { email, password } = await readBody(req);
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email || '']);
  if (!user || !verifyPassword(password || '', user.salt, user.password_hash) || user.status !== 'active') {
    // Same generic error for "wrong password" and "account disabled" — a
    // distinct message would let someone probe whether a removed
    // teammate's account still exists.
    return send(res, 401, { error: 'invalid_credentials' });
  }
  const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [user.tenant_id]);
  if (tenant && tenant.status === 'suspended') return send(res, 403, { error: 'tenant_suspended' });
  const isSuperAdmin = await maybePromoteSuperAdmin(user);
  const token = signToken({ tenantId: user.tenant_id, userId: user.id, role: user.role, email: user.email, isSuperAdmin });
  send(res, 200, { token, tenant: { id: tenant.id, name: tenant.name }, user: { id: user.id, name: user.name, email: user.email, role: user.role, isSuperAdmin } });
});

route('GET', '/api/me', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const user = await db.get('SELECT id, name, email, role, is_super_admin, agent_name, agent_persona FROM users WHERE id = ?', [auth.userId]);
  const tenant = await db.get('SELECT id, name, plan_key, status, trial_start, ai_provider FROM tenants WHERE id = ?', [auth.tenantId]);
  send(res, 200, { user, tenant });
});

// ---- personal Agent customization (each team member personalizes their own Agent) ----
route('PATCH', '/api/me/agent', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { agentName, agentPersona } = await readBody(req);
  const tenant = await db.get('SELECT plan_key FROM tenants WHERE id = ?', [auth.tenantId]);
  const plan = await db.get('SELECT features_json FROM plans WHERE key = ?', [tenant.plan_key]);
  const features = plan ? JSON.parse(plan.features_json) : {};
  if (agentPersona && !features.customAgentPersona) {
    return send(res, 402, { error: 'plan_feature_locked', message: 'شخصی‌سازی شخصیت Agent فقط در پلن‌های Starter به بالاست.' });
  }
  await db.run('UPDATE users SET agent_name = ?, agent_persona = ? WHERE id = ?',
    [(agentName || 'Agent').slice(0, 40), (agentPersona || '').slice(0, 300), auth.userId]);
  await audit(auth.tenantId, 'user', auth.userId, 'update_agent_persona', 'user:' + auth.userId, { agentName });
  send(res, 200, await db.get('SELECT id, agent_name, agent_persona FROM users WHERE id = ?', [auth.userId]));
});

// ---- team / personnel management (RBAC) ----
route('GET', '/api/team', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  send(res, 200, await db.all('SELECT id, name, email, role, status, agent_name, created_at FROM users WHERE tenant_id = ? ORDER BY created_at ASC', [auth.tenantId]));
});

route('POST', '/api/team/invite', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  if (!requireRole(auth, res, ['owner', 'admin'])) return;
  const { name, email, role } = await readBody(req);
  if (!name || !isValidEmail(email)) return send(res, 400, { error: 'invalid_input' });
  const finalRole = ['admin', 'member'].includes(role) ? role : 'member';
  if (finalRole === 'admin' && auth.role !== 'owner') return send(res, 403, { error: 'only_owner_can_grant_admin' });

  const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return send(res, 409, { error: 'email_taken' });

  const tenant = await db.get('SELECT plan_key FROM tenants WHERE id = ?', [auth.tenantId]);
  const plan = await db.get('SELECT seats_limit FROM plans WHERE key = ?', [tenant.plan_key]);
  if (plan && plan.seats_limit != null) {
    const countRow = await db.get(`SELECT COUNT(*) c FROM users WHERE tenant_id = ? AND status = 'active'`, [auth.tenantId]);
    if (Number(countRow.c) >= plan.seats_limit) return send(res, 402, { error: 'seat_limit_reached', message: `پلن فعلی حداکثر ${plan.seats_limit} کاربر اجازه می‌ده.` });
  }

  const tempPassword = randomPassword();
  const { hash, salt } = hashPassword(tempPassword);
  const id = uid(); const t = now();
  await db.run('INSERT INTO users (id, tenant_id, name, email, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, auth.tenantId, name, email, hash, salt, finalRole, t]);
  await audit(auth.tenantId, 'user', auth.userId, 'invite_team_member', 'user:' + id, { email, role: finalRole });
  // NOTE: no email sending in this environment — temp password is returned directly so the
  // inviter can share it. In production this becomes an emailed invite link instead.
  send(res, 201, { id, name, email, role: finalRole, tempPassword });
});

route('PATCH', '/api/team/:id/role', async (req, res, params) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  if (!requireRole(auth, res, ['owner'])) return;
  const target = await db.get('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [params.id, auth.tenantId]);
  if (!target) return send(res, 404, { error: 'not_found' });
  const { role } = await readBody(req);
  if (!['owner', 'admin', 'member'].includes(role)) return send(res, 400, { error: 'invalid_role' });
  if (target.role === 'owner' && role !== 'owner') {
    const ownerCountRow = await db.get(`SELECT COUNT(*) c FROM users WHERE tenant_id = ? AND role = 'owner'`, [auth.tenantId]);
    if (Number(ownerCountRow.c) <= 1) return send(res, 400, { error: 'cannot_demote_last_owner' });
  }
  await db.run('UPDATE users SET role = ? WHERE id = ?', [role, target.id]);
  await audit(auth.tenantId, 'user', auth.userId, 'change_team_role', 'user:' + target.id, { role });
  send(res, 200, await db.get('SELECT id, name, email, role FROM users WHERE id = ?', [target.id]));
});

route('DELETE', '/api/team/:id', async (req, res, params) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  if (!requireRole(auth, res, ['owner', 'admin'])) return;
  const target = await db.get('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [params.id, auth.tenantId]);
  if (!target) return send(res, 404, { error: 'not_found' });
  if (target.role === 'owner') return send(res, 400, { error: 'cannot_remove_owner' });
  if (target.id === auth.userId) return send(res, 400, { error: 'cannot_remove_self' });
  await db.run(`UPDATE users SET status = 'disabled' WHERE id = ?`, [target.id]);
  await db.run(`UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ?`, [target.id]);
  await audit(auth.tenantId, 'user', auth.userId, 'remove_team_member', 'user:' + target.id, {});
  send(res, 200, { removed: true });
});

// ---- tasks: reminders, follow-ups, delegation between personnel ----
route('GET', '/api/tasks', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const rows = await db.all(`
    SELECT t.*, u1.name as assignee_name, u2.name as creator_name
    FROM tasks t
    LEFT JOIN users u1 ON u1.id = t.assignee_id
    LEFT JOIN users u2 ON u2.id = t.created_by
    WHERE t.tenant_id = ? ORDER BY (t.due_at IS NULL), t.due_at ASC, t.created_at DESC
  `, [auth.tenantId]);
  send(res, 200, rows);
});

route('POST', '/api/tasks', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { title, description, assigneeId, dueAt, relatedEntity } = await readBody(req);
  if (!title) return send(res, 400, { error: 'title_required' });
  if (assigneeId) {
    const assignee = await db.get('SELECT id FROM users WHERE id = ? AND tenant_id = ?', [assigneeId, auth.tenantId]);
    if (!assignee) return send(res, 400, { error: 'invalid_assignee' });
  }
  const { data } = await dispatch({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, 'task.created', { title, description, assigneeId, dueAt, relatedEntity });
  send(res, 201, data);
});

route('PATCH', '/api/tasks/:id', async (req, res, params) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const task = await db.get('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?', [params.id, auth.tenantId]);
  if (!task) return send(res, 404, { error: 'not_found' });
  const { status, dueAt, assigneeId, title, description } = await readBody(req);
  const wasDelegated = assigneeId && assigneeId !== task.assignee_id;
  await db.run(`UPDATE tasks SET
      status = COALESCE(?, status), due_at = COALESCE(?, due_at), assignee_id = COALESCE(?, assignee_id),
      title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ? WHERE id = ?`,
    [status || null, dueAt != null ? dueAt : null, assigneeId || null, title || null, description || null, now(), task.id]);
  await audit(auth.tenantId, 'user', auth.userId, wasDelegated ? 'delegate_task' : 'update_task', 'task:' + task.id, { status, assigneeId });
  send(res, 200, await db.get('SELECT * FROM tasks WHERE id = ?', [task.id]));
});

route('DELETE', '/api/tasks/:id', async (req, res, params) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const task = await db.get('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?', [params.id, auth.tenantId]);
  if (!task) return send(res, 404, { error: 'not_found' });
  await db.run('DELETE FROM tasks WHERE id = ?', [task.id]);
  await audit(auth.tenantId, 'user', auth.userId, 'delete_task', 'task:' + task.id, {});
  send(res, 200, { deleted: true });
});

// ---- contacts ----
route('GET', '/api/contacts', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  send(res, 200, await db.all('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC', [auth.tenantId]));
});
route('POST', '/api/contacts', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { name, phone, company } = await readBody(req);
  if (!name) return send(res, 400, { error: 'name_required' });
  const { data } = await dispatch({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, 'contact.created', { name, phone, company });
  send(res, 201, data);
});
route('DELETE', '/api/contacts/:id', async (req, res, params) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { data } = await dispatch({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, 'contact.deleted', { id: params.id });
  if (!data) return send(res, 404, { error: 'not_found' });
  send(res, 200, { deleted: true });
});

// ---- deals ----
route('GET', '/api/deals', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  send(res, 200, await db.all('SELECT * FROM deals WHERE tenant_id = ? ORDER BY created_at DESC', [auth.tenantId]));
});
route('POST', '/api/deals', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { title, contactName, amount, stage } = await readBody(req);
  if (!title) return send(res, 400, { error: 'title_required' });
  const { data } = await dispatch({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, 'deal.created', { title, contactName, amount, stage });
  send(res, 201, data);
});
route('PATCH', '/api/deals/:id/stage', async (req, res, params) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { stage } = await readBody(req);
  const { data } = await dispatch({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, 'deal.stage_changed', { id: params.id, stage });
  if (!data) return send(res, 404, { error: 'not_found' });
  send(res, 200, data);
});
route('DELETE', '/api/deals/:id', async (req, res, params) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { data } = await dispatch({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, 'deal.deleted', { id: params.id });
  if (!data) return send(res, 404, { error: 'not_found' });
  send(res, 200, { deleted: true });
});

// ---- invoices ----
route('GET', '/api/invoices', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  send(res, 200, await db.all('SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC', [auth.tenantId]));
});
route('POST', '/api/invoices', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { dealTitle, amount } = await readBody(req);
  const { data } = await dispatch({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, 'invoice.issued', { dealTitle, amount });
  send(res, 201, data);
});

// ---- custom modules (Module Builder) ----
route('GET', '/api/modules', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const rows = (await db.all('SELECT * FROM custom_modules WHERE tenant_id = ? ORDER BY created_at DESC', [auth.tenantId]))
    .map(m => ({ ...m, fields: JSON.parse(m.fields_json) }));
  send(res, 200, rows);
});
route('POST', '/api/modules', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { name, entityLabel, fields } = await readBody(req);
  if (!name || !Array.isArray(fields) || !fields.length) return send(res, 400, { error: 'name_and_fields_required' });

  const { data } = await dispatch({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, 'module.created', { name, entityLabel, fields });
  if (data.type === 'plan_limit') return send(res, 402, { error: 'plan_limit_reached', message: `پلن فعلی حداکثر ${data.data.limit} ماژول اجازه می‌ده.` });
  send(res, 201, { ...data, fields: JSON.parse(data.fields_json) });
});
route('POST', '/api/modules/:id/records', async (req, res, params) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { values } = await readBody(req);
  const { data } = await dispatch({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, 'module.record_created', { moduleId: params.id, values });
  if (!data) return send(res, 404, { error: 'not_found' });
  send(res, 201, data.record);
});
route('GET', '/api/modules/:id/records', async (req, res, params) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const mod = await db.get('SELECT * FROM custom_modules WHERE id = ? AND tenant_id = ?', [params.id, auth.tenantId]);
  if (!mod) return send(res, 404, { error: 'not_found' });
  send(res, 200, await db.all('SELECT * FROM module_records WHERE module_id = ? ORDER BY created_at DESC', [mod.id]));
});

// ---- marketplace ----
route('GET', '/api/marketplace', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return; // still requires login, but not tenant-scoped by design
  send(res, 200, await db.all('SELECT * FROM marketplace_modules WHERE enabled = TRUE ORDER BY created_at DESC'));
});
route('POST', '/api/marketplace/publish', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { moduleId } = await readBody(req);
  const { data } = await dispatch({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, 'marketplace.published', { moduleId });
  if (!data) return send(res, 404, { error: 'not_found' });
  send(res, 200, data);
});
route('POST', '/api/marketplace/:id/install', async (req, res, params) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { data } = await dispatch({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role }, 'module.installed', { marketItemId: params.id });
  if (!data) return send(res, 404, { error: 'not_found' });
  send(res, 201, { ...data, fields: JSON.parse(data.fields_json) });
});

// ---- agent (chat-first entrypoint) ----
route('POST', '/api/agent/act', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
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
  const auth = await requireAuth(req, res); if (!auth) return;
  send(res, 200, await resolvePending(auth.tenantId, auth.userId, params.id, true));
});
route('POST', '/api/agent/pending/:id/reject', async (req, res, params) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  send(res, 200, await resolvePending(auth.tenantId, auth.userId, params.id, false));
});
route('GET', '/api/agent/pending', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  send(res, 200, await db.all(`SELECT * FROM events WHERE tenant_id = ? AND status = 'pending_approval' ORDER BY created_at DESC`, [auth.tenantId]));
});

// ---- billing (tenant-scoped) ----
route('POST', '/api/billing/trial/activate', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [auth.tenantId]);
  if (tenant.plan_key !== 'free') return send(res, 400, { error: 'not_on_free_plan' });
  if (tenant.trial_start) return send(res, 400, { error: 'trial_already_used' });
  await db.run('UPDATE tenants SET trial_start = ? WHERE id = ?', [now(), auth.tenantId]);
  await audit(auth.tenantId, 'user', auth.userId, 'trial_activated', 'tenant:' + auth.tenantId, {});
  send(res, 200, { trialStart: now(), trialDays: 7 });
});

route('POST', '/api/billing/subscribe', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  if (!requireRole(auth, res, ['owner', 'admin'])) return;
  const { planKey, billingCycle } = await readBody(req);
  if (!planKey || !['monthly', 'yearly'].includes(billingCycle)) {
    return send(res, 400, { error: 'invalid_input', message: 'planKey و billingCycle (monthly|yearly) الزامی است.' });
  }
  const user = await db.get('SELECT email FROM users WHERE id = ?', [auth.userId]);
  try {
    const result = await createPaymentRequest({
      tenantId: auth.tenantId, userId: auth.userId, planKey, billingCycle, email: user?.email
    });
    await audit(auth.tenantId, 'user', auth.userId, 'subscription_payment_requested', 'plan:' + planKey, { billingCycle });
    send(res, 200, result);
  } catch (e) {
    send(res, 502, { error: 'payment_gateway_error', message: e.message });
  }
});

route('POST', '/api/billing/verify', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const { authority, status } = await readBody(req);
  if (!authority) return send(res, 400, { error: 'authority_required' });
  try {
    const result = await verifyPayment({ tenantId: auth.tenantId, authority, status });
    if (result.ok && !result.alreadyProcessed) {
      await audit(auth.tenantId, 'user', auth.userId, 'subscription_paid', 'plan:' + result.planKey, { refId: result.refId, amountToman: result.amountToman });
    }
    send(res, result.ok ? 200 : 402, result);
  } catch (e) {
    send(res, 502, { error: 'payment_gateway_error', message: e.message });
  }
});

route('GET', '/api/billing/history', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  send(res, 200, await db.all('SELECT id, plan_key, billing_cycle, amount_toman, status, ref_id, created_at, paid_at FROM subscription_payments WHERE tenant_id = ? ORDER BY created_at DESC', [auth.tenantId]));
});

// ---- Super Admin Dashboard API ----
route('GET', '/api/admin/kpis', async (req, res) => {
  const auth = await requireSuperAdmin(req, res); if (!auth) return;
  const totalTenants = (await db.get('SELECT COUNT(*) c FROM tenants')).c;
  const activeTenants = (await db.get(`SELECT COUNT(*) c FROM tenants WHERE status = 'active'`)).c;
  const suspendedTenants = Number(totalTenants) - Number(activeTenants);
  const totalUsers = (await db.get('SELECT COUNT(*) c FROM users')).c;
  const byPlan = await db.all('SELECT plan_key, COUNT(*) c FROM tenants GROUP BY plan_key');
  const dayAgo = now() - 86400000;
  const sevenDaysAgo = now() - 7 * 86400000;
  const activeTrials = (await db.get(`SELECT COUNT(*) c FROM tenants WHERE trial_start IS NOT NULL AND trial_start > ?`, [sevenDaysAgo])).c;
  const agentActionsToday = (await db.get(`SELECT COUNT(*) c FROM events WHERE actor_type = 'agent' AND created_at > ?`, [dayAgo])).c;
  const pendingApprovals = (await db.get(`SELECT COUNT(*) c FROM events WHERE status = 'pending_approval'`)).c;
  const totalContacts = (await db.get('SELECT COUNT(*) c FROM contacts')).c;
  const totalDeals = (await db.get('SELECT COUNT(*) c FROM deals')).c;
  const totalInvoices = (await db.get('SELECT COUNT(*) c FROM invoices')).c;
  const marketplaceModules = (await db.get('SELECT COUNT(*) c FROM marketplace_modules')).c;

  const plans = await db.all('SELECT key, price_monthly_toman FROM plans');
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
  const auth = await requireSuperAdmin(req, res); if (!auth) return;
  const tenants = await db.all('SELECT * FROM tenants ORDER BY created_at DESC');
  const rows = await Promise.all(tenants.map(async t => {
    const userCount = (await db.get('SELECT COUNT(*) c FROM users WHERE tenant_id = ?', [t.id])).c;
    const contactCount = (await db.get('SELECT COUNT(*) c FROM contacts WHERE tenant_id = ?', [t.id])).c;
    const dealCount = (await db.get('SELECT COUNT(*) c FROM deals WHERE tenant_id = ?', [t.id])).c;
    const lastActivity = await db.get('SELECT created_at FROM events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1', [t.id]);
    const trialLeft = t.trial_start ? Math.max(0, 7 - Math.floor((now() - t.trial_start) / 86400000)) : null;
    return {
      id: t.id, name: t.name, planKey: t.plan_key, status: t.status, aiProvider: t.ai_provider,
      createdAt: t.created_at, userCount, contactCount, dealCount,
      trialActive: trialLeft != null && trialLeft > 0, trialDaysLeft: trialLeft,
      lastActivityAt: lastActivity ? lastActivity.created_at : null
    };
  }));
  send(res, 200, rows);
});

route('GET', '/api/admin/tenants/:id', async (req, res, params) => {
  const auth = await requireSuperAdmin(req, res); if (!auth) return;
  const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [params.id]);
  if (!tenant) return send(res, 404, { error: 'not_found' });
  const users = await db.all('SELECT id, name, email, role, is_super_admin, created_at FROM users WHERE tenant_id = ?', [tenant.id]);
  const modules = await db.all('SELECT id, name, entity_label, created_at FROM custom_modules WHERE tenant_id = ?', [tenant.id]);
  const recentAudit = await db.all('SELECT * FROM events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 25', [tenant.id]);
  send(res, 200, { tenant, users, modules, recentAudit });
});

route('PATCH', '/api/admin/tenants/:id', async (req, res, params) => {
  const auth = await requireSuperAdmin(req, res); if (!auth) return;
  const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [params.id]);
  if (!tenant) return send(res, 404, { error: 'not_found' });
  const { planKey, status } = await readBody(req);
  if (planKey) {
    const plan = await db.get('SELECT key FROM plans WHERE key = ?', [planKey]);
    if (!plan) return send(res, 400, { error: 'invalid_plan_key' });
    await db.run('UPDATE tenants SET plan_key = ? WHERE id = ?', [planKey, tenant.id]);
  }
  if (status) {
    if (!['active', 'suspended'].includes(status)) return send(res, 400, { error: 'invalid_status' });
    await db.run('UPDATE tenants SET status = ? WHERE id = ?', [status, tenant.id]);
  }
  await audit(tenant.id, 'user', auth.userId, 'admin_update_tenant', 'tenant:' + tenant.id, { planKey, status, by: 'super_admin' });
  send(res, 200, await db.get('SELECT * FROM tenants WHERE id = ?', [tenant.id]));
});

route('GET', '/api/admin/plans', async (req, res) => {
  const auth = await requireSuperAdmin(req, res); if (!auth) return;
  const plans = await db.all('SELECT * FROM plans ORDER BY price_monthly_toman ASC');
  send(res, 200, plans.map(p => ({ ...p, features: JSON.parse(p.features_json) })));
});

// Public plan catalogue for the pricing page — no auth required.
route('GET', '/api/plans', async (req, res) => {
  const plans = await db.all('SELECT * FROM plans WHERE is_active = TRUE ORDER BY price_monthly_toman ASC');
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
  const auth = await requireSuperAdmin(req, res); if (!auth) return;
  const plan = await db.get('SELECT * FROM plans WHERE key = ?', [params.key]);
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
    await db.run(`UPDATE plans SET ${setSql}, updated_at = ? WHERE key = ?`, [...Object.values(updates), now(), params.key]);
  }
  await audit('platform', 'user', auth.userId, 'admin_update_plan', 'plan:' + params.key, updates);
  const updated = await db.get('SELECT * FROM plans WHERE key = ?', [params.key]);
  send(res, 200, { ...updated, features: JSON.parse(updated.features_json) });
});

route('GET', '/api/admin/marketplace', async (req, res) => {
  const auth = await requireSuperAdmin(req, res); if (!auth) return;
  const items = await db.all('SELECT * FROM marketplace_modules ORDER BY created_at DESC');
  const withPublisher = await Promise.all(items.map(async it => {
    const tenant = await db.get('SELECT name FROM tenants WHERE id = ?', [it.published_by_tenant]);
    return { ...it, publisherName: tenant ? tenant.name : it.published_by_tenant };
  }));
  send(res, 200, withPublisher);
});

route('PATCH', '/api/admin/marketplace/:id', async (req, res, params) => {
  const auth = await requireSuperAdmin(req, res); if (!auth) return;
  const item = await db.get('SELECT * FROM marketplace_modules WHERE id = ?', [params.id]);
  if (!item) return send(res, 404, { error: 'not_found' });
  const { enabled } = await readBody(req);
  await db.run('UPDATE marketplace_modules SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, params.id]);
  await audit('platform', 'user', auth.userId, 'admin_toggle_marketplace_module', 'marketplace:' + params.id, { enabled });
  send(res, 200, await db.get('SELECT * FROM marketplace_modules WHERE id = ?', [params.id]));
});

route('GET', '/api/admin/audit', async (req, res) => {
  const auth = await requireSuperAdmin(req, res); if (!auth) return;
  send(res, 200, await db.all(`SELECT id, type as action, (entity_type || ':' || entity_id) as entity, actor_type, actor_id, tenant_id, created_at FROM events ORDER BY created_at DESC LIMIT 150`));
});

// ---- reports (real file downloads — Excel-compatible CSV with UTF-8 BOM for Persian text) ----
// CSV/formula-injection guard: report rows are user-entered CRM data (contact
// names, deal titles, ...). If a cell's text starts with =, +, -, @, or a
// tab, Excel/LibreOffice treats it as a formula when the file is opened —
// prefixing a leading apostrophe forces it to be read as plain text instead.
// (Same OWASP-recommended mitigation applied in xlsx-writer.js.)
function sanitizeForSpreadsheet(v) {
  if (typeof v !== 'string') return v; // numbers/null can't start with a formula trigger
  return /^[=+\-@\t]/.test(v) ? `'${v}` : v;
}
function csvEscape(v) {
  const s = sanitizeForSpreadsheet(v == null ? '' : String(v));
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
  const auth = await requireAuth(req, res); if (!auth) return;
  const rows = await db.all('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC', [auth.tenantId]);
  sendCsv(res, 'contacts.csv', [{key:'name',label:'نام'},{key:'phone',label:'تلفن'},{key:'company',label:'شرکت'}], rows);
});
route('GET', '/api/reports/deals.csv', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const rows = await db.all('SELECT * FROM deals WHERE tenant_id = ? ORDER BY created_at DESC', [auth.tenantId]);
  sendCsv(res, 'deals.csv', [{key:'title',label:'عنوان'},{key:'contact_name',label:'مخاطب'},{key:'amount',label:'مبلغ'},{key:'stage',label:'مرحله'}], rows);
});
route('GET', '/api/reports/invoices.csv', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const rows = await db.all('SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC', [auth.tenantId]);
  sendCsv(res, 'invoices.csv', [{key:'deal_title',label:'معامله'},{key:'amount',label:'مبلغ'}], rows);
});
route('GET', '/api/reports/tasks.csv', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const rows = await db.all(`SELECT t.title, u.name as assignee_name, t.status, t.due_at FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.tenant_id = ? ORDER BY t.created_at DESC`, [auth.tenantId]);
  sendCsv(res, 'tasks.csv', [{key:'title',label:'عنوان'},{key:'assignee_name',label:'مسئول'},{key:'status',label:'وضعیت'},{key:'due_at',label:'موعد'}], rows);
});

// Real .xlsx (OOXML) reports — genuine Excel files, not CSV-with-an-extension.
function sendXlsx(res, filename, sheetName, headers, rows) {
  const safeRows = rows.map(row => row.map(sanitizeForSpreadsheet));
  const buf = buildXlsx(sheetName, headers, safeRows);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(buf);
}
route('GET', '/api/reports/contacts.xlsx', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const rows = await db.all('SELECT name, phone, company FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC', [auth.tenantId]);
  sendXlsx(res, 'contacts.xlsx', 'مخاطبین', ['نام','تلفن','شرکت'], rows.map(r => [r.name, r.phone, r.company]));
});
route('GET', '/api/reports/deals.xlsx', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const rows = await db.all('SELECT title, contact_name, amount, stage FROM deals WHERE tenant_id = ? ORDER BY created_at DESC', [auth.tenantId]);
  sendXlsx(res, 'deals.xlsx', 'معاملات', ['عنوان','مخاطب','مبلغ','مرحله'], rows.map(r => [r.title, r.contact_name, r.amount, r.stage]));
});
route('GET', '/api/reports/invoices.xlsx', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const rows = await db.all('SELECT deal_title, amount FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC', [auth.tenantId]);
  sendXlsx(res, 'invoices.xlsx', 'فاکتورها', ['معامله','مبلغ'], rows.map(r => [r.deal_title, r.amount]));
});
route('GET', '/api/reports/tasks.xlsx', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  const rows = await db.all(`SELECT t.title, u.name as assignee_name, t.status, t.due_at FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.tenant_id = ? ORDER BY t.created_at DESC`, [auth.tenantId]);
  sendXlsx(res, 'tasks.xlsx', 'وظایف', ['عنوان','مسئول','وضعیت','موعد'], rows.map(r => [r.title, r.assignee_name, r.status, r.due_at ? new Date(r.due_at).toLocaleDateString('fa-IR') : '']));
});

// ---- audit ----
route('GET', '/api/audit', async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  send(res, 200, await db.all(`SELECT id, type as action, (entity_type || ':' || entity_id) as entity, actor_type, actor_id, created_at FROM events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`, [auth.tenantId]));
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

if (require.main === module) {
  const { ready } = require('./db');
  ready.then(() => {
    server.listen(PORT, () => {
      console.log(`AgentOS backend listening on http://localhost:${PORT}`);
      const provider = resolveProvider();
      console.log(provider === 'mock' ? 'AI Gateway: DEV_MOCK (set ANTHROPIC_API_KEY or OPENAI_API_KEY for real agent parsing)' : `AI Gateway: LIVE (${provider})`);
    });
  }).catch(e => { console.error('Failed to initialize database schema:', e); process.exit(1); });
}

module.exports = server;
