import 'dotenv/config';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import cors from 'cors';
import express from 'express';
import multer from 'multer';

import { AppError, errorMessage } from './errors.js';
import {
  buildMessages,
  callAI,
  extractMediaRequest,
  synthesizeSpeech,
  transcribeAudio,
  TTS_MODEL,
} from './ai.js';
import * as evo from './evolution.js';
import { getModelCatalog } from './models.js';
import {
  addAgentMedia,
  agentMediaBuffer,
  assignChat,
  createAgent,
  deleteAgent,
  getAgent,
  getAssignedAgent,
  getConversations,
  getDefaultAgent,
  getGroupAgent,
  getHistory,
  getInboxMessages,
  getInstanceForJid,
  getSettings,
  hostGroup,
  listAgents,
  listGroups,
  removeAgentMedia,
  resolveKeys,
  saveHistory,
  saveInboxMessage,
  saveSettings,
  unhostGroup,
  updateAgent,
  upsertGroups,
} from './agents/store.js';
import {
  isSupabaseConfigured,
  MEDIA_BUCKET,
  mediaObjectPath,
  supabase,
  uploadMedia,
} from './supabase.js';
import { MEMORY_WARNING, memoryCounts, memorySnapshot } from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DIST_DIR = path.join(__dirname, '..', 'dist');

const PORT = Number(process.env.PORT || 3000);
const TELEGRAM_MESSAGE = 'Telegram MTProto Coming Soon (Disabled)';
const SUPABASE_WARNING =
  '⚠️ Supabase not connected - optional - agents, inbox, groups, media will NOT be saved permanently. '
  + 'Add SUPABASE_URL + SUPABASE_KEY in .env to enable persistence. Get free at supabase.com';
const UPLOAD_LIMIT = 20 * 1024 * 1024;

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(PUBLIC_DIR, { index: false }));
// Optional prebuilt asset output (only used when a `dist` build exists).
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { index: false }));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMIT, files: 10 },
});

/* -------------------------------- helpers --------------------------------- */

