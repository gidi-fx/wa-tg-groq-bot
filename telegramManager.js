import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { computeCheck } from 'telegram/Password.js';

import { askAgent, transcribeAudio } from './agents.js';
import { normalizePhone, saveUser } from './userStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = path.join(__dirname, 'telegram_sessions.json');

/* ----------------------------------- config --------------------------------- */

// gramjs requires a number: parseInt, never the raw string.
const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_ID = Number.isFinite(apiId) ? apiId : 0;
const apiHash = String(process.env.TELEGRAM_API_HASH || '').trim();
const API_HASH = apiHash;

console.log(
  `[telegram] apiId=${API_ID} (parsed from TELEGRAM_API_ID=${JSON.stringify(
    process.env.TELEGRAM_API_ID === undefined ? null : process.env.TELEGRAM_API_ID,
  )}) apiHash=${API_HASH ? 'set' : 'MISSING'}`,
);

/* ----------------------------------- state ---------------------------------- */

/** phone -> connected + authorized client, handler attached */
const activeClients = new Map();
/** phone -> { client, phoneCodeHash, createdAt } while a login code is pending */
const pendingCodes = new Map();
/** phones that already have a NewMessage handler bound */
const listening = new Set();
/** last message handler passed to initTelegramClients, reused after logins */
let storedMessageHandler = null;

/**
 * phone -> session string. Kept in memory and mirrored to telegram_sessions.json.
 * On boot it is seeded from ENV first, because Render's free tier wipes the
 * filesystem on every redeploy: TELEGRAM_SESSIONS_JSON (base64 or raw JSON) or
 * the legacy single-user TELEGRAM_SESSION.
 */
const sessions = Object.create(null);

let envSessionsLoaded = 0;
let fileSessionsLoaded = 0;

function sessionKey(phone) {
  const raw = String(phone === undefined || phone === null ? '' : phone).trim();
  if (!raw) return '';
  return normalizePhone(raw) || raw;
}

function extractSessions(parsed) {
  if (!parsed || typeof parsed !== 'object') return {};
  if (parsed.sessions && typeof parsed.sessions === 'object') return parsed.sessions;
  return parsed;
}

function parseEnvSessions(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  let json = value;
  if (!value.startsWith('{')) {
    // Render env holds the base64 form written by saveSessions().
    try {
      json = Buffer.from(value, 'base64').toString('utf8').trim();
    } catch (err) {
      console.error('[telegram] could not base64-decode TELEGRAM_SESSIONS_JSON:', err.message);
      return null;
    }
  }
  try {
    return JSON.parse(json);
  } catch (err) {
    console.error('[telegram] could not parse TELEGRAM_SESSIONS_JSON:', err.message);
    return null;
  }
}

/** Load TELEGRAM_SESSIONS_JSON (base64 or JSON) plus the legacy single session. */
function loadSessionsFromEnv() {
  const parsed = parseEnvSessions(process.env.TELEGRAM_SESSIONS_JSON);
  if (parsed) {
    for (const [phone, session] of Object.entries(extractSessions(parsed))) {
      const key = sessionKey(phone);
      if (key && typeof session === 'string' && session) {
        sessions[key] = session;
        envSessionsLoaded += 1;
      }
    }
  }

  const legacy = String(process.env.TELEGRAM_SESSION || '').trim();
  if (legacy && !sessions.default) {
    sessions.default = legacy;
    envSessionsLoaded += 1;
  }
}

/** Fill any gaps from telegram_sessions.json (ENV wins). */
function loadSessionsFromFile() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    for (const [phone, session] of Object.entries(extractSessions(parsed))) {
      const key = sessionKey(phone);
      if (key && typeof session === 'string' && session && !sessions[key]) {
        sessions[key] = session;
        fileSessionsLoaded += 1;
      }
    }
  } catch (err) {
    console.error('[telegram] could not read telegram_sessions.json:', err.message);
  }
}

