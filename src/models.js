/**
 * Model catalog + live testing.
 *
 * Groq: EXACTLY two models are allowed (gpt-oss-120b, gpt-oss-20b). Nothing else
 * is listed or selectable. Each id is probed with and without the `openai/` prefix.
 *
 * OpenRouter: the full catalog is exposed so the UI can search it, and the user
 * may also type any model id by hand.
 */
const GROQ_BASE = String(process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const OPENROUTER_BASE = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

const CACHE_MS = 60 * 60 * 1000;
const TEST_TIMEOUT_MS = 20000;
const LIST_TIMEOUT_MS = 15000;
const GROQ_TEST_CONCURRENCY = 2;
const OPENROUTER_TEST_LIMIT = 15;

/** The only Groq models this app allows, with their UI labels. */
export const GROQ_MODELS = [
  {
    id: 'groq/openai/gpt-oss-120b',
    apiId: 'openai/gpt-oss-120b',
    label: '1. gpt-oss-120b - BEST (Sales/Coding)',
  },
  {
    id: 'groq/openai/gpt-oss-20b',
    apiId: 'openai/gpt-oss-20b',
    label: '2. gpt-oss-20b - FASTEST',
  },
];

const GROQ_ALLOWED = new Set(GROQ_MODELS.map((model) => model.id));

const state = {
  groq: { at: 0, models: null, error: null, running: null },
  openrouter: { at: 0, models: null, error: null, running: null },
  openrouterCatalog: { at: 0, models: null, running: null },
};

export function isAllowedGroqModel(id) {
  return GROQ_ALLOWED.has(String(id || ''));
}

async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;

  async function run() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
    }
  }

  const lanes = Array.from({ length: Math.min(limit, list.length) }, () => run());
  await Promise.all(lanes);
  return results;
}

async function readJSON(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Real chat completion: HTTP 200 with non-empty choices[0].message.content means
 * the model replies. Reasoning models (gpt-oss) spend the token budget on
 * reasoning first, so max_tokens must be well above 5 or content comes back empty
 * and the probe wrongly reports a working model as "failed: HTTP 200".
 */
async function probeChat({ url, apiId, headers, label }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        model: apiId,
        messages: [{ role: 'user', content: 'Say hi in one short sentence.' }],
        max_tokens: 256,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    const choice = payload?.choices?.[0];
    const content = choice?.message?.content;
    const working = response.ok && typeof content === 'string' && content.trim().length > 0;
    if (!working && response.ok) {
      console.warn(
        `[models] ${label} ${apiId}: HTTP ${response.status} but no content `
        + `(finish_reason=${choice?.finish_reason || 'unknown'}) raw body: ${raw.slice(0, 1200)}`,
      );
    }
    return {
      working,
      latency: Date.now() - started,
      error: working
        ? null
        : String(
          payload?.error?.message
          || payload?.message
          || (response.ok ? `HTTP ${response.status} with empty content` : `HTTP ${response.status}`),
        ).slice(0, 220),
      status: response.status,
      label,
    };
  } catch (err) {
    return {
      working: false,
      latency: Date.now() - started,
      error: err.name === 'AbortError' ? `${label} timed out after ${TEST_TIMEOUT_MS}ms` : String(err.message || err).slice(0, 220),
      status: 0,
      label,
    };
  } finally {
    clearTimeout(timer);
  }
}

function entry({ provider, id, apiId, displayName, tier, working, latency, error }) {
  return {
    id,
    provider,
    apiId,
    displayName,
    tier,
    price: tier === 'FREE' ? 'Free (Groq free tier)' : 'Paid',
    working: Boolean(working),
    status: working ? 'working' : 'failed',
    latency: Number.isFinite(latency) ? latency : null,
    error: error || null,
  };
}

/**
 * Groq: probe the 2 allowed models only.
 * Each is tried as `openai/gpt-oss-...` and then as bare `gpt-oss-...`.
 */
