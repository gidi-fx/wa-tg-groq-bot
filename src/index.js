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
  DEFAULT_MODEL,
  extractMediaRequest,
  synthesizeSpeech,
  transcribeAudio,
  TRANSCRIBE_MODEL,
  TTS_MODEL,
  TTS_VOICE,
} from './ai.js';
import * as evo from './evolution.js';
import { getModelReport, getOpenRouterCatalog, isAllowedGroqModel, startModelTests } from './models.js';
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
  hostGroup,
  listAgents,
  listGroups,
  removeAgentMedia,
  saveHistory,
  saveInboxMessage,
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

const PORT = Number(process.env.PORT || 1000);
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

/**
 * Latest QR payload pushed by Evolution webhooks, per instance.
 * `qrcode.updated` carries QR data only - the pairing code always comes from
 * GET /instance/connect and is never read from this cache.
 */
const LATEST_QR = new Map();

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
  if (!value) return DEFAULT_MODEL;
  if (!/^(groq|openrouter)\//.test(value)) {
    throw new AppError('Model must start with "groq/" or "openrouter/"', 400, 'invalid_model');
  }
  // Groq is locked to the two allowed gpt-oss models.
  if (value.startsWith('groq/') && !isAllowedGroqModel(value)) {
    throw new AppError(
      'Groq only supports groq/openai/gpt-oss-120b and groq/openai/gpt-oss-20b. Use openrouter/<any-model> for other models.',
      400,
      'groq_model_not_allowed',
    );
  }
  return value;
}

async function publicAgent(agent) {
  return agent || null;
}

/* --------------------------------- status --------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ok: true,
    hasSupabase: isSupabaseConfigured(),
    persistence: isSupabaseConfigured() ? 'supabase' : 'memory',
    uptime: Math.round(process.uptime()),
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

    res.json({
      ok: true,
      app: 'WhatsApp Groq Router v2',
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
        groq: Boolean(process.env.GROQ_API_KEY),
        openrouter: Boolean(process.env.OPENROUTER_API_KEY),
        tts: TTS_MODEL,
        ttsVoice: TTS_VOICE,
        stt: TRANSCRIBE_MODEL,
        defaultModel: DEFAULT_MODEL,
        keysSource: 'server-env',
      },
      realtime: {
        url: String(process.env.SUPABASE_URL || '').replace(/\/+$/, '') || null,
        anonKey: process.env.SUPABASE_ANON_KEY || null,
      },
      counts,
      modelsSource: 'live-test',
    });
  }),
);

app.get(
  '/api/models',
  asyncRoute(async (req, res) => {
    // Never blocks: while the first live run is in flight it returns testing:true.
    res.json(await getModelReport());
  }),
);

/** Full OpenRouter catalog for the searchable model picker. */
app.get(
  '/api/openrouter/models',
  asyncRoute(async (req, res) => {
    const catalog = await getOpenRouterCatalog({ refresh: req.query.refresh === '1' });
    res.json({ ...catalog, count: catalog.models?.length || 0 });
  }),
);

/**
 * Speech to text with Groq Whisper.
 * Accepts multipart (field "file") or JSON { audioBase64, fileName, mimetype }.
 */
app.post(
  '/api/transcribe',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    let buffer = null;
    let fileName = 'audio.ogg';
    let mimetype = 'audio/ogg';

    if (req.file?.buffer?.length) {
      buffer = req.file.buffer;
      fileName = req.file.originalname || fileName;
      mimetype = req.file.mimetype || mimetype;
    } else if (body.audioBase64) {
      const raw = String(body.audioBase64);
      buffer = Buffer.from(raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw, 'base64');
      fileName = String(body.fileName || fileName);
      mimetype = String(body.mimetype || mimetype);
    } else if (body.audioUrl) {
      const response = await fetch(String(body.audioUrl));
      if (!response.ok) throw new AppError(`Could not download audio (${response.status})`, 400, 'audio_download_failed');
      buffer = Buffer.from(await response.arrayBuffer());
      fileName = String(body.fileName || 'audio.ogg');
      mimetype = String(body.mimetype || response.headers.get('content-type') || 'audio/ogg');
    }

    if (!buffer || !buffer.length) {
      throw new AppError('Send a file field, audioBase64 or audioUrl', 400, 'missing_audio');
    }

    const result = await transcribeAudio(buffer, fileName, mimetype);
    console.log(`[transcribe] ${fileName}: ${result.text.slice(0, 120)}`);
    res.json({ ok: true, text: result.text, model: result.model });
  }),
);

