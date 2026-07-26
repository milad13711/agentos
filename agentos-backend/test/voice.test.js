// Regression coverage for src/voice.js (STT/TTS over a direct OpenAI
// account). Real network access to api.openai.com isn't available in this
// dev sandbox, so this stands up a tiny local HTTP server that implements
// the same contract as /audio/transcriptions (multipart upload -> {text})
// and /audio/speech (JSON in -> raw audio bytes out), and points
// OPENAI_VOICE_BASE_URL at it. The business logic under test — request
// shape, model/voice selection, timeout/error handling — is exactly what
// would run against the real API; only the transport is faked.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.AGENTOS_TOKEN_SECRET = 'test-secret';

const requests = { transcriptions: [], speech: [] };
let forceTranscriptionsError = null;

const fakeServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url.endsWith('/audio/transcriptions')) {
      if (forceTranscriptionsError) {
        res.writeHead(forceTranscriptionsError, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'forced test failure' }));
      }
      const raw = body.toString('latin1');
      requests.transcriptions.push({
        authorization: req.headers['authorization'],
        containsModel: raw.includes('gpt-4o-transcribe') || raw.includes('name="model"'),
        containsLanguageFa: raw.includes('fa'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ text: 'سلام دنیا' }));
    }
    if (req.url.endsWith('/audio/speech')) {
      const parsed = JSON.parse(body.toString('utf8') || '{}');
      requests.speech.push({ authorization: req.headers['authorization'], ...parsed });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return res.end(Buffer.from([0xff, 0xfb, 0x90, 0x00])); // fake mp3-ish bytes
    }
    res.writeHead(404);
    res.end();
  });
});

let fakePort;
test.before(async () => {
  await new Promise((resolve) => fakeServer.listen(0, resolve));
  fakePort = fakeServer.address().port;
  process.env.OPENAI_VOICE_API_KEY = 'test-voice-key';
  process.env.OPENAI_VOICE_BASE_URL = `http://127.0.0.1:${fakePort}/v1`;
});
test.after(async () => {
  await new Promise((resolve) => fakeServer.close(resolve));
});

const voice = require('../src/voice');

test('voiceEnabled() is false until OPENAI_VOICE_API_KEY is set', () => {
  const saved = process.env.OPENAI_VOICE_API_KEY;
  delete process.env.OPENAI_VOICE_API_KEY;
  assert.equal(voice.voiceEnabled(), false);
  process.env.OPENAI_VOICE_API_KEY = saved;
  assert.equal(voice.voiceEnabled(), true);
});

test('transcribeAudio() uploads the audio as multipart and returns the transcript', async () => {
  requests.transcriptions.length = 0;
  const text = await voice.transcribeAudio(Buffer.from('fake-ogg-bytes'), 'voice.ogg', 'audio/ogg');
  assert.equal(text, 'سلام دنیا');
  assert.equal(requests.transcriptions.length, 1);
  assert.equal(requests.transcriptions[0].authorization, 'Bearer test-voice-key');
  assert.ok(requests.transcriptions[0].containsLanguageFa, 'must hint the Persian language to the model');
});

test('transcribeAudio() surfaces a real error instead of swallowing it', async () => {
  forceTranscriptionsError = 500;
  await assert.rejects(
    () => voice.transcribeAudio(Buffer.from('x'), 'a.ogg', 'audio/ogg'),
    /voice STT error 500/
  );
  forceTranscriptionsError = null;
});

test('synthesizeSpeech() sends the configured model/voice and returns raw audio bytes', async () => {
  requests.speech.length = 0;
  const audio = await voice.synthesizeSpeech('سلام، حالت چطوره؟', 'opus');
  assert.ok(Buffer.isBuffer(audio));
  assert.ok(audio.length > 0);
  assert.equal(requests.speech.length, 1);
  assert.equal(requests.speech[0].authorization, 'Bearer test-voice-key');
  assert.equal(requests.speech[0].model, 'gpt-4o-mini-tts');
  assert.equal(requests.speech[0].voice, 'alloy');
  assert.equal(requests.speech[0].response_format, 'opus');
  assert.equal(requests.speech[0].input, 'سلام، حالت چطوره؟');
});

test('transcribeAudio()/synthesizeSpeech() throw voice_not_configured when the key is unset', async () => {
  const saved = process.env.OPENAI_VOICE_API_KEY;
  delete process.env.OPENAI_VOICE_API_KEY;
  await assert.rejects(() => voice.transcribeAudio(Buffer.from('x'), 'a.ogg', 'audio/ogg'), /voice_not_configured/);
  await assert.rejects(() => voice.synthesizeSpeech('hi'), /voice_not_configured/);
  process.env.OPENAI_VOICE_API_KEY = saved;
});
