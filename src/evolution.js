import axios from 'axios';

import { AppError, errorMessage } from './errors.js';

const EVOLUTION_API_URL = String(process.env.EVOLUTION_API_URL || '').trim().replace(/\/+$/, '');
const EVOLUTION_API_KEY = String(process.env.EVOLUTION_API_KEY || '').trim();
const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];

export function evolutionConfigured() {
  return Boolean(EVOLUTION_API_URL && EVOLUTION_API_KEY);
}

function requireEvolution() {
  if (!evolutionConfigured()) {
    throw new AppError(
      'Evolution API is not configured. Set EVOLUTION_API_URL and EVOLUTION_API_KEY.',
      503,
      'evolution_not_configured',
    );
  }
}

function instancePath(instance) {
  return encodeURIComponent(String(instance || '').trim());
}

/** Evolution instance name for a phone number: wa-<digits>. The user never types this. */
export function instanceNameForNumber(number) {
  const digitsOnly = String(number || '').replace(/\D/g, '');
  if (digitsOnly.length < 8) {
    throw new AppError('A WhatsApp number with country code is required', 400, 'invalid_number');
  }
  return `wa-${digitsOnly}`;
}

/** Phone number encoded in an instance name, or null for custom names. */
export function instanceNumber(instance) {
  const match = /^wa-(\d+)$/.exec(String(instance || '').trim());
  return match ? match[1] : null;
}

function headers() {
  return { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' };
}

async function call(method, path, data, timeout = 30000) {
  requireEvolution();
  try {
    const response = await axios.request({
      method,
      url: `${EVOLUTION_API_URL}${path}`,
      data,
      headers: headers(),
      timeout,
    });
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? errorMessage({ response: err.response }) : err.message;
    throw new AppError(
      `Evolution ${method} ${path.split('?')[0]} failed${status ? ` (${status})` : ''}: ${String(detail).slice(0, 300)}`,
      502,
      'evolution_error',
      { status },
    );
  }
}

function normalizeInstance(item) {
  const inner = item && typeof item.instance === 'object' ? item.instance : {};
  return {
    name: item?.name || item?.instanceName || inner.instanceName || inner.name || 'unknown',
    status: item?.connectionStatus || item?.status || item?.state || inner.status || inner.state || 'unknown',
    profileName: item?.profileName || inner.profileName || null,
    number: item?.owner || item?.ownerJid || item?.number || inner.owner || inner.ownerJid || null,
  };
}

export async function fetchInstances() {
  const data = await call('GET', '/instance/fetchInstances');
  const list = Array.isArray(data) ? data : Array.isArray(data?.instances) ? data.instances : [];
  return list.map(normalizeInstance).filter((item) => item.name !== 'unknown');
}

export async function createInstance(instanceName, webhookUrl) {
  const name = String(instanceName || '').trim();
  if (!name) throw new AppError('Instance name is required', 400, 'invalid_instance');

  const data = await call(
    'POST',
    '/instance/create',
    { instanceName: name, qrcode: true, integration: 'WHATSAPP-BAILEYS' },
    45000,
  );

  let webhook = { ok: false, url: webhookUrl || null, error: null };
  if (webhookUrl) {
    try {
      await setWebhook(name, webhookUrl);
      webhook = { ok: true, url: webhookUrl, error: null };
    } catch (err) {
      webhook = { ok: false, url: webhookUrl, error: err.message };
    }
  }
  return { instance: name, evolution: data, webhook };
}

/** Evolution v2 nests webhook config under "webhook"; v1 builds use a flat body. */
export async function setWebhook(instance, url) {
  const body = {
    webhook: {
      enabled: true,
      url,
      webhookByEvents: false,
      webhookBase64: false,
      events: WEBHOOK_EVENTS,
    },
  };
  try {
    return await call('POST', `/webhook/set/${instancePath(instance)}`, body, 20000);
  } catch (firstErr) {
    const legacy = {
      url,
      webhook_by_events: false,
      webhook_base64: false,
      events: WEBHOOK_EVENTS,
    };
    try {
      return await call('POST', `/webhook/set/${instancePath(instance)}`, legacy, 20000);
    } catch {
      throw firstErr;
    }
  }
}

/** Create the instance when it does not exist yet, then reuse it. */
export async function ensureInstance(instanceName, webhookUrl) {
  const name = String(instanceName || '').trim();
  if (!name) throw new AppError('Instance name is required', 400, 'invalid_instance');
  const existing = await fetchInstances().catch(() => []);
  if (existing.some((item) => item.name === name)) return { instance: name, created: false };
  const created = await createInstance(name, webhookUrl);
  return { instance: name, created: true, webhook: created.webhook };
}

export async function connectInstance(instance, number) {
  const digitsOnly = number ? String(number).replace(/\D/g, '') : '';
  const query = digitsOnly ? `?number=${encodeURIComponent(digitsOnly)}` : '';
  console.log(`[evolution] GET /instance/connect/${instance}${query}`);
  const data = await call('GET', `/instance/connect/${instancePath(instance)}${query}`, undefined, 30000);
  console.log('[evolution] connect response:', JSON.stringify(data)?.slice(0, 4000));

  const qr = data?.qrcode && typeof data.qrcode === 'object' ? data.qrcode : {};
  const inner = data?.data && typeof data.data === 'object' ? data.data : {};
  const rawCode = data?.pairingCode
    || inner.pairingCode
    || data?.code
    || inner.code
    || qr.pairingCode
    || qr.code
    || data?.instance?.pairingCode
    || null;
  const rawBase64 = data?.base64
    || inner.base64
    || qr.base64
    || inner.qrcode?.base64
    || data?.instance?.qrcode?.base64
    || null;
  const codeDigits = rawCode ? String(rawCode).replace(/\D/g, '') : '';

  return {
    instance,
    number: digitsOnly || instanceNumber(instance),
    state: data?.state || inner.state || data?.instance?.state || null,
    base64: rawBase64,
    pairingCode: codeDigits.length === 8 ? codeDigits : null,
    count: qr.count ?? data?.count ?? inner.count ?? null,
  };
}

export async function getInstanceStatus(instance) {
  try {
    const data = await call('GET', `/instance/connectionState/${instancePath(instance)}`, undefined, 15000);
    const state = data?.instance?.state || data?.state || 'unknown';
    return { instance, state, connected: /open|connected/i.test(String(state)) };
  } catch (err) {
    const list = await fetchInstances().catch(() => []);
    const match = list.find((item) => item.name === instance);
    if (match) {
      return { instance, state: match.status, connected: /open|connected/i.test(String(match.status)) };
    }
    throw err;
  }
}

export async function sendText(instance, number, text, { quoted } = {}) {
  const body = { number: String(number), text: String(text || '') };
  if (quoted?.key) {
    body.quoted = quoted.message ? quoted : { key: quoted.key };
  }
  return call('POST', `/message/sendText/${instancePath(instance)}`, body, 30000);
}

export async function sendPresence(instance, number, presence = 'composing') {
  try {
    return await call(
      'POST',
      `/chat/sendPresence/${instancePath(instance)}`,
      { number: String(number), presence },
      10000,
    );
  } catch (err) {
    console.warn(`[evolution] presence ${presence} failed for ${number}: ${err.message}`);
    return null;
  }
}

export async function sendAudio(instance, number, audio, { mimetype, quoted } = {}) {
  const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || '');
  if (!buffer.length) throw new AppError('Audio buffer is empty', 400, 'empty_audio');
  const body = {
    number: String(number),
    audio: buffer.toString('base64'),
    encoding: true,
    mimetype: mimetype || 'audio/ogg; codecs=opus',
  };
  if (quoted?.key) body.quoted = quoted.message ? quoted : { key: quoted.key };
  return call('POST', `/message/sendWhatsAppAudio/${instancePath(instance)}`, body, 60000);
}