/** Real test run: only the 2 allowed Groq models get a chat completion request. */
app.post(
  '/api/test-groq-models',
  asyncRoute(async (req, res) => {
    console.log('[models] live re-test requested');
    const report = await getModelReport({ refresh: true, wait: true });
    console.log(
      `[models] re-test done: ${report.counts.freeWorking} free / ${report.counts.paidWorking} paid working / ${report.counts.notWorking} not working`,
    );
    res.json(report);
  }),
);

/* -------------------------------- settings -------------------------------- */

app.get('/api/settings', (req, res) => {
  // API keys live only in the server environment. Nothing is editable here.
  res.json({
    ok: true,
    keysSource: 'server-env',
    hasGroq: Boolean(process.env.GROQ_API_KEY),
    hasOpenRouter: Boolean(process.env.OPENROUTER_API_KEY),
    note: 'AI keys are read only from the server environment (GROQ_API_KEY, OPENROUTER_API_KEY).',
  });
});

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
      voiceId: body.voiceId,
      replyMode: body.replyMode,
      mediaEnabled: body.mediaEnabled,
      model: validateModel(body.model),
      mediaFiles: body.mediaFiles,
      connectedInstance: body.connectedInstance,
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
      'voiceId',
      'replyMode',
      'mediaEnabled',
      'mediaFiles',
      'connectedInstance',
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
  const rawName = String(req.body?.instanceName || req.body?.name || '').trim();
  const number = req.body?.number ? digits(req.body.number) : '';
  const name = rawName || (number ? evo.instanceNameForNumber(number) : '');
  if (!name) throw new AppError('A WhatsApp number is required', 400, 'invalid_number');
  const webhookUrl = `${baseUrl(req)}/webhook/${encodeURIComponent(name)}`;
  const result = await evo.createInstance(name, webhookUrl);
  console.log(`[connect] instance ${name} created (webhook=${webhookUrl})`);
  res.status(201).json({ ok: true, ...result });
});

/** Instance names are derived from the phone number: wa-<digits>. */
const connectInstanceHandler = asyncRoute(async (req, res) => {
  const number = digits(req.query.number || req.body?.number || '');
  const instance = req.params.instance
    ? String(req.params.instance).trim()
    : (number ? evo.instanceNameForNumber(number) : '');
  if (!instance) throw new AppError('A WhatsApp number is required', 400, 'invalid_number');

  const webhookUrl = `${baseUrl(req)}/webhook/${encodeURIComponent(instance)}`;
  const ensured = await evo.ensureInstance(instance, webhookUrl);
  // One connect call only. The pairing code comes from this response and nowhere else;
  // the qrcode.updated webhook never carries it, and a second call invalidates the code.
  const data = await evo.connectInstance(instance, number);

  console.log(
    `[connect] ${instance}: pairingCode=${data.pairingCode ? 'yes' : 'no'} qr=${data.base64 ? 'yes' : 'no'}`,
  );

  res.json({
    ok: true,
    instance: data.instance,
    number: data.number,
    state: data.state,
    pairingCode: data.pairingCode || null,
    qr: data.pairingCode ? null : data.base64 || null,
    base64: data.base64 || null,
    count: data.count,
    created: ensured.created,
  });
});

