import { AppError } from './errors.js';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_MS = 10 * 60 * 1000;

const GROQ_MODELS = [
  {
    id: 'groq/llama-3.1-8b-instant',
    label: 'Llama 3.1 8B Instant',
    note: 'Fastest free model',
    free: true,
    pricePer1k: 0,
  },
  {
    id: 'groq/llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B Versatile',
    note: 'BEST FREE - recommended',
    free: true,
    pricePer1k: 0,
  },
  {
    id: 'groq/mixtral-8x7b-32768',
    label: 'Mixtral 8x7B 32k',
    note: 'Free (availability depends on Groq)',
    free: true,
    pricePer1k: 0,
  },
  {
    id: 'groq/gemma2-9b-it',
    label: 'Gemma 2 9B',
    note: 'Free (availability depends on Groq)',
    free: true,
    pricePer1k: 0,
  },
];

const FALLBACK_FREE = [
  'meta-llama/llama-3.1-8b-instruct:free',
  'qwen/qwen-2.5-7b-instruct:free',
  'google/gemma-2-9b-it:free',
  'deepseek/deepseek-r1:free',
  'mistralai/mistral-7b-instruct:free',
].map((id) => ({
  id: `openrouter/${id}`,
  label: id.split('/').slice(1).join('/').replace(':free', '') + ' (free)',
  free: true,
  pricePer1k: 0,
}));

const FALLBACK_PAID = [
  { id: 'openrouter/anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'openrouter/openai/gpt-4o', label: 'GPT-4o' },
  { id: 'openrouter/openai/gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'openrouter/google/gemini-pro-1.5', label: 'Gemini 1.5 Pro' },
].map((model) => ({ ...model, free: false, pricePer1k: null }));

let cache = { at: 0, catalog: null };

function pricePer1k(pricing, key) {
  const value = Number(pricing?.[key]);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 1000 * 1000000) / 1000000;
}

function normalizeOpenRouter(models) {
  const free = [];
  const paid = [];

  for (const model of models) {
    if (!model?.id) continue;
    const promptPrice = Number(model.pricing?.prompt || 0);
    const completionPrice = Number(model.pricing?.completion || 0);
    const isFree = model.id.endsWith(':free') || (promptPrice === 0 && completionPrice === 0);
    const entry = {
      id: `openrouter/${model.id}`,
      label: model.name || model.id,
      free: isFree,
      pricePer1k: isFree ? 0 : pricePer1k(model.pricing, 'prompt'),
      contextLength: model.context_length || null,
      note: model.description ? String(model.description).slice(0, 140) : '',
    };
    if (isFree) free.push(entry);
    else paid.push(entry);
  }

  // Keep paid lists useful: cheapest prompt price first, cap at 150 entries.
  paid.sort((a, b) => (a.pricePer1k ?? Number.MAX_SAFE_INTEGER) - (b.pricePer1k ?? Number.MAX_SAFE_INTEGER));

  return { free, paid: paid.slice(0, 150) };
}

async function fetchOpenRouterCatalog() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new AppError(`OpenRouter models returned ${response.status}`, 502, 'openrouter_models_failed');
    const payload = await response.json();
    const models = Array.isArray(payload?.data) ? payload.data : [];
    if (!models.length) throw new Error('OpenRouter returned no models');
    return normalizeOpenRouter(models);
  } finally {
    clearTimeout(timer);
  }
}

export async function getModelCatalog({ refresh = false } = {}) {
  if (!refresh && cache.catalog && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.catalog, cached: true };
  }

  let openrouter;
  let source = 'live';
  try {
    openrouter = await fetchOpenRouterCatalog();
  } catch (err) {
    source = 'fallback';
    console.warn(`[models] live OpenRouter catalog unavailable (${err.message}) - using built-in list`);
    openrouter = { free: FALLBACK_FREE, paid: FALLBACK_PAID };
  }

  const catalog = {
    free: [...GROQ_MODELS.map((m) => ({ ...m, provider: 'groq' })), ...openrouter.free],
    paid: openrouter.paid,
    source,
    fetchedAt: new Date().toISOString(),
  };

  cache = { at: Date.now(), catalog };
  return { ...catalog, cached: false };
}

export function isKnownModel(id) {
  return Boolean(id && typeof id === 'string' && /^(groq|openrouter)\//.test(id));
}
