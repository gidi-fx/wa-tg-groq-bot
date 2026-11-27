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

/** JSON for logs with credentials redacted. The apikey is never printed. */
function safeLog(value) {
  try {
    const cleaned = JSON.stringify(value, (key, inner) =>
      /apikey|api_key|authorization|token/i.test(key) ? '***' : inner,
    );
    return String(cleaned ?? value).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
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

export async function createInstance(instanceName, webhookUrl, { number } = {}) {
  const name = String(instanceName || '').trim();
  if (!name) throw new AppError('Instance name is required', 400, 'invalid_instance');

  const digitsOnly = number ? String(number).replace(/\D/g, '') : (instanceNumber(name) || '');
  // An instance must never be created without its number: with `number` Evolution
  // returns a pairing code, without it the instance is useless for pairing.
  if (digitsOnly.length < 8) {
    throw new AppError('A WhatsApp number with country code is required', 400, 'invalid_number');
  }
  const body = { instanceName: name, qrcode: true, integration: 'WHATSAPP-BAILEYS', number: digitsOnly };

  const data = await call('POST', '/instance/create', body, 45000);

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
export async function ensureInstance(instanceName, webhookUrl, { number } = {}) {
  const name = String(instanceName || '').trim();
  if (!name) throw new AppError('Instance name is required', 400, 'invalid_instance');
  const existing = await fetchInstances().catch(() => []);
  if (existing.some((item) => item.name === name)) return { instance: name, created: false };
  const created = await createInstance(name, webhookUrl, { number });
  return { instance: name, created: true, webhook: created.webhook };
}

/**
 * Ask Evolution for a connect payload (pairing code and/or QR).
 *
 * Evolution v2.3.8 only exposes GET /instance/connect/:instance?number=<digits>.
 * The POST variant 404s on every call, and only the GET response carries
 * `pairingCode`. `code` in that response is the raw QR string, never the
 * pairing code, so it is deliberately ignored here.
 *
 * The pairing code may contain letters (e.g. "6DAQQ8N2"), so it is returned
 * exactly as Evolution sent it - never digit-filtered.
 *
 * Call this ONCE per pairing attempt: a second call invalidates the first code.
 */
export async function connectInstance(instance, number) {
  const digitsOnly = number ? String(number).replace(/\D/g, '') : '';
  const query = digitsOnly ? `?number=${encodeURIComponent(digitsOnly)}` : '';
  const path = `/instance/connect/${instancePath(instance)}${query}`;

  console.log(`[evolution] GET ${path}`);
  const data = await call('GET', path, undefined, 45000);

  // Raw response for debugging. safeLog redacts any credential-looking field.
  console.log('[evolution] connect raw response:', safeLog(data));

  const pairingCode = extractPairingCode(data);
  const qrBase64 = extractQrBase64(data);

  return {
    instance,
    number: digitsOnly || instanceNumber(instance),
    state: data?.state || data?.instance?.state || null,
    pairingCode: pairingCode || null, // exactly as returned, letters allowed
    qr: pairingCode ? null : qrBase64, // QR fallback only when no pairing code
    base64: qrBase64, // kept for the QR panel
    count: data?.count ?? null,
    raw: data, // debugging only, always logged through safeLog()
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Evolution returns the pairing code at the top level or nested under qrcode. */
export function extractPairingCode(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return firstString(
    payload.pairingCode,
    payload.qrcode?.pairingCode,
    payload.data?.pairingCode,
    payload.data?.qrcode?.pairingCode,
    payload.instance?.pairingCode,
    payload.instance?.qrcode?.pairingCode,
  );
}

/** QR image data, at the top level or nested under qrcode/data. */
export function extractQrBase64(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return firstString(
    payload.base64,
    payload.qrcode?.base64,
    payload.data?.base64,
    payload.data?.qrcode?.base64,
    payload.instance?.qrcode?.base64,
  );
}

function pairResult(instance, number, state, extra = {}) {
  const pairingCode = extra.pairingCode || null;
  const base64 = extra.base64 || null;
  return {
    instance,
    number,
    state: state || 'unknown',
    connected: /open|connected/i.test(String(state || '')),
    pairingCode,
    base64,
    qr: pairingCode ? null : base64,
    steps: extra.steps || [],
  };
}

/**
 * Pairing ladder used by "Get pairing code".
 *
 *  1. an instance that is already open is returned as-is;
 *  2. a connecting instance gets exactly one connect call, which is the only
 *     place Evolution exposes a pairing code;
 *  3. a closed / missing instance (or a connect call without a code) is reset:
 *     DELETE /instance/delete/:instance, 3s wait, POST /instance/create with the
 *     number. The code is read from create (top level or qrcode.pairingCode);
 *  4. if create returned no code, wait 2s and call GET /instance/connect once;
 *  5. still no code: the raw response is logged (credentials redacted) and the QR
 *     is returned as a fallback.
 *
 * The apikey is never logged: every payload goes through safeLog().
 */
export async function pairInstance(instance, number, webhookUrl) {
  const name = String(instance || '').trim();
  if (!name) throw new AppError('Instance name is required', 400, 'invalid_instance');
  const digitsOnly = number ? String(number).replace(/\D/g, '') : (instanceNumber(name) || '');
  const steps = [];
  let lastPayload = null;
  let state = 'unknown';

  try {
    const status = await getInstanceStatus(name);
    state = String(status.state || 'unknown');
    steps.push('status=' + state);
  } catch (err) {
    steps.push('status failed: ' + err.message);
  }

  if (/open|connected/i.test(state)) {
    return pairResult(name, digitsOnly, 'open', { steps });
  }

  // Only reuse a live instance. close / not_found always go through the reset below.
  const reusable = Boolean(state) && !/close|not_found|unknown|^$/i.test(state);
  if (reusable) {
    try {
      const connected = await connectInstance(name, digitsOnly);
      lastPayload = connected.raw || lastPayload;
      if (connected.state) state = String(connected.state);
      if (connected.pairingCode) {
        steps.push('connect');
        return pairResult(name, digitsOnly, state, {
          pairingCode: connected.pairingCode,
          base64: connected.base64,
          steps,
        });
      }
      steps.push('connect without code');
    } catch (err) {
      steps.push('connect failed: ' + err.message);
    }
  }

  // Reset: delete, wait, create with the number.
  try {
    await deleteInstance(name);
    steps.push('deleted');
  } catch (err) {
    // A 404 just means the instance was already gone; that is not fatal here.
    steps.push('delete skipped: ' + err.message);
  }

  await sleep(3000);

  let createdPayload = null;
  try {
    const created = await createInstance(name, webhookUrl, { number: digitsOnly });
    createdPayload = created.evolution || null;
    lastPayload = createdPayload || lastPayload;
    steps.push('created');
  } catch (err) {
    steps.push('create failed: ' + err.message);
  }

  let pairingCode = extractPairingCode(createdPayload);
  let base64 = extractQrBase64(createdPayload);

  if (!pairingCode) {
    await sleep(2000);
    try {
      const connected = await connectInstance(name, digitsOnly);
      lastPayload = connected.raw || lastPayload;
      if (connected.state) state = String(connected.state);
      pairingCode = connected.pairingCode || null;
      base64 = base64 || connected.base64 || null;
      steps.push('connect retry');
    } catch (err) {
      steps.push('connect retry failed: ' + err.message);
    }
  }

  if (!pairingCode) {
    // Raw response for debugging. safeLog() strips the apikey and any token.
    console.log('[evolution] pair returned no pairing code, raw response:', safeLog(lastPayload));
  }

  return pairResult(name, digitsOnly, state, { pairingCode, base64, steps });
}

export async function getInstanceStatus(instance) {
  try {
    const data = await call('GET', `/instance/connectionState/${instancePath(instance)}`, undefined, 15000);
    const state = data?.instance?.state || data?.state || 'unknown';
    return { instance, state, connected: /open|connected/i.test(String(state)) };
  } catch (err) {
    // A 404 means the instance does not exist yet. That is a normal state while
    // the user is still linking, not an error, so it is not logged as one.
    if (err?.details?.status === 404 || err?.status === 404) {
      return { instance, state: 'not_found', connected: false, exists: false };
    }
    const list = await fetchInstances().catch(() => []);
    const match = list.find((item) => item.name === instance);
    if (match) {
      return { instance, state: match.status, connected: /open|connected/i.test(String(match.status)) };
    }
    if (/404/.test(String(err?.message || ''))) {
      return { instance, state: 'not_found', connected: false, exists: false };
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

/** Mark received messages as read (blue ticks) for a chat. */
export async function markAsRead(instance, number, key) {
  if (!key?.id) return null;
  try {
    return await call(
      'POST',
      `/chat/markMessageAsRead/${instancePath(instance)}`,
      { readMessages: [{ remoteJid: String(number), fromMe: false, id: String(key.id) }] },
      10000,
    );
  } catch (err) {
    console.warn(`[evolution] markAsRead failed for ${number}: ${err.message}`);
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

/** Delete an Evolution instance (removes it from Evolution). */
export async function deleteInstance(instance) {
  const name = String(instance || '').trim();
  if (!name) throw new AppError('Instance name is required', 400, 'invalid_instance');
  await call('DELETE', `/instance/delete/${instancePath(name)}`, undefined, 30000);
}

/** Reconnect an Evolution instance (re-establishes the connection). */
export async function reconnectInstance(instance) {
  const name = String(instance || '').trim();
  if (!name) throw new AppError('Instance name is required', 400, 'invalid_instance');
  await call('POST', `/instance/reconnect/${instancePath(name)}`, undefined, 60000);
}