function baseUrl(req) {
  const configured = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function maskKey(key) {
  if (!key) return null;
  const value = String(key);
  if (value.length <= 10) return '••••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function unwrapMessage(message) {
  if (!message || typeof message !== 'object') return {};
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  return message;
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
  return Object.keys(message).filter((key) => key !== 'messageContextInfo')[0] || 'unknown';
}

function extractText(message) {
  if (!message) return '';
  const candidates = [
    message.conversation,
    message.extendedTextMessage?.text,
    message.imageMessage?.caption,
    message.videoMessage?.caption,
    message.documentMessage?.caption,
    message.stickerMessage?.caption,
    message.audioMessage?.caption,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

const MEDIA_KINDS = {
  imageMessage: { kind: 'image', ext: '.jpg', mime: 'image/jpeg' },
  videoMessage: { kind: 'video', ext: '.mp4', mime: 'video/mp4' },
  documentMessage: { kind: 'document', ext: '', mime: 'application/octet-stream' },
  stickerMessage: { kind: 'sticker', ext: '.webp', mime: 'image/webp' },
  audioMessage: { kind: 'audio', ext: '.ogg', mime: 'audio/ogg' },
};

function mediaDetails(message, type) {
  const info = MEDIA_KINDS[type];
  if (!info) return null;
  const node = message[type] || {};
  return {
    kind: info.kind,
    mimetype: node.mimetype || info.mime,
    fileName: node.fileName || `whatsapp-${info.kind}${info.ext}`,
    caption: node.caption || '',
    seconds: node.seconds || null,
  };
}

function mediaTypeFromMime(mimetype, fileName = '') {
  const mime = String(mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (/\.(png|jpe?g|gif|webp)$/i.test(fileName)) return 'image';
  if (/\.(mp4|mov|webm)$/i.test(fileName)) return 'video';
  if (/\.(mp3|ogg|opus|m4a|wav)$/i.test(fileName)) return 'audio';
  return 'document';
}

function timestampToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return new Date().toISOString();
  const ms = number > 1e12 ? number : number * 1000;
  return new Date(ms).toISOString();
}

function validateModel(model) {
  const value = String(model || '').trim();
  if (!value) return 'groq/llama-3.3-70b-versatile';
  if (!/^(groq|openrouter)\//.test(value)) {
    throw new AppError('Model must start with "groq/" or "openrouter/"', 400, 'invalid_model');
  }
  return value;
}

async function publicAgent(agent) {
  if (!agent) return null;
  const { groqKey, openrouterKey, ...rest } = agent;
  return rest;
}

/* --------------------------------- status --------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ok: true,
    hasSupabase: isSupabaseConfigured(),
    persistence: isSupabaseConfigured() ? 'supabase' : 'memory',
    uptime: Math.round(process.uptime()),
    telegram: TELEGRAM_MESSAGE,
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: 'WhatsApp Groq Router v2',
    uptime: Math.round(process.uptime()),
    port: PORT,
    supabase: isSupabaseConfigured(),
    persistence: isSupabaseConfigured() ? 'supabase' : 'memory',
    evolution: evo.evolutionConfigured(),
    telegram: TELEGRAM_MESSAGE,
  });
});

app.get(
  '/api/config',
  asyncRoute(async (req, res) => {
    let counts = { agents: 0, chats: 0, groups: 0, messages: 0 };
    if (isSupabaseConfigured()) {
      const [agents, groups, messages] = await Promise.all([
        supabase.from('agents').select('*', { count: 'exact', head: true }),
        supabase.from('groups').select('*', { count: 'exact', head: true }),
        supabase.from('inbox_messages').select('*', { count: 'exact', head: true }),
      ]);
      counts = {
        agents: agents.count || 0,
        groups: groups.count || 0,
        messages: messages.count || 0,
        chats: 0,
      };
      const conversations = await getConversations({ limit: 3000 }).catch(() => []);
      counts.chats = conversations.length;
    } else {
      counts = memoryCounts();
    }

    const settings = await getSettings().catch(() => ({ groqKey: '', openrouterKey: '' }));

    res.json({
      ok: true,
      app: 'WhatsApp Groq Router v2',
      telegram: TELEGRAM_MESSAGE,
      telegramDisabled: true,
      supabase: {
        configured: isSupabaseConfigured(),
        optional: true,
        bucket: MEDIA_BUCKET,
        warning: isSupabaseConfigured() ? null : SUPABASE_WARNING,
      },
      persistence: isSupabaseConfigured() ? 'supabase' : 'memory',
      evolution: {
        configured: evo.evolutionConfigured(),
        url: process.env.EVOLUTION_API_URL ? String(process.env.EVOLUTION_API_URL).replace(/\/+$/, '') : null,
      },
      ai: {
        groq: Boolean(settings.groqKey || process.env.GROQ_API_KEY),
        openrouter: Boolean(settings.openrouterKey || process.env.OPENROUTER_API_KEY),
        tts: TTS_MODEL,
      },
      realtime: {
        url: String(process.env.SUPABASE_URL || '').replace(/\/+$/, '') || null,
        anonKey: process.env.SUPABASE_ANON_KEY || null,
      },
      counts,
      modelsSource: (await getModelCatalog().catch(() => ({ source: 'fallback' }))).source,
    });
  }),
);

app.get(
  '/api/models',
  asyncRoute(async (req, res) => {
    const catalog = await getModelCatalog({ refresh: req.query.refresh === '1' });
    res.json({ ok: true, ...catalog });
  }),
);

/* -------------------------------- settings -------------------------------- */

app.get(
  '/api/settings',
  asyncRoute(async (req, res) => {
    const settings = await getSettings();
    res.json({
      ok: true,
      groqKey: maskKey(settings.groqKey || process.env.GROQ_API_KEY),
      openrouterKey: maskKey(settings.openrouterKey || process.env.OPENROUTER_API_KEY),
      hasGroq: Boolean(settings.groqKey || process.env.GROQ_API_KEY),
      hasOpenRouter: Boolean(settings.openrouterKey || process.env.OPENROUTER_API_KEY),
      source: {
        groq: settings.groqKey ? 'settings' : process.env.GROQ_API_KEY ? 'environment' : null,
        openrouter: settings.openrouterKey
          ? 'settings'
          : process.env.OPENROUTER_API_KEY
            ? 'environment'
            : null,
      },
    });
  }),
);

app.put(
  '/api/settings',
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (body.groqKey !== undefined) patch.groqKey = body.groqKey;
    if (body.openrouterKey !== undefined) patch.openrouterKey = body.openrouterKey;
    if (body.clearGroq) patch.groqKey = '';
    if (body.clearOpenRouter) patch.openrouterKey = '';
    if (!Object.keys(patch).length) {
      throw new AppError('Nothing to update', 400, 'empty_update');
    }

    const settings = await saveSettings(patch);
    console.log('[settings] global BYOK keys updated');
    res.json({
      ok: true,
      groqKey: maskKey(settings.groqKey || process.env.GROQ_API_KEY),
      openrouterKey: maskKey(settings.openrouterKey || process.env.OPENROUTER_API_KEY),
      hasGroq: Boolean(settings.groqKey || process.env.GROQ_API_KEY),
      hasOpenRouter: Boolean(settings.openrouterKey || process.env.OPENROUTER_API_KEY),
    });
  }),
);

/* --------------------------------- agents --------------------------------- */

app.get(
  '/api/agents',
  asyncRoute(async (req, res) => {
    const agents = await listAgents();
    res.json({ ok: true, agents });
  }),
);

app.get(
  '/api/agents/:id',
  asyncRoute(async (req, res) => {
    const agent = await getAgent(req.params.id);
    if (!agent) throw new AppError('Agent not found', 404, 'agent_not_found');
    res.json({ ok: true, agent });
  }),
);

app.post(
  '/api/agents',
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const agent = await createAgent({
      name: body.name,
      instruction: body.instruction,
      voiceEnabled: body.voiceEnabled,
      mediaEnabled: body.mediaEnabled,
      model: validateModel(body.model),
      mediaFiles: body.mediaFiles,
      groqKey: body.groqKey,
      openrouterKey: body.openrouterKey,
    });
    res.status(201).json({ ok: true, agent: await publicAgent(agent) });
  }),
);