/** Merge ENV and file sessions, logging where each one came from. */
export function loadSessions() {
  envSessionsLoaded = 0;
  fileSessionsLoaded = 0;
  loadSessionsFromEnv();
  loadSessionsFromFile();

  const total = Object.keys(sessions).length;
  console.log(
    `[telegram] loadSessions: fromEnv=${envSessionsLoaded} fromFile=${fileSessionsLoaded} total=${total}`,
  );
  if (total) {
    console.log(`[telegram] saved sessions for: ${Object.keys(sessions).join(', ')}`);
  }
  return { fromEnv: envSessionsLoaded, fromFile: fileSessionsLoaded, total };
}

/** Full session store as JSON and as the base64 value Render needs. */
export function exportSessions() {
  const json = JSON.stringify(sessions);
  const base64 = Buffer.from(json).toString('base64');
  return {
    json,
    base64,
    env: `TELEGRAM_SESSIONS_JSON=${base64}`,
    count: Object.keys(sessions).length,
  };
}

/**
 * Write telegram_sessions.json and log the complete TELEGRAM_SESSIONS_JSON value
 * so it can be pasted into Render's Environment tab after each login.
 */
export function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions }, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error('[telegram] could not write telegram_sessions.json:', err.message);
  }

  const { base64, count } = exportSessions();
  console.log('=== COPY THIS TO RENDER ENV (TELEGRAM_SESSIONS_JSON) ===');
  console.log(base64);
  console.log(`TELEGRAM_SESSIONS_JSON=${base64}`);
  console.log('=== END TELEGRAM_SESSIONS_JSON ===');
  console.log(`[telegram] saveSessions: wrote telegram_sessions.json (${count} session(s))`);
  return base64;
}

export function getSessionLoadInfo() {
  return {
    fromEnv: envSessionsLoaded,
    fromFile: fileSessionsLoaded,
    total: Object.keys(sessions).length,
  };
}

export function hasSessions() {
  return Object.keys(sessions).length > 0;
}

export function getActiveClientPhones() {
  return [...activeClients.keys()];
}

export function getDebugInfo() {
  return {
    apiId: API_ID,
    apiHashSet: Boolean(API_HASH),
    envSessionsJsonSet: Boolean(String(process.env.TELEGRAM_SESSIONS_JSON || '').trim()),
    sessionsFileExists: fs.existsSync(SESSIONS_FILE),
    activeClients: getActiveClientPhones(),
    pendingLogins: [...pendingCodes.keys()],
    sessions: listSessions(),
    load: getSessionLoadInfo(),
  };
}

function getSession(phone) {
  const key = sessionKey(phone);
  if (!key) return '';
  return sessions[key] || '';
}

function saveSessionForPhone(phone, sessionString) {
  const key = sessionKey(phone) || 'default';
  if (!sessionString) return '';
  sessions[key] = sessionString;
  saveSessions();
  return key;
}

function deleteSession(phone) {
  const key = sessionKey(phone);
  if (!key || !(key in sessions)) return false;
  delete sessions[key];
  saveSessions();
  return true;
}

// ENV wins, the file fills any gaps, then the file is kept in sync for local dev.
loadSessions();

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

