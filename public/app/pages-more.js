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
      let settings;
      try {
        settings = await api('/api/settings');
      } catch (error) {
        console.error('[settings] /api/settings failed, showing empty BYOK form', error);
        settings = { groqKey: null, openrouterKey: null, hasGroq: false, hasOpenRouter: false };
        if (error.offline) {
          el.innerHTML = offlinePanel(error);
          return;
        }
      }
      const config = await getConfig(true).catch((error) => {
        console.error('[settings] /api/config failed, using fallback status', error);
        state.config = fallbackConfig();
        return state.config;
      });

      const keyRow = (label, masked, hasValue, field, link, help) =>
        '<div class="rounded-xl border border-slate-200 p-4 dark:border-slate-800"><div class="flex flex-wrap items-center justify-between gap-2"><div><p class="text-sm font-semibold">' + esc(label) + '</p>' + statusPill(hasValue, 'Key saved', 'No key') + '</div>' + (hasValue ? '<button data-clear="' + field + '" class="text-xs font-semibold text-rose-500 hover:underline">Remove</button>' : '') + '</div>'
        + (masked ? '<p class="mt-2 font-mono text-xs text-slate-500 dark:text-slate-400">' + esc(masked) + '</p>' : '')
        + '<div class="mt-3 flex gap-2"><input id="' + field + '" type="password" autocomplete="off" class="' + inputCls + '" placeholder="' + (hasValue ? 'Enter a new key to replace' : 'Paste your key') + '" /><button data-save="' + field + '" class="' + btnPrimary + ' !px-3">Save</button></div>'
        + '<p class="mt-2 text-xs text-slate-500 dark:text-slate-400">' + help + ' · <a href="' + link + '" target="_blank" rel="noopener" class="text-emerald-600 hover:underline dark:text-emerald-400">get a key ↗</a></p></div>';

      el.innerHTML = '<div class="grid gap-5 lg:grid-cols-3">'
        + '<div class="space-y-5 lg:col-span-2">'
        + '<div class="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-200"><p class="font-bold">⚠️ Use YOUR OWN keys — not the developer’s key — to avoid limits.</p><p class="mt-1 text-xs">Groq is 100% free at console.groq.com/keys. OpenRouter has <b>:free</b> models and paid models; a key unlocks both. Keys are stored in Supabase (<code class="rounded bg-amber-500/10 px-1">settings.data</code>) or per agent.</p></div>'
        + '<div class="' + cardCls + ' p-5"><div class="flex items-center justify-between"><h2 class="text-sm font-bold">Add your keys (BYOK)</h2><span class="text-[11px] text-slate-500 dark:text-slate-400">applies to all agents without their own key</span></div>'
        + '<div class="mt-4 space-y-4">'
        + keyRow('Groq API key', settings.groqKey, settings.hasGroq, 'groqKey', 'https://console.groq.com/keys', 'Free text models + Whisper voice notes + voice replies')
        + keyRow('OpenRouter API key (optional)', settings.openrouterKey, settings.hasOpenRouter, 'openrouterKey', 'https://openrouter.ai/keys', 'Required for paid models; needed to use OpenRouter free :free models')
        + '</div></div>'
        + '<div class="' + cardCls + ' p-5"><h2 class="text-sm font-bold">Environment status</h2><div class="mt-4 divide-y divide-slate-200 text-sm dark:divide-slate-800">'
        + '<div class="flex items-center justify-between py-2"><span class="text-slate-500 dark:text-slate-400">Supabase (optional)</span>' + optionalPill(supabaseReady(config)) + '</div>'
        + '<div class="flex items-center justify-between py-2"><span class="text-slate-500 dark:text-slate-400">Storage bucket</span><span class="font-mono text-xs">' + (supabaseReady(config) ? esc(config.supabase.bucket) : 'unused (in-memory)') + '</span></div>'
        + '<div class="flex items-center justify-between py-2"><span class="text-slate-500 dark:text-slate-400">Evolution API</span>' + statusPill(config.evolution.configured) + '</div>'
        + '<div class="flex items-center justify-between py-2"><span class="text-slate-500 dark:text-slate-400">Groq (env or saved)</span>' + statusPill(config.ai.groq) + '</div>'
        + '<div class="flex items-center justify-between py-2"><span class="text-slate-500 dark:text-slate-400">OpenRouter</span>' + statusPill(config.ai.openrouter, 'Configured', 'Optional') + '</div>'
        + '</div><p class="mt-3 text-xs text-slate-500 dark:text-slate-400">Configure Supabase, Evolution and optional env keys in your host’s environment (or <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">.env</code>).</p></div>'
        + '</div>'
        + '<div class="space-y-5">'
        + '<div class="' + cardCls + ' p-5"><h2 class="text-sm font-bold">Telegram</h2><div class="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4"><p class="text-sm font-bold text-amber-700 dark:text-amber-300">' + TELEGRAM + '</p><p class="mt-1 text-xs text-amber-700/80 dark:text-amber-200/70">Telegram is not included in this build. All <code>/telegram/*</code> endpoints return 410 Gone.</p></div></div>'
        + '<div class="' + cardCls + ' p-5"><h2 class="text-sm font-bold">Modes</h2><div class="mt-3 space-y-2 text-xs text-slate-600 dark:text-slate-300"><p><b>Free:</b> Groq models are always free. OpenRouter <b>:free</b> models work with a key.</p><p><b>Paid:</b> choose any paid OpenRouter model; prices are shown per 1k tokens.</p><p><b>Fallback:</b> selected model → groq/llama-3.1-8b-instant → error.</p></div></div>'
        + '<div class="' + cardCls + ' p-5"><h2 class="text-sm font-bold">Schema</h2><p class="mt-2 text-xs text-slate-500 dark:text-slate-400">Run <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">supabase/schema.sql</code> once to create tables, indexes, the <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">agent-media</code> bucket and the inbox RLS policy.</p></div>'
        + '</div></div>';

      async function save(field) {
        const input = el.querySelector('#' + field);
        const value = input.value.trim();
        if (!value) return toast('Enter a key first', 'error');
        try {
          const result = await api('/api/settings', { method: 'PUT', body: { [field]: value } });
          input.value = '';
          toast('Key saved');
          state.config = null;
          await settingsPage(el);
          return result;
        } catch (error) {
          toast(error.message, 'error');
        }
      }

      $$('[data-save]', el).forEach((button) => button.addEventListener('click', () => save(button.dataset.save)));

      $$('[data-clear]', el).forEach((button) =>
        button.addEventListener('click', async () => {
          if (!confirm('Remove this saved key?')) return;
          try {
            await api('/api/settings', { method: 'PUT', body: { ['clear' + (button.dataset.clear === 'groqKey' ? 'Groq' : 'OpenRouter')]: true } });
            toast('Key removed');
            state.config = null;
            await settingsPage(el);
          } catch (error) { toast(error.message, 'error'); }
        }),
      );
    }

    /* -------------------------------- telegram ---------------------------- */
    async function telegramPage(el) {
      el.innerHTML = '<div class="mx-auto max-w-2xl"><div class="' + cardCls + ' overflow-hidden"><div class="border-b border-amber-500/30 bg-amber-500/10 px-6 py-8 text-center"><p class="text-4xl">✈</p><p class="mt-3 text-xs font-bold uppercase tracking-[0.2em] text-amber-600 dark:text-amber-400">Feature disabled</p><h2 class="mt-2 text-2xl font-extrabold text-amber-700 dark:text-amber-300">' + TELEGRAM + '</h2></div>'
        + '<div class="space-y-4 p-6 text-sm text-slate-600 dark:text-slate-300"><p>This build is WhatsApp-only. Telegram MTProto (phone login) is planned but not included.</p>'
        + '<ul class="list-disc space-y-1 pl-5 text-xs"><li>No Telegram login, sessions or phone codes.</li><li><code class="rounded bg-slate-100 px-1 dark:bg-slate-800">/telegram/*</code> returns HTTP 410.</li><li>WhatsApp features are unaffected.</li></ul>'
        + '<a href="/connect" data-link class="' + btnPrimary + ' mt-2 inline-flex">Go to WhatsApp Connect</a></div></div></div>';
    }

    async function notFoundPage(el) {
      el.innerHTML = '<div class="mx-auto max-w-lg ' + cardCls + ' p-10 text-center"><p class="text-4xl">404</p><h2 class="mt-3 text-lg font-bold">Page not found</h2><p class="mt-1 text-sm text-slate-500 dark:text-slate-400">' + esc(location.pathname) + ' does not exist.</p><a href="/" data-link class="' + btnPrimary + ' mt-5">Back to dashboard</a></div>';
    }
