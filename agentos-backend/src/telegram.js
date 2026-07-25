// telegram.js — connects the per-user Agent to Telegram via an official
// BotFather bot (not a personal account — see CLAUDE.md for why). Uses long
// polling (getUpdates), not a webhook: no public HTTPS endpoint to configure,
// works the same in local dev and production, and this is a single Node
// process already handling I/O concurrently, so a polling loop costs nothing
// extra to run inside it.
//
// Linking: a user gets a short-lived 6-digit code from Settings, sends
// "/start <code>" to the bot, and their Telegram chat_id gets attached to
// their AgentOS users row (telegram_chat_id). From then on, whatever they
// type in that chat goes through the exact same agent.js `act()` used by the
// web ChatPanel — same approval gate, same actions, same everything.
//
// TELEGRAM_API_BASE defaults to the real Telegram API but is overridable so
// tests (and this sandboxed dev environment, which cannot reach
// api.telegram.org) can point it at a local fake server instead.
//
// TELEGRAM_SOCKS_PROXY: api.telegram.org is DNS-hijacked to a private/
// internal address from inside Iran (confirmed: even querying 8.8.8.8
// directly for it returns the same bogus 10.x address — network-level
// interception, not a local resolver misconfiguration) — the same class of
// block that made GapGPT necessary for OpenAI. When this is set to a
// socks5://[user:pass@]host:port URL, every Telegram API call is routed
// through it instead of a direct connection. Requests go over node:https
// with a SocksProxyAgent rather than global fetch, because undici's fetch
// dispatcher isn't compatible with socks-proxy-agent's classic Node
// http.Agent interface — this is the officially supported way to pair the
// two. Left unset, behavior is unchanged (plain fetch, used by tests too).
const https = require('node:https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { db, now } = require('./db');
const { act, resolvePending } = require('./agent');

const POLL_TIMEOUT_S = 30;
const LINK_CODE_TTL_MS = 10 * 60 * 1000;

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN;
}

// Read fresh on every call, not captured at require-time — tests set this
// env var after the module is already loaded (to point at a local fake
// server instead of the real Telegram API).
function apiUrl(method) {
  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  return `${base}/bot${botToken()}/${method}`;
}

let cachedAgent = null;
let cachedProxyUrl = null;
function getProxyAgent() {
  const proxyUrl = process.env.TELEGRAM_SOCKS_PROXY;
  if (!proxyUrl) return null;
  if (cachedAgent && cachedProxyUrl === proxyUrl) return cachedAgent;
  cachedAgent = new SocksProxyAgent(proxyUrl);
  cachedProxyUrl = proxyUrl;
  return cachedAgent;
}

