import { AppError, errorMessage } from './errors.js';

const GROQ_BASE = String(process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const OPENROUTER_BASE = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

export const TRANSCRIBE_MODEL = String(process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3');
export const TRANSCRIBE_FALLBACK_MODEL = String(process.env.GROQ_TRANSCRIBE_FALLBACK_MODEL || 'whisper-large-v3-turbo');
// Groq retired playai-tts on 2025-12-31; Orpheus (Canopy Labs) is the current TTS family.
export const TTS_MODEL = String(process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english');
export const TTS_VOICE = String(process.env.GROQ_TTS_VOICE || 'troy');
export const TTS_FORMAT = String(process.env.GROQ_TTS_FORMAT || 'wav');
export const GROQ_MODEL_IDS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
export const DEFAULT_MODEL = 'groq/openai/gpt-oss-120b';
export const FALLBACK_MODEL = 'groq/openai/gpt-oss-20b';

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

async function requestChat({ model, messages, temperature, maxTokens }) {
  const parsed = parseModelId(model);

  if (parsed.provider === 'groq') {
    const key = String(process.env.GROQ_API_KEY || '').trim();
    if (!key) {
      throw new AppError(
        'Groq API key is not configured on the server. Add GROQ_API_KEY to the backend .env.',
        503,
        'missing_groq_key',
      );
    }

    // Groq accepts both "openai/gpt-oss-120b" and the bare "gpt-oss-120b".
    // Try the id as given, then the same id without the openai/ prefix.
    const candidates = [parsed.id];
    if (/^openai\//.test(parsed.id)) candidates.push(parsed.id.replace(/^openai\//, ''));

    let lastError = null;
    for (const modelId of candidates) {
      try {
        const payload = await postJSON(
          `${GROQ_BASE}/chat/completions`,
          {
            model: modelId,
            messages,
            temperature,
            max_tokens: maxTokens,
          },
          { Authorization: `Bearer ${key}` },
          'Groq',
        );
        return { payload, provider: 'groq', model: `groq/${modelId}` };
      } catch (err) {
        lastError = err;
        // Only retry the bare id when Groq says the model does not exist.
        const modelMissing = /model.*(does not exist|not found|decommissioned|invalid)/i.test(err.message || '');
        if (modelId === candidates[candidates.length - 1] || !modelMissing) throw err;
        console.warn(`[ai] Groq model ${modelId} unavailable, retrying without prefix`);
      }
    }
    throw lastError;
  }

  const key = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!key) {
    throw new AppError(
      'OpenRouter API key is not configured on the server. Add OPENROUTER_API_KEY to the backend .env.',
      400,
      'missing_openrouter_key',
    );
  }

  const headers = {
    'HTTP-Referer': String(process.env.PUBLIC_URL || 'https://whatsapp-groq-router'),
    'X-Title': 'WhatsApp Groq Router v2',
    Authorization: `Bearer ${key}`,
  };

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
 * selected -> groq/openai/gpt-oss-20b -> error message.
 */
export async function callAI({ model, messages, temperature = 0.7, maxTokens = 800 }) {
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

/**
 * Groq Whisper speech-to-text.
 * Tries whisper-large-v3 first, then whisper-large-v3-turbo.
 * Node 18+ FormData/Blob keeps this dependency-free.
 */
export async function transcribeAudio(buffer, fileName = 'audio.ogg', mimetype = 'audio/ogg') {
  const key = String(process.env.GROQ_API_KEY || '').trim();
  if (!key) throw new AppError('GROQ_API_KEY is not configured on the server (voice transcription)', 503, 'missing_groq_key');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new AppError('Empty audio file', 400, 'empty_audio');

  const models = [TRANSCRIBE_MODEL, TRANSCRIBE_FALLBACK_MODEL]
    .filter((model, index, list) => model && list.indexOf(model) === index);

  let lastError = null;
  for (const model of models) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimetype }), fileName);
    form.append('model', model);
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
        lastError = new AppError(`Transcription failed (${response.status}): ${text.slice(0, 200)}`, 502, 'transcription_failed');
        console.warn(`[stt] ${model} failed (${response.status}) - trying next model`);
        continue;
      }
      const payload = text ? JSON.parse(text) : {};
      return { text: String(payload.text || '').trim(), model };
    } catch (err) {
      if (err instanceof AppError) {
        lastError = err;
        continue;
      }
      lastError = new AppError(`Transcription request failed: ${errorMessage(err)}`, 502, 'transcription_failed');
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new AppError('Transcription failed', 502, 'transcription_failed');
}

/**
 * Text -> speech. ElevenLabs is used when configured, otherwise Groq TTS.
 * Returns { buffer, mimetype, provider }.
 */
export async function synthesizeSpeech(text) {
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

  const key = String(process.env.GROQ_API_KEY || '').trim();
  if (!key) throw new AppError('GROQ_API_KEY is not configured on the server (voice replies)', 503, 'missing_groq_key');

  // Groq TTS = Canopy Labs Orpheus (playai-tts was retired 2025-12-31).
  const formats = [TTS_FORMAT, 'wav'].filter((value, index, list) => value && list.indexOf(value) === index);
  let lastError = null;

  for (const format of formats) {
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
      const detail = (await response.text()).slice(0, 300);
      lastError = new AppError(`Groq TTS failed (${response.status}): ${detail}`, 502, 'tts_failed');
      console.warn(`[tts] Groq ${format} failed (${response.status}): ${detail.slice(0, 160)}`);
      continue;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
      lastError = new AppError('Groq TTS returned empty audio', 502, 'tts_failed');
      continue;
    }
    return { buffer, mimetype: TTS_MIME[format] || 'audio/wav', provider: 'groq', model: TTS_MODEL, voice: TTS_VOICE };
  }

  throw lastError || new AppError('Groq TTS failed', 502, 'tts_failed');
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