// Public aliases documented for Evolution-style integrations.
app.post('/api/instance/create', createInstanceHandler);
app.post('/instance/create', createInstanceHandler);
app.post('/api/instance/connect', connectInstanceHandler);
app.get('/api/instance/connect', connectInstanceHandler);
app.post('/api/instance/connect/:instance', connectInstanceHandler);
app.get('/api/instance/connect/:instance', connectInstanceHandler);
app.post('/instance/connect/:instance', connectInstanceHandler);
app.get('/instance/connect/:instance', connectInstanceHandler);

/** Latest QR data pushed by the Evolution webhook for an instance (never a pairing code). */
app.get(
  '/api/instance/qr/:instance',
  asyncRoute(async (req, res) => {
    const instance = String(req.params.instance || '').trim();
    // Cache read only: never call connect from here, because every extra connect
    // call invalidates the pairing code the user is trying to enter.
    const cached = LATEST_QR.get(instance) || null;
    res.json({
      ok: true,
      instance,
      pairingCode: null,
      base64: cached?.base64 || null,
      code: cached?.code || null,
      count: cached?.count ?? null,
      updatedAt: cached?.updatedAt || null,
      source: 'webhook',
    });
  }),
);

app.get(
  '/api/instance/status/:instance',
  asyncRoute(async (req, res) => {
    const data = await evo.getInstanceStatus(req.params.instance);
    res.json({ ok: true, ...data });
  }),
);

app.delete(
  '/api/instance/delete/:instance',
  asyncRoute(async (req, res) => {
    const instance = String(req.params.instance || '').trim();
    if (!instance) throw new AppError('instance is required', 400, 'missing_instance');
    await evo.deleteInstance(instance);
    console.log(`[instance] deleted ${instance}`);
    res.json({ ok: true, instance });
  }),
)

app.post(
  '/api/instance/reconnect/:instance',
  asyncRoute(async (req, res) => {
    const instance = String(req.params.instance || '').trim();
    if (!instance) throw new AppError('instance is required', 400, 'missing_instance');
    await evo.reconnectInstance(instance);
    console.log(`[instance] reconnecting ${instance}`);
    res.json({ ok: true, instance });
  }),
)

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
    events: ['MESSAGES_UPSERT', 'QRCODE_UPDATED', 'CONNECTION_UPDATE'],
  });
});

