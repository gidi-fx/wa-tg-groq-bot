import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Groq from 'groq-sdk';

import { getHistory, addMessage } from './userStore.js';

export const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'qwen/qwen3-32b';
export const TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3';

let groqClient = null;

function getGroq() {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');
  if (!groqClient) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
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

  const completion = await groq.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 512,
  });

  let reply = stripThinking(completion.choices && completion.choices[0] && completion.choices[0].message
    ? completion.choices[0].message.content
    : '');
  if (!reply) reply = "Sorry, I couldn't come up with a reply just now. Try again?";

  addMessage(phone, 'assistant', reply);
  console.log(`[agent] ${platform} reply to ${phone}: ${reply.slice(0, 120)}`);
  return reply;
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