app.put(
  '/api/agents/:id',
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const patch = {};
    for (const field of [
      'name',
      'instruction',
      'voiceEnabled',
      'mediaEnabled',
      'mediaFiles',
      'groqKey',
      'openrouterKey',
    ]) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (body.model !== undefined) patch.model = validateModel(body.model);

    const agent = await updateAgent(req.params.id, patch);
    res.json({ ok: true, agent: await publicAgent(agent) });
  }),
);

app.delete(
  '/api/agents/:id',
  asyncRoute(async (req, res) => {
    const result = await deleteAgent(req.params.id);
    res.json({ ok: true, ...result });
  }),
);

app.post(
  '/api/agents/:id/media',
  upload.array('files', 10),
  asyncRoute(async (req, res) => {
    const files = req.files || [];
    if (!files.length) throw new AppError('No files uploaded', 400, 'missing_files');
    const agent = await addAgentMedia(req.params.id, files);
    res.status(201).json({ ok: true, agent: await publicAgent(agent) });
  }),
);

app.delete(
  '/api/agents/:id/media',
  asyncRoute(async (req, res) => {
    const filePath = String(req.query.path || req.body?.path || '');
    if (!filePath) throw new AppError('path is required', 400, 'missing_path');
    const agent = await removeAgentMedia(req.params.id, filePath);
    res.json({ ok: true, agent: await publicAgent(agent) });
  }),
);