async function handleWebhook(instance, payload) {
  const event = String(payload.event || payload.type || '').toLowerCase();
  const instanceName = payload.instance || payload.instanceName || instance || 'unknown';

  // qrcode.updated only ever carries QR data. It is cached for the QR panel,
  // but the pairing code is never read from it - that only comes from connect.
  if (event.includes('qrcode') || event.includes('qr')) {
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const qr = data.qrcode && typeof data.qrcode === 'object' ? data.qrcode : data;
    const record = {
      pairingCode: null,
      code: qr.code ? String(qr.code) : null,
      base64: qr.base64 || data.base64 || null,
      count: qr.count ?? data.count ?? null,
      updatedAt: new Date().toISOString(),
    };
    LATEST_QR.set(instanceName, record);
    console.log(`[webhook] qrcode.updated ${instanceName}: base64=${record.base64 ? 'yes' : 'no'}`);
    return;
  }

  if (event.includes('connection')) {
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const connectionState = String(data.state || data.connectionStatus || '').toLowerCase();
    console.log(`[webhook] connection.update ${instanceName}: ${connectionState || 'unknown'}`);
    if (/open|connected/.test(connectionState)) LATEST_QR.delete(instanceName);
    return;
  }

  if (event && !event.includes('messages.upsert')) {
    console.log(`[webhook] ignored event ${event || 'unknown'}`);
    return;
  }

  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const key = data.key || {};
  if (key.fromMe) return;

  const remoteJid = String(key.remoteJid || data.remoteJid || '');
  if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast')) return;

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

  // Every agent replies from the WhatsApp account chosen when it was created.
  const sendInstance = agent?.connectedInstance || instanceName;

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
            const transcript = await transcribeAudio(buffer, media.fileName, media.mimetype);
            if (transcript.text) {
              content = transcript.text;
              console.log(`[webhook] voice transcribed (${transcript.model}): ${transcript.text.slice(0, 120)}`);
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

  // A voice note must be answered with a voice note when the agent mirrors the user.
  const isIncomingAudio = Boolean(media && media.kind === 'audio') || messageType === 'audioMessage';

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

  const replyMode = agent.replyMode || (agent.voiceEnabled ? 'voiceOnly' : 'textOnly');
  const voiceWillBeSent =
    replyMode === 'voiceOnly'
    || replyMode === 'both'
    || (replyMode === 'mirror' && isIncomingAudio);
  const presenceKind = voiceWillBeSent ? 'recording' : 'composing';

  // Read receipt first, then show the indicator immediately (before the model
  // call) and keep refreshing it so it never times out while we generate.
  await evo.markAsRead(sendInstance, target, key).catch(() => null);
  const pingPresence = () => {
    evo.sendPresence(sendInstance, target, presenceKind).catch(() => null);
  };
  const presenceInterval = setInterval(pingPresence, 8000);
  pingPresence();

  try {
    const history = await getHistory(remoteJid, 20).catch(() => []);
    await saveHistory(remoteJid, 'user', content);

    const result = await callAI({
      model: agent.model,
      messages: buildMessages({ agent, history, userText: content }),
    });

    let replyText = extractMediaRequest(result.text, agent.mediaFiles).text;
    // Voice notes are synthesised, so keep the text short for faster TTS.
    if (voiceWillBeSent) {
      replyText = replyText.slice(0, 500);
    }

    const wantsVoice =
      replyMode === 'voiceOnly'
      || replyMode === 'both'
      || (replyMode === 'mirror' && isIncomingAudio);
    const wantsText =
      replyMode === 'textOnly'
      || replyMode === 'both'
      || (replyMode === 'mirror' && !isIncomingAudio);

    if (requestedMedia && agent.mediaEnabled) {
      const file = await agentMediaBuffer(requestedMedia);
      await evo.sendMedia(sendInstance, target, {
        media: file.buffer,
        mediatype: mediaTypeFromMime(requestedMedia.type, requestedMedia.name),
        mimetype: requestedMedia.type,
        fileName: requestedMedia.name,
        caption: replyText,
        quoted,
      });
      console.log(`[webhook] replied to ${remoteJid} with media ${requestedMedia.name}`);
    }

    // Apply reply mode: textOnly, voiceOnly, both, or mirror
    if (wantsText && wantsVoice) {
      // Both text and voice
      const ttsStart = Date.now();
      try {
        const speech = await synthesizeSpeech(replyText, { voice: agent.voiceId });
        const ttsDuration = Date.now() - ttsStart;
        await evo.sendAudio(sendInstance, target, speech.buffer, {
          mimetype: speech.mimetype,
          quoted,
        });
        const sendDuration = Date.now() - ttsStart - ttsDuration;
        await evo.sendText(sendInstance, target, replyText, { quoted });
        console.log(`[webhook] replied to ${remoteJid} with both text+voice Groq=${result.usage?.totalTokens || '?'} tokens TTS=${ttsDuration}ms Send=${sendDuration}ms`);
      } catch (err) {
        console.warn(`[webhook] TTS failed - sending text only: ${err.message}`);
        await evo.sendText(sendInstance, target, replyText, { quoted });
      }
    } else if (wantsVoice) {
      // Voice only
      try {
        const speech = await synthesizeSpeech(replyText, { voice: agent.voiceId });
        await evo.sendAudio(sendInstance, target, speech.buffer, {
          mimetype: speech.mimetype,
          quoted,
        });
        console.log(`[webhook] replied to ${remoteJid} with voice only Groq=${result.usage?.totalTokens || '?'} tokens`);
      } catch (err) {
        console.warn(`[webhook] TTS failed - sending text instead: ${err.message}`);
        await evo.sendText(sendInstance, target, replyText, { quoted });
      }
    } else if (wantsText) {
      // Text only
      await evo.sendText(sendInstance, target, replyText, { quoted });
    }

    await saveInboxMessage({
      instance: sendInstance,
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
      .sendText(sendInstance, target, `⚠️ AI error: ${err.message}`.slice(0, 500), { quoted })
      .catch(() => null);
  } finally {
    clearInterval(presenceInterval);
    await evo.sendPresence(sendInstance, target, 'paused').catch(() => null);
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
    let instance = String(req.body?.instance || '').trim();
    const number = req.body?.number ? digits(req.body.number) : '';
    if (!instance && number) instance = evo.instanceNameForNumber(number);
    if (!instance) {
      const instances = await evo.fetchInstances().catch(() => []);
      instance = instances.find((item) => /open|connected/i.test(String(item.status)))?.name
        || instances[0]?.name
        || String(process.env.EVOLUTION_INSTANCE || '').trim();
    }
    if (!instance) throw new AppError('Connect a WhatsApp number first', 409, 'no_instance');

    const groups = await evo.fetchGroups(instance);
    await upsertGroups(groups);
    console.log(`[groups] synced ${groups.length} groups from ${instance}`);
    const saved = await listGroups();

    if (!isSupabaseConfigured()) {
      return res.json({
        ok: true,
        instance,
        hasSupabase: false,
        warning: MEMORY_WARNING,
        groups: saved,
        data: memorySnapshot(),
      });
    }

    res.json({ ok: true, instance, hasSupabase: true, groups: saved });
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

    const instances = await evo.fetchInstances().catch(() => []);
    const connected = instances.find((item) => /open|connected/i.test(String(item.status))) || null;
    if (!connected) throw new AppError('Connect WhatsApp first in Connect page', 409, 'no_connected_instance');

    const agent = await createAgent({
      name: `${groupName || groupJid.split('@')[0]} Host`,
      instruction:
        `You are the assistant for the WhatsApp group "${groupName || groupJid}". `
        + 'Answer group members briefly and helpfully, keep replies short, and never claim to be a human. '
        + 'Only reply when a message is addressed to you or clearly needs the group assistant.',
      voiceEnabled: false,
      mediaEnabled: false,
      model: DEFAULT_MODEL,
      connectedInstance: connected.name,
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

    const agent = await getAgent(agentId);
    if (!agent) throw new AppError('Agent not found', 404, 'agent_not_found');

    const history = Array.isArray(req.body?.history)
      ? req.body.history
          .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
          .slice(-20)
          .map((entry) => ({ role: entry.role, content: String(entry.content || '').slice(0, 4000) }))
      : [];

    const result = await callAI({
      model: agent.model,
      messages: buildMessages({ agent, history, userText: message }),
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
  console.log(`  groq:        ${process.env.GROQ_API_KEY ? 'env key present' : 'MISSING GROQ_API_KEY'}`);
  console.log(`  openrouter:  ${process.env.OPENROUTER_API_KEY ? 'env key present' : 'optional'}`);
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

  // Test every model live on boot so the Agents page never shows a fake list.
  try {
    const report = await getModelReport();
    console.log('[models] initial model report loaded:', report.counts.freeWorking, 'free /', report.counts.paidWorking, 'paid /', report.counts.notWorking, 'not working');
  } catch (err) {
    console.warn('[models] initial model report failed:', err.message);
  }
  startModelTests();

  const port = process.env.PORT || 1000;
  app.listen(port, '0.0.0.0', () => {
    console.log('[server] Listening on', port);
    console.log(`[server] listening on http://0.0.0.0:${port}`);
    console.log(`[server] webhook base: ${String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '')}/webhook/:instance`);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason instanceof Error ? reason.message : reason);
});

start().catch((err) => {
  console.error('[server] startup failed:', err);
  process.exit(1);
});
