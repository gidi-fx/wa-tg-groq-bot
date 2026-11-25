import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

import { askAgent, transcribeAudio, CHAT_MODEL, TRANSCRIBE_MODEL } from './agents.js';
import {
  normalizePhone,
  getUserByWaJid,
  getUserByPhone,
  saveUser,
  listUsers,
} from './userStore.js';
import {
  initSessions,
  getTelegramStatus,
  getSessionLoadInfo,
  hasSessions,
  exportSessions,
  sendCode,
  verifyCode,
  listSessions,
  logout,
} from './telegramManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Keep the last 50 log lines in memory so the dashboard can tail them.
const LOG_LINES = [];
const MAX_LOG_LINES = 50;
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try {
      const text = args
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' ')
        .slice(0, 400);
      LOG_LINES.push(`${new Date().toISOString()} ${level.toUpperCase()} ${text}`);
      if (LOG_LINES.length > MAX_LOG_LINES) LOG_LINES.splice(0, LOG_LINES.length - MAX_LOG_LINES);
    } catch {
      /* never let logging break the app */
    }
  };
}

const PORT = Number(process.env.PORT || 3000);
const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').trim().replace(/[/]+$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const evolutionHeaders = { apikey: EVOLUTION_API_KEY };

function evolutionConfigured() {
  return Boolean(EVOLUTION_API_URL && EVOLUTION_API_KEY);
}

async function fetchEvolutionInstances() {
  if (!evolutionConfigured()) return { configured: false, instances: [] };
  try {
    const response = await axios.get(`${EVOLUTION_API_URL}/instance/fetchInstances`, {
      headers: evolutionHeaders,
      timeout: 10000,
    });
    const raw = Array.isArray(response.data) ? response.data : [];
    const instances = raw.map((item) => {
      const inner = item && item.instance && typeof item.instance === 'object' ? item.instance : {};
      return {
        name: item.name || item.instanceName || inner.instanceName || inner.name || 'unknown',
        status: item.connectionStatus || item.status || inner.status || 'unknown',
        profileName: item.profileName || inner.profileName || null,
        number: item.owner || item.ownerJid || inner.owner || inner.ownerJid || null,
      };
    });
    return { configured: true, instances };
  } catch (err) {
    console.error('[evolution] fetchInstances failed:', err.message);
    return { configured: true, instances: [], error: err.message };
  }
}

function instanceName(instance) {
  const raw = String(instance || '').trim();
  return encodeURIComponent(raw || 'any');
}

async function sendWhatsApp(instance, number, text) {
  if (!evolutionConfigured()) throw new Error('Evolution API is not configured');
  const response = await axios.post(
    `${EVOLUTION_API_URL}/message/sendText/${instanceName(instance)}`,
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

async function downloadEvolutionAudio(instance, rawMessage) {
  if (!evolutionConfigured()) return null;
  const response = await axios.post(
    `${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${instanceName(instance)}`,
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

async function handleEvolutionPayload(payload, instance) {
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
    const buffer = await downloadEvolutionAudio(instance, rawMessage);
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

  console.log(`[whatsapp] ${user.phone} via ${instance || 'any'} (${source}): ${text}`);
  const reply = await askAgent(user.phone, text, 'whatsapp');
  await sendWhatsApp(instance, user.phone, reply);
}

/* ---------------------------------- routes ---------------------------------- */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', async (req, res) => {
  const backup = hasSessions() ? exportSessions() : null;

  res.json({
    status: 'ok',
    service: 'wa-tg-groq-bot',
    multiUser: true,
    uptime: Math.round(process.uptime()),
    // On Render's free tier the disk is wiped on redeploy: copy this base64 into
    // Environment > TELEGRAM_SESSIONS_JSON so sessions are restored on boot.
    envBackup: backup
      ? {
          envVar: 'TELEGRAM_SESSIONS_JSON',
          value: backup.base64,
          count: backup.count,
        }
      : { envVar: 'TELEGRAM_SESSIONS_JSON', value: null, count: 0 },
    links: {
      health: '/health',
      users: '/users',
      whatsappWebhook: '/webhook/evolution',
      whatsappCreateInstance: '/instance/create',
      telegramSendCode: '/telegram/send-code',
      telegramVerifyCode: '/telegram/verify-code',
      telegramSessions: '/telegram/sessions',
      telegramLogout: '/telegram/logout',
    },
    telegram: getTelegramStatus(),
    telegramSessionsFromEnv: getSessionLoadInfo(),
    evolutionConfigured: evolutionConfigured(),
    evolution: await fetchEvolutionInstances(),
    models: { chat: CHAT_MODEL, transcription: TRANSCRIBE_MODEL },
  });
});

app.get('/logs', (req, res) => {
  res.json({ ok: true, count: LOG_LINES.length, lines: LOG_LINES });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    evolutionConfigured: evolutionConfigured(),
    telegram: getTelegramStatus(),
  });
});