function errorText(err) {
  if (!err) return 'unknown error';
  return err.errorMessage || err.message || String(err);
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

/** Handler passed to initTelegramClients(...) by the server. */
export async function handleTelegramMessage(phone, client, event) {
  try {
    await handleIncoming(phone, client, event);
  } catch (err) {
    console.error(`[telegram] ${phone} message handler error:`, err.message);
  }
}

/**
 * Attach a NewMessage({}) handler and remember the client as active.
 * Returns false when the phone already listens.
 */
function activateClient(phone, client, handler) {
  activeClients.set(phone, client);
  if (listening.has(phone)) return false;
  client.addEventHandler((event) => {
    const messageHandler = handler || storedMessageHandler;
    if (typeof messageHandler === 'function') {
      Promise.resolve(messageHandler(phone, client, event)).catch((err) => {
        console.error(`[telegram] ${phone} handler failed:`, errorText(err));
      });
      return;
    }
    handleIncoming(phone, client, event).catch((err) => {
      console.error(`[telegram] ${phone} message handler error:`, err.message);
    });
  }, new NewMessage({}));
  listening.add(phone);
  console.log(`[telegram] Client ACTIVE for ${phone} - listening...`);
  return true;
}

/**
 * Connect every saved session and start listening.
 * Called once at boot (awaited before app.listen) and again after each login.
 */
export async function initTelegramClients(handleMessage) {
  if (typeof handleMessage === 'function') storedMessageHandler = handleMessage;
  const handler = handleMessage || storedMessageHandler;

  if (!API_ID || !API_HASH) {
    console.warn('[telegram] TELEGRAM_API_ID / TELEGRAM_API_HASH missing - Telegram disabled');
    return { active: 0, failed: 0, skipped: 0 };
  }

  const phones = Object.keys(sessions);
  if (!phones.length) {
    console.log('[telegram] no saved sessions yet. Users log in via POST /telegram/send-code');
    return { active: 0, failed: 0, skipped: 0 };
  }

  let active = 0;
  let failed = 0;
  let skipped = 0;

  for (const phone of phones) {
    const existing = activeClients.get(phone);
    if (existing && existing.connected && listening.has(phone)) {
      console.log(`[telegram] Client already ACTIVE for ${phone}`);
      skipped += 1;
      continue;
    }

    let client = existing;
    try {
      if (!client) {
        client = createClient(sessions[phone]);
        console.log(`[telegram] connecting saved session for ${phone}...`);
      }
      await client.connect();

      const authorized = await client.isUserAuthorized().catch(() => false);
      if (!authorized) {
        console.error(`[telegram] session for ${phone} is not authorized (logged out or revoked)`);
        try {
          await client.disconnect();
        } catch {
          /* ignore */
        }
        failed += 1;
        continue;
      }

      activateClient(phone, client, handler);
      active += 1;
    } catch (err) {
      console.error(`[telegram] could not activate ${phone}:`, errorText(err));
      failed += 1;
    }
  }

  console.log(
    `[telegram] initTelegramClients done: active=${active} failed=${failed} skipped=${skipped} total=${phones.length}`,
  );
  return { active, failed, skipped };
}

/* ----------------------------------- login ---------------------------------- */

async function dropPending(phone) {
  const pending = pendingCodes.get(phone);
  pendingCodes.delete(phone);
  if (pending && pending.client) {
    try {
      await pending.client.disconnect();
    } catch (err) {
      console.error('[telegram] pending disconnect failed:', err.message);
    }
  }
}

/**
 * Step 1: fresh client -> connect -> auth.sendCode.
 * Keeps the connected client plus its phoneCodeHash in pendingCodes[phone].
 */
export async function sendCode(phone) {
  const normalized = sessionKey(phone);
  if (!normalized) {
    throw new Error('phone is required, e.g. { "phone": "2348021234567" }');
  }
  assertConfigured();

  await dropPending(normalized);

  console.log(`[telegram] sendCode: connecting fresh client for ${normalized} (apiId=${API_ID})`);
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
  });
  await client.connect();
  console.log(`[telegram] sendCode: connected, requesting code`);

  try {
    const sent = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, normalized);
    if (!sent || !sent.phoneCodeHash) throw new Error('Telegram did not return a phoneCodeHash');

    pendingCodes.set(normalized, {
      client,
      phoneCodeHash: sent.phoneCodeHash,
      createdAt: Date.now(),
    });

    console.log(
      `[telegram] sendCode SUCCESS for ${normalized} (phoneCodeHash=${sent.phoneCodeHash}, viaApp=${Boolean(
        sent.isCodeViaApp,
      )})`,
    );

    return {
      success: true,
      phone: normalized,
      phoneCodeHash: sent.phoneCodeHash,
      isCodeViaApp: Boolean(sent.isCodeViaApp),
      message: 'Check Telegram app > Chat Telegram for code',
    };
  } catch (err) {
    console.error(`[telegram] sendCode FAILED for ${normalized}:`, errorText(err));
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Step 2: sign in with the code on the pending client, handle 2FA, persist the
 * session and activate the client immediately.
 * Accepts verifyCode(phone, code, phoneCodeHash, password, handleMessage) or a
 * single object { phone, code, phoneCodeHash, password }.
 */
export async function verifyCode(phoneOrOptions, codeArg, phoneCodeHashArg, passwordArg, handleMessageArg) {
  let phone;
  let code;
  let phoneCodeHash;
  let password;
  let handleMessage;

  if (phoneOrOptions && typeof phoneOrOptions === 'object') {
    ({ phone, code, phoneCodeHash, password } = phoneOrOptions);
    handleMessage = codeArg;
  } else {
    phone = phoneOrOptions;
    code = codeArg;
    phoneCodeHash = phoneCodeHashArg;
    password = passwordArg;
    handleMessage = handleMessageArg;
  }

  const normalized = sessionKey(phone);
  if (!normalized) throw new Error('phone is required');
  if (!code) throw new Error('code is required');
  assertConfigured();

  const pending = pendingCodes.get(normalized);
  const client = pending && pending.client;
  const hash = phoneCodeHash || (pending && pending.phoneCodeHash);
  if (!client || !hash) {
    throw new Error('No pending login for this phone. Call POST /telegram/send-code first');
  }

  console.log(`[telegram] verifyCode: signing in ${normalized} (hash=${hash})`);

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: normalized,
        phoneCodeHash: hash,
        phoneCode: String(code),
      }),
    );
    console.log(`[telegram] verifyCode: code accepted for ${normalized}`);
  } catch (err) {
    const errorMessage = errorText(err);
    console.error(`[telegram] verifyCode: SignIn failed for ${normalized}:`, errorMessage);

    if (errorMessage !== 'SESSION_PASSWORD_NEEDED') {
      throw new Error(errorMessage);
    }

    if (!password) {
      // Keep the pending client: the same code + hash are retried with a password.
      return {
        success: false,
        needsPassword: true,
        phone: normalized,
        phoneCodeHash: hash,
        message: 'Two-factor password required. Repeat with { phone, code, phoneCodeHash, password }.',
      };
    }

    console.log(`[telegram] verifyCode: 2FA required for ${normalized}, checking password`);
    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(passwordInfo, String(password));
    await client.invoke(new Api.auth.CheckPassword({ password: check }));
    console.log(`[telegram] verifyCode: 2FA password accepted for ${normalized}`);
  }

  const sessionString = client.session.save();
  const key = saveSessionForPhone(normalized, sessionString);
  console.log(`[telegram] verifyCode: session saved for ${key} (${sessionString.length} chars)`);

  pendingCodes.delete(normalized);
  activateClient(normalized, client, handleMessage || storedMessageHandler);
  console.log(`[telegram] verifyCode: client activated for ${normalized}`);

  // Activate any other saved sessions too (idempotent; active ones are skipped).
  await initTelegramClients(handleMessage || storedMessageHandler).catch((err) => {
    console.error('[telegram] initTelegramClients after login failed:', errorText(err));
  });

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

  const { base64, count } = exportSessions();
  console.log(`[telegram] login OK for ${normalized} (${count} session(s) saved)`);

  return {
    success: true,
    sessionSaved: true,
    phone: normalized,
    message: 'Login successful. Session saved and client listening.',
    account,
    session: sessionString,
    envValue: base64,
    instruction: 'Copy this base64 to Render env TELEGRAM_SESSIONS_JSON to survive redeploys',
  };
}