export async function sendMedia(instance, number, { media, mediatype, mimetype, fileName, caption, quoted }) {
  const buffer = Buffer.isBuffer(media) ? media : Buffer.from(media || '');
  if (!buffer.length) throw new AppError('Media buffer is empty', 400, 'empty_media');

  const body = {
    number: String(number),
    mediatype: mediatype || 'document',
    mimetype: mimetype || 'application/octet-stream',
    media: buffer.toString('base64'),
    fileName: fileName || 'file',
    caption: String(caption || '').slice(0, 1024),
  };
  if (quoted?.key) body.quoted = quoted.message ? quoted : { key: quoted.key };
  return call('POST', `/message/sendMedia/${instancePath(instance)}`, body, 60000);
}

export async function fetchGroups(instance) {
  const data = await call(
    'GET',
    `/group/fetchAllGroups/${instancePath(instance)}?getParticipants=true`,
    undefined,
    45000,
  );
  const candidates = [data, data?.data, data?.groups, data?.data?.groups, data?.result];
  const list = candidates.find((item) => Array.isArray(item)) || [];
  return list
    .map((group) => ({
      jid: group.id || group.jid || group.remoteJid,
      name: group.subject || group.name || group.id || 'Unnamed group',
      participants: (group.participants || [])
        .map((member) => member?.id || member?.jid || member?.phoneNumber || member)
        .filter(Boolean),
    }))
    .filter((group) => group.jid);
}

/** Evolution v2 exposes chats as POST; some builds accept GET. */
export async function findChats(instance) {
  try {
    return await call('POST', `/chat/findChats/${instancePath(instance)}`, {}, 45000);
  } catch (err) {
    return call('GET', `/chat/findChats/${instancePath(instance)}`, undefined, 45000);
  }
}

export async function getMediaBase64(instance, key, message) {
  if (!key?.id) return null;
  const mediaMessage = { key };
  if (message && Object.keys(message).length) mediaMessage.message = message;
  const data = await call(
    'POST',
    `/chat/getBase64FromMediaMessage/${instancePath(instance)}`,
    { message: mediaMessage, convertToMp4: false },
    60000,
  );
  const raw = data?.base64 || data?.data?.base64 || data?.media || data?.data?.media;
  if (!raw || typeof raw !== 'string') return null;
  const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const buffer = Buffer.from(base64, 'base64');
  return buffer.length ? buffer : null;
}
