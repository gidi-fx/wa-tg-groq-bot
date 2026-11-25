import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { computeCheck } from 'telegram/Password.js';

import { askAgent, transcribeAudio } from './agents.js';
import { normalizePhone, saveUser } from './userStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = path.join(__dirname, 'telegram_sessions.json');

const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.TELEGRAM_API_HASH || '';

/** phone -> connected + authorized TelegramClient */
const clients = new Map();
/** phone -> TelegramClient created by sendCode, waiting for the login code */
const pendingClients = new Map();
/** phone -> { phoneCodeHash, createdAt } */
const pendingCodes = new Map();
/** phones that already have a NewMessage handler bound */
const listening = new Set();

/* ---------------------------------- storage --------------------------------- */

function readSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return { sessions: {} };
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed.sessions || typeof parsed.sessions !== 'object') parsed.sessions = {};
    return parsed;
  } catch (err) {
    console.error('[telegram] could not read telegram_sessions.json:', err.message);
    return { sessions: {} };
  }
}

function writeSessions(db) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
}

function getSession(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return '';
  return readSessions().sessions[normalized] || '';
}

function saveSession(phone, sessionString) {
  const normalized = normalizePhone(phone);
  if (!normalized || !sessionString) return;
  const db = readSessions();
  db.sessions[normalized] = sessionString;
  writeSessions(db);
}

function deleteSession(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  const db = readSessions();
  if (!(normalized in db.sessions)) return;
  delete db.sessions[normalized];
  writeSessions(db);
}

/* ----------------------------------- client --------------------------------- */

function assertConfigured() {
  if (!API_ID || !API_HASH) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH are not set');
  }
}

function createClient(sessionString = '') {
  return new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, {
    connectionRetries: 5,
    autoReconnect: true,
  });
}

function normalizeChatId(chatId) {
  if (typeof chatId === 'number' || typeof chatId === 'bigint') return chatId;
  const raw = String(chatId === undefined || chatId === null ? '' : chatId).trim();
  if (/^-?\d+$/.test(raw)) {
    const num = Number(raw);
    if (Number.isSafeInteger(num)) return num;
  }
  return raw;
}

function isVoiceMessage(message) {
  const document = message && message.document;
  if (!document || !Array.isArray(document.attributes)) return false;
  return document.attributes.some(
    (attribute) => attribute.className === 'DocumentAttributeAudio' && attribute.voice === true,
  );
}

/* -------------------------------- message flow ------------------------------ */

async function handleIncoming(ownerPhone, client, event) {
  const message = event && event.message;
  if (!message || message.out) return;

  const senderId = message.senderId ? String(message.senderId) : '';
  let senderPhone = '';
  let senderName = '';

  if (message.senderId) {
    try {
      const entity = await client.getEntity(message.senderId);
      if (entity) {
        if (entity.phone) senderPhone = normalizePhone(entity.phone);
        senderName = [entity.firstName, entity.lastName, entity.title].filter(Boolean).join(' ').trim();
      }
    } catch (err) {
      console.error('[telegram] could not resolve sender entity:', err.message);
    }
  }

  let text = String(message.message || '').trim();
  let source = 'text';

  if (!text && isVoiceMessage(message)) {
    const buffer = await client.downloadMedia(message, {});
    if (Buffer.isBuffer(buffer) && buffer.length) {
      text = await transcribeAudio(buffer, 'telegram-voice.ogg');
      source = 'voice';
    }
  }

  if (!text) return;

  // The logged-in account's phone is the identity, so it matches the same phone on WhatsApp.
  saveUser({ phone: ownerPhone, telegramPhone: ownerPhone });

  console.log(
    `[telegram] ${ownerPhone} (${source}) from ${senderName || senderPhone || senderId || 'unknown'}: ${text}`,
  );

  const reply = await askAgent(ownerPhone, text, 'telegram');
  const chatId = message.chatId || message.senderId;

  try {
    await sendTelegramMessage(ownerPhone, chatId, reply);
  } catch (err) {
    console.error('[telegram] sendMessage failed, falling back to reply():', err.message);
    if (typeof message.reply === 'function') {
      await message.reply({ message: reply, linkPreview: false });
    } else {
      throw err;
    }
  }
}

function startListening(phone, client) {
  if (listening.has(phone)) return;
  client.addEventHandler((event) => {
    handleIncoming(phone, client, event).catch((err) => {
      console.error(`[telegram] ${phone} message handler error:`, err.message);
    });
  }, new NewMessage({ incoming: true }));
  listening.add(phone);
  console.log(`[telegram] listening for ${phone}`);
}

/* ----------------------------------- login ---------------------------------- */

async function dropPending(phone) {
  const client = pendingClients.get(phone);
  pendingClients.delete(phone);
  pendingCodes.delete(phone);
  if (client) {
    try {
      await client.disconnect();
    } catch (err) {
      console.error('[telegram] pending disconnect failed:', err.message);
    }
  }
}

