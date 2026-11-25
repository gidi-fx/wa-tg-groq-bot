import 'dotenv/config';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { computeCheck } from 'telegram/Password.js';

import { askAgent, transcribeAudio } from './agents.js';
import { normalizePhone, getUserByPhone, saveUser } from './userStore.js';

const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const LOGIN_PHONE = normalizePhone(process.env.TELEGRAM_PHONE || '');

let client = null;
let connected = false;
let handlerRegistered = false;
let authorized = false;
let pendingLogin = null;
let sessionString = (process.env.TELEGRAM_SESSION || '').trim();

function createClient() {
  if (client) return client;
  const session = new StringSession(sessionString);
  client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    autoReconnect: true,
  });
  return client;
}

async function ensureConnected() {
  if (!API_ID || !API_HASH) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH are not set');
  }
  const current = createClient();
  if (!connected) {
    await current.connect();
    connected = true;
  }
  return current;
}

async function isAuthorized(current) {
  try {
    return await current.isUserAuthorized();
  } catch (err) {
    console.error('[telegram] authorization check failed:', err.message);
    return false;
  }
}

function registerHandler(current) {
  if (handlerRegistered) return;
  current.addEventHandler(onNewMessage, new NewMessage({ incoming: true }));
  handlerRegistered = true;
  console.log('[telegram] new-message handler registered');
}

function isVoiceMessage(message) {
  const document = message && message.document;
  if (!document) return false;
  const attributes = document.attributes || [];
  return attributes.some(
    (attribute) => attribute.className === 'DocumentAttributeAudio' && attribute.voice === true,
  );
}