async function runGroqTests() {
  const apiKey = String(process.env.GROQ_API_KEY || '').trim();

  const build = (model, working, latency, error) => entry({
    provider: 'groq',
    id: model.id,
    apiId: model.apiId,
    displayName: model.label,
    tier: 'FREE',
    working,
    latency,
    error,
  });

  if (!apiKey) {
    state.groq = {
      at: Date.now(),
      models: GROQ_MODELS.map((model) => build(model, false, null, 'GROQ_API_KEY is not set on the server')),
      error: 'GROQ_API_KEY is not set on the server',
      running: null,
    };
    console.warn('[models] GROQ_API_KEY missing - cannot test Groq models');
    return state.groq;
  }

  console.log(`[models] testing ${GROQ_MODELS.length} allowed Groq models live...`);
  const results = await mapLimit(GROQ_MODELS, GROQ_TEST_CONCURRENCY, async (model) => {
    const bare = model.apiId.replace(/^openai\//, '');
    const candidates = [model.apiId, bare].filter((value, index, list) => list.indexOf(value) === index);

    let lastError = 'model does not exist on Groq';
    for (const apiId of candidates) {
      const probe = await probeChat({
        url: `${GROQ_BASE}/chat/completions`,
        apiId,
        headers: { Authorization: `Bearer ${apiKey}` },
        label: 'Groq',
      });
      if (probe.working) {
        console.log(`[models] Groq ${model.apiId} replied as "${apiId}" in ${probe.latency}ms`);
        return build(model, true, probe.latency, null);
      }
      lastError = probe.error || lastError;
      const missing = /does not exist|not found|decommissioned|invalid/i.test(lastError);
      if (!missing) break;
    }

    console.warn(`[models] Groq ${model.apiId} failed: ${lastError}`);
    return build(model, false, null, lastError);
  });

  const working = results.filter((model) => model.working).length;
  console.log(`[models] Groq: ${working}/${results.length} allowed models replied`);
  state.groq = { at: Date.now(), models: results, error: null, running: null };
  return state.groq;
}

/** Full OpenRouter catalog (all models, free and paid). */
export async function getOpenRouterCatalog({ refresh = false } = {}) {
  const cached = state.openrouterCatalog;
  if (!refresh && cached.models && Date.now() - cached.at < CACHE_MS) {
    return { ok: true, models: cached.models, cached: true };
  }
  if (cached.running) return cached.running;

  cached.running = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
    try {
      const response = await fetch(`${OPENROUTER_BASE}/models`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenRouter models returned ${response.status}`);
      const payload = await readJSON(response);
      const list = Array.isArray(payload?.data) ? payload.data : [];
      const models = list
        .filter((model) => model && typeof model.id === 'string')
        .map((model) => ({
          id: model.id,
          name: model.name || model.id,
          free: model.id.endsWith(':free'),
          context: model.context_length ?? null,
          promptPrice: model.pricing?.prompt ?? null,
          completionPrice: model.pricing?.completion ?? null,
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));

      state.openrouterCatalog = { at: Date.now(), models, running: null };
      console.log(`[models] OpenRouter catalog loaded: ${models.length} models`);
      return { ok: true, models, cached: false };
    } catch (err) {
      state.openrouterCatalog = { at: 0, models: [], running: null };
      console.warn(`[models] OpenRouter catalog failed: ${err.message}`);
      return { ok: false, models: [], error: err.message };
    } finally {
      clearTimeout(timer);
    }
  })();

  const result = await state.openrouterCatalog.running;
  return result;
}

/** Probe a sample of the OpenRouter catalog so the UI can show what replies. */
async function runOpenRouterTests() {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) {
    state.openrouter = {
      at: Date.now(),
      models: [],
      error: 'OPENROUTER_API_KEY is not set on the server',
      running: null,
    };
    console.log('[models] OPENROUTER_API_KEY missing - skipping OpenRouter model tests');
    return state.openrouter;
  }

  const catalog = await getOpenRouterCatalog();
  if (!catalog.ok) {
    state.openrouter = { at: Date.now(), models: [], error: catalog.error, running: null };
    return state.openrouter;
  }

  const free = catalog.models.filter((model) => model.free);
  const sample = free.slice(0, OPENROUTER_TEST_LIMIT);
  console.log(`[models] testing ${sample.length}/${catalog.models.length} OpenRouter models live...`);

  const results = await mapLimit(sample, 6, async (model) => {
    const probe = await probeChat({
      url: `${OPENROUTER_BASE}/chat/completions`,
      apiId: model.id,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': String(process.env.PUBLIC_URL || 'https://whatsapp-groq-router'),
        'X-Title': 'WhatsApp Groq Router v2',
      },
      label: 'OpenRouter',
    });
    return entry({
      provider: 'openrouter',
      id: `openrouter/${model.id}`,
      apiId: model.id,
      displayName: String(model.name || model.id).replace(/\s*\(free\)\s*$/i, ''),
      tier: 'FREE',
      working: probe.working,
      latency: probe.latency,
      error: probe.error,
    });
  });

  const working = results.filter((model) => model.working).length;
  console.log(`[models] OpenRouter: ${working}/${results.length} tested free models replied`);
  state.openrouter = { at: Date.now(), models: results, error: null, running: null };
  return state.openrouter;
}

function fresh(bucket) {
  return bucket.models && Date.now() - bucket.at < CACHE_MS;
}

async function ensureGroq({ refresh = false } = {}) {
  if (!refresh && fresh(state.groq)) return state.groq;
  if (state.groq.running) return state.groq.running;
  state.groq.running = runGroqTests();
  const result = await state.groq.running;
  return result;
}

async function ensureOpenRouter({ refresh = false } = {}) {
  if (!refresh && fresh(state.openrouter)) return state.openrouter;
  if (state.openrouter.running) return state.openrouter.running;
  state.openrouter.running = runOpenRouterTests();
  const result = await state.openrouter.running;
  return result;
}

function legacyShape(model) {
  return {
    id: model.id,
    label: model.displayName,
    free: model.tier === 'FREE',
    pricePer1k: model.tier === 'FREE' ? 0 : null,
    provider: model.provider,
    tier: model.tier,
    working: model.working,
    latency: model.latency,
    status: model.status,
  };
}

export async function getModelReport({ refresh = false, wait = false } = {}) {
  if (wait) {
    await Promise.all([ensureGroq({ refresh }), ensureOpenRouter({ refresh })]);
  } else if (!refresh && (!fresh(state.groq) || !fresh(state.openrouter))) {
    if (!state.groq.running || !state.openrouter.running) startModelTests();
  }

  const groq = state.groq;
  const openrouter = state.openrouter;
  const models = [...(groq.models || []), ...(openrouter.models || [])];
  const freeWorking = models.filter((model) => model.working && model.tier === 'FREE');
  const paidWorking = models.filter((model) => model.working && model.tier === 'PAID');
  const notWorking = models.filter((model) => !model.working);

  const testedAt = state.groq.at || state.openrouter.at
    ? new Date(Math.max(state.groq.at || 0, state.openrouter.at || 0)).toISOString()
    : null;

  return {
    ok: true,
    source: 'live-test',
    tested: Boolean(testedAt),
    testing: Boolean(state.groq.running || state.openrouter.running),
    testingDetail: {
      groq: Boolean(state.groq.running),
      openrouter: Boolean(state.openrouter.running),
    },
    testedAt,
    cachedForMinutes: Math.round(CACHE_MS / 60000),
    errors: [groq.error, openrouter.error].filter(Boolean),
    // The only Groq models the app ever offers.
    groqAllowed: GROQ_MODELS.map((model) => ({ id: model.id, label: model.label, apiId: model.apiId })),
    groups: { freeWorking, paidWorking, notWorking },
    free: freeWorking.map(legacyShape),
    paid: paidWorking.map(legacyShape),
    counts: {
      freeWorking: freeWorking.length,
      paidWorking: paidWorking.length,
      notWorking: notWorking.length,
    },
  };
}

/** Kick off both test runs without blocking startup. */
export function startModelTests() {
  ensureGroq().catch((err) => console.warn(`[models] Groq test run failed: ${err.message}`));
  ensureOpenRouter().catch((err) => console.warn(`[models] OpenRouter test run failed: ${err.message}`));
}

export function isKnownModel(id) {
  return Boolean(id && typeof id === 'string' && /^(groq|openrouter)\//.test(id));
}

export function getModels() {
  return [];
}

export function getModelCatalog() {
  return getModels();
}
