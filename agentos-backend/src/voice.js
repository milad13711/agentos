// voice.js — Speech-to-Text and Text-to-Speech for the Agent, over a real
// direct OpenAI account. Deliberately a SEPARATE key/endpoint from
// OPENAI_API_KEY/OPENAI_BASE_URL (the text pipeline in agent.js), which is
// usually GapGPT — an OpenAI-compatible reseller. Voice quality (especially
// Persian) depends on genuinely reaching OpenAI's own /audio/* endpoints,
// which a text-only reseller proxy may not mirror faithfully. Disabled
// entirely (voiceEnabled() === false) until OPENAI_VOICE_API_KEY is set.
const VOICE_GATEWAY_TIMEOUT_MS = 30_000;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function voiceConfig() {
  const apiKey = process.env.OPENAI_VOICE_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.OPENAI_VOICE_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    // gpt-4o-transcribe/gpt-4o-mini-tts are the newer models the user
    // specifically asked for ("نسخه جدید صوتی") — better multilingual/Persian
    // quality than the older whisper-1/tts-1. Overridable in case a given
    // OpenAI account doesn't have access yet.
    sttModel: process.env.OPENAI_STT_MODEL || 'gpt-4o-transcribe',
    ttsModel: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    ttsVoice: process.env.OPENAI_TTS_VOICE || 'alloy',
  };
}

function voiceEnabled() {
  return !!voiceConfig();
}

// buffer: raw audio bytes (webm/ogg/mp3/whatever the caller recorded).
async function transcribeAudio(buffer, filename, mimeType) {
  const cfg = voiceConfig();
  if (!cfg) throw new Error('voice_not_configured');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename || 'audio');
  form.append('model', cfg.sttModel);
  // Hints the model toward Persian instead of relying on auto-detect, which
  // gets short/noisy voice clips wrong more often than a fixed language hint.
  form.append('language', 'fa');

  const { signal, cancel } = withTimeout(VOICE_GATEWAY_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`voice STT timeout after ${VOICE_GATEWAY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    cancel();
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`voice STT error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return (data.text || '').trim();
}

// format: 'mp3' (web <audio> playback) or 'opus' (Telegram sendVoice, which
// requires an OGG/Opus payload) — see telegram.js for why.
async function synthesizeSpeech(text, format) {
  const cfg = voiceConfig();
  if (!cfg) throw new Error('voice_not_configured');

  const { signal, cancel } = withTimeout(VOICE_GATEWAY_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.ttsModel,
        voice: cfg.ttsVoice,
        input: text,
        response_format: format || 'mp3',
      }),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`voice TTS timeout after ${VOICE_GATEWAY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    cancel();
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`voice TTS error ${res.status}: ${errText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { voiceEnabled, transcribeAudio, synthesizeSpeech };
