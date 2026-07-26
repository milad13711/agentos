// Regression coverage for three pieces added together:
//  - hour/minute-precision reminders (actions.js's computeDueAt, used by the
//    'task.created' registry entry)
//  - interaction notes on contacts/deals ('interaction.logged')
//  - sending a Telegram message to a specific contact/lead ('contact.messaged')
// api.telegram.org isn't reachable from this sandbox, so contact.messaged's
// Telegram send is verified against a fake local Bot API server, same
// pattern as test/telegram.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const dbPath = path.join(os.tmpdir(), `agentos-test-interactions-${process.pid}-${Date.now()}.sqlite`);
process.env.AGENTOS_DB_PATH = dbPath;
process.env.AGENTOS_TOKEN_SECRET = 'test-secret';

const calls = { sendMessage: [] };
const fakeServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    if (req.url.endsWith('sendMessage')) calls.sendMessage.push(parsed);
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
const { dispatch } = require('../src/actions');

test.before(() => ready);

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

// ---- hour-precision reminders ----
test('task.created with dueHour/dueMinute sets that exact wall-clock time, not just a day count', async () => {
  const { tenantId, userId } = await makeTenant();
  const before = new Date();
  const result = await dispatch({ tenantId, userId, role: 'owner' }, 'task.created', { title: 'Call back', dueInDays: 1, dueHour: 9, dueMinute: 30 });
  const dueDate = new Date(result.data.due_at);
  const expected = new Date(before.getTime() + 86400000);
  expected.setHours(9, 30, 0, 0);
  assert.equal(dueDate.getHours(), 9);
  assert.equal(dueDate.getMinutes(), 30);
  // Same calendar day as "tomorrow" (allowing for the test running near midnight).
  assert.ok(Math.abs(dueDate.getTime() - expected.getTime()) < 60_000);
});

test('task.created with only dueHour (no dueInDays) rolls to tomorrow if that hour already passed today', async () => {
  const { tenantId, userId } = await makeTenant();
  const past = new Date();
  past.setHours(past.getHours() - 1, 0, 0, 0); // an hour that has already happened today
  const result = await dispatch({ tenantId, userId, role: 'owner' }, 'task.created', { title: 'Later today', dueHour: past.getHours() });
  assert.ok(result.data.due_at > now(), 'a due time already past today must roll forward to tomorrow, not fire immediately');
});

test('task.created still supports the original days-only behavior with no hour given', async () => {
  const { tenantId, userId } = await makeTenant();
  const result = await dispatch({ tenantId, userId, role: 'owner' }, 'task.created', { title: 'In 3 days', dueInDays: 3 });
  assert.ok(Math.abs(result.data.due_at - (now() + 3 * 86400000)) < 5000);
});

// ---- interaction notes ----
test('interaction.logged resolves a contact by name and stores a running note', async () => {
  const { tenantId, userId } = await makeTenant();
  await dispatch({ tenantId, userId, role: 'owner' }, 'contact.created', { name: 'آقای رضایی', phone: '0912' });

  const result = await dispatch({ tenantId, userId, role: 'agent' }, 'interaction.logged', { contactName: 'رضایی', note: 'تماس گرفتم، قرار بعدی هفته دیگه' });
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.entity_type, 'contact');
  assert.match(result.data.note, /قرار بعدی/);

  const history = await db.all('SELECT * FROM interactions WHERE tenant_id = ?', [tenantId]);
  assert.equal(history.length, 1, 'the note must actually persist, not just echo back');
});

test('interaction.logged resolves a deal/lead by title', async () => {
  const { tenantId, userId } = await makeTenant();
  const deal = (await dispatch({ tenantId, userId, role: 'owner' }, 'deal.created', { title: 'قرارداد فلان', stage: 'سرنخ' })).data;

  const result = await dispatch({ tenantId, userId, role: 'agent' }, 'interaction.logged', { dealTitle: 'قرارداد فلان', note: 'پیام واتساپ فرستادم' });
  assert.equal(result.data.entity_type, 'deal');
  assert.equal(result.data.entity_id, deal.id);
});

test('interaction.logged returns nothing (no crash) when the named contact/lead does not exist', async () => {
  const { tenantId, userId } = await makeTenant();
  const result = await dispatch({ tenantId, userId, role: 'agent' }, 'interaction.logged', { contactName: 'کسی که وجود نداره', note: 'یادداشت' });
  assert.equal(result.data, null);
});

// ---- messaging a specific contact/lead via the Telegram bot ----
test('contact.messaged sends via Telegram and logs the send as an interaction, once the contact is linked', async () => {
  const { tenantId, userId } = await makeTenant();
  const contact = (await dispatch({ tenantId, userId, role: 'owner' }, 'contact.created', { name: 'مشتری وی‌آی‌پی' })).data;
  await db.run('UPDATE contacts SET telegram_chat_id = ? WHERE id = ?', ['900123', contact.id]);
  calls.sendMessage.length = 0;

  const result = await dispatch({ tenantId, userId, role: 'agent' }, 'contact.messaged', { contactName: 'وی‌آی‌پی', message: 'سلام، تخفیف ویژه براتون فعال شد' });
  assert.equal(result.data.type, 'message_sent');
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0].chat_id, '900123');
  assert.match(calls.sendMessage[0].text, /تخفیف ویژه/);

  const history = await db.all('SELECT * FROM interactions WHERE tenant_id = ? AND entity_id = ?', [tenantId, contact.id]);
  assert.equal(history.length, 1, 'sending a message must also be logged in the contact\'s interaction history');
  assert.match(history[0].note, /تخفیف ویژه/);
});

test('contact.messaged fails clearly (not silently) when the contact has no linked Telegram chat', async () => {
  const { tenantId, userId } = await makeTenant();
  await dispatch({ tenantId, userId, role: 'owner' }, 'contact.created', { name: 'بدون تلگرام' });
  calls.sendMessage.length = 0;

  const result = await dispatch({ tenantId, userId, role: 'agent' }, 'contact.messaged', { contactName: 'بدون تلگرام', message: 'سلام' });
  assert.equal(result.data.type, 'telegram_not_linked');
  assert.equal(calls.sendMessage.length, 0, 'must not attempt to send anywhere when there is no linked chat');
});

// ---- linking a contact's Telegram chat via /start contact_<code> ----
test('a customer/lead links their chat via /start contact_<code>, distinct from a team member\'s own login link', async () => {
  const { tenantId, userId } = await makeTenant();
  const contact = (await dispatch({ tenantId, userId, role: 'owner' }, 'contact.created', { name: 'لینک‌شونده' })).data;
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.run('INSERT INTO contact_link_codes (code, tenant_id, contact_id, expires_at, created_at) VALUES (?,?,?,?,?)',
    [code, tenantId, contact.id, now() + 600000, now()]);

  const telegram = require('../src/telegram');
  await telegram.handleMessage({ chat: { id: 800555 }, text: `/start contact_${code}` });

  const updated = await db.get('SELECT telegram_chat_id FROM contacts WHERE id = ?', [contact.id]);
  assert.equal(updated.telegram_chat_id, '800555');
  // The code must be single-use.
  const leftover = await db.get('SELECT code FROM contact_link_codes WHERE code = ?', [code]);
  assert.equal(leftover, undefined);
});
