import 'dotenv/config';
import axios from 'axios';

import { askAgent, transcribeAudio } from './agents.js';
import { logError } from './logger.js';
import { normalizePhone, getUserByWaJid, getUserByPhone, saveUser } from './userStore.js';

/* ----------------------------------- config --------------------------------- */

const EVOLUTION_API_URL = String(process.env.EVOLUTION_API_URL || '')
  .trim()
  .replace(/[/]+$/, '');
const EVOLUTION_API_KEY = String(process.env.EVOLUTION_API_KEY || '').trim();
// Optional: pin one instance. Otherwise every instance Evolution reports is used.
const EVOLUTION_INSTANCE = String(
  process.env.EVOLUTION_INSTANCE || process.env.INSTANCE_NAME || '',
).trim();
const WEBHOOK_URL = String(
  process.env.WEBHOOK_URL || 'https://wa-tg-groq-bot.onrender.com/webhook/evolution',
).trim();

const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];

/** instance name -> { name, status, profileName, number, webhookSet } */
const activeInstances = new Map();
let storedHandler = null;
let lastInitAt = null;
let lastInitError = null;

export { WEBHOOK_URL, EVOLUTION_INSTANCE };

export function evolutionConfigured() {
  return Boolean(EVOLUTION_API_URL && EVOLUTION_API_KEY);
}

