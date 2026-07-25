// Regression coverage for the Telegram integration (src/telegram.js).
// Real network access to api.telegram.org isn't available in this dev
// sandbox (org egress policy), so these tests stand up a tiny local HTTP
// server that implements the same JSON contract as the real Bot API
// (getMe/sendMessage/answerCallbackQuery/getUpdates) and point
// TELEGRAM_API_BASE at it. The business logic under test — linking,
// routing a message through agent.js's act(), the approval-gate inline
// keyboard, offset tracking — is exactly what would run against the real
// API; only the transport is faked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const dbPath = path.join(os.tmpdir(), `agentos-test-telegram-${process.pid}-${Date.now()}.sqlite`);
process.env.AGENTOS_DB_PATH = dbPath;
process.env.AGENTOS_TOKEN_SECRET = 'test-secret';

// --- fake Telegram Bot API server ---
const calls = { sendMessage: [], answerCallbackQuery: [] };
let pendingUpdates = [];
const fakeServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    const method = req.url.split('/').pop();
    if (method === 'getMe') {
      return json(res, { ok: true, result: { id: 1, username: 'agentos_test_bot' } });
    }
    if (method === 'sendMessage') {
      calls.sendMessage.push(parsed);
      return json(res, { ok: true, result: {} });
    }
    if (method === 'answerCallbackQuery') {
      calls.answerCallbackQuery.push(parsed);
      return json(res, { ok: true, result: true });
    }
    if (method === 'getUpdates') {
      const offset = parsed.offset || 0;
      const batch = pendingUpdates.filter((u) => u.update_id >= offset);
      return json(res, { ok: true, result: batch });
    }
    json(res, { ok: false, description: 'unknown method' });
  });
});
function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

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
const telegram = require('../src/telegram');

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

test('a valid /start <code> links the chat to the right user', async () => {
  const { tenantId, userId } = await makeTenant();
  const { code } = await telegram.createLinkCode(tenantId, userId);

  await telegram.handleMessage({ chat: { id: 555001 }, text: `/start ${code}` });

  const user = await db.get('SELECT telegram_chat_id FROM users WHERE id = ?', [userId]);
  assert.equal(user.telegram_chat_id, '555001');
  assert.ok(calls.sendMessage.some((c) => c.chat_id === '555001' && c.text.includes('وصل شد')));

  // The code must be single-use.
  const leftover = await db.get('SELECT code FROM telegram_link_codes WHERE code = ?', [code]);
  assert.equal(leftover, undefined);
});

test('an expired/unknown code is rejected without linking anything', async () => {
  await telegram.handleMessage({ chat: { id: 555002 }, text: '/start 000000' });
  const user = await db.get('SELECT id FROM users WHERE telegram_chat_id = ?', ['555002']);
  assert.equal(user, undefined);
  assert.ok(calls.sendMessage.some((c) => c.chat_id === '555002' && /نامعتبر|منقضی/.test(c.text)));
});

test('a message from an unlinked chat is told to link first, not silently dropped', async () => {
  calls.sendMessage.length = 0;
  await telegram.handleMessage({ chat: { id: 555003 }, text: 'سلام' });
  assert.equal(calls.sendMessage.length, 1);
  assert.match(calls.sendMessage[0].text, /وصل نیست/);
});

test('a linked user\'s plain message is routed through agent.js act() and the reply comes back over Telegram', async () => {
  const { tenantId, userId } = await makeTenant();
  const { code } = await telegram.createLinkCode(tenantId, userId);
  await telegram.handleMessage({ chat: { id: 555004 }, text: `/start ${code}` });
  calls.sendMessage.length = 0;

  await telegram.handleMessage({ chat: { id: 555004 }, text: 'مشتری جدید ثبت کن به نام آقای رضایی' });

  const contact = await db.get('SELECT * FROM contacts WHERE tenant_id = ?', [tenantId]);
  assert.ok(contact, 'the non-sensitive create_contact action must have actually run');
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0].chat_id, '555004');
});

test('a sensitive action sends an approve/reject inline keyboard instead of running immediately', async () => {
  const { tenantId, userId } = await makeTenant();
  const { code } = await telegram.createLinkCode(tenantId, userId);
  await telegram.handleMessage({ chat: { id: 555005 }, text: `/start ${code}` });
  calls.sendMessage.length = 0;

  await telegram.handleMessage({ chat: { id: 555005 }, text: 'معامله فلان رو حذف کن' });

  assert.equal(calls.sendMessage.length, 1);
  const sent = calls.sendMessage[0];
  assert.ok(sent.reply_markup?.inline_keyboard?.[0]?.some((b) => b.callback_data.startsWith('approve:')));
});

test('tapping the approve button actually applies the pending action', async () => {
  const { tenantId, userId } = await makeTenant();
  const deal = (await require('../src/actions').dispatch({ tenantId, userId, role: 'owner' }, 'deal.created', { title: 'ToDelete' })).data;
  const { code } = await telegram.createLinkCode(tenantId, userId);
  await telegram.handleMessage({ chat: { id: 555006 }, text: `/start ${code}` });
  calls.sendMessage.length = 0;
  calls.answerCallbackQuery.length = 0;

  // Phrased so DEV_MOCK's fuzzy regex captures the deal title with no
  // trailing words (it greedily captures everything after "معامله ").
  await telegram.handleMessage({ chat: { id: 555006 }, text: `حذف کن معامله ${deal.title}` });
  const pendingCall = calls.sendMessage.at(-1);
  const pendingId = pendingCall.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1];

  await telegram.handleCallbackQuery({ id: 'cbq1', message: { chat: { id: 555006 } }, data: `approve:${pendingId}` });

  const gone = await db.get('SELECT id FROM deals WHERE id = ?', [deal.id]);
  assert.equal(gone, undefined, 'approving via Telegram must actually delete the deal');
  assert.equal(calls.answerCallbackQuery.length, 1);
});

test('pollOnce processes queued updates and advances the offset so nothing is reprocessed', async () => {
  const { tenantId, userId } = await makeTenant();
  const { code } = await telegram.createLinkCode(tenantId, userId);
  pendingUpdates = [
    { update_id: 9001, message: { chat: { id: 555007 }, text: `/start ${code}` } },
  ];

  const n1 = await telegram.pollOnce();
  assert.equal(n1, 1);
  const user = await db.get('SELECT telegram_chat_id FROM users WHERE id = ?', [userId]);
  assert.equal(user.telegram_chat_id, '555007');

  const state = await db.get('SELECT last_update_id FROM telegram_poll_state WHERE id = 1');
  assert.equal(state.last_update_id, 9001);

  // Same fixed update list, but the fake server now filters by offset just
  // like the real API — a second poll must return nothing new.
  const n2 = await telegram.pollOnce();
  assert.equal(n2, 0);
});
