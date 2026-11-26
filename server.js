import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { askAgent, synthesizeSpeech, CHAT_MODEL, TRANSCRIBE_MODEL, TTS_MODEL } from './agents.js';
import { listUsers } from './userStore.js';
import { logError } from './logger.js';
import {
  initTelegramClients,
  handleTelegramMessage,
  getTelegramStatus,
  getSessionLoadInfo,
  getDebugInfo,
  hasSessions,
  exportSessions,
  sendCode,
  verifyCode,
  listSessions,
  logout,
} from './telegramManager.js';
import {
  initWhatsAppClients,
  handleEvolutionPayload,
  sendWhatsAppMessage,
  sendWhatsAppAudio,
  sendPresence,
  fetchInstances,
  createInstance,
  connectInstance,
  evolutionConfigured,
  getWhatsAppStatus,
  WEBHOOK_URL,
  EVOLUTION_INSTANCE,
} from './whatsappManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Keep the last 100 log lines in memory so the dashboard can tail them.
const LOG_LINES = [];
const MAX_LOG_LINES = 100;
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try {
      const text = args
        .map((arg) => {
          if (typeof arg === 'string') return arg;
          if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(' ')
        .slice(0, 400);
      LOG_LINES.push(`${new Date().toISOString()} ${level.toUpperCase()} ${text}`);
      if (LOG_LINES.length > MAX_LOG_LINES) LOG_LINES.splice(0, LOG_LINES.length - MAX_LOG_LINES);
    } catch {
      /* never let logging break the app */
    }
  };
}

const PORT = Number(process.env.PORT || 10000);

/* ---------------------------------- routes ---------------------------------- */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', async (req, res) => {
  const backup = hasSessions() ? exportSessions() : null;
  const telegram = getTelegramStatus();
  const whatsapp = getWhatsAppStatus();
  const evolution = await fetchInstances();

  res.json({
    status: 'ok',
    service: 'wa-tg-groq-bot',
    multiUser: true,
    uptime: Math.round(process.uptime()),
    port: PORT,
    links: {
      health: '/health',
      users: '/users',
      whatsappWebhook: '/webhook/evolution',
      whatsappCreateInstance: '/instance/create',
      telegramSendCode: '/telegram/send-code',
      telegramVerifyCode: '/telegram/verify-code',
      telegramSessions: '/telegram/sessions',
      telegramLogout: '/telegram/logout',
      telegramDebug: '/telegram/debug',
    },
    whatsapp: {
      configured: whatsapp.configured,
      total: whatsapp.total,
      active: whatsapp.active,
      instanceFromEnv: whatsapp.instanceFromEnv,
      webhookUrl: whatsapp.webhookUrl,
      instances: whatsapp.instances,
      lastInitAt: whatsapp.lastInitAt,
      lastInitError: whatsapp.lastInitError,
    },
    telegram: {
      configured: telegram.configured,
      apiId: telegram.apiId,
      total: telegram.total,
      active: telegram.active,
      pendingLogins: telegram.pendingLogins,
      sessions: telegram.sessions,
    },
    evolution: {
      configured: evolution.configured,
      count: evolution.instances.length,
      instances: evolution.instances,
      error: evolution.error || null,
    },
    evolutionConfigured: evolution.configured,
    evolutionInstanceCount: evolution.instances.length,
    telegramSessionsFromEnv: getSessionLoadInfo(),
    // On Render's free tier the disk is wiped on redeploy: copy this base64 into
    // Environment > TELEGRAM_SESSIONS_JSON so sessions are restored on boot.
    envBackup: backup
      ? { envVar: 'TELEGRAM_SESSIONS_JSON', value: backup.base64, count: backup.count }
      : { envVar: 'TELEGRAM_SESSIONS_JSON', value: null, count: 0 },
    models: { chat: CHAT_MODEL, transcription: TRANSCRIBE_MODEL },
  });
});

app.get('/logs', (req, res) => {
  res.json({ ok: true, count: LOG_LINES.length, lines: LOG_LINES });
});

app.get('/health', (req, res) => {
  const telegram = getTelegramStatus();
  const whatsapp = getWhatsAppStatus();
  res.json({
    ok: true,
    uptime: process.uptime(),
    port: PORT,
    whatsapp: { configured: whatsapp.configured, total: whatsapp.total, active: whatsapp.active },
    telegram: { configured: telegram.configured, total: telegram.total, active: telegram.active },
  });
});

/* -------------------------------- Telegram ---------------------------------- */

app.post('/telegram/send-code', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await sendCode(body.phone);
    res.json({
      phone: result.phone,
      phoneCodeHash: result.phoneCodeHash,
      isCodeViaApp: result.isCodeViaApp,
      message: 'Check Telegram app > Chat Telegram for code',
      success: true,
    });
  } catch (err) {
    logError(`[telegram] send-code failed for ${body.phone || '(no phone)'}`, err);
    res.status(400).json({
      success: false,
      phone: body.phone || null,
      error: err.errorMessage || err.message || String(err),
      errorMessage: err.errorMessage || null,
      code: err.code || null,
      hint: 'Check TELEGRAM_API_ID / TELEGRAM_API_HASH are valid and the number uses international format',
    });
  }
});