async function onNewMessage(event) {
  const message = event && event.message;
  if (!message || message.out) return;

  try {
    const current = await ensureConnected();
    const senderId = message.senderId ? String(message.senderId) : '';

    let senderPhone = '';
    let senderName = '';
    if (message.senderId) {
      try {
        const entity = await current.getEntity(message.senderId);
        if (entity) {
          if (entity.phone) senderPhone = normalizePhone(entity.phone);
          senderName = [entity.firstName, entity.lastName, entity.title]
            .filter(Boolean)
            .join(' ')
            .trim();
        }
      } catch (err) {
        console.error('[telegram] could not resolve sender entity:', err.message);
      }
    }

    const identifier = senderPhone || senderId || String(message.chatId || '');
    if (!identifier) return;

    let text = String(message.message || '').trim();
    let source = 'text';

    if (!text && isVoiceMessage(message)) {
      const buffer = await current.downloadMedia(message, {});
      if (Buffer.isBuffer(buffer) && buffer.length) {
        text = await transcribeAudio(buffer, 'telegram-voice.ogg');
        source = 'voice';
      }
    }

    if (!text) return;

    const existing = getUserByPhone(identifier);
    const user = saveUser({
      phone: existing && existing.phone ? existing.phone : identifier,
      telegramId: senderId || undefined,
      chatId: String(message.chatId || senderId),
      name: senderName || undefined,
    });

    console.log(`[telegram] ${user.phone} (${source}): ${text}`);
    const reply = await askAgent(user.phone, text, 'telegram');

    try {
      await sendTelegram(message.chatId || senderId, reply);
    } catch (err) {
      console.error('[telegram] sendMessage failed, falling back to reply():', err.message);
      if (typeof message.reply === 'function') {
        await message.reply({ message: reply, linkPreview: false });
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error('[telegram] message handler error:', err.message);
  }
}

export async function initTelegram() {
  if (!API_ID || !API_HASH) {
    console.warn('[telegram] TELEGRAM_API_ID / TELEGRAM_API_HASH missing - Telegram disabled');
    return false;
  }
  if (!sessionString) {
    console.log('Go to /auth/telegram to login');
    return false;
  }

  try {
    const current = await ensureConnected();
    authorized = await isAuthorized(current);
    if (!authorized) {
      console.log('Go to /auth/telegram to login (stored TELEGRAM_SESSION is invalid or expired)');
      return false;
    }

    registerHandler(current);

    let me = null;
    try {
      me = await current.getMe();
    } catch (err) {
      console.error('[telegram] getMe failed:', err.message);
    }

    console.log(
      `[telegram] logged in as ${me ? (me.username ? '@' + me.username : String(me.id)) : 'unknown account'}`,
    );

    if (LOGIN_PHONE && me) {
      saveUser({
        phone: LOGIN_PHONE,
        telegramId: String(me.id),
        chatId: String(me.id),
        name: [me.firstName, me.lastName].filter(Boolean).join(' ') || undefined,
      });
    }
    return true;
  } catch (err) {
    console.error('[telegram] init failed:', err.message);
    return false;
  }
}

export async function requestLoginCode(phone) {
  const current = await ensureConnected();
  const targetPhone = normalizePhone(phone || LOGIN_PHONE);
  if (!targetPhone) {
    throw new Error('No phone number. Send { "phone": "+2348012345678" } or set TELEGRAM_PHONE');
  }

  const result = await current.sendCode({ apiId: API_ID, apiHash: API_HASH }, targetPhone);
  pendingLogin = { phone: targetPhone, phoneCodeHash: result.phoneCodeHash };

  if (!result.phoneCodeHash) throw new Error('Telegram did not return a phoneCodeHash');

  return {
    phone: targetPhone,
    codeSent: true,
    isCodeViaApp: Boolean(result.isCodeViaApp),
    next: 'POST /auth/telegram/verify-code with { "code": "<code from Telegram>" }',
  };
}

export async function verifyLoginCode(code, password) {
  const current = await ensureConnected();
  if (!pendingLogin) {
    throw new Error('No pending login. Call POST /auth/telegram/send-code first');
  }
  if (!code) throw new Error('code is required');

  try {
    await current.invoke(
      new Api.auth.SignIn({
        phoneNumber: pendingLogin.phone,
        phoneCodeHash: pendingLogin.phoneCodeHash,
        phoneCode: String(code),
      }),
    );
  } catch (err) {
    const message = err && err.errorMessage ? err.errorMessage : String((err && err.message) || err);
    if (message === 'SESSION_PASSWORD_NEEDED') {
      if (!password) {
        return {
          ok: false,
          needsPassword: true,
          message:
            'Two-factor password required. Repeat this request with { "code": "...", "password": "..." }',
        };
      }
      const passwordInfo = await current.invoke(new Api.account.GetPassword());
      const check = await computeCheck(passwordInfo, String(password));
      await current.invoke(new Api.auth.CheckPassword({ password: check }));
    } else {
      throw err;
    }
  }

  authorized = true;
  sessionString = current.session.save();
  console.log('[telegram] LOGIN OK. Save this value as TELEGRAM_SESSION:', sessionString);

  registerHandler(current);

  let me = null;
  try {
    me = await current.getMe();
  } catch (err) {
    console.error('[telegram] getMe failed after login:', err.message);
  }

  if (me) {
    saveUser({
      phone: normalizePhone(pendingLogin.phone),
      telegramId: String(me.id),
      chatId: String(me.id),
      name: [me.firstName, me.lastName].filter(Boolean).join(' ') || undefined,
    });
  }

  const loginPhone = pendingLogin.phone;
  pendingLogin = null;

  return {
    ok: true,
    session: sessionString,
    phone: loginPhone,
    message: 'Login successful. Copy TELEGRAM_SESSION into your environment variables and redeploy.',
    account: me
      ? {
          id: String(me.id),
          username: me.username || null,
          name: [me.firstName, me.lastName].filter(Boolean).join(' ') || null,
        }
      : null,
  };
}

export function getTelegramStatus() {
  return {
    configured: Boolean(API_ID && API_HASH),
    phoneConfigured: Boolean(LOGIN_PHONE),
    sessionSaved: Boolean(sessionString),
    connected,
    authorized,
    pendingLogin: Boolean(pendingLogin),
  };
}

export async function sendTelegram(chatId, text) {
  const current = await ensureConnected();
  const ok = await isAuthorized(current);
  if (!ok) {
    authorized = false;
    throw new Error('Telegram client is not authorized. Login via /auth/telegram');
  }
  return current.sendMessage(chatId, { message: text });
}