/* ------------------------------- instances -------------------------------- */

app.get(
  '/api/instances',
  asyncRoute(async (req, res) => {
    if (!evo.evolutionConfigured()) {
      return res.json({ ok: true, configured: false, instances: [], error: null });
    }
    try {
      const instances = await evo.fetchInstances();
      res.json({ ok: true, configured: true, instances, error: null });
    } catch (err) {
      res.json({ ok: true, configured: true, instances: [], error: err.message });
    }
  }),
);

const createInstanceHandler = asyncRoute(async (req, res) => {
  const name = String(req.body?.instanceName || req.body?.name || '').trim();
  if (!name) throw new AppError('instanceName is required', 400, 'invalid_instance');
  const webhookUrl = `${baseUrl(req)}/webhook/${encodeURIComponent(name)}`;
  const result = await evo.createInstance(name, webhookUrl);
  console.log(`[connect] instance ${name} created (webhook=${webhookUrl})`);
  res.status(201).json({ ok: true, ...result });
});

const connectInstanceHandler = asyncRoute(async (req, res) => {
  const instance = req.params.instance;
  const number = req.query.number ? digits(req.query.number) : null;
  const data = await evo.connectInstance(instance, number);
  res.json({ ok: true, ...data });
});

// Public aliases documented for Evolution-style integrations.
app.post('/api/instance/create', createInstanceHandler);
app.post('/instance/create', createInstanceHandler);
app.get('/api/instance/connect/:instance', connectInstanceHandler);
app.get('/instance/connect/:instance', connectInstanceHandler);

app.get(
  '/api/instance/status/:instance',
  asyncRoute(async (req, res) => {
    const data = await evo.getInstanceStatus(req.params.instance);
    res.json({ ok: true, ...data });
  }),
);

/* -------------------------------- webhook --------------------------------- */

app.post(
  '/webhook/:instance',
  asyncRoute(async (req, res) => {
    const instance = req.params.instance;
    res.json({ ok: true, received: true });
    const payload = req.body || {};
    handleWebhook(instance, payload).catch((err) => {
      console.error(`[webhook] ${instance} processing failed: ${err.message}`);
    });
  }),
);

app.get('/webhook/:instance', (req, res) => {
  res.json({
    ok: true,
    webhook: `${baseUrl(req)}/webhook/${req.params.instance}`,
    events: ['MESSAGES_UPSERT'],
    telegram: TELEGRAM_MESSAGE,
  });
});

