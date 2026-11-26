    /* ============================== state ================================= */
    const state = {
      config: null,
      catalog: {
        free: [],
        paid: [],
        groups: { freeWorking: [], paidWorking: [], notWorking: [] },
        testing: false,
        tested: false,
        testedAt: null,
        errors: [],
        source: 'unknown',
      },
      agents: [],
      instances: [],
      cleanup: null,
      currentJid: null,
      inbox: { conversations: [], messages: [], agents: [] },
      groups: { selected: new Set() },
      playground: { agentId: null, history: [], messages: [] },
    };

    const SUPABASE_WARNING = '⚠️ Supabase not connected - optional - agents, inbox, groups, media will NOT be saved permanently. Add SUPABASE_URL + SUPABASE_KEY in .env to enable persistence. Get free at supabase.com';
    const API_TIMEOUT_MS = 45000; // Render free tier cold starts can take ~40s

    /** True only when the backend confirmed Supabase is configured. Never assume it is. */
    function supabaseReady(config) {
      return Boolean(config && config.supabase && config.supabase.configured === true);
    }

    /** Config shape used when the backend is unreachable or returns nothing (mock/memory mode). */
    function fallbackConfig() {
      return {
        ok: true,
        app: 'WhatsApp Groq Router v2',
        offline: true,
        supabase: { configured: false, optional: true, bucket: 'unused', warning: SUPABASE_WARNING },
        persistence: 'memory',
        evolution: { configured: false, url: null },
        ai: { groq: false, openrouter: false, tts: 'unavailable' },
        realtime: { url: null, anonKey: null },
        counts: { agents: 0, chats: 0, groups: 0, messages: 0 },
        modelsSource: 'fallback',
      };
    }
    const titles = {
      '/': ['Dashboard', 'Overview of your WhatsApp AI router'],
      '/connect': ['Connect WhatsApp', 'Link an Evolution API instance by QR or phone number'],
      '/agents': ['Agents', 'Agents, live-tested models and the account they reply from'],
      '/inbox': ['Inbox', 'All chats, replies and agent assignment'],
      '/groups': ['Groups', 'Sync WhatsApp groups and assign hosts'],
      '/playground': ['Playground', 'Test an agent without WhatsApp'],
      '/settings': ['Settings', 'Server keys, persistence and integration status'],
    };

    const NAV = [
      { path: '/', label: 'Dashboard', icon: '◎' },
      { path: '/connect', label: 'Connect', icon: '⌁' },
      { path: '/agents', label: 'Agents', icon: '✦' },
      { path: '/inbox', label: 'Inbox', icon: '✉' },
      { path: '/groups', label: 'Groups', icon: '⊞' },
      { path: '/playground', label: 'Playground', icon: '▷' },
      { path: '/settings', label: 'Settings', icon: '⚙' },
    ];

    const btnBase = 'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50';
    const btnPrimary = btnBase + ' bg-emerald-500 text-slate-950 hover:bg-emerald-400';
    const btnGhost = btnBase + ' border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800';
    const btnDanger = btnBase + ' border border-rose-500/40 text-rose-600 hover:bg-rose-500/10 dark:text-rose-400';
    const cardCls = 'rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/60';
    const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100';
    const labelCls = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400';

    /** Fill in any missing config fields so pages never read undefined. */
    function normalizeConfig(raw) {
      const base = fallbackConfig();
      const config = raw && typeof raw === 'object' ? raw : {};
      return {
        ...base,
        ...config,
        supabase: { ...base.supabase, ...(config.supabase || {}) },
        evolution: { ...base.evolution, ...(config.evolution || {}) },
        ai: { ...base.ai, ...(config.ai || {}) },
        realtime: { ...base.realtime, ...(config.realtime || {}) },
        counts: { ...base.counts, ...(config.counts || {}) },
      };
    }

    /* ============================== utils ================================= */
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const esc = (value) =>
      String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function timeAgo(value) {
      if (!value) return '';
      const diff = Date.now() - new Date(value).getTime();
      if (!Number.isFinite(diff)) return '';
      if (diff < 60_000) return 'now';
      if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm';
      if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h';
      if (diff < 604_800_000) return Math.floor(diff / 86_400_000) + 'd';
      return new Date(value).toLocaleDateString();
    }

    function bytes(size) {
      const n = Number(size || 0);
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    async function api(path, options = {}) {
      const init = { method: options.method || 'GET', headers: {} };
      if (options.body instanceof FormData) {
        init.body = options.body;
      } else if (options.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || API_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(path, { ...init, signal: controller.signal });
      } catch (cause) {
        console.error('[api] network error for ' + path, cause);
        const error = new Error(
          cause && cause.name === 'AbortError'
            ? 'Request timed out for ' + path + '. The backend may still be waking up.'
            : 'Cannot reach the backend for ' + path + '. It may be waking up.',
        );
        error.code = 'network_error';
        error.offline = true;
        error.path = path;
        throw error;
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
      if (!response.ok) {
        const error = new Error(data.error || ('Request failed (' + response.status + ')'));
        error.status = response.status;
        error.code = data.code;
        throw error;
      }
      return data;
    }

    function toast(message, type = 'success') {
      const root = $('#toast-root');
      const tone = type === 'error'
        ? 'border-rose-500/40 bg-rose-950/95 text-rose-100'
        : type === 'info'
          ? 'border-sky-500/40 bg-sky-950/95 text-sky-100'
          : 'border-emerald-500/40 bg-emerald-950/95 text-emerald-100';
      const el = document.createElement('div');
      el.className = 'fade-in pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm font-medium shadow-xl backdrop-blur ' + tone;
      el.innerHTML = '<span class="mt-0.5">' + (type === 'error' ? '⚠' : type === 'info' ? 'ℹ' : '✓') + '</span><span class="flex-1">' + esc(message) + '</span><button class="opacity-60 hover:opacity-100" aria-label="Dismiss">✕</button>';
      el.querySelector('button').addEventListener('click', () => el.remove());
      root.appendChild(el);
      setTimeout(() => el.remove(), 5200);
    }

    function spinner(label = 'Loading') {
      return '<div class="flex items-center justify-center gap-3 py-16 text-sm text-slate-500 dark:text-slate-400"><div class="spinner"></div>' + esc(label) + '…</div>';
    }

    function offlinePanel(error) {
      const detail = error && error.message ? error.message : 'The backend did not respond.';
      return '<div class="mx-auto max-w-lg ' + cardCls + ' p-8 text-center">'
        + '<div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-2xl">⏳</div>'
        + '<h2 class="mt-4 text-lg font-bold">Backend waking up on Render free tier</h2>'
        + '<p class="mt-2 text-sm text-slate-600 dark:text-slate-300">Wait 40s then refresh. Free instances sleep when idle and take a while to boot.</p>'
        + '<p class="mt-3 break-words text-xs text-slate-500 dark:text-slate-400">' + esc(detail) + '</p>'
        + '<button onclick="location.reload()" class="' + btnPrimary + ' mt-5">Retry</button>'
        + '<p class="mt-4 text-[11px] text-slate-500 dark:text-slate-400">No Supabase? That is optional - the app runs on temporary in-memory data.</p>'
        + '</div>';
    }

    function errorBox(error, retry = true) {
      return '<div class="' + cardCls + ' p-6"><div class="flex items-start gap-3"><span class="text-xl">⚠️</span><div class="min-w-0"><p class="font-semibold text-rose-600 dark:text-rose-400">Something went wrong</p><p class="mt-1 break-words text-sm text-slate-600 dark:text-slate-300">' + esc(error.message || String(error)) + '</p>' + (retry ? '<button id="retry-btn" class="' + btnGhost + ' mt-4">Retry</button>' : '') + '</div></div></div>';
    }

    function statusPill(ok, okText = 'Configured', badText = 'Not configured') {
      const cls = ok
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300';
      const text = ok ? okText : badText;
      return '<span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ' + cls + '"><span class="h-1.5 w-1.5 rounded-full ' + (ok ? 'bg-emerald-500' : 'bg-rose-500') + '"></span>' + esc(text) + '</span>';
    }

    function optionalPill(ok) {
      const cls = ok
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
      return '<span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ' + cls + '"><span class="h-1.5 w-1.5 rounded-full ' + (ok ? 'bg-emerald-500' : 'bg-amber-500') + '"></span>' + (ok ? 'Configured' : 'In-memory (optional)') + '</span>';
    }

    function paintPersistenceBanner() {
      const banner = $('#persistence-banner');
      if (!banner) return;
      if (state.config && !supabaseReady(state.config)) {
        banner.innerHTML = '<span>⚠️ Supabase not connected - <b>optional</b> - agents, inbox, groups, media will <b>NOT</b> be saved permanently. Add <code class="rounded bg-amber-500/20 px-1">SUPABASE_URL</code> + <code class="rounded bg-amber-500/20 px-1">SUPABASE_KEY</code> in <code class="rounded bg-amber-500/20 px-1">.env</code> to enable persistence. Get free at <a href="https://supabase.com" target="_blank" rel="noopener" class="underline">supabase.com</a></span>';
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
        banner.innerHTML = '';
      }
    }

    function isInstanceConnected(status) {
      return /open|connected/i.test(String(status || ''));
    }

    function modelBadge(model) {
      const info = modelInfo(model);
      const base = 'rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ';
      if (!info) {
        return '<span class="' + base + 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300">Untested</span>';
      }
      if (!info.working) {
        return '<span class="' + base + 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300" title="' + esc(info.error || '') + '">Not working</span>';
      }
      if (info.tier === 'FREE') {
        return '<span class="' + base + 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">FREE ✓ Working</span>';
      }
      return '<span class="' + base + 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">PAID $ Working</span>';
    }

    /** Every model the last live test touched, in any group. */
    function modelInfo(id) {
      const groups = state.catalog.groups || { freeWorking: [], paidWorking: [], notWorking: [] };
      return [...groups.freeWorking, ...groups.paidWorking, ...groups.notWorking].find((m) => m.id === id)
        || [...state.catalog.free, ...state.catalog.paid].find((m) => m.id === id)
        || null;
    }

    function modelLabel(id) {
      const info = modelInfo(id);
      if (info) return info.displayName || info.label || id;
      return String(id || '').split('/').pop();
    }

    function priceLabel(info) {
      if (!info) return '';
      if (info.price) return info.price;
      if (info.tier === 'FREE' || info.free) return 'free';
      if (info.pricePer1k === null || info.pricePer1k === undefined) return 'price varies';
      if (!info.pricePer1k) return 'free';
      return '$' + Number(info.pricePer1k).toFixed(4) + '/1k tokens';
    }

    /** Best default: the recommended free Groq model, else the first free one that replied. */
    function defaultModelId() {
      const groups = state.catalog.groups || { freeWorking: [] };
      const preferred = ['groq/llama-3.3-70b-versatile', 'groq/llama-3.1-8b-instant'];
      const hit = preferred.find((id) => groups.freeWorking.some((m) => m.id === id));
      if (hit) return hit;
      if (groups.freeWorking.length) return groups.freeWorking[0].id;
      return 'groq/llama-3.1-8b-instant';
    }

    /* ============================== layout ================================ */
    function navHTML(compact = false) {
      return NAV.map((item) => {
        if (compact) {
          return '<a href="' + item.path + '" data-link data-nav="' + item.path + '" class="nav-item flex flex-none items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">'
            + '<span class="opacity-70">' + item.icon + '</span>' + esc(item.label)
            + (item.badge ? '<span class="rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-bold uppercase text-amber-700 dark:text-amber-300">' + item.badge + '</span>' : '') + '</a>';
        }
        return '<a href="' + item.path + '" data-link data-nav="' + item.path + '" class="nav-item flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">'
          + '<span class="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-xs dark:bg-slate-800">' + item.icon + '</span>'
          + '<span class="flex-1">' + esc(item.label) + '</span>'
          + (item.badge ? '<span class="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-700 dark:text-amber-300">' + item.badge + '</span>' : '')
          + '</a>';
      }).join('');
    }

    function setActiveNav(path) {
      $$('[data-nav]').forEach((el) => {
        const active = el.getAttribute('data-nav') === path;
        el.classList.toggle('bg-emerald-500/10', active);
        el.classList.toggle('text-emerald-700', active);
        el.classList.toggle('dark:text-emerald-300', active);
        el.classList.toggle('ring-1', active);
        el.classList.toggle('ring-emerald-500/30', active);
      });
    }

    function setTheme(dark) {
      document.documentElement.classList.toggle('dark', dark);
      localStorage.setItem('theme', dark ? 'dark' : 'light');
      $$('[data-theme-label]').forEach((el) => (el.textContent = dark ? 'On' : 'Off'));
    }

    function navigate(path, replace = false) {
      if (replace) history.replaceState({}, '', path);
      else history.pushState({}, '', path);
      render();
    }

    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-link]');
      if (!link) return;
      const href = link.getAttribute('href');
      if (!href || !href.startsWith('/')) return;
      event.preventDefault();
      if (href !== location.pathname) navigate(href);
    });

    $$('[data-theme-toggle]').forEach((button) =>
      button.addEventListener('click', () => setTheme(!document.documentElement.classList.contains('dark'))),
    );

    function openModal({ title, body, width = 'max-w-2xl' }) {
      const root = $('#modal-root');
      root.innerHTML = '<div class="fixed inset-0 z-50 overflow-y-auto bg-slate-950/70 p-4 backdrop-blur-sm" data-backdrop>'
        + '<div class="fade-in mx-auto my-6 w-full ' + width + ' rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900" role="dialog" aria-modal="true">'
        + '<div class="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800"><h2 class="text-base font-bold">' + esc(title) + '</h2><button data-close class="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200" aria-label="Close">✕</button></div>'
        + '<div class="max-h-[75vh] overflow-y-auto p-5">' + body + '</div></div></div>';

      const close = () => {
        root.innerHTML = '';
        document.removeEventListener('keydown', onKey);
      };
      const onKey = (event) => { if (event.key === 'Escape') close(); };
      document.addEventListener('keydown', onKey);
      root.querySelector('[data-close]').addEventListener('click', close);
      root.querySelector('[data-backdrop]').addEventListener('click', (event) => {
        if (event.target === root.querySelector('[data-backdrop]')) close();
      });
      return { close, root };
    }

    /* ============================== pages ================================= */
    async function getConfig(force = false) {
      if (!state.config || force) state.config = normalizeConfig(await api('/api/config'));
      return state.config;
    }

    // Loaders fall back to whatever is already in memory so a failing endpoint
    // never blanks a page. Network failures are logged and swallowed.
    async function loadAgents() {
      try {
        const data = await api('/api/agents');
        state.agents = data.agents || [];
      } catch (error) {
        console.error('[agents] /api/agents failed, keeping in-memory list', error);
        state.agents = state.agents || [];
      }
      return state.agents;
    }

    async function loadCatalog(force = false) {
      const cached = state.catalog;
      if (!force && !cached.testing && (cached.free.length || cached.paid.length || cached.tested)) return cached;
      try {
        const data = await api('/api/models');
        state.catalog = {
          free: data.free || [],
          paid: data.paid || [],
          groups: data.groups || { freeWorking: [], paidWorking: [], notWorking: [] },
          testing: Boolean(data.testing),
          tested: Boolean(data.tested),
          testedAt: data.testedAt || null,
          errors: data.errors || [],
          source: data.source || 'unknown',
        };
      } catch (error) {
        console.error('[models] /api/models failed, keeping last live-test results', error);
      }
      return state.catalog;
    }

    /** Phone number encoded in an auto-generated instance name (wa-<digits>), else null. */
    function instanceNumber(name) {
      const match = /^wa-(\d+)$/.exec(String(name || '').trim());
      return match ? match[1] : null;
    }

    /** "Connected as 234..." — never the raw Evolution instance name. */
    function connectedAsLabel(name) {
      const number = instanceNumber(name);
      return number ? 'Connected as ' + number : 'No WhatsApp connected';
    }

    async function loadInstances() {
      try {
        const data = await api('/api/instances');
        state.instances = data.instances || [];
        return data;
      } catch (error) {
        console.error('[instances] /api/instances failed, using empty list', error);
        return { ok: true, configured: false, instances: state.instances || [], error: error.message };
      }
    }