// extraOptions lets tests inject a `ca` for a self-signed test server; real
// calls (a genuinely trusted api.telegram.org cert) never need it.
function requestViaAgent(urlStr, payload, agent, extraOptions) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const body = JSON.stringify(payload || {});
    const req = https.request({
      hostname: url.hostname,
      servername: url.hostname, // TLS SNI/cert check target — a custom agent otherwise leaves this to guess
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      agent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 35_000,
      ...extraOptions,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('telegram request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callTelegram(method, params) {
  const url = apiUrl(method);
  const agent = getProxyAgent();
  let data;
  if (agent) {
    data = await requestViaAgent(url, params, agent);
  } else {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
    data = await res.json().catch(() => null);
  }
  if (!data || !data.ok) console.error(`[telegram] ${method} failed:`, data);
  return data;
}

async function sendMessage(chatId, text, extra) {
  return callTelegram('sendMessage', { chat_id: chatId, text, ...extra });
}

async function answerCallbackQuery(callbackQueryId, text) {
  return callTelegram('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

async function getUpdates(offset) {
  const data = await callTelegram('getUpdates', { offset, timeout: POLL_TIMEOUT_S });
  // A non-ok response (bad token, transient outage, blocked network...)
  // means something is actually wrong — throw so startPolling()'s backoff
  // kicks in, instead of silently returning [] and letting the poll loop
  // spin at full speed with no updates and no delay between attempts.
  if (!data || !data.ok) throw new Error('getUpdates did not return ok');
  return data.result;
}

let cachedBotUsername = null;
// Best-effort: used only to build a clickable https://t.me/<bot>?start=code
// deep link in Settings. If it fails (no network, bad token), linking still
// works — the user just has to search for the bot manually in Telegram.
async function getBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  const data = await callTelegram('getMe', {});
  if (data && data.ok) cachedBotUsername = data.result.username;
  return cachedBotUsername;
}

// ---- linking ----
async function createLinkCode(tenantId, userId) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.run('INSERT INTO telegram_link_codes (code, tenant_id, user_id, expires_at, created_at) VALUES (?,?,?,?,?)',
    [code, tenantId, userId, now() + LINK_CODE_TTL_MS, now()]);
  const botUsername = await getBotUsername().catch(() => null);
  return { code, botUsername, deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : null };
}

async function consumeLinkCode(code, chatId) {
  const row = await db.get('SELECT * FROM telegram_link_codes WHERE code = ?', [code]);
  if (!row || row.expires_at < now()) return null;
  await db.run('DELETE FROM telegram_link_codes WHERE code = ?', [code]);
  await db.run('UPDATE users SET telegram_chat_id = ? WHERE id = ?', [String(chatId), row.user_id]);
  return row;
}

async function unlink(userId) {
  await db.run('UPDATE users SET telegram_chat_id = NULL WHERE id = ?', [userId]);
}

// ---- message handling ----
// Recent plain-text turns per chat, in-memory only (like the web ChatPanel's
// own history, which also isn't persisted server-side) — good enough for
// conversational follow-ups, lost on restart, never a source of truth.
const chatHistory = new Map();
function pushHistory(chatId, role, text) {
  const h = chatHistory.get(chatId) || [];
  h.push({ role, text });
  chatHistory.set(chatId, h.slice(-8));
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  if (!text) return;

  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1];
    if (!code) {
      await sendMessage(chatId, 'برای اتصال حساب، از صفحه «تنظیمات» توی AgentOS یک کد بگیر و همینجا بفرست: /start <کد>');
      return;
    }
    const linked = await consumeLinkCode(code, chatId);
    if (!linked) {
      await sendMessage(chatId, 'این کد نامعتبر یا منقضی‌شده — یک کد جدید از تنظیمات بگیر.');
      return;
    }
    await sendMessage(chatId, '✅ حساب شما به این Agent وصل شد. از همین‌جا هرچی تو چت AgentOS می‌نویسی رو بنویس.');
    return;
  }

  const user = await db.get('SELECT id, tenant_id FROM users WHERE telegram_chat_id = ?', [chatId]);
  if (!user) {
    await sendMessage(chatId, 'این چت هنوز به هیچ حساب AgentOS وصل نیست. از «تنظیمات» یک کد بگیر و بفرست: /start <کد>');
    return;
  }

  pushHistory(chatId, 'user', text);
  try {
    const result = await act(user.tenant_id, user.id, text, chatHistory.get(chatId) || []);
    if (result.requiresApproval) {
      await sendMessage(chatId, result.reply || 'این عملیات نیاز به تایید داره.', {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ تایید', callback_data: `approve:${result.pendingId}` },
            { text: '✖️ رد', callback_data: `reject:${result.pendingId}` },
          ]],
        },
      });
      return;
    }
    pushHistory(chatId, 'agent', result.reply || '');
    await sendMessage(chatId, result.reply || 'انجام شد.');
  } catch (e) {
    console.error('[telegram act]', e);
    await sendMessage(chatId, 'خطا در پردازش پیام: ' + e.message);
  }
}

async function handleCallbackQuery(cq) {
  const chatId = String(cq.message.chat.id);
  const [action, pendingId] = (cq.data || '').split(':');
  const user = await db.get('SELECT id, tenant_id FROM users WHERE telegram_chat_id = ?', [chatId]);
  if (!user || !pendingId) { await answerCallbackQuery(cq.id); return; }
  const outcome = await resolvePending(user.tenant_id, user.id, pendingId, action === 'approve');
  await answerCallbackQuery(cq.id, outcome.status === 'applied' ? 'تایید شد' : outcome.status === 'rejected' ? 'رد شد' : 'قبلاً پردازش شده');
  await sendMessage(chatId, action === 'approve' ? '✅ انجام شد.' : '✖️ لغو شد.');
}

// ---- polling loop ----
async function pollOnce() {
  const state = await db.get('SELECT last_update_id FROM telegram_poll_state WHERE id = 1');
  const offset = (state ? state.last_update_id : 0) + 1;
  const updates = await getUpdates(offset);
  for (const u of updates) {
    try {
      if (u.message) await handleMessage(u.message);
      else if (u.callback_query) await handleCallbackQuery(u.callback_query);
    } catch (e) {
      console.error('[telegram update]', e);
    }
    await db.run(
      `INSERT INTO telegram_poll_state (id, last_update_id) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_update_id = excluded.last_update_id`,
      [u.update_id]
    );
  }
  return updates.length;
}

let polling = false;
async function startPolling() {
  if (!botToken()) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — Telegram integration disabled.');
    return;
  }
  if (polling) return;
  polling = true;
  console.log('[telegram] polling started');
  while (polling) {
    try {
      await pollOnce();
    } catch (e) {
      console.error('[telegram] poll error:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function stopPolling() {
  polling = false;
}

module.exports = {
  startPolling, stopPolling, pollOnce,
  createLinkCode, unlink, getBotUsername,
  sendMessage, handleMessage, handleCallbackQuery,
  // exported for test/telegram-proxy.test.js only
  requestViaAgent, getProxyAgent,
};