app.post('/telegram/verify-code', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await verifyCode(
      body.phone,
      body.code,
      body.phoneCodeHash,
      body.password,
      handleTelegramMessage,
    );

    if (result && result.success && result.sessionSaved) {
      const { base64 } = exportSessions();
      result.envValue = base64;
      result.instruction =
        result.instruction ||
        'Copy this base64 to Render env TELEGRAM_SESSIONS_JSON to survive redeploys';
    }

    res.json(result);
  } catch (err) {
    logError(`[telegram] verify-code failed for ${body.phone || '(no phone)'}`, err);
    res.status(400).json({
      success: false,
      phone: body.phone || null,
      error: err.errorMessage || err.message || String(err),
      errorMessage: err.errorMessage || null,
      code: err.code || null,
    });
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
    logError('[telegram] logout failed', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/telegram/debug', (req, res) => {
  res.json({
    ok: true,
    port: PORT,
    telegram: getDebugInfo(),
    whatsapp: getWhatsAppStatus(),
    status: getTelegramStatus(),
  });
});

/* --------------------------------- WhatsApp --------------------------------- */

app.get('/webhook/evolution', (req, res) => {
  res.json({
    ok: true,
    webhook: WEBHOOK_URL,
    instanceFromEnv: EVOLUTION_INSTANCE || null,
    whatsapp: getWhatsAppStatus(),
    hint: 'Point Evolution API webhooks here: POST /webhook/set/{instance} with this URL',
  });
});

app.post('/webhook/evolution', (req, res) => {
  const body = req.body || {};
  const instance =
    body.instance || body.instanceName || req.query.instance || EVOLUTION_INSTANCE || 'any';

  // Answer Evolution immediately so it never retries a slow Groq call.
  res.json({ ok: true });

  handleEvolutionPayload(body, instance).catch((err) => {
    logError('[whatsapp] webhook handler failed', err);
  });
});

app.post('/instance/create', async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.instanceName || body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'instanceName is required' });
    const result = await createInstance(name);
    res.json({ success: true, instance: result.instance, webhook: WEBHOOK_URL, evolution: result.evolution });
  } catch (err) {
    logError('[whatsapp] instance/create failed', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/instance/connect', async (req, res) => {
  try {
    const data = await connectInstance(req.query.instance);
    res.json({ success: true, ...data });
  } catch (err) {
    logError('[whatsapp] instance/connect failed', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/users', (req, res) => {
  const users = listUsers();
  res.json({ ok: true, count: users.length, users });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

/* ---------------------------------- startup --------------------------------- */

process.on('unhandledRejection', (reason) => {
  logError('[server] unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

const TYPING_MS = Number(process.env.WHATSAPP_TYPING_MS || 2500);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Groq reply + Evolution send, used as the WhatsApp message handler.
 * Typing indicator starts before the Groq call and stays visible at least
 * TYPING_MS (2.5s), then the reply is sent quoted to the incoming message.
 * A voice note is answered with a voice note (Groq TTS); if TTS fails the same
 * reply goes out as text so the message is never left unanswered.
 */
async function handleWhatsAppMessage({ instance, phone, text, quoted, messageType, isVoice }) {
  await sendPresence(instance, phone, 'composing');
  const startedAt = Date.now();

  try {
    const reply = await askAgent(phone, text, 'whatsapp');

    // TTS runs while the typing indicator is still visible.
    let voice = null;
    if (isVoice) {
      try {
        voice = await synthesizeSpeech(reply);
      } catch (err) {
        logError(`[whatsapp] TTS reply failed for ${phone} - sending text instead`, err);
      }
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed < TYPING_MS) await sleep(TYPING_MS - elapsed);
    await sendPresence(instance, phone, 'paused');

    if (voice) {
      await sendWhatsAppAudio(instance, phone, voice.buffer, { quoted, mimetype: voice.mimetype });
      console.log(
        `[whatsapp] replied to ${phone} (${messageType || 'text'}, voice note back): ${reply.slice(0, 120)}`,
      );
    } else {
      await sendWhatsAppMessage(instance, phone, reply, { quoted });
      console.log(
        `[whatsapp] replied to ${phone} (${messageType || 'text'}${isVoice ? ', voice -> text fallback' : ''}): ${reply.slice(0, 120)}`,
      );
    }
    return reply;
  } catch (err) {
    await sendPresence(instance, phone, 'paused');
    throw err;
  }
}

async function start() {
  console.log(`[server] starting wa-tg-groq-bot on PORT=${PORT} (process.env.PORT=${process.env.PORT || 'unset'})`);

  const loadInfo = getSessionLoadInfo();
  console.log(
    `Loaded ${loadInfo.fromEnv} sessions from ENV, ${loadInfo.fromFile} from file (${loadInfo.total} total)`,
  );
  console.log(`[models] chat=${CHAT_MODEL} transcription=${TRANSCRIBE_MODEL} tts=${TTS_MODEL}`);
  console.log(`[whatsapp] webhook target ${WEBHOOK_URL}`);

  // Both platforms must be active before the server accepts traffic.
  await initTelegramClients(handleTelegramMessage);
  await initWhatsAppClients(handleWhatsAppMessage);

  app.listen(PORT, '0.0.0.0', () => {
    const telegram = getTelegramStatus();
    const whatsapp = getWhatsAppStatus();
    console.log(`[server] listening on 0.0.0.0:${PORT}`);
    console.log(
      `[server] ACTIVE clients -> telegram=${telegram.active}/${telegram.total} whatsapp=${whatsapp.active}/${whatsapp.total}`,
    );
    console.log(`[server] Telegram webhook? no - MTProto. WhatsApp webhook: ${WEBHOOK_URL}`);
  });
}

start().catch((err) => {
  logError('[server] startup failed', err);
  process.exit(1);
});
