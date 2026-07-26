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
const voice = require('./voice');

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
  // socks-proxy-agent resolves the hostname ITSELF (via the container's own,
  // still-poisoned DNS) before ever contacting the proxy when the URL scheme
  // is socks4/socks5 — only socks5h (and plain socks:) hand the hostname to
  // the proxy for remote resolution. Since the entire point of this proxy is
  // to route around DNS interception, force remote resolution regardless of
  // which scheme was configured — a plain "socks5://" here would otherwise
  // silently resolve api.telegram.org locally, defeating the proxy (this is
  // exactly what happened the first time: the SOCKS tunnel connected fine,
  // but to whatever bogus address local DNS handed it).
  const normalized = proxyUrl.replace(/^socks5:\/\//, 'socks5h://').replace(/^socks4:\/\//, 'socks4a://');
  cachedAgent = new SocksProxyAgent(normalized);
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

// Raw (non-JSON) request over the same proxy-aware https.request path as
// requestViaAgent, for binary bodies/responses (file downloads, multipart
// uploads) that a JSON POST can't express. GET when no body is given.
function requestRaw(urlStr, { headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request({
      hostname: url.hostname,
      servername: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: body ? 'POST' : 'GET',
      agent,
      headers,
      timeout: 35_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('telegram request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Downloads a file Telegram is hosting (voice note, photo, ...) given the
// file_path returned by getFile. This hits api.telegram.org's /file/ path —
// the same host as every other call, so it needs the same SOCKS proxy
// routing when TELEGRAM_SOCKS_PROXY is set (the DNS hijack applies here too).
async function downloadFile(filePath) {
  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const url = `${base}/file/bot${botToken()}/${filePath}`;
  const agent = getProxyAgent();
  if (agent) {
    const { body } = await requestRaw(url, { agent });
    return body;
  }
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}

function buildMultipartBody(fields, filePart) {
  const boundary = '----AgentOSBoundary' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  if (filePart) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${filePart.field}"; filename="${filePart.filename}"\r\nContent-Type: ${filePart.mimeType}\r\n\r\n`
    ));
    parts.push(filePart.buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

// Multipart POST, for endpoints that upload a file (sendVoice, sendAudio,
// ...) rather than send JSON — mirrors callTelegram()'s proxy/no-proxy split.
async function callTelegramFile(method, fields, filePart) {
  const url = apiUrl(method);
  const { boundary, body } = buildMultipartBody(fields, filePart);
  const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length };
  const agent = getProxyAgent();
  let data;
  if (agent) {
    const raw = await requestRaw(url, { headers, body, agent });
    try { data = JSON.parse(raw.body.toString('utf8')); } catch { data = null; }
  } else {
    const res = await fetch(url, { method: 'POST', headers, body });
    data = await res.json().catch(() => null);
  }
  if (!data || !data.ok) console.error(`[telegram] ${method} (file) failed:`, data);
  return data;
}

// Telegram's "voice message" bubble (round, with waveform) strictly requires
// an OGG container with the Opus codec — anything else has to go through
// sendAudio instead (shown as a plain audio file). synthesizeSpeech(text,
// 'opus') is asked to produce that format for this reason.
async function sendVoice(chatId, buffer) {
  return callTelegramFile('sendVoice', { chat_id: chatId },
    { field: 'voice', filename: 'reply.ogg', mimeType: 'audio/ogg', buffer });
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

// ---- linking a CONTACT's (customer/lead's) chat, not a team member's ----
async function consumeContactLinkCode(code, chatId) {
  const row = await db.get('SELECT * FROM contact_link_codes WHERE code = ?', [code]);
  if (!row || row.expires_at < now()) return null;
  await db.run('DELETE FROM contact_link_codes WHERE code = ?', [code]);
  await db.run('UPDATE contacts SET telegram_chat_id = ? WHERE id = ?', [String(chatId), row.contact_id]);
  return row;
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

// Shared by both the plain-text and voice-note paths below: run the
// transcribed/typed text through the exact same act() pipeline the web
// ChatPanel uses (approval gate included), then reply — as a voice message
// if the incoming message was itself voice, otherwise as text.
async function respondToUser(chatId, user, text, { asVoice } = {}) {
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
    const replyText = result.reply || 'انجام شد.';
    if (asVoice && voice.voiceEnabled()) {
      try {
        const audio = await voice.synthesizeSpeech(replyText, 'opus');
        await sendVoice(chatId, audio);
        return;
      } catch (e) {
        // TTS failing shouldn't swallow the answer — fall back to text below.
        console.error('[telegram tts]', e);
      }
    }
    await sendMessage(chatId, replyText);
  } catch (e) {
    console.error('[telegram act]', e);
    await sendMessage(chatId, 'خطا در پردازش پیام: ' + e.message);
  }
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();

  if (text.startsWith('/start')) {
    const arg = text.split(/\s+/)[1];
    if (!arg) {
      await sendMessage(chatId, 'برای اتصال حساب، از صفحه «تنظیمات» توی AgentOS یک کد بگیر و همینجا بفرست: /start <کد>');
      return;
    }
    // A team member links their own AgentOS login (plain 6-digit code); a
    // customer/lead links as a CONTACT instead, via a "contact_<code>"
    // deep-link a staff member shared with them from the Contacts page —
    // that chat then never goes through act(), only receives outbound
    // messages (see 'contact.messaged' in actions.js).
    if (arg.startsWith('contact_')) {
      const linked = await consumeContactLinkCode(arg.slice('contact_'.length), chatId);
      if (!linked) {
        await sendMessage(chatId, 'این لینک نامعتبر یا منقضی‌شده — از فروشنده/پشتیبانی یک لینک جدید بخواه.');
        return;
      }
      await sendMessage(chatId, '✅ این چت به AgentOS وصل شد — پیام‌هایی که براتون می‌فرستیم از همینجا می‌رسه.');
      return;
    }
    const linked = await consumeLinkCode(arg, chatId);
    if (!linked) {
      await sendMessage(chatId, 'این کد نامعتبر یا منقضی‌شده — یک کد جدید از تنظیمات بگیر.');
      return;
    }
    await sendMessage(chatId, '✅ حساب شما به این Agent وصل شد. از همین‌جا هرچی تو چت AgentOS می‌نویسی رو بنویس، یا برام وویس بفرست.');
    return;
  }

  if (!text && !msg.voice) return;

  const user = await db.get('SELECT id, tenant_id FROM users WHERE telegram_chat_id = ?', [chatId]);
  if (!user) {
    await sendMessage(chatId, 'این چت هنوز به هیچ حساب AgentOS وصل نیست. از «تنظیمات» یک کد بگیر و بفرست: /start <کد>');
    return;
  }

  if (msg.voice) {
    if (!voice.voiceEnabled()) {
      await sendMessage(chatId, 'قابلیت صوتی هنوز روی این سرور فعال نشده.');
      return;
    }
    try {
      const fileInfo = await callTelegram('getFile', { file_id: msg.voice.file_id });
      if (!fileInfo || !fileInfo.ok) throw new Error('getFile failed');
      const buffer = await downloadFile(fileInfo.result.file_path);
      const transcript = await voice.transcribeAudio(buffer, 'voice.ogg', 'audio/ogg');
      if (!transcript) {
        await sendMessage(chatId, 'صدا رو متوجه نشدم، می‌شه دوباره امتحان کنی؟');
        return;
      }
      await respondToUser(chatId, user, transcript, { asVoice: true });
    } catch (e) {
      console.error('[telegram voice]', e);
      await sendMessage(chatId, 'خطا در پردازش پیام صوتی: ' + e.message);
    }
    return;
  }

  await respondToUser(chatId, user, text, { asVoice: false });
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
  sendVoice, downloadFile,
  // exported for test/telegram-proxy.test.js only
  requestViaAgent, getProxyAgent,
};
