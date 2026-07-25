// Regression coverage for the task-reminder worker (src/reminders.js) —
// sends a Telegram message when a task's due_at arrives, exactly once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const dbPath = path.join(os.tmpdir(), `agentos-test-reminders-${process.pid}-${Date.now()}.sqlite`);
process.env.AGENTOS_DB_PATH = dbPath;
process.env.AGENTOS_TOKEN_SECRET = 'test-secret';

const calls = [];
const fakeServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    if (req.url.endsWith('sendMessage')) calls.push(parsed);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
});

let fakePort;
test.before(async () => {
  await new Promise((resolve) => fakeServer.listen(0, resolve));
  fakePort = fakeServer.address().port;
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${fakePort}`;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
});
test.after(async () => {
  await new Promise((resolve) => fakeServer.close(resolve));
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

const { db, uid, now, ready } = require('../src/db');
const { checkAndSendReminders } = require('../src/reminders');

test.before(() => ready);

async function makeTenantWithLinkedUser(chatId) {
  const tenantId = uid();
  const userId = uid();
  const t = now();
  await db.run('INSERT INTO tenants (id, name, plan, plan_key, status, ai_provider, created_at) VALUES (?,?,?,?,?,?,?)',
    [tenantId, 'Test Co', 'trial', 'free', 'active', 'anthropic', t]);
  await db.run('INSERT INTO users (id, tenant_id, name, email, password_hash, salt, role, telegram_chat_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [userId, tenantId, 'Test User', `${userId}@test.local`, 'x', 'x', 'owner', chatId, t]);
  return { tenantId, userId };
}

test('a due task with a linked assignee gets exactly one reminder sent', async () => {
  const { tenantId, userId } = await makeTenantWithLinkedUser('700001');
  const taskId = uid();
  await db.run(`INSERT INTO tasks (id, tenant_id, title, assignee_id, created_by, status, due_at, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`,
    [taskId, tenantId, 'Follow up', userId, userId, 'open', now() - 1000, now(), now()]);

  const sent1 = await checkAndSendReminders();
  assert.equal(sent1, 1);
  assert.ok(calls.some((c) => c.chat_id === '700001' && c.text.includes('Follow up')));

  // A second run must not re-send — reminder_sent_at should now be set.
  calls.length = 0;
  const sent2 = await checkAndSendReminders();
  assert.equal(sent2, 0);
  assert.equal(calls.length, 0);

  const task = await db.get('SELECT reminder_sent_at FROM tasks WHERE id = ?', [taskId]);
  assert.ok(task.reminder_sent_at);
});

test('a task not yet due is not reminded', async () => {
  const { tenantId, userId } = await makeTenantWithLinkedUser('700002');
  await db.run(`INSERT INTO tasks (id, tenant_id, title, assignee_id, created_by, status, due_at, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`,
    [uid(), tenantId, 'Future task', userId, userId, 'open', now() + 86400000, now(), now()]);

  calls.length = 0;
  const sent = await checkAndSendReminders();
  assert.equal(sent, 0);
});

test('a due task whose assignee has not linked Telegram is skipped, not crashed on', async () => {
  const tenantId = uid();
  const userId = uid();
  await db.run('INSERT INTO tenants (id, name, plan, plan_key, status, ai_provider, created_at) VALUES (?,?,?,?,?,?,?)',
    [tenantId, 'Test Co', 'trial', 'free', 'active', 'anthropic', now()]);
  await db.run('INSERT INTO users (id, tenant_id, name, email, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [userId, tenantId, 'No Telegram', `${userId}@test.local`, 'x', 'x', 'owner', now()]);
  await db.run(`INSERT INTO tasks (id, tenant_id, title, assignee_id, created_by, status, due_at, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`,
    [uid(), tenantId, 'Unlinked assignee task', userId, userId, 'open', now() - 1000, now(), now()]);

  const sent = await checkAndSendReminders();
  assert.equal(sent, 0);
});
