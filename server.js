import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';

import { askAgent, transcribeAudio, CHAT_MODEL, TRANSCRIBE_MODEL } from './agents.js';
import {
  normalizePhone,
  getUserByWaJid,
  getUserByPhone,
  saveUser,
  listUsers,
} from './userStore.js';
import {
  initTelegram,
  getTelegramStatus,
  requestLoginCode,
  verifyLoginCode,
} from './telegramClient.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const PORT = Number(process.env.PORT || 3000);
const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').trim().replace(/[/]+$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || '';
const evolutionHeaders = { apikey: EVOLUTION_API_KEY };

function evolutionConfigured() {
  return Boolean(EVOLUTION_API_URL && EVOLUTION_API_KEY && EVOLUTION_INSTANCE);
}

async function sendWhatsApp(number, text) {
  if (!evolutionConfigured()) throw new Error('Evolution API is not configured');
  const url = `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`;
  const response = await axios.post(
    url,
    { number, text },
    { headers: evolutionHeaders, timeout: 30000 },
  );
  return response.data;
}

function unwrapMessage(message) {
  if (!message || typeof message !== 'object') return {};
  if (message.ephemeralMessage && message.ephemeralMessage.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage && message.viewOnceMessage.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2 && message.viewOnceMessageV2.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  return message;
}

function extractText(message) {
  if (!message) return '';
  const candidates = [
    message.conversation,
    message.extendedTextMessage && message.extendedTextMessage.text,
    message.imageMessage && message.imageMessage.caption,
    message.videoMessage && message.videoMessage.caption,
    message.documentMessage && message.documentMessage.caption,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

async function downloadEvolutionAudio(rawMessage) {
  if (!evolutionConfigured()) return null;
  const url = `${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`;
  const response = await axios.post(
    url,
    { message: rawMessage },
    { headers: evolutionHeaders, timeout: 60000 },
  );
  const payload = response.data || {};
  const raw =
    payload.base64 ||
    (payload.data && payload.data.base64) ||
    payload.media ||
    (payload.data && payload.data.media);
  if (!raw || typeof raw !== 'string') return null;
  const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const buffer = Buffer.from(base64, 'base64');
  return buffer.length ? buffer : null;
}

async function handleEvolutionPayload(payload) {
  if (!payload || typeof payload !== 'object') return;

  const eventName = String(payload.event || payload.type || '').toLowerCase();
  if (eventName && !eventName.includes('messages.upsert')) return;

  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const key = data.key || {};
  if (key.fromMe) return;

  const remoteJid = String(key.remoteJid || '');
  if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid.includes('status@broadcast')) {
    return;
  }

  const phone = normalizePhone(remoteJid.split('@')[0]);
  if (!phone) return;

  const rawMessage = data.message || {};
  const message = unwrapMessage(rawMessage);
  let text = extractText(message);
  let source = 'text';

  if (!text && message.audioMessage) {
    const buffer = await downloadEvolutionAudio(rawMessage);
    if (buffer) {
      text = await transcribeAudio(buffer, 'whatsapp-audio.ogg');
      source = 'voice';
    }
  }

  if (!text) return;

  const existing = getUserByWaJid(remoteJid) || getUserByPhone(phone);
  const user = saveUser({
    phone: existing && existing.phone ? existing.phone : phone,
    waJid: remoteJid,
    name: data.pushName || undefined,
  });

  console.log(`[whatsapp] ${user.phone} (${source}): ${text}`);
  const reply = await askAgent(user.phone, text, 'whatsapp');
  await sendWhatsApp(user.phone, reply);
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'wa-tg-groq-bot',
    links: {
      telegramAuth: '/auth/telegram',
      health: '/health',
      users: '/users',
      whatsappWebhook: '/webhook/evolution',
    },
    telegram: getTelegramStatus(),
    models: { chat: CHAT_MODEL, transcription: TRANSCRIBE_MODEL },
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    evolutionConfigured: evolutionConfigured(),
    telegram: getTelegramStatus(),
  });
});

app.get('/auth/telegram', (req, res) => {
  res.json({
    ok: true,
    status: getTelegramStatus(),
    steps: [
      '1. POST /auth/telegram/send-code with { "phone": "+2348012345678" } (or set TELEGRAM_PHONE).',
      '2. Telegram sends a login code to your app or by SMS.',
      '3. POST /auth/telegram/verify-code with { "code": "12345" }. Add "password" if 2FA is enabled.',
      '4. Copy the TELEGRAM_SESSION printed in the server logs (also returned in the JSON) into your environment variables and redeploy.',
    ],
    endpoints: {
      sendCode: 'POST /auth/telegram/send-code',
      verifyCode: 'POST /auth/telegram/verify-code',
    },
    note: 'This logs in as a real Telegram user account over MTProto. No bot token is used.',
  });
});

app.post('/auth/telegram/send-code', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await requestLoginCode(body.phone || process.env.TELEGRAM_PHONE);
    res.json(result);
  } catch (err) {
    console.error('[telegram] send-code failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/auth/telegram/verify-code', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await verifyLoginCode(body.code, body.password);
    res.json(result);
  } catch (err) {
    console.error('[telegram] verify-code failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/users', (req, res) => {
  const users = listUsers();
  res.json({ ok: true, count: users.length, users });
});

app.post('/webhook/evolution', (req, res) => {
  res.json({ ok: true });
  handleEvolutionPayload(req.body).catch((err) => {
    console.error('[whatsapp] handler error:', err.message);
  });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});

async function checkEvolution() {
  if (!evolutionConfigured()) {
    console.warn(
      '[evolution] missing EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE - WhatsApp disabled',
    );
    return;
  }
  try {
    const response = await axios.get(
      `${EVOLUTION_API_URL}/instance/connectionState/${EVOLUTION_INSTANCE}`,
      { headers: evolutionHeaders, timeout: 15000 },
    );
    console.log('[evolution] connection state:', JSON.stringify(response.data));
  } catch (err) {
    console.error('[evolution] connection check failed:', err.message);
  }
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`wa-tg-groq-bot listening on 0.0.0.0:${PORT}`);
  console.log(`[models] chat=${CHAT_MODEL} transcription=${TRANSCRIBE_MODEL}`);
  await checkEvolution();
  await initTelegram();
});