export async function sendCode(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new Error('phone is required, e.g. { "phone": "2348021234567" }');
  }
  assertConfigured();

  await dropPending(normalized);

  const client = createClient('');
  await client.connect();

  try {
    const sent = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, normalized);
    if (!sent || !sent.phoneCodeHash) throw new Error('Telegram did not return a phoneCodeHash');

    pendingClients.set(normalized, client);
    pendingCodes.set(normalized, { phoneCodeHash: sent.phoneCodeHash, createdAt: Date.now() });

    return {
      success: true,
      phone: normalized,
      phoneCodeHash: sent.phoneCodeHash,
      isCodeViaApp: Boolean(sent.isCodeViaApp),
      message: 'Code sent to Telegram',
    };
  } catch (err) {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export async function verifyCode({ phone, code, phoneCodeHash, password } = {}) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('phone is required');
  if (!code) throw new Error('code is required');
  assertConfigured();

  const client = pendingClients.get(normalized);
  const pending = pendingCodes.get(normalized);
  const hash = phoneCodeHash || (pending && pending.phoneCodeHash);
  if (!client || !hash) {
    throw new Error('No pending login for this phone. Call POST /telegram/send-code first');
  }

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: normalized,
        phoneCodeHash: hash,
        phoneCode: String(code),
      }),
    );
  } catch (err) {
    const errorMessage = err && err.errorMessage ? err.errorMessage : String((err && err.message) || err);
    if (errorMessage !== 'SESSION_PASSWORD_NEEDED') throw err;

    if (!password) {
      return {
        success: false,
        needsPassword: true,
        phone: normalized,
        message: 'Two-factor password required. Repeat with { phone, code, phoneCodeHash, password }.',
      };
    }

    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(passwordInfo, String(password));
    await client.invoke(new Api.auth.CheckPassword({ password: check }));
  }

  const sessionString = client.session.save();
  saveSession(normalized, sessionString);

  clients.set(normalized, client);
  pendingClients.delete(normalized);
  pendingCodes.delete(normalized);
  startListening(normalized, client);

  let account = null;
  try {
    const me = await client.getMe();
    if (me) {
      account = {
        id: String(me.id),
        username: me.username || null,
        name: [me.firstName, me.lastName].filter(Boolean).join(' ') || null,
      };
    }
  } catch (err) {
    console.error('[telegram] getMe failed after login:', err.message);
  }

  saveUser({
    phone: normalized,
    telegramPhone: normalized,
    name: account && account.name ? account.name : undefined,
  });

  console.log(`[telegram] login OK for ${normalized} (session saved)`);

  return {
    success: true,
    sessionSaved: true,
    phone: normalized,
    message: 'Login successful. Session saved on the server.',
    account,
  };
}

/* ----------------------------------- usage ---------------------------------- */

export async function getClient(phone) {
  assertConfigured();
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('phone is required');

  const existing = clients.get(normalized);
  if (existing && existing.connected) return existing;

  const sessionString = getSession(normalized);
  if (!sessionString) {
    throw new Error(`No Telegram session for ${normalized}. Login via POST /telegram/send-code`);
  }

  const client = createClient(sessionString);
  await client.connect();

  const authorized = await client.isUserAuthorized().catch(() => false);
  if (!authorized) {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    deleteSession(normalized);
    throw new Error(`Telegram session for ${normalized} is invalid or revoked. Login again.`);
  }

  clients.set(normalized, client);
  startListening(normalized, client);
  return client;
}

export async function sendTelegramMessage(phone, chatId, text) {
  const client = await getClient(phone);
  return client.sendMessage(normalizeChatId(chatId), {
    message: String(text || ''),
    linkPreview: false,
  });
}

export function listSessions() {
  const db = readSessions();
  const phones = new Set([...Object.keys(db.sessions), ...clients.keys()]);
  return [...phones].map((phone) => {
    const client = clients.get(phone);
    return {
      phone,
      sessionSaved: Boolean(db.sessions[phone]),
      connected: Boolean(client && client.connected),
      listening: listening.has(phone),
    };
  });
}

export async function logout(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('phone is required');

  const client = clients.get(normalized);
  if (client) {
    try {
      await client.invoke(new Api.auth.LogOut());
    } catch (err) {
      console.error(`[telegram] logOut failed for ${normalized}:`, err.message);
    }
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    clients.delete(normalized);
    listening.delete(normalized);
  }

  await dropPending(normalized);
  deleteSession(normalized);

  return { success: true, phone: normalized, loggedOut: true };
}

export function getTelegramStatus() {
  return {
    configured: Boolean(API_ID && API_HASH),
    sessions: listSessions(),
    pendingLogins: [...pendingCodes.keys()],
    activeClients: clients.size,
  };
}

/** Reconnect every saved session on boot so handlers resume after a restart. */
export async function initSessions() {
  if (!API_ID || !API_HASH) {
    console.warn('[telegram] TELEGRAM_API_ID / TELEGRAM_API_HASH missing - Telegram disabled');
    return;
  }

  const phones = Object.keys(readSessions().sessions);
  if (!phones.length) {
    console.log('[telegram] no saved sessions yet. Users log in via POST /telegram/send-code');
    return;
  }

  for (const phone of phones) {
    try {
      await getClient(phone);
      console.log(`[telegram] restored session for ${phone}`);
    } catch (err) {
      console.error(`[telegram] could not restore ${phone}:`, err.message);
    }
  }
}