/* --------------------------------- QR login --------------------------------- */

const qrState = {
  status: 'idle',
  url: null,
  dataUrl: null,
  expires: null,
  phone: null,
  error: null,
  startedAt: null,
};

let qrClient = null;

export function getQRStatus() {
  return {
    success: qrState.status === 'success',
    status: qrState.status,
    needsPassword: qrState.status === 'password-needed',
    url: qrState.url,
    qr: qrState.dataUrl,
    expires: qrState.expires,
    phone: qrState.phone,
    error: qrState.error,
    startedAt: qrState.startedAt,
    activeClients: getActiveClientPhones(),
  };
}

async function stopQR() {
  const client = qrClient;
  qrClient = null;
  if (!client) return;
  try {
    await client.disconnect();
  } catch {
    /* ignore */
  }
}

/**
 * Backup login: QR token via gramjs signInUserWithQrCode, rendered with the
 * qrcode library. Poll GET /telegram/qr-status until success (or password-needed).
 */
export async function getQR(password) {
  assertConfigured();

  if (qrState.status === 'pending' && qrClient) {
    return getQRStatus();
  }

  await stopQR();

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
  });
  qrClient = client;

  qrState.status = 'pending';
  qrState.url = null;
  qrState.dataUrl = null;
  qrState.expires = null;
  qrState.phone = null;
  qrState.error = null;
  qrState.startedAt = new Date().toISOString();

  await client.connect();
  const passwordValue = password ? String(password) : '';
  console.log('[telegram] getQR: connected, requesting QR login token');

  // signInUserWithQrCode blocks until the code is scanned, so run it in the background.
  (async () => {
    try {
      await client.signInUserWithQrCode(
        { apiId: API_ID, apiHash: API_HASH },
        {
          qrCode: async ({ token, expires }) => {
            const url = `tg://login?token=${Buffer.from(token).toString('base64url')}`;
            qrState.url = url;
            qrState.dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
            qrState.expires = Number(expires) || null;
            qrState.status = 'pending';
            console.log(`[telegram] getQR: QR token ready (expires ${qrState.expires})`);
          },
          password: async () => {
            if (!passwordValue) {
              const err = new Error('SESSION_PASSWORD_NEEDED');
              err.errorMessage = 'SESSION_PASSWORD_NEEDED';
              throw err;
            }
            return passwordValue;
          },
          onError: (err) => {
            const text = errorText(err);
            console.error('[telegram] getQR: login error:', text);
            if (text === 'SESSION_PASSWORD_NEEDED') {
              qrState.status = 'password-needed';
              qrState.error = null;
            } else {
              qrState.status = 'error';
              qrState.error = text;
            }
            return true;
          },
        },
      );

      const sessionString = client.session.save();
      let phone = 'default';
      try {
        const me = await client.getMe();
        phone = sessionKey(me && me.phone) || 'default';
      } catch (err) {
        console.error('[telegram] getQR: getMe failed:', err.message);
      }

      saveSessionForPhone(phone, sessionString);
      qrState.status = 'success';
      qrState.phone = phone;
      qrState.dataUrl = null;
      console.log(`[telegram] getQR: login SUCCESS for ${phone}, session saved`);

      await client.disconnect().catch(() => {});
      if (qrClient === client) qrClient = null;

      await initTelegramClients(storedMessageHandler).catch((err) => {
        console.error('[telegram] getQR: initTelegramClients failed:', errorText(err));
      });
    } catch (err) {
      const text = errorText(err);
      if (qrState.status !== 'success') {
        if (text === 'SESSION_PASSWORD_NEEDED') {
          qrState.status = 'password-needed';
        } else if (text !== 'AUTH_USER_CANCEL') {
          qrState.status = 'error';
          qrState.error = text;
        }
      }
      console.error('[telegram] getQR: flow failed:', text);
      await stopQR();
    }
  })();

  return getQRStatus();
}

