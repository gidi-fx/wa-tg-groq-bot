import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.join(__dirname, 'users.json');
const MAX_HISTORY = 20;

function readDb() {
  try {
    if (!fs.existsSync(USERS_FILE)) return { users: [] };
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!Array.isArray(parsed.users)) parsed.users = [];
    return parsed;
  } catch (err) {
    console.error('[users] could not read users.json:', err.message);
    return { users: [] };
  }
}

function writeDb(db) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2) + '\n');
}

/**
 * Normalise a phone number to digits only, converting a leading 0 to Nigeria's 234.
 * "+234 802-123-4567" -> "2348021234567", "08021234567" -> "2348021234567".
 */
export function normalizePhone(phone) {
  if (phone === undefined || phone === null) return '';
  let digits = String(phone).replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = '234' + digits.slice(1);
  return digits;
}

export function getUserByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const db = readDb();
  return db.users.find((user) => normalizePhone(user.phone) === normalized) || null;
}

export function getUserByWaJid(jid) {
  const raw = String(jid || '').trim();
  if (!raw) return null;
  const db = readDb();
  const direct = db.users.find((user) => user.waJid && user.waJid === raw);
  if (direct) return direct;
  const normalized = normalizePhone(raw.split('@')[0]);
  if (!normalized) return null;
  return (
    db.users.find((user) => {
      const jidPhone = user.waJid ? normalizePhone(String(user.waJid).split('@')[0]) : '';
      return jidPhone === normalized || normalizePhone(user.phone) === normalized;
    }) || null
  );
}

export function getUserByTelegramChatId(chatId) {
  if (chatId === undefined || chatId === null || chatId === '') return null;
  const target = String(chatId);
  const db = readDb();
  return (
    db.users.find(
      (user) =>
        (user.telegramChatId && String(user.telegramChatId) === target) ||
        (user.telegramId && String(user.telegramId) === target),
    ) || null
  );
}

/**
 * Create or update a user. The phone number is the identity: a WhatsApp JID and a
 * Telegram account with the same phone end up on the same record (and history).
 */
export function saveUser({ phone, waJid, telegramId, chatId, name } = {}) {
  const db = readDb();
  const normalized = normalizePhone(phone);

  let user = null;
  if (normalized) user = db.users.find((u) => normalizePhone(u.phone) === normalized) || null;
  if (!user && waJid) user = db.users.find((u) => u.waJid && u.waJid === waJid) || null;
  if (!user && chatId) {
    user =
      db.users.find(
        (u) =>
          (u.telegramChatId && String(u.telegramChatId) === String(chatId)) ||
          (u.telegramId && String(u.telegramId) === String(chatId)),
      ) || null;
  }

  if (!user) {
    user = {
      phone: normalized || '',
      waJid: null,
      telegramId: null,
      telegramChatId: null,
      name: null,
      history: [],
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
  }

  if (!user.phone && normalized) user.phone = normalized;
  if (waJid) user.waJid = waJid;
  if (telegramId) user.telegramId = String(telegramId);
  if (chatId) user.telegramChatId = String(chatId);
  if (name) user.name = name;
  if (!Array.isArray(user.history)) user.history = [];
  user.updatedAt = new Date().toISOString();

  writeDb(db);
  return user;
}

export function getHistory(phone) {
  const user = getUserByPhone(phone);
  if (!user || !Array.isArray(user.history)) return [];
  return user.history.map((entry) => ({ role: entry.role, content: entry.content }));
}

export function addMessage(phone, role, content) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const db = readDb();
  let user = db.users.find((u) => normalizePhone(u.phone) === normalized);

  if (!user) {
    user = {
      phone: normalized,
      waJid: null,
      telegramId: null,
      telegramChatId: null,
      name: null,
      history: [],
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
  }

  if (!Array.isArray(user.history)) user.history = [];
  user.history.push({ role, content: String(content || ''), at: new Date().toISOString() });
  if (user.history.length > MAX_HISTORY) user.history = user.history.slice(-MAX_HISTORY);
  user.updatedAt = new Date().toISOString();

  writeDb(db);
  return user;
}

export function listUsers() {
  return readDb().users.map((user) => ({
    phone: user.phone || null,
    waJid: user.waJid || null,
    telegramId: user.telegramId || null,
    telegramChatId: user.telegramChatId || null,
    name: user.name || null,
    messages: Array.isArray(user.history) ? user.history.length : 0,
    updatedAt: user.updatedAt || null,
  }));
}
