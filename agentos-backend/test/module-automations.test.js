// Regression coverage for the module automation engine — modules used to be
// pure forms with nothing behind them ("ماژول‌ها فقط فرم هستن"); this locks
// in that creating a module_record now actually runs any enabled
// module_automations rows attached to that module (dispatch() ->
// actions.js's runAutomations(), wired into the 'module.record_created'
// registry entry).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const dbPath = path.join(os.tmpdir(), `agentos-test-automations-${process.pid}-${Date.now()}.sqlite`);
process.env.AGENTOS_DB_PATH = dbPath;
process.env.AGENTOS_TOKEN_SECRET = 'test-secret';

const { db, uid, now, ready } = require('../src/db');
const { dispatch } = require('../src/actions');

test.before(() => ready);
test.after(() => {
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

async function makeTenant() {
  const tenantId = uid();
  const userId = uid();
  const t = now();
  await db.run('INSERT INTO tenants (id, name, plan, plan_key, status, ai_provider, created_at) VALUES (?,?,?,?,?,?,?)',
    [tenantId, 'Test Co', 'trial', 'free', 'active', 'anthropic', t]);
  await db.run('INSERT INTO users (id, tenant_id, name, email, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [userId, tenantId, 'Test User', `${userId}@test.local`, 'x', 'x', 'owner', t]);
  return { tenantId, userId };
}

async function addAutomation(tenantId, moduleId, actionType, config, actorUserId) {
  const id = uid();
  await db.run(`INSERT INTO module_automations (id, tenant_id, module_id, trigger, action_type, config_json, enabled, created_by, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, moduleId, 'record_created', actionType, JSON.stringify(config), 1, actorUserId, now()]);
  return id;
}

test('a create_task automation fires when a module record is created, with template interpolation', async () => {
  const { tenantId, userId } = await makeTenant();
  const mod = (await dispatch({ tenantId, userId, role: 'owner' }, 'module.created', {
    name: 'Warranties', entityLabel: 'Warranty', fields: [{ key: 'customer', label: 'Customer', type: 'text' }],
  })).data;

  await addAutomation(tenantId, mod.id, 'create_task', { titleTemplate: 'پیگیری گارانتی {{customer}}' }, userId);

  await dispatch({ tenantId, userId, role: 'owner' }, 'module.record_created', { moduleId: mod.id, values: { customer: 'رضا' } });

  const tasks = await db.all('SELECT * FROM tasks WHERE tenant_id = ?', [tenantId]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'پیگیری گارانتی رضا');
  assert.equal(tasks[0].status, 'open');
});

test('a disabled automation does not fire', async () => {
  const { tenantId, userId } = await makeTenant();
  const mod = (await dispatch({ tenantId, userId, role: 'owner' }, 'module.created', {
    name: 'Warranties2', entityLabel: 'Warranty', fields: [{ key: 'customer', label: 'Customer', type: 'text' }],
  })).data;
  const ruleId = await addAutomation(tenantId, mod.id, 'create_task', { titleTemplate: 'پیگیری {{customer}}' }, userId);
  await db.run('UPDATE module_automations SET enabled = 0 WHERE id = ?', [ruleId]);

  await dispatch({ tenantId, userId, role: 'owner' }, 'module.record_created', { moduleId: mod.id, values: { customer: 'علی' } });

  const tasks = await db.all('SELECT * FROM tasks WHERE tenant_id = ?', [tenantId]);
  assert.equal(tasks.length, 0);
});

test('a webhook automation actually POSTs the record to the configured URL', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const { tenantId, userId } = await makeTenant();
  const mod = (await dispatch({ tenantId, userId, role: 'owner' }, 'module.created', {
    name: 'Webhooked', entityLabel: 'Item', fields: [{ key: 'note', label: 'Note', type: 'text' }],
  })).data;
  await addAutomation(tenantId, mod.id, 'webhook', { url: `http://127.0.0.1:${port}/hook` }, userId);

  await dispatch({ tenantId, userId, role: 'owner' }, 'module.record_created', { moduleId: mod.id, values: { note: 'hello' } });

  // The webhook fires with `await` inside apply(), so by the time dispatch()
  // resolves the POST has already landed — no polling/sleep needed.
  assert.equal(received.length, 1);
  assert.equal(received[0].event, 'record_created');
  assert.equal(received[0].values.note, 'hello');

  await new Promise(resolve => server.close(resolve));
});

test('a broken webhook does not fail the record creation itself', async () => {
  const { tenantId, userId } = await makeTenant();
  const mod = (await dispatch({ tenantId, userId, role: 'owner' }, 'module.created', {
    name: 'BrokenWebhook', entityLabel: 'Item', fields: [{ key: 'note', label: 'Note', type: 'text' }],
  })).data;
  await addAutomation(tenantId, mod.id, 'webhook', { url: 'http://127.0.0.1:1/unreachable' }, userId);

  const result = await dispatch({ tenantId, userId, role: 'owner' }, 'module.record_created', { moduleId: mod.id, values: { note: 'still works' } });
  assert.ok(result.data.record.id, 'record must still be created even if the webhook fails');
});
