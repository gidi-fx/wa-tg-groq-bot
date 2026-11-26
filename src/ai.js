import { AppError, errorMessage } from './errors.js';

const GROQ_BASE = String(process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const OPENROUTER_BASE = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

export const TRANSCRIBE_MODEL = String(process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3');
export const TTS_MODEL = String(process.env.GROQ_TTS_MODEL || 'playai-tts');
export const TTS_VOICE = String(process.env.GROQ_TTS_VOICE || 'Fritz-PlayAI');
export const FALLBACK_MODEL = 'groq/llama-3.1-8b-instant';

const TTS_MIME = {
  ogg: 'audio/ogg; codecs=opus',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

export function parseModelId(model) {
  const raw = String(model || '').trim() || FALLBACK_MODEL;
  if (raw.startsWith('groq/')) return { provider: 'groq', id: raw.slice('groq/'.length), full: raw };
  if (raw.startsWith('openrouter/')) {
    return { provider: 'openrouter', id: raw.slice('openrouter/'.length), full: raw };
  }
  return { provider: 'groq', id: raw, full: `groq/${raw}` };
}

export function isFreeModel(model) {
  const parsed = parseModelId(model);
  return parsed.provider === 'groq' || parsed.id.endsWith(':free');
}

export function stripThinking(text) {
  let out = String(text || '');
  while (out.includes('<think')) {
    const start = out.indexOf('<think');
    const closeTag = out.indexOf('</think', start);
    if (closeTag === -1) {
      out = out.slice(0, start).trim();
      break;
    }
    const closeBracket = out.indexOf('>', closeTag);
    out = (out.slice(0, start) + ' ' + (closeBracket === -1 ? '' : out.slice(closeBracket + 1))).trim();
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Build the chat message array sent to the selected model. */
export function buildMessages({ agent, history = [], userText }) {
  const files = Array.isArray(agent?.mediaFiles) ? agent.mediaFiles : [];
  let system = String(agent?.instruction || '').trim()
    || 'You are a helpful WhatsApp assistant. Reply clearly and keep messages short.';

  if (agent?.name) system += `\n\nYour name is "${agent.name}".`;
  system += '\n\nYou are chatting on WhatsApp. Use plain text, short paragraphs, no markdown tables.';

  if (agent?.mediaEnabled && files.length) {
    const list = files.map((file) => `- ${file.name}`).join('\n');
    system += `\n\nYou can send these real files when the user asks:\n${list}\n`
      + 'To send one, include the exact token [[SEND_MEDIA: file-name]] in your reply (one file per reply). '
      + 'The app removes the token and sends the file. Only do this when it is clearly wanted.';
  }

  const messages = [{ role: 'system', content: system }];
  for (const entry of history.slice(-20)) {
    if (!entry || !entry.content) continue;
    const role = entry.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, content: String(entry.content).slice(0, 4000) });
  }
  messages.push({ role: 'user', content: String(userText || '').slice(0, 8000) });
  return messages;
}

async function postJSON(url, body, headers, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.error || payload?.message || text || response.statusText;
      throw new AppError(`${label} error ${response.status}: ${String(detail).slice(0, 300)}`, 502, 'ai_request_failed', {
        status: response.status,
        provider: label,
      });
    }
    return payload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err.name === 'AbortError') throw new AppError(`${label} timed out after 60s`, 504, 'ai_timeout');
    throw new AppError(`${label} request failed: ${errorMessage(err)}`, 502, 'ai_request_failed');
  } finally {
    clearTimeout(timer);
  }
}

async function requestChat({ model, messages, temperature, maxTokens, groqKey, openrouterKey }) {
  const parsed = parseModelId(model);

  if (parsed.provider === 'groq') {
    const key = String(groqKey || process.env.GROQ_API_KEY || '').trim();
    if (!key) {
      throw new AppError(
        'No Groq API key. Add your own key in Settings (BYOK) or set GROQ_API_KEY.',
        400,
        'missing_groq_key',
      );
    }
    const payload = await postJSON(
      `${GROQ_BASE}/chat/completions`,
      {
        model: parsed.id,
        messages,
        temperature,
        max_tokens: maxTokens,
      },
      { Authorization: `Bearer ${key}` },
      'Groq',
    );
    return { payload, provider: 'groq', model: parsed.full };
  }

  const key = String(openrouterKey || process.env.OPENROUTER_API_KEY || '').trim();
  if (!key) {
    if (!isFreeModel(parsed.full)) {
      throw new AppError('Add OpenRouter key in Settings to use paid models', 400, 'missing_openrouter_key');
    }
    // Free models still need an OpenRouter key on their side; let the request fail
    // and the router fall back to a Groq free model.
    console.warn('[ai] no OpenRouter key - free OpenRouter models fall back to Groq');
  }

  const headers = {
    'HTTP-Referer': String(process.env.PUBLIC_URL || 'https://whatsapp-groq-router'),
    'X-Title': 'WhatsApp Groq Router v2',
  };
  if (key) headers.Authorization = `Bearer ${key}`;

  const payload = await postJSON(
    `${OPENROUTER_BASE}/chat/completions`,
    {
      model: parsed.id,
      messages,
      temperature,
      max_tokens: maxTokens,
    },
    headers,
    'OpenRouter',
  );
  return { payload, provider: 'openrouter', model: parsed.full };
}