function headers() {
  return { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' };
}

function instancePath(instance) {
  return encodeURIComponent(String(instance || 'any').trim() || 'any');
}

/* --------------------------------- instances -------------------------------- */

export async function fetchInstances() {
  if (!evolutionConfigured()) return { configured: false, instances: [], error: null };

  try {
    const response = await axios.get(`${EVOLUTION_API_URL}/instance/fetchInstances`, {
      headers: headers(),
      timeout: 15000,
    });
    const raw = Array.isArray(response.data) ? response.data : [];
    const instances = raw.map((item) => {
      const inner = item && item.instance && typeof item.instance === 'object' ? item.instance : {};
      return {
        name: item.name || item.instanceName || inner.instanceName || inner.name || 'unknown',
        status: item.connectionStatus || item.status || item.state || inner.status || 'unknown',
        profileName: item.profileName || inner.profileName || null,
        number: item.owner || item.ownerJid || item.number || inner.owner || inner.ownerJid || null,
      };
    });
    return { configured: true, instances, error: null };
  } catch (err) {
    logError('[whatsapp] instance/fetchInstances failed', err);
    return { configured: true, instances: [], error: err.message || 'fetchInstances failed' };
  }
}

export async function createInstance(name) {
  if (!evolutionConfigured()) throw new Error('Evolution API is not configured');
  const instanceName = String(name || '').trim();
  if (!instanceName) throw new Error('instanceName is required');

  console.log(`[whatsapp] creating instance ${instanceName}`);
  const response = await axios.post(
    `${EVOLUTION_API_URL}/instance/create`,
    { instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS' },
    { headers: headers(), timeout: 30000 },
  );

  activeInstances.set(instanceName, {
    name: instanceName,
    status: 'connecting',
    profileName: null,
    number: null,
    webhookSet: false,
  });
  await setWebhook(instanceName);

  return { instance: instanceName, evolution: response.data };
}

export async function connectInstance(instance) {
  if (!evolutionConfigured()) throw new Error('Evolution API is not configured');
  const name = String(instance || '').trim();
  if (!name) throw new Error('instance is required');

  const response = await axios.get(`${EVOLUTION_API_URL}/instance/connect/${instancePath(name)}`, {
    headers: headers(),
    timeout: 20000,
  });
  const data = response.data || {};
  const qr = data.qrcode && typeof data.qrcode === 'object' ? data.qrcode : {};

  return {
    instance: name,
    state: data.state || (data.instance && data.instance.state) || null,
    base64: qr.base64 || data.base64 || null,
    pairingCode: qr.pairingCode || data.pairingCode || null,
  };
}

/**
 * Point an instance at this app's webhook. Evolution v2 nests the config under
 * "webhook"; older builds take a flat body - try v2 first, then v1.
 */
export async function setWebhook(instance) {
  if (!evolutionConfigured()) return false;
  const name = String(instance || '').trim();
  if (!name) return false;

  const v2Body = {
    webhook: {
      enabled: true,
      url: WEBHOOK_URL,
      webhookByEvents: false,
      webhookBase64: false,
      events: WEBHOOK_EVENTS,
    },
  };
  const v1Body = {
    url: WEBHOOK_URL,
    webhook_by_events: false,
    webhook_base64: false,
    events: WEBHOOK_EVENTS,
  };

  const url = `${EVOLUTION_API_URL}/webhook/set/${instancePath(name)}`;

  try {
    await axios.post(url, v2Body, { headers: headers(), timeout: 20000 });
    console.log(`Webhook set for instance ${name} -> ${WEBHOOK_URL}`);
    markWebhook(name, true);
    return true;
  } catch (v2Err) {
    console.warn(
      `[whatsapp] webhook/set v2 body rejected for ${name} (${
        v2Err.response ? v2Err.response.status : v2Err.message
      }), retrying with v1 body`,
    );
  }

  try {
    await axios.post(url, v1Body, { headers: headers(), timeout: 20000 });
    console.log(`Webhook set for instance ${name} -> ${WEBHOOK_URL}`);
    markWebhook(name, true);
    return true;
  } catch (err) {
    const detail =
      err.response && err.response.data
        ? `${err.response.status} ${JSON.stringify(err.response.data)}`
        : '';
    logError(`[whatsapp] webhook/set FAILED for ${name} ${detail}`.trim(), err);
    markWebhook(name, false);
    return false;
  }
}

function markWebhook(name, ok) {
  const existing = activeInstances.get(name) || { name };
  activeInstances.set(name, { ...existing, webhookSet: ok });
}

/**
 * Startup: validate the Evolution config, fetch every instance, register it as
 * active and point it at /webhook/evolution. Awaited before app.listen.
 */
export async function initWhatsAppClients(handleMessage) {
  if (typeof handleMessage === 'function') storedHandler = handleMessage;

  if (!evolutionConfigured()) {
    console.warn('[whatsapp] missing EVOLUTION_API_URL / EVOLUTION_API_KEY - WhatsApp disabled');
    lastInitError = 'EVOLUTION_API_URL / EVOLUTION_API_KEY missing';
    return { configured: false, total: 0, active: 0, webhooks: 0 };
  }

  console.log(
    `[whatsapp] Evolution API url=${EVOLUTION_API_URL} apiKey=${
      EVOLUTION_API_KEY ? `set(${EVOLUTION_API_KEY.length} chars)` : 'MISSING'
    } instance=${EVOLUTION_INSTANCE || '(all instances from API)'} webhook=${WEBHOOK_URL}`,
  );

  const { instances, error } = await fetchInstances();
  lastInitAt = new Date().toISOString();
  lastInitError = error;

  console.log(`[whatsapp] evolution connected, ${instances.length} instance(s) found`);

  if (!instances.length) {
    console.warn(
      '[whatsapp] no instances yet - create one via POST /instance/create, then reload to set its webhook',
    );
  }

  let webhooks = 0;
  for (const inst of instances) {
    const name = inst.name;
    if (!name || name === 'unknown') continue;

    activeInstances.set(name, { ...inst, webhookSet: Boolean(activeInstances.get(name)?.webhookSet) });
    console.log(
      `[whatsapp] Client ACTIVE for ${name} (status=${inst.status}${
        inst.number ? `, number=${inst.number}` : ''
      })`,
    );

    if (inst.status && !/open|connected/i.test(String(inst.status))) {
      console.warn(`[whatsapp] ${name} is not connected yet (status=${inst.status}) - scan its QR`);
    }

    if (await setWebhook(name)) webhooks += 1;
  }

  // A pinned instance may not be listed yet; still try its webhook once.
  if (EVOLUTION_INSTANCE && !activeInstances.has(EVOLUTION_INSTANCE)) {
    console.log(`[whatsapp] pinned instance ${EVOLUTION_INSTANCE} not in fetchInstances, setting its webhook`);
    activeInstances.set(EVOLUTION_INSTANCE, { name: EVOLUTION_INSTANCE, status: 'unknown', webhookSet: false });
    if (await setWebhook(EVOLUTION_INSTANCE)) webhooks += 1;
  }

  console.log(
    `[whatsapp] initWhatsAppClients done: instances=${instances.length} active=${activeInstances.size} webhooks=${webhooks}`,
  );

  return { configured: true, total: instances.length, active: activeInstances.size, webhooks };
}

export function getWhatsAppStatus() {
  return {
    configured: evolutionConfigured(),
    url: EVOLUTION_API_URL || null,
    instanceFromEnv: EVOLUTION_INSTANCE || null,
    webhookUrl: WEBHOOK_URL,
    total: activeInstances.size,
    active: activeInstances.size,
    instances: [...activeInstances.values()],
    lastInitAt,
    lastInitError,
  };
}

/* -------------------------------- messaging --------------------------------- */

/**
 * Typing indicator. Evolution exposes Baileys' sendPresenceUpdate as
 * POST /chat/sendPresence/{instance} with { number, presence }.
 * Non-fatal: a failed presence update must never stop the reply.
 */
export async function sendPresence(instance, number, presence = 'composing') {
  if (!evolutionConfigured()) return false;
  const target = String(number || '').trim();
  if (!target) return false;

  try {
    await axios.post(
      `${EVOLUTION_API_URL}/chat/sendPresence/${instancePath(instance)}`,
      { number: target, presence: String(presence || 'composing') },
      { headers: headers(), timeout: 10000 },
    );
    return true;
  } catch (err) {
    console.warn(
      `[whatsapp] sendPresence ${presence} to ${target} failed (${
        err.response ? err.response.status : err.message
      })`,
    );
    return false;
  }
}

/**
 * sendWhatsAppMessage(instance, number, text, { quoted, delay })
 * `quoted` is the incoming message ({ key, message }) so WhatsApp shows a reply.
 */
export async function sendWhatsAppMessage(instance, number, text, options = {}) {
  if (!evolutionConfigured()) throw new Error('Evolution API is not configured');
  const target = String(number || '').trim();
  if (!target) throw new Error('number is required');

  const body = { number: target, text: String(text || '') };
  if (options.quoted && options.quoted.key) {
    body.quoted = options.quoted.message
      ? options.quoted
      : { key: options.quoted.key };
  }
  if (Number.isFinite(options.delay) && options.delay > 0) {
    body.delay = Math.round(options.delay);
    body.presence = options.presence || 'composing';
  }

  console.log(`[whatsapp] sending ${String(text || '').length} chars to ${target} via ${instance || 'any'}`);
  const response = await axios.post(
    `${EVOLUTION_API_URL}/message/sendText/${instancePath(instance)}`,
    body,
    { headers: headers(), timeout: 30000 },
  );
  return response.data;
}

const MESSAGE_TYPES = [
  'conversation',
  'extendedTextMessage',
  'audioMessage',
  'imageMessage',
  'videoMessage',
  'documentMessage',
  'stickerMessage',
  'reactionMessage',
  'locationMessage',
  'contactMessage',
];

function detectMessageType(message) {
  if (!message || typeof message !== 'object') return 'unknown';
  for (const type of MESSAGE_TYPES) {
    if (message[type] !== undefined) return type;
  }
  const keys = Object.keys(message).filter((name) => name !== 'messageContextInfo');
  return keys[0] || 'unknown';
}

function audioExtension(mimetype) {
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  const map = {
    'audio/ogg': '.ogg',
    'audio/opus': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/wav': '.wav',
    'audio/webm': '.webm',
  };
  return map[mime] || '.ogg';
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

function decodeBase64(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const buffer = Buffer.from(base64, 'base64');
  return buffer.length ? buffer : null;
}

/**
 * Audio bytes for a voice note.
 *
 * Evolution's /chat/getBase64FromMediaMessage expects
 * { message: { key, message }, convertToMp4: false } - a WebMessageInfo, or at
 * least one carrying `key` (older payloads posted only `message` and got a 400,
 * which is why voice notes never transcribed). If the webhook was configured
 * with webhookBase64 the bytes are already inline and no request is needed.
 */
async function downloadEvolutionAudio(instance, data) {
  const message = (data && data.message) || {};
  const inline =
    decodeBase64(data && data.base64) ||
    decodeBase64(message.base64) ||
    decodeBase64(message.audioMessage && message.audioMessage.base64);
  if (inline) return inline;

  if (!evolutionConfigured()) return null;
  const key = data && data.key;
  if (!key || !key.id) {
    console.warn('[whatsapp] audio message has no key.id - cannot download media');
    return null;
  }

  const mediaMessage = { key };
  if (Object.keys(message).length) mediaMessage.message = message;

  const response = await axios.post(
    `${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${instancePath(instance)}`,
    { message: mediaMessage, convertToMp4: false },
    { headers: headers(), timeout: 60000 },
  );
  const payload = response.data || {};
  const raw =
    payload.base64 ||
    (payload.data && payload.data.base64) ||
    payload.media ||
    (payload.data && payload.data.media);
  const buffer = decodeBase64(raw);
  if (!buffer) {
    console.warn(
      `[whatsapp] media response had no base64 (keys: ${Object.keys(payload).join(',') || 'none'})`,
    );
  }
  return buffer;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Default handler: typing indicator, Groq reply, then a quoted reply. */
export async function defaultMessageHandler({ instance, phone, text, quoted }) {
  await sendPresence(instance, phone, 'composing');
  const startedAt = Date.now();
  try {
    const reply = await askAgent(phone, text, 'whatsapp');
    const elapsed = Date.now() - startedAt;
    if (elapsed < 2500) await delay(2500 - elapsed);
    await sendPresence(instance, phone, 'paused');
    await sendWhatsAppMessage(instance, phone, reply, { quoted });
    console.log(`[whatsapp] replied to ${phone} via ${instance || 'any'}: ${reply.slice(0, 120)}`);
    return reply;
  } catch (err) {
    await sendPresence(instance, phone, 'paused');
    throw err;
  }
}

/**
 * Entry point for POST /webhook/evolution. Logs the incoming message, then hands
 * it to handleMessage (Groq + Evolution reply) with full error logging.
 */
export async function handleEvolutionPayload(payload, instanceFallback, handleMessage) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'empty payload' };

  const handler =
    typeof handleMessage === 'function'
      ? handleMessage
      : storedHandler || defaultMessageHandler;

  const eventName = String(payload.event || payload.type || '').toLowerCase();
  if (eventName && !eventName.includes('messages.upsert')) {
    console.log(`[whatsapp] ignored event ${eventName}`);
    return { ok: true, ignored: eventName };
  }

  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const instance =
    payload.instance ||
    payload.instanceName ||
    (data.instance && data.instance.instanceName) ||
    instanceFallback ||
    EVOLUTION_INSTANCE ||
    'any';

  const key = data.key || {};
  if (key.fromMe) return { ok: true, ignored: 'fromMe' };

  const remoteJid = String(key.remoteJid || data.remoteJid || '');
  if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid.includes('status@broadcast')) {
    return { ok: true, ignored: 'group/status' };
  }

  const phone = normalizePhone(remoteJid.split('@')[0]);
  if (!phone) return { ok: true, ignored: 'no phone' };

  const pushName = data.pushName || (data.key && data.key.participant) || 'unknown';

  try {
    const rawMessage = data.message || {};
    const message = unwrapMessage(rawMessage);
    const messageType = detectMessageType(message);
    const isVoice = Boolean(message.audioMessage);
    console.log(`[whatsapp] incoming type: ${messageType} from ${remoteJid}`);

    let text = extractText(message);
    let source = 'text';

    if (!text && isVoice) {
      try {
        const buffer = await downloadEvolutionAudio(instance, data);
        if (buffer) {
          const fileName = `whatsapp-voice${audioExtension(message.audioMessage.mimetype)}`;
          text = await transcribeAudio(buffer, fileName);
          if (text) {
            source = 'voice';
            console.log(`[whatsapp] voice transcribed: ${text}`);
          }
        } else {
          console.warn(`[whatsapp] voice note from ${phone}: media download returned no audio`);
        }
      } catch (err) {
        logError(`[whatsapp] voice transcription failed for ${phone}`, err);
      }
    }

    if (!text) {
      if (isVoice) {
        // Never leave a voice note unanswered, even when Whisper/Evolution fails.
        const fallback = "Sorry, I couldn't make out that voice note. Please resend it or type your message.";
        await sendWhatsAppMessage(instance, phone, fallback, {
          quoted: { key: data.key, message: rawMessage },
        }).catch((err) => logError('[whatsapp] voice fallback reply failed', err));
        console.log(`[whatsapp] replied to ${phone} with voice fallback (no transcription)`);
        return { ok: true, voiceNotTranscribed: true };
      }
      console.log(`[whatsapp] message from ${pushName} (${phone}) has no text/audio - ignored`);
      return { ok: true, ignored: 'no text' };
    }

    console.log(`NEW WHATSAPP MESSAGE from ${pushName}: ${text}`);

    const existing = getUserByWaJid(remoteJid) || getUserByPhone(phone);
    const user = saveUser({
      phone: existing && existing.phone ? existing.phone : phone,
      waJid: remoteJid,
      name: pushName !== 'unknown' ? pushName : undefined,
    });

    const ctx = {
      instance,
      phone: user.phone || phone,
      remoteJid,
      pushName,
      text,
      source,
      messageType,
      isVoice,
      // Quoted reply target: key + message = the incoming WhatsApp message.
      quoted: { key: data.key, message: rawMessage },
    };

    await handler(ctx);
    return { ok: true };
  } catch (err) {
    logError(`[whatsapp] handling message from ${pushName} (${phone}) failed`, err);
    return { ok: false, error: err.message || 'handler failed' };
  }
}