/* -------------------------------- Telegram ---------------------------------- */

app.post('/telegram/send-code', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await sendCode(body.phone);
    res.json(result);
  } catch (err) {
    console.error('[telegram] send-code failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/telegram/verify-code', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await verifyCode({
      phone: body.phone,
      code: body.code,
      phoneCodeHash: body.phoneCodeHash,
      password: body.password,
    });

    if (result && result.success && result.sessionSaved) {
      const { base64 } = exportSessions();
      console.log('=== PERSIST THIS TO RENDER ENV ===');
      console.log('TELEGRAM_SESSIONS_JSON=' + base64);
      console.log('=== END ===');
      result.session = result.session || '';
      result.envValue = base64;
      result.instruction =
        'Copy this base64 to Render env TELEGRAM_SESSIONS_JSON to survive redeploys';
    }

    res.json(result);
  } catch (err) {
    console.error('[telegram] verify-code failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/telegram/sessions', (req, res) => {
  const sessions = listSessions();
  res.json({ success: true, count: sessions.length, sessions });
});

app.post('/telegram/logout', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await logout(body.phone);
    res.json(result);
  } catch (err) {
    console.error('[telegram] logout failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/* --------------------------------- WhatsApp --------------------------------- */

app.post('/instance/create', async (req, res) => {
  try {
    if (!evolutionConfigured()) throw new Error('Evolution API is not configured');
    const body = req.body || {};
    const name = String(body.instanceName || body.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, error: 'instanceName is required' });
    }

    const response = await axios.post(
      `${EVOLUTION_API_URL}/instance/create`,
      { instanceName: name, qrcode: true, integration: 'WHATSAPP-BAILEYS' },
      { headers: evolutionHeaders, timeout: 30000 },
    );

    res.json({ success: true, instance: name, evolution: response.data });
  } catch (err) {
    console.error('[evolution] instance/create failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/instance/connect', async (req, res) => {
  try {
    if (!evolutionConfigured()) throw new Error('Evolution API is not configured');
    const name = String(req.query.instance || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'instance is required' });

    const response = await axios.get(
      `${EVOLUTION_API_URL}/instance/connect/${instanceName(name)}`,
      { headers: evolutionHeaders, timeout: 20000 },
    );
    const data = response.data || {};
    const qr = data.qrcode && typeof data.qrcode === 'object' ? data.qrcode : {};

    res.json({
      success: true,
      instance: name,
      state: data.state || data.instance?.state || null,
      base64: qr.base64 || data.base64 || null,
      pairingCode: qr.pairingCode || data.pairingCode || null,
    });
  } catch (err) {
    console.error('[evolution] instance/connect failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/webhook/evolution', (req, res) => {
  const body = req.body || {};
  const instance = body.instance || req.query.instance || 'any';

  res.json({ ok: true });

  handleEvolutionPayload(body, instance).catch((err) => {
    console.error('[whatsapp] handler error:', err.message);
  });
});

app.get('/users', (req, res) => {
  const users = listUsers();
  res.json({ ok: true, count: users.length, users });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});

async function checkEvolution() {
  if (!evolutionConfigured()) {
    console.warn('[evolution] missing EVOLUTION_API_URL / EVOLUTION_API_KEY - WhatsApp disabled');
    return;
  }
  try {
    const response = await axios.get(`${EVOLUTION_API_URL}/instance/fetchInstances`, {
      headers: evolutionHeaders,
      timeout: 15000,
    });
    const instances = Array.isArray(response.data) ? response.data : [];
    console.log(`[evolution] connected, ${instances.length} instance(s) found`);
  } catch (err) {
    console.error('[evolution] connection check failed:', err.message);
  }
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`wa-tg-groq-bot listening on 0.0.0.0:${PORT}`);
  console.log(`[models] chat=${CHAT_MODEL} transcription=${TRANSCRIBE_MODEL}`);

  const loadInfo = getSessionLoadInfo();
  if (loadInfo.fromEnv > 0) {
    console.log(`Loaded ${loadInfo.fromEnv} sessions from ENV`);
  } else if (loadInfo.total > 0) {
    console.log(`Loaded ${loadInfo.total} sessions from file (TELEGRAM_SESSIONS_JSON not set)`);
  } else {
    console.log('Loaded 0 sessions from ENV');
  }

  await checkEvolution();
  await initSessions();
});