export async function cancelQR() {
  await stopQR();
  qrState.status = 'idle';
  qrState.url = null;
  qrState.dataUrl = null;
  return getQRStatus();
}

/* ----------------------------------- usage ---------------------------------- */

export async function getClient(phone) {
  assertConfigured();
  const normalized = sessionKey(phone);
  if (!normalized) throw new Error('phone is required');

  const existing = activeClients.get(normalized);
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

  activateClient(normalized, client, storedMessageHandler);
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
  const phones = new Set([...Object.keys(sessions), ...activeClients.keys()]);
  return [...phones].map((phone) => {
    const client = activeClients.get(phone);
    return {
      phone,
      sessionSaved: Boolean(sessions[phone]),
      connected: Boolean(client && client.connected),
      listening: listening.has(phone),
    };
  });
}

export async function logout(phone) {
  const normalized = sessionKey(phone);
  if (!normalized) throw new Error('phone is required');

  const client = activeClients.get(normalized);
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
    activeClients.delete(normalized);
    listening.delete(normalized);
  }

  await dropPending(normalized);
  deleteSession(normalized);

  return { success: true, phone: normalized, loggedOut: true };
}

export function getTelegramStatus() {
  return {
    configured: Boolean(API_ID && API_HASH),
    apiId: API_ID,
    sessions: listSessions(),
    pendingLogins: [...pendingCodes.keys()],
    activeClients: activeClients.size,
    activeClientPhones: getActiveClientPhones(),
    qr: { status: qrState.status },
  };
}
