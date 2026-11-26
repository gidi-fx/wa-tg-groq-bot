    /* ------------------------------ playground ---------------------------- */
    async function playgroundPage(el) {
      await Promise.all([loadAgents(), loadCatalog()]);
      if (!state.playground.agentId && state.agents[0]) state.playground.agentId = state.agents[0].id;

      el.innerHTML = '<div class="grid gap-4 lg:grid-cols-[300px_1fr]">'
        + '<div class="' + cardCls + ' h-fit p-5"><label class="' + labelCls + '" for="pg-agent">Agent</label>'
        + '<select id="pg-agent" class="' + inputCls + '">' + (state.agents.length ? state.agents.map((agent) => '<option value="' + esc(agent.id) + '">' + esc(agent.name) + '</option>').join('') : '<option value="">No agents</option>') + '</select>'
        + '<div id="pg-model" class="mt-3 rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-800"></div>'
        + '<button id="pg-clear" class="' + btnGhost + ' mt-3 w-full !py-1.5 !text-xs">Clear conversation</button>'
        + '<div class="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-amber-700 dark:text-amber-300">Playground uses the same model routing as WhatsApp. Paid OpenRouter models need a key in Settings.</div></div>'
        + '<div class="' + cardCls + ' flex max-h-[78vh] min-h-[460px] flex-col overflow-hidden">'
        + '<div class="border-b border-slate-200 px-4 py-3 dark:border-slate-800"><p class="text-sm font-bold">Test without WhatsApp</p><p class="text-xs text-slate-500 dark:text-slate-400" id="pg-usage">Tokens will appear after a reply.</p></div>'
        + '<div id="pg-thread" class="scroll-thin flex-1 space-y-3 overflow-y-auto px-4 py-4"></div>'
        + '<form id="pg-form" class="flex items-end gap-2 border-t border-slate-200 p-3 dark:border-slate-800"><textarea id="pg-input" rows="2" class="' + inputCls + ' resize-none" placeholder="Ask the agent something…"></textarea><button type="submit" id="pg-send" class="' + btnPrimary + ' !px-4">Send</button></form>'
        + '</div></div>';

      const agentSelect = $('#pg-agent', el);
      const thread = $('#pg-thread', el);
      const input = $('#pg-input', el);
      const sendButton = $('#pg-send', el);
      const usageEl = $('#pg-usage', el);

      if (state.playground.agentId) agentSelect.value = state.playground.agentId;

      function paintModel() {
        const agent = state.agents.find((item) => item.id === agentSelect.value);
        if (!agent) { $('#pg-model', el).textContent = 'Create an agent first.'; return; }
        $('#pg-model', el).innerHTML = '<p class="flex items-center gap-2 font-semibold">' + modelBadge(agent.model) + esc(modelLabel(agent.model)) + '</p><p class="mt-1 text-slate-500 dark:text-slate-400">' + esc(agent.voiceEnabled ? 'Voice replies' : 'Text replies') + ' · ' + (agent.mediaFiles.length ? agent.mediaFiles.length + ' media files' : 'no media') + '</p>';
      }

      function paintThread() {
        if (!state.playground.messages.length) {
          thread.innerHTML = '<div class="flex h-full flex-col items-center justify-center py-12 text-center"><p class="text-3xl">▷</p><p class="mt-3 text-sm font-semibold">Send a message to test this agent</p><p class="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">No WhatsApp connection is used here.</p></div>';
          return;
        }
        thread.innerHTML = state.playground.messages.map((message) =>
          '<div class="flex ' + (message.role === 'user' ? 'justify-end' : 'justify-start') + '"><div class="max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ' + (message.role === 'user' ? 'rounded-br-md bg-emerald-500 text-slate-950' : 'rounded-bl-md bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100') + '"><p class="whitespace-pre-wrap break-words">' + esc(message.content) + '</p>'
          + (message.meta ? '<p class="mt-1 text-[10px] opacity-70">' + esc(message.meta) + '</p>' : '')
          + '</div></div>').join('');
        thread.scrollTop = thread.scrollHeight;
      }

      agentSelect.addEventListener('change', () => {
        state.playground.agentId = agentSelect.value;
        state.playground.messages = [];
        state.playground.history = [];
        usageEl.textContent = 'Tokens will appear after a reply.';
        paintModel();
        paintThread();
      });

      $('#pg-clear', el).addEventListener('click', () => {
        state.playground.messages = [];
        state.playground.history = [];
        usageEl.textContent = 'Tokens will appear after a reply.';
        paintThread();
      });

      $('#pg-form', el).addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        if (!agentSelect.value) return toast('Create an agent first', 'error');

        state.playground.messages.push({ role: 'user', content: text });
        input.value = '';
        paintThread();
        sendButton.disabled = true;
        sendButton.textContent = '…';

        try {
          const result = await api('/api/playground', {
            method: 'POST',
            body: {
              agentId: agentSelect.value,
              message: text,
              history: state.playground.history,
            },
          });
          const usage = result.usage || {};
          const meta = (result.fallbackFrom ? 'fallback from ' + result.fallbackFrom + ' · ' : '') + result.model + (usage.totalTokens ? ' · ' + usage.totalTokens + ' tokens (' + (usage.promptTokens ?? '?') + ' in / ' + (usage.completionTokens ?? '?') + ' out)' : '');
          state.playground.history.push({ role: 'user', content: text });
          state.playground.history.push({ role: 'assistant', content: result.reply });
          state.playground.messages.push({ role: 'assistant', content: result.reply, meta });
          usageEl.textContent = meta;
          paintThread();
        } catch (error) {
          state.playground.messages.push({ role: 'assistant', content: '⚠️ ' + error.message });
          usageEl.textContent = 'Request failed.';
          paintThread();
        } finally {
          sendButton.disabled = false;
          sendButton.textContent = 'Send';
        }
      });

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          $('#pg-form', el).requestSubmit();
        }
      });

      paintModel();
      paintThread();
    }

    /* -------------------------------- settings ---------------------------- */
    async function settingsPage(el) {
      const config = await getConfig(true).catch((error) => {
        console.error('[settings] /api/config failed, using fallback status', error);
        state.config = fallbackConfig();
        return state.config;
      });

      const keyRow = (label, ok, envName, help) =>
        '<div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-4 dark:border-slate-800"><div><p class="text-sm font-semibold">' + esc(label) + '</p><p class="mt-1 text-xs text-slate-500 dark:text-slate-400">' + help + ' · <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">' + esc(envName) + '</code></p></div>' + statusPill(ok, 'Key ready on server', 'Not set on server') + '</div>';

      el.innerHTML = '<div class="grid gap-5 lg:grid-cols-3">'
        + '<div class="space-y-5 lg:col-span-2">'
        + '<div class="rounded-2xl border border-sky-500/30 bg-sky-500/5 p-4 text-sm text-sky-800 dark:text-sky-200"><p class="font-bold">🔑 API keys are never entered in the browser.</p><p class="mt-1 text-xs">The backend reads <code class="rounded bg-sky-500/10 px-1">GROQ_API_KEY</code> and <code class="rounded bg-sky-500/10 px-1">OPENROUTER_API_KEY</code> from its environment (host dashboard, Render env vars, or <code class="rounded bg-sky-500/10 px-1">.env</code>). Agents always use those keys.</p></div>'
        + '<div class="' + cardCls + ' p-5"><div class="flex items-center justify-between"><h2 class="text-sm font-bold">AI keys (server environment)</h2><span class="text-[11px] text-slate-500 dark:text-slate-400">read-only</span></div>'
        + '<div class="mt-4 space-y-3">'
        + keyRow('Groq API key', config.ai.groq, 'GROQ_API_KEY', 'Text models, Whisper voice notes and voice replies')
        + keyRow('OpenRouter API key', config.ai.openrouter, 'OPENROUTER_API_KEY', 'Optional: paid models and OpenRouter :free models')
        + '</div><p class="mt-3 text-xs text-slate-500 dark:text-slate-400">Change a key by updating the server environment and redeploying. No key is ever stored in Supabase or typed here.</p></div>'
        + '<div class="' + cardCls + ' p-5"><h2 class="text-sm font-bold">Environment status</h2><div class="mt-4 divide-y divide-slate-200 text-sm dark:divide-slate-800">'
        + '<div class="flex items-center justify-between py-2"><span class="text-slate-500 dark:text-slate-400">Supabase (optional)</span>' + optionalPill(supabaseReady(config)) + '</div>'
        + '<div class="flex items-center justify-between py-2"><span class="text-slate-500 dark:text-slate-400">Storage bucket</span><span class="font-mono text-xs">' + (supabaseReady(config) ? esc(config.supabase.bucket) : 'unused (in-memory)') + '</span></div>'
        + '<div class="flex items-center justify-between py-2"><span class="text-slate-500 dark:text-slate-400">Evolution API</span>' + statusPill(config.evolution.configured) + '</div>'
        + '<div class="flex items-center justify-between py-2"><span class="text-slate-500 dark:text-slate-400">Groq key</span>' + statusPill(config.ai.groq, 'Configured', 'Missing') + '</div>'
        + '<div class="flex items-center justify-between py-2"><span class="text-slate-500 dark:text-slate-400">OpenRouter key</span>' + statusPill(config.ai.openrouter, 'Configured', 'Optional') + '</div>'
        + '<div class="flex items-center justify-between py-2"><span class="text-slate-500 dark:text-slate-400">Model source</span><span class="font-mono text-xs">' + esc(config.modelsSource || 'live-test') + '</span></div>'
        + '</div><p class="mt-3 text-xs text-slate-500 dark:text-slate-400">Models are tested live on the server; the Agents page only shows models that actually replied.</p></div>'
        + '</div>'
        + '<div class="space-y-5">'
        + '<div class="' + cardCls + ' p-5"><h2 class="text-sm font-bold">Modes</h2><div class="mt-3 space-y-2 text-xs text-slate-600 dark:text-slate-300"><p><b>Free:</b> Groq models are always free. OpenRouter <b>:free</b> models work with the server key.</p><p><b>Paid:</b> paid OpenRouter models, marked with a yellow badge.</p><p><b>Groq:</b> only <code>gpt-oss-120b</code> and <code>gpt-oss-20b</code> are allowed. Any other model must be chosen under OpenRouter.</p><p><b>Fallback:</b> selected model → groq/openai/gpt-oss-20b → error.</p></div></div>'
        + '<div class="' + cardCls + ' p-5"><h2 class="text-sm font-bold">Schema</h2><p class="mt-2 text-xs text-slate-500 dark:text-slate-400">Run <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">supabase/schema.sql</code> once to create tables, indexes, the <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">agent-media</code> bucket and the inbox RLS policy. Re-running it adds <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">agents.connected_instance</code>.</p></div>'
        + '</div></div>';
    }

    async function notFoundPage(el) {
      el.innerHTML = '<div class="mx-auto max-w-lg ' + cardCls + ' p-10 text-center"><p class="text-4xl">404</p><h2 class="mt-3 text-lg font-bold">Page not found</h2><p class="mt-1 text-sm text-slate-500 dark:text-slate-400">' + esc(location.pathname) + ' does not exist.</p><a href="/" data-link class="' + btnPrimary + ' mt-5">Back to dashboard</a></div>';
    }
