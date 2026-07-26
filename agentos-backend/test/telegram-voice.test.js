// Regression coverage for the voice-note path added to src/telegram.js:
// receiving a Telegram voice message, transcribing it, running the
// transcript through the exact same agent.js act() pipeline as text, and
// replying with a synthesized voice message instead of plain text.
//
// Neither api.telegram.org nor api.openai.com is reachable from this dev
// sandbox, so this stands up two tiny local HTTP servers implementing just
// enough of each real contract (Bot API's getFile/file-download/sendVoice,
// and OpenAI's /audio/transcriptions + /audio/speech) and points
// TELEGRAM_API_BASE / OPENAI_VOICE_BASE_URL at them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const dbPath = path.join(os.tmpdir(), `agentos-test-tgvoice-${process.pid}-${Date.now()}.sqlite`);
process.env.AGENTOS_DB_PATH = dbPath;
process.env.AGENTOS_TOKEN_SECRET = 'test-secret';

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// --- fake Telegram Bot API ---
const tgCalls = { sendMessage: [], sendVoice: [] };
const fakeVoiceFileBytes = Buffer.from('fake-ogg-opus-bytes');
const fakeTelegram = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url.includes('/file/bot')) {
      // File download endpoint — raw bytes, no JSON envelope.
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(fakeVoiceFileBytes);
    }
    const method = req.url.split('/').pop();
    if (method === 'getFile') {
      return json(res, { ok: true, result: { file_path: 'voice/file_1.oga' } });
    }
    if (method === 'getMe') {
      return json(res, { ok: true, result: { id: 1, username: 'agentos_test_bot' } });
    }
    if (method === 'sendMessage') {
      const parsed = JSON.parse(body.toString('utf8') || '{}');
      tgCalls.sendMessage.push(parsed);
      return json(res, { ok: true, result: {} });
    }
    if (method === 'sendVoice') {
      const raw = body.toString('latin1');
      tgCalls.sendVoice.push({
        hasChatId: /name="chat_id"/.test(raw),
        hasVoiceFile: /name="voice"; filename="reply\.ogg"/.test(raw),
      });
      return json(res, { ok: true, result: {} });
    }
    json(res, { ok: false, description: 'unknown method' });
  });
});

// --- fake OpenAI audio endpoints ---
const openaiCalls = { transcriptions: 0, speech: 0 };
let transcriptToReturn = 'مشتری جدید ثبت کن به نام آقای رضایی';
const fakeOpenAI = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url.endsWith('/audio/transcriptions')) {
      openaiCalls.transcriptions++;
      return json(res, { text: transcriptToReturn });
    }
    if (req.url.endsWith('/audio/speech')) {
      openaiCalls.speech++;
      res.writeHead(200, { 'Content-Type': 'audio/ogg' });
      return res.end(Buffer.from([0x4f, 0x67, 0x67, 0x53])); // 'OggS' magic, fake
    }
    res.writeHead(404);
    res.end();
  });
});

let tgPort, openaiPort;
test.before(async () => {
  await new Promise((resolve) => fakeTelegram.listen(0, resolve));
  tgPort = fakeTelegram.address().port;
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${tgPort}`;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';

  await new Promise((resolve) => fakeOpenAI.listen(0, resolve));
  openaiPort = fakeOpenAI.address().port;
  process.env.OPENAI_VOICE_API_KEY = 'test-voice-key';
  process.env.OPENAI_VOICE_BASE_URL = `http://127.0.0.1:${openaiPort}/v1`;
});
test.after(async () => {
  await new Promise((resolve) => fakeTelegram.close(resolve));
  await new Promise((resolve) => fakeOpenAI.close(resolve));
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

const { db, uid, now, ready } = require('../src/db');
const telegram = require('../src/telegram');

test.before(() => ready);

async function makeLinkedChat(chatId) {
  const tenantId = uid();
  const userId = uid();
  const t = now();
  await db.run('INSERT INTO tenants (id, name, plan, plan_key, status, ai_provider, created_at) VALUES (?,?,?,?,?,?,?)',
    [tenantId, 'Test Co', 'trial', 'free', 'active', 'anthropic', t]);
  await db.run('INSERT INTO users (id, tenant_id, name, email, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [userId, tenantId, 'Test User', `${userId}@test.local`, 'x', 'x', 'owner', t]);
  const { code } = await telegram.createLinkCode(tenantId, userId);
  await telegram.handleMessage({ chat: { id: chatId }, text: `/start ${code}` });
  return { tenantId, userId };
}

test('a voice note is downloaded, transcribed, run through act(), and replied to with sendVoice', async () => {
  const { tenantId } = await makeLinkedChat(700001);
  tgCalls.sendMessage.length = 0;
  tgCalls.sendVoice.length = 0;
  openaiCalls.transcriptions = 0;
  openaiCalls.speech = 0;
  transcriptToReturn = 'مشتری جدید ثبت کن به نام آقای رضایی';

  await telegram.handleMessage({ chat: { id: 700001 }, voice: { file_id: 'FILEID1', duration: 3 } });

  assert.equal(openaiCalls.transcriptions, 1, 'must call the STT endpoint');
  const contact = await db.get('SELECT * FROM contacts WHERE tenant_id = ?', [tenantId]);
  assert.ok(contact, 'the transcribed text must actually run through act() (non-sensitive action executed)');
  assert.equal(openaiCalls.speech, 1, 'must synthesize the reply as speech');
  assert.equal(tgCalls.sendVoice.length, 1, 'must reply via sendVoice, not sendMessage');
  assert.ok(tgCalls.sendVoice[0].hasChatId);
  assert.ok(tgCalls.sendVoice[0].hasVoiceFile);
  assert.equal(tgCalls.sendMessage.length, 0, 'a successful voice round-trip should not also send a text message');
});

test('a voice note triggering a sensitive action still uses the text approval-gate keyboard, not voice', async () => {
  await makeLinkedChat(700002);
  tgCalls.sendMessage.length = 0;
  tgCalls.sendVoice.length = 0;
  transcriptToReturn = 'یک معامله فلان رو حذف کن';

  await telegram.handleMessage({ chat: { id: 700002 }, voice: { file_id: 'FILEID2', duration: 2 } });

  assert.equal(tgCalls.sendVoice.length, 0, 'approval prompts must stay text (inline keyboard), never voice');
  assert.equal(tgCalls.sendMessage.length, 1);
  assert.ok(tgCalls.sendMessage[0].reply_markup?.inline_keyboard?.[0]?.some((b) => b.callback_data.startsWith('approve:')));
});

test('a voice note when voice is not configured gets a clear text reply instead of silently failing', async () => {
  await makeLinkedChat(700003);
  tgCalls.sendMessage.length = 0;
  const saved = process.env.OPENAI_VOICE_API_KEY;
  delete process.env.OPENAI_VOICE_API_KEY;

  await telegram.handleMessage({ chat: { id: 700003 }, voice: { file_id: 'FILEID3', duration: 1 } });

  process.env.OPENAI_VOICE_API_KEY = saved;
  assert.equal(tgCalls.sendMessage.length, 1);
  assert.match(tgCalls.sendMessage[0].text, /فعال نشده/);
});