async function handleWebhook(instance, payload) {
  const event = String(payload.event || payload.type || '').toLowerCase();
  if (event && !event.includes('messages.upsert')) {
    console.log(`[webhook] ignored event ${event || 'unknown'}`);
    return;
  }

  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const key = data.key || {};
  if (key.fromMe) return;

  const remoteJid = String(key.remoteJid || data.remoteJid || '');
  if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast')) return;

  const instanceName = payload.instance || payload.instanceName || instance || 'unknown';
  const rawMessage = data.message || {};
  const message = unwrapMessage(rawMessage);
  const messageType = detectMessageType(message);
  const isGroup = remoteJid.endsWith('@g.us');
  const pushName = data.pushName || key.participant || (isGroup ? remoteJid.split('@')[0] : '');
  const timestamp = timestampToIso(data.messageTimestamp);
  const waMessageId = key.id || null;

  console.log(
    `[webhook] ${instanceName} ${isGroup ? 'group' : 'chat'} ${remoteJid} type=${messageType} from=${pushName || 'unknown'}`,
  );

  let content = extractText(message);
  let media = mediaDetails(message, messageType);
  let mediaUrl = null;

  // Resolve the agent first: its key is needed for voice transcription.
  let agent = null;
  try {
    if (isGroup) agent = await getGroupAgent(remoteJid);
    else agent = (await getAssignedAgent(remoteJid)) || (await getDefaultAgent());
  } catch (err) {
    console.error(`[webhook] could not resolve agent: ${err.message}`);
  }

  const keys = await resolveKeys(agent).catch(() => ({
    groqKey: process.env.GROQ_API_KEY || '',
    openrouterKey: process.env.OPENROUTER_API_KEY || '',
  }));

  if (media) {
    try {
      const buffer = await evo.getMediaBase64(instanceName, key, message);
      if (buffer) {
        const objectPath = mediaObjectPath(`inbox/${instanceName}`, media.fileName);
        if (isSupabaseConfigured()) {
          mediaUrl = await uploadMedia(buffer, objectPath, media.mimetype);
        } else {
          console.warn('[webhook] media not persisted (Supabase not configured, in-memory mode)');
        }

        if (media.kind === 'audio') {
          try {
            const transcript = await transcribeAudio(buffer, media.fileName, keys.groqKey, media.mimetype);
            if (transcript) {
              content = transcript;
              console.log(`[webhook] voice transcribed: ${transcript.slice(0, 120)}`);
            }
          } catch (err) {
            console.error(`[webhook] transcription failed: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.error(`[webhook] media download/upload failed: ${err.message}`);
    }
  }

  if (!content) {
    if (media) content = `[${media.kind}]`;
    else {
      console.log(`[webhook] ${remoteJid}: no text/media - ignored`);
      return;
    }
  }

  await saveInboxMessage({
    instance: instanceName,
    remoteJid,
    pushName,
    messageType: media?.kind || (messageType === 'conversation' ? 'text' : messageType),
    content,
    mediaUrl,
    isFromMe: false,
    timestamp,
    waMessageId,
  });

  if (!agent) {
    console.log(`[webhook] ${remoteJid}: stored, no agent assigned (use Inbox assign or Groups host)`);
    return;
  }

  const target = remoteJid;
  const quoted = { key, message: rawMessage };
  await evo.sendPresence(instanceName, target, 'composing');

  try {
    const history = await getHistory(remoteJid, 20).catch(() => []);
    await saveHistory(remoteJid, 'user', content);

    const result = await callAI({
      model: agent.model,
      messages: buildMessages({ agent, history, userText: content }),
      groqKey: keys.groqKey,
      openrouterKey: keys.openrouterKey,
    });

    const { text: replyText, media: requestedMedia } = extractMediaRequest(result.text, agent.mediaFiles);

    if (requestedMedia && agent.mediaEnabled) {
      const file = await agentMediaBuffer(requestedMedia);
      await evo.sendMedia(instanceName, target, {
        media: file.buffer,
        mediatype: mediaTypeFromMime(requestedMedia.type, requestedMedia.name),
        mimetype: requestedMedia.type,
        fileName: requestedMedia.name,
        caption: replyText,
        quoted,
      });
      console.log(`[webhook] replied to ${remoteJid} with media ${requestedMedia.name}`);
    } else if (agent.voiceEnabled) {
      try {
        const speech = await synthesizeSpeech(replyText, { groqKey: keys.groqKey });
        await evo.sendAudio(instanceName, target, speech.buffer, {
          mimetype: speech.mimetype,
          quoted,
        });
        console.log(`[webhook] replied to ${remoteJid} with voice (${speech.provider})`);
      } catch (err) {
        console.warn(`[webhook] TTS failed - sending text instead: ${err.message}`);
        await evo.sendText(instanceName, target, replyText, { quoted });
      }
    } else {
      await evo.sendText(instanceName, target, replyText, { quoted });
    }

    await saveInboxMessage({
      instance: instanceName,
      remoteJid,
      pushName: 'Agent',
      messageType: 'text',
      content: replyText,
      isFromMe: true,
      timestamp: new Date().toISOString(),
    });
    await saveHistory(remoteJid, 'assistant', replyText);

    console.log(
      `[webhook] replied to ${remoteJid} via ${agent.name} (${result.model}) ${result.usage.totalTokens || '?'} tokens`,
    );
  } catch (err) {
    console.error(`[webhook] reply failed for ${remoteJid}: ${err.message}`);
    await evo
      .sendText(instanceName, target, `⚠️ AI error: ${err.message}`.slice(0, 500), { quoted })
      .catch(() => null);
  } finally {
    await evo.sendPresence(instanceName, target, 'paused').catch(() => null);
  }
}

/* --------------------------------- inbox ---------------------------------- */

app.get(
  '/api/inbox',
  asyncRoute(async (req, res) => {
    if (!isSupabaseConfigured()) {
      return res.json({
        ok: true,
        hasSupabase: false,
        warning: MEMORY_WARNING,
        data: memorySnapshot(),
      });
    }
    const [conversations, groups, agents] = await Promise.all([
      getConversations({ search: req.query.search || '' }),
      listGroups(),
      listAgents(),
    ]);
    res.json({
      ok: true,
      hasSupabase: true,
      warning: null,
      data: {
        conversations,
        groups,
        agents,
        counts: { agents: agents.length, groups: groups.length, conversations: conversations.length },
      },
    });
  }),
);

app.get(
  '/api/inbox/conversations',
  asyncRoute(async (req, res) => {
    const conversations = await getConversations({ search: req.query.search || '' });
    res.json({ ok: true, conversations });
  }),
);

app.get(
  '/api/inbox/messages',
  asyncRoute(async (req, res) => {
    const jid = String(req.query.jid || '').trim();
    if (!jid) throw new AppError('jid is required', 400, 'missing_jid');
    const messages = await getInboxMessages(jid, req.query.limit || 200);
    res.json({ ok: true, jid, messages });
  }),
);

app.post(
  '/api/inbox/reply',
  asyncRoute(async (req, res) => {
    const jid = String(req.body?.jid || '').trim();
    const text = String(req.body?.text || '').trim();
    if (!jid) throw new AppError('jid is required', 400, 'missing_jid');
    if (!text) throw new AppError('Message text is required', 400, 'missing_text');

    let instance = String(req.body?.instance || '').trim();
    if (!instance) {
      instance = (await getInstanceForJid(jid).catch(() => null)) || '';
    }
    if (!instance) {
      const instances = await evo.fetchInstances().catch(() => []);
      instance = instances[0]?.name || process.env.EVOLUTION_INSTANCE || '';
    }
    if (!instance) throw new AppError('No WhatsApp instance available', 409, 'no_instance');

    await evo.sendText(instance, jid, text);
    await saveInboxMessage({
      instance,
      remoteJid: jid,
      pushName: 'Dashboard',
      messageType: 'text',
      content: text,
      isFromMe: true,
      timestamp: new Date().toISOString(),
    });
    await saveHistory(jid, 'assistant', text).catch(() => null);
    console.log(`[inbox] replied to ${jid} via ${instance}`);
    res.json({ ok: true, jid, instance, message: text });
  }),
);

app.post(
  '/api/inbox/assign',
  asyncRoute(async (req, res) => {
    const jid = String(req.body?.jid || '').trim();
    const agentId = req.body?.agentId ? String(req.body.agentId) : null;
    if (!jid) throw new AppError('jid is required', 400, 'missing_jid');
    const result = await assignChat(jid, agentId);
    res.json({ ok: true, ...result });
  }),
);

app.post(
  '/api/inbox/sync',
  asyncRoute(async (req, res) => {
    const instance = String(req.body?.instance || '').trim();
    if (!instance) throw new AppError('instance is required', 400, 'invalid_instance');

    const chats = await evo.findChats(instance);
    const list = Array.isArray(chats) ? chats : Array.isArray(chats?.chats) ? chats.chats : [];
    let synced = 0;

    for (const chat of list) {
      const jid = chat.id || chat.remoteJid || chat.jid;
      if (!jid) continue;
      const last = chat.lastMessage || (Array.isArray(chat.messages) ? chat.messages[0] : null);
      if (!last) continue;

      const message = unwrapMessage(last.message || {});
      const type = detectMessageType(message);
      const content = extractText(message) || `[${type}]`;
      const waMessageId = last.key?.id || `sync-${jid}-${last.messageTimestamp || Date.now()}`;

      try {
        await saveInboxMessage({
          instance,
          remoteJid: jid,
          pushName: chat.name || chat.pushName || jid.split('@')[0],
          messageType: type,
          content,
          isFromMe: Boolean(last.key?.fromMe),
          timestamp: timestampToIso(last.messageTimestamp),
          waMessageId,
        });
        synced += 1;
      } catch (err) {
        console.warn(`[inbox] sync skipped ${jid}: ${err.message}`);
      }
    }

    console.log(`[inbox] synced ${synced}/${list.length} chats from ${instance}`);
    res.json({ ok: true, instance, chats: list.length, synced });
  }),
);

/* --------------------------------- groups --------------------------------- */

app.get(
  '/api/groups',
  asyncRoute(async (req, res) => {
    const [groups, agents] = await Promise.all([listGroups(), listAgents()]);
    res.json({ ok: true, groups, agents });
  }),
);

app.post(
  '/api/groups/sync',
  asyncRoute(async (req, res) => {
    const instance = String(req.body?.instance || '').trim();
    if (!instance) throw new AppError('instance is required', 400, 'invalid_instance');
    const groups = await evo.fetchGroups(instance);
    await upsertGroups(groups);
    console.log(`[groups] synced ${groups.length} groups from ${instance}`);

    if (!isSupabaseConfigured()) {
      return res.json({
        ok: true,
        instance,
        hasSupabase: false,
        warning: MEMORY_WARNING,
        data: memorySnapshot(),
      });
    }

    res.json({ ok: true, instance, hasSupabase: true, groups: await listGroups() });
  }),
);

app.post(
  '/api/groups/host',
  asyncRoute(async (req, res) => {
    const groupJid = String(req.body?.groupJid || '').trim();
    const agentId = String(req.body?.agentId || '').trim();
    if (!groupJid) throw new AppError('groupJid is required', 400, 'missing_group');
    if (!agentId) throw new AppError('agentId is required', 400, 'missing_agent');
    const result = await hostGroup(groupJid, agentId);
    res.json({ ok: true, ...result });
  }),
);

app.delete(
  '/api/groups/host/:jid',
  asyncRoute(async (req, res) => {
    const result = await unhostGroup(req.params.jid);
    res.json({ ok: true, ...result });
  }),
);

app.post(
  '/api/groups/create-agent',
  asyncRoute(async (req, res) => {
    const groupJid = String(req.body?.groupJid || '').trim();
    const groupName = String(req.body?.name || '').trim();
    if (!groupJid) throw new AppError('groupJid is required', 400, 'missing_group');

    const agent = await createAgent({
      name: `${groupName || groupJid.split('@')[0]} Host`,
      instruction:
        `You are the assistant for the WhatsApp group "${groupName || groupJid}". `
        + 'Answer group members briefly and helpfully, keep replies short, and never claim to be a human. '
        + 'Only reply when a message is addressed to you or clearly needs the group assistant.',
      voiceEnabled: false,
      mediaEnabled: false,
      model: 'groq/llama-3.3-70b-versatile',
    });

    await hostGroup(groupJid, agent.id);
    console.log(`[groups] created agent ${agent.name} and hosted ${groupJid}`);
    res.status(201).json({ ok: true, agent: await publicAgent(agent) });
  }),
);

/* ------------------------------- playground ------------------------------- */

app.post(
  '/api/playground',
  asyncRoute(async (req, res) => {
    const agentId = String(req.body?.agentId || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!agentId) throw new AppError('agentId is required', 400, 'missing_agent');
    if (!message) throw new AppError('message is required', 400, 'missing_message');

    const agent = await getAgent(agentId, { withKeys: true });
    if (!agent) throw new AppError('Agent not found', 404, 'agent_not_found');

    const history = Array.isArray(req.body?.history)
      ? req.body.history
          .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
          .slice(-20)
          .map((entry) => ({ role: entry.role, content: String(entry.content || '').slice(0, 4000) }))
      : [];

    const keys = await resolveKeys(agent);
    const result = await callAI({
      model: agent.model,
      messages: buildMessages({ agent, history, userText: message }),
      groqKey: keys.groqKey,
      openrouterKey: keys.openrouterKey,
    });

    res.json({
      ok: true,
      reply: result.text,
      model: result.model,
      provider: result.provider,
      fallbackFrom: result.fallbackFrom,
      usage: result.usage,
    });
  }),
);

/* -------------------------------- telegram -------------------------------- */

app.all(['/telegram', '/telegram/*'], (req, res) => {
  res.status(410).json({
    ok: false,
    disabled: true,
    telegram: TELEGRAM_MESSAGE,
    error: TELEGRAM_MESSAGE,
  });
});

/* ------------------------------ SPA + errors ------------------------------ */

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Not found: ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err instanceof AppError ? err.status : err.statusCode || 500;

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'File too large. Max size is 20 MB.', code: 'file_too_large' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ ok: false, error: 'Too many files. Max 10 per upload.', code: 'too_many_files' });
  }

  if (status >= 500) {
    console.error(`[api] ${req.method} ${req.path} failed: ${errorMessage(err)}`);
  } else {
    console.warn(`[api] ${req.method} ${req.path} rejected: ${errorMessage(err)}`);
  }

  res.status(status).json({
    ok: false,
    error: errorMessage(err),
    code: err.code || 'error',
    ...(err.details ? { details: err.details } : {}),
  });
});

/* --------------------------------- startup -------------------------------- */

async function start() {
  console.log('============================================================');
  console.log(' WhatsApp Groq Router v2');
  console.log(`  port:        ${PORT}`);
  console.log(
    `  supabase:    ${isSupabaseConfigured() ? 'configured (persistent)' : 'not configured - optional, using in-memory store (data resets on restart)'}`,
  );
  console.log(`  evolution:   ${evo.evolutionConfigured() ? 'configured' : 'MISSING'}`);
  console.log(`  groq:        ${process.env.GROQ_API_KEY ? 'env key present' : 'add a key in Settings'}`);
  console.log(`  openrouter:  ${process.env.OPENROUTER_API_KEY ? 'env key present' : 'optional'}`);
  console.log(`  telegram:    ${TELEGRAM_MESSAGE}`);
  console.log('============================================================');

  if (evo.evolutionConfigured()) {
    try {
      const instances = await evo.fetchInstances();
      console.log(`[evolution] ${instances.length} instance(s): ${instances.map((i) => `${i.name}=${i.status}`).join(', ') || 'none'}`);
      for (const instance of instances) {
        console.log(`[evolution] Client ACTIVE for ${instance.name} (status=${instance.status})`);
        if (!/open|connected/i.test(String(instance.status))) {
          console.log(`[evolution] ${instance.name} not connected - open /connect to scan the QR`);
        }
      }
    } catch (err) {
      console.warn(`[evolution] could not list instances: ${err.message}`);
    }
  }

  getModelCatalog().catch(() => null);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`);
    console.log(`[server] webhook base: ${String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '')}/webhook/:instance`);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason instanceof Error ? reason.message : reason);
});

start().catch((err) => {
  console.error('[server] startup failed:', err);
  process.exit(1);
});
