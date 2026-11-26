import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Groq from 'groq-sdk';

import { getHistory, addMessage } from './userStore.js';

export const CHAT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
export const TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3';
// Voice-note replies: Groq TTS (free tier) renders the reply as ogg/opus, which
// WhatsApp plays as a normal voice message.
export const TTS_MODEL = process.env.GROQ_TTS_MODEL || 'playai-tts';
export const TTS_VOICE = process.env.GROQ_TTS_VOICE || 'Fritz-PlayAI';
export const TTS_FORMAT = process.env.GROQ_TTS_FORMAT || 'ogg';

const TTS_MIME = {
  ogg: 'audio/ogg; codecs=opus',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mulaw: 'audio/basic',
};

// Free Groq models, tried in order. The last one is the long-standing stable text model.
const FALLBACK_MODELS = ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile'];

function modelChain(preferred) {
  const chain = [preferred, ...FALLBACK_MODELS].filter(Boolean);
  return chain.filter((model, index) => chain.indexOf(model) === index);
}

function isModelGone(err) {
  const text = String((err && (err.message || err.errorMessage)) || err || '').toLowerCase();
  return text.includes('model_not_found')
    || text.includes('decommissioned')
    || text.includes('does not exist')
    || text.includes('no longer supported')
    || text.includes('invalid_model');
}

let groqClient = null;

function getGroq() {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');
  if (!groqClient) {
    groqClient = new Groq({
      apiKey: process.env.GROQ_API_KEY,
      ...(process.env.GROQ_BASE_URL ? { baseURL: process.env.GROQ_BASE_URL } : {}),
    });
  }
  return groqClient;
}

function systemPrompt(phone) {
  return `You are helpful WhatsApp+Telegram assistant. User phone ${phone} has linked WA+TG. Keep replies short, natural. Same user across platforms.`;
}

// Qwen3 may wrap its reasoning in  thinking tags; strip them from the final reply.
function stripThinking(text) {
  let out = String(text || '');
  while (out.indexOf('<think') !== -1) {
    const start = out.indexOf('<think');
    const closeTag = out.indexOf('</think', start);
    if (closeTag === -1) {
      out = out.slice(0, start).trim();
      break;
    }
    const closeBracket = out.indexOf('>', closeTag);
    const tail = closeBracket === -1 ? '' : out.slice(closeBracket + 1);
    out = (out.slice(0, start) + ' ' + tail).trim();
  }
  return out.trim();
}

export async function askAgent(phone, userText, platform = 'whatsapp') {
  const groq = getGroq();
  const text = String(userText || '').trim();
  if (!text) throw new Error('askAgent called with empty text');

  const history = getHistory(phone);
  addMessage(phone, 'user', text);

  const messages = [
    { role: 'system', content: systemPrompt(phone) },
    ...history.map((entry) => ({ role: entry.role, content: entry.content })),
    { role: 'user', content: text },
  ];

  const models = modelChain(CHAT_MODEL);
  let completion = null;
  let lastError = null;

  for (const model of models) {
    try {
      console.log(`[groq] using free model ${model}`);
      completion = await groq.chat.completions.create({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 512,
      });
      break;
    } catch (err) {
      lastError = err;
      const detail = (err && (err.errorMessage || err.message)) || String(err);
      console.log(`[groq] model ${model} failed: ${detail}${isModelGone(err) ? ' (model unavailable, trying next)' : ''}`);
    }
  }

  if (!completion) {
    if (lastError) {
      throw new Error(`All Groq models failed (${models.join(', ')}): ${(lastError && (lastError.errorMessage || lastError.message)) || lastError}`);
    }
    throw new Error('Groq returned no completion');
  }

  let reply = stripThinking(completion.choices && completion.choices[0] && completion.choices[0].message
    ? completion.choices[0].message.content
    : '');
  if (!reply) reply = "Sorry, I couldn't come up with a reply just now. Try again?";

  addMessage(phone, 'assistant', reply);
  console.log(`[agent] ${platform} reply to ${phone}: ${reply.slice(0, 120)}`);
  return reply;
}

/**
 * Text -> speech with Groq TTS. Returns { buffer, mimetype } so the caller can
 * send it straight to WhatsApp as a voice note.
 */
export async function synthesizeSpeech(text) {
  const input = String(text || '')
    .replace(/[*_~`]/g, '')
    .trim();
  if (!input) throw new Error('synthesizeSpeech called with empty text');

  const groq = getGroq();
  const speech = await groq.audio.speech.create({
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: input.slice(0, 4000),
    response_format: TTS_FORMAT,
  });
  const arrayBuffer = await speech.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) throw new Error('Groq TTS returned empty audio');

  console.log(`[tts] generated ${buffer.length} bytes (${TTS_MODEL}/${TTS_VOICE}/${TTS_FORMAT})`);
  return { buffer, mimetype: TTS_MIME[TTS_FORMAT] || 'audio/ogg' };
}

export async function transcribeAudio(buffer, fileName = 'audio.ogg') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Empty audio buffer');
  const groq = getGroq();

  const ext = path.extname(fileName) || '.ogg';
  const tmpPath = path.join(
    os.tmpdir(),
    `wa-tg-groq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  );
  await fs.promises.writeFile(tmpPath, buffer);

  try {
    const result = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: TRANSCRIBE_MODEL,
    });
    const text = result && typeof result.text === 'string' ? result.text.trim() : '';
    console.log(`[whisper] transcribed ${buffer.length} bytes -> ${text.slice(0, 120)}`);
    return text;
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}
