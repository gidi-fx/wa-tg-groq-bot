/** Live model testing.
 * Nothing here is a hardcoded catalog: every model shown in the UI has just been asked to complete a real chat request with the server's own API keys.
 * Results are cached for one hour and refreshed on demand.
 */
const GROQ_BASE = String(process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const OPENROUTER_BASE = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

const CACHE_MS = 60 * 60 * 1000;
const TEST_TIMEOUT_MS = 20000;
const LIST_TIMEOUT_MS = 15000;
const TEST_CONCURRENCY = 6;
const OPENROUTER_TEST_LIMIT = 15;

/** Groq's free tier is the Llama 3.x / Mixtral / Gemma family; everything else bills. */
const FREE_MODEL_PATTERN = /^(llama-?3|mixtral|gemma)/i;

const state = {
  groq: { at: 0, models: null, error: null, running: null },
  openrouter: { at: 0, models: null, error: null, running: null },
};

function prettyName(apiId) {
  const cleaned = String(apiId || '').split('/').pop().replace(/:free$/, '');
  return cleaned
    .split('-')
    .map((part) => (/^\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

function tierFor(apiId) {
  return FREE_MODEL_PATTERN.test(String(apiId || '')) ? 'FREE' : 'PAID';
}

function priceLabelFor(tier) {
  return tier === 'FREE' ? 'Free (Groq free tier)' : 'Paid (Groq billing)';
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

/** Real chat completion: HTTP 200 with non-empty content means the model replies. */
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
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    const content = payload?.choices?.[0]?.message?.content;
    const working = response.ok && typeof content === 'string' && content.trim().length > 0;
    return {
      working,
      latency: Date.now() - started,
      error: working
        ? null
        : String(payload?.error?.message || payload?.message || text || `HTTP ${response.status}`).slice(0, 220),
      label,
    };
  } catch (err) {
    return {
      working: false,
      latency: Date.now() - started,
      error: err.name === 'AbortError' ? `${label} timed out after ${TEST_TIMEOUT_MS}ms` : String(err.message || err).slice(0, 220),
      label,
    };
  } finally {
    clearTimeout(timer);
  }
}

function entry({ provider, apiId, displayName, tier, working, latency, error }) {
  return {
    id: `${provider}/${apiId}`,
    provider,
    apiId,
    displayName: displayName || prettyName(apiId),
    tier,
    price: priceLabelFor(tier),
    working: Boolean(working),
    status: working ? 'working' : 'failed',
    latency: Number.isFinite(latency) ? latency : null,
    error: error || null,
  };
}

async function listGroqModelIds(apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const response = await fetch(`${GROQ_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
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
      throw new Error(`Groq models returned ${response.status}: ${String(payload?.error?.message || text).slice(0, 200)}`);
    }
    const list = Array.isArray(payload?.data) ? payload.data : [];
    return list.filter((model) => model && model.id && model.active !== false).map((model) => ({ id: model.id }));
  } finally {
    clearTimeout(timer);
  }
}

async function runGroqTests() {
  const apiKey = String(process.env.GROQ_API_KEY || '').trim();
  const startedAt = new Date().toISOString();

  if (!apiKey) {
    state.groq = { at: Date.now(), models: [], error: 'GROQ_API_KEY is not set on the server', running: null };
    console.warn('[models] GROQ_API_KEY missing - cannot test Groq models');
    return state.groq;
  }

  let catalog;
  try {
    catalog = await listGroqModelIds(apiKey);
  } catch (err) {
    state.groq = { at: Date.now(), models: [], error: err.message, running: null };
    console.warn(`[models] Groq model list failed: ${err.message}`);
    return state.groq;
  }

  console.log(`[models] testing ${catalog.length} Groq models live...`);
  const results = await mapLimit(catalog, TEST_CONCURRENCY, async (model) => {
    const probe = await probeChat({
      url: `${GROQ_BASE}/chat/completions`,
      apiId: model.id,
      headers: { Authorization: `Bearer ${apiKey}` },
      label: 'Groq',
    });
    return entry({
      provider: 'groq',
      apiId: model.id,
      tier: tierFor(model.id),
      working: probe.working,
      latency: probe.latency,
      error: probe.error,
    });
  });

  const working = results.filter((model) => model.working).length;
  console.log(`[models] Groq: ${working}/${results.length} models replied (${startedAt})`);
  state.groq = { at: Date.now(), models: results, error: null, running: null };
  return state.groq;
}

async function listOpenRouterFreeModels() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const response = await fetch(`${OPENROUTER_BASE}/models`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) throw new Error(`OpenRouter models returned ${response.status}`);
    const list = Array.isArray(payload?.data) ? payload.data : [];
    return list
      .filter((model) => model && typeof model.id === 'string' && model.id.endsWith(':free'))
      .map((model) => ({ id: model.id, name: model.name || model.id }));
  } finally {
    clearTimeout(timer);
  }
}

async function runOpenRouterTests() {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) {
    state.openrouter = {
      at: Date.now(),
      models: [],
      error: 'OPENROUTER_API_KEY is not set on the server',
      running: null,
    };
    console.log('[models] OPENROUTER_API_KEY missing - skipping OpenRouter free model tests');
    return state.openrouter;
  }

  let catalog;
  try {
    catalog = await listOpenRouterFreeModels();
  } catch (err) {
    state.openrouter = { at: Date.now(), models: [], error: err.message, running: null };
    console.warn(`[models] OpenRouter model list failed: ${err.message}`);
    return state.openrouter;
  }

  const sample = catalog.slice(0, OPENROUTER_TEST_LIMIT);
  console.log(`[models] testing ${sample.length}/${catalog.length} OpenRouter :free models live...`);
  const results = await mapLimit(sample, TEST_CONCURRENCY, async (model) => {
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
      apiId: model.id,
      displayName: String(model.name || '').replace(/\s*\(free\)\s*$/i, ''),
      tier: 'FREE',
      working: probe.working,
      latency: probe.latency,
      error: probe.error,
    });
  });

  const working = results.filter((model) => model.working).length;
  console.log(`[models] OpenRouter: ${working}/${results.length} free models replied`);
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

/**
 * Groups: FREE & working, PAID & working, not working (shown disabled).
 * Only models that were actually probed in the last test appear here.
 *
 * Without `wait` this never blocks: while the first run is in flight it returns
 * `testing: true` so the UI can show a loading state instead of a fake list.
 */
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
    groups: { freeWorking, paidWorking, notWorking },
    // Backwards-compatible lists used by the dashboard counts and playground.
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