/**
 * Call the selected model, with the required fallback chain:
 * selected -> groq/llama-3.1-8b-instant -> error message.
 */
export async function callAI({
  model,
  messages,
  groqKey,
  openrouterKey,
  temperature = 0.7,
  maxTokens = 800,
}) {
  const selected = parseModelId(model).full;
  const chain = [selected, FALLBACK_MODEL].filter((value, index, list) => list.indexOf(value) === index);
  const attempts = [];

  for (const candidate of chain) {
    try {
      const { payload, provider, model: used } = await requestChat({
        model: candidate,
        messages,
        temperature,
        maxTokens,
        groqKey,
        openrouterKey,
      });

      const choice = payload?.choices?.[0];
      let text = stripThinking(choice?.message?.content || '');
      if (!text) text = "Sorry, I couldn't generate a reply just now. Please try again.";

      const usage = {
        promptTokens: payload?.usage?.prompt_tokens ?? null,
        completionTokens: payload?.usage?.completion_tokens ?? null,
        totalTokens: payload?.usage?.total_tokens ?? null,
      };

      return {
        text,
        usage,
        model: used,
        provider,
        fallbackFrom: used !== selected ? selected : null,
        attempts,
      };
    } catch (err) {
      attempts.push({ model: candidate, error: err.message, code: err.code || null });
      const blockedPaid = err.code === 'missing_openrouter_key';
      const onlyGroq = parsedProvider(candidate) === 'groq' && err.code === 'missing_groq_key';
      if (blockedPaid || onlyGroq) throw err;
      console.warn(`[ai] ${candidate} failed: ${err.message}`);
    }
  }

  throw new AppError(
    `AI request failed. ${attempts.map((a) => `${a.model}: ${a.error}`).join(' | ')}`,
    502,
    'ai_failed',
    { attempts },
  );
}

function parsedProvider(model) {
  return parseModelId(model).provider;
}

/** Groq Whisper transcription. Node 18+ FormData/Blob keeps this dependency-free. */
export async function transcribeAudio(buffer, fileName = 'audio.ogg', groqKey = '', mimetype = 'audio/ogg') {
  const key = String(groqKey || process.env.GROQ_API_KEY || '').trim();
  if (!key) throw new AppError('No Groq API key for voice transcription', 400, 'missing_groq_key');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new AppError('Empty audio file', 400, 'empty_audio');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), fileName);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AppError(`Transcription failed (${response.status}): ${text.slice(0, 200)}`, 502, 'transcription_failed');
    }
    const payload = text ? JSON.parse(text) : {};
    return String(payload.text || '').trim();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`Transcription request failed: ${errorMessage(err)}`, 502, 'transcription_failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Text -> speech. ElevenLabs is used when configured, otherwise Groq TTS.
 * Returns { buffer, mimetype, provider }.
 */
export async function synthesizeSpeech(text, { groqKey = '' } = {}) {
  const input = String(text || '')
    .replace(/\[\[SEND_MEDIA:[^\]]+\]\]/gi, '')
    .replace(/[*_~`#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!input) throw new AppError('Nothing to speak', 400, 'empty_tts_input');

  const elevenKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
  if (elevenKey) {
    try {
      const voiceId = String(process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM');
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': elevenKey },
          body: JSON.stringify({ text: input.slice(0, 2500), model_id: 'eleven_turbo_v2_5' }),
        },
      );
      if (!response.ok) throw new Error(`ElevenLabs ${response.status}: ${(await response.text()).slice(0, 160)}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new Error('empty audio');
      return { buffer, mimetype: 'audio/mpeg', provider: 'elevenlabs' };
    } catch (err) {
      console.warn(`[tts] ElevenLabs failed (${err.message}) - trying Groq TTS`);
    }
  }

  const key = String(groqKey || process.env.GROQ_API_KEY || '').trim();
  if (!key) throw new AppError('No Groq API key for voice replies', 400, 'missing_groq_key');

  const format = String(process.env.GROQ_TTS_FORMAT || 'ogg');
  const response = await fetch(`${GROQ_BASE}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: input.slice(0, 3500),
      response_format: format,
    }),
  });

  if (!response.ok) {
    throw new AppError(`Groq TTS failed (${response.status}): ${(await response.text()).slice(0, 200)}`, 502, 'tts_failed');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new AppError('Groq TTS returned empty audio', 502, 'tts_failed');
  return { buffer, mimetype: TTS_MIME[format] || 'audio/ogg', provider: 'groq' };
}

/** Pull an optional [[SEND_MEDIA: file]] instruction out of the model reply. */
export function extractMediaRequest(reply, mediaFiles = []) {
  const files = Array.isArray(mediaFiles) ? mediaFiles : [];
  const pattern = /\[{1,2}\s*SEND_MEDIA:\s*([^\]\n]+?)\s*\]{1,2}/i;
  const match = String(reply || '').match(pattern);
  if (!match || !files.length) return { text: String(reply || '').trim(), media: null };

  const wanted = match[1].trim().toLowerCase();
  const file =
    files.find((item) => String(item.name).toLowerCase() === wanted) ||
    files.find((item) => String(item.path).toLowerCase() === wanted) ||
    files.find((item) => String(item.name).toLowerCase().includes(wanted));

  const text = String(reply).replace(pattern, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, media: file || null };
}
