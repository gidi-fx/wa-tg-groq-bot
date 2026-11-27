    /* ------------------------------ dashboard ----------------------------- */
    async function dashboardPage(el) {
      let config;
      try {
        config = await getConfig(true);
      } catch (error) {
        console.error('[dashboard] /api/config failed', error);
        state.config = fallbackConfig();
        if (error.offline) {
          el.innerHTML = offlinePanel(error);
          return;
        }
        config = state.config;
        toast('Showing temporary data - backend config unavailable', 'info');
      }

      const [instancesData] = await Promise.all([
        loadInstances().catch(() => ({ instances: [] })),
        loadCatalog().catch(() => null),
      ]);
      const instances = instancesData.instances || [];
      const connected = instances.filter((i) => isInstanceConnected(i.status)).length;
      const supabaseOk = supabaseReady(config);
      const evolutionOk = Boolean(config.evolution && config.evolution.configured);
      const ai = config.ai || {};
      const counts = config.counts || {};
      const bucket = (config.supabase && config.supabase.bucket) || 'unused';

      const stat = (label, value, note, tone) =>
        '<div class="' + cardCls + ' p-4"><p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">' + esc(label) + '</p>'
        + '<p class="mt-1 text-2xl font-extrabold ' + (tone || '') + '">' + esc(value) + '</p>'
        + (note ? '<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">' + esc(note) + '</p>' : '') + '</div>';

      el.innerHTML = '<div class="space-y-6">'
        + (!supabaseOk
          ? '<div class="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4"><p class="font-semibold text-amber-700 dark:text-amber-300">⚠️ Supabase not connected - optional</p><p class="mt-1 text-sm text-amber-700/90 dark:text-amber-200/90">Everything works now, but agents, inbox, groups and media are kept <b>in memory</b> and reset when the server restarts. Add <code class="rounded bg-amber-500/20 px-1">SUPABASE_URL</code> and <code class="rounded bg-amber-500/20 px-1">SUPABASE_KEY</code> in <code class="rounded bg-amber-500/20 px-1">.env</code> and run <code class="rounded bg-amber-500/20 px-1">supabase/schema.sql</code> to persist. Get a free project at <a href="https://supabase.com" target="_blank" rel="noopener" class="underline">supabase.com</a>.</p></div>'
          : '')
        + '<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">'
        + '<div class="' + cardCls + ' p-4"><div class="flex items-start justify-between gap-2"><p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Supabase</p>' + optionalPill(supabaseOk) + '</div><p class="mt-3 text-sm font-semibold">Postgres + Storage (optional)</p><p class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">' + (supabaseOk ? 'bucket: ' + esc(bucket) : 'in-memory · bucket unused') + '</p></div>'
        + '<div class="' + cardCls + ' p-4"><div class="flex items-start justify-between gap-2"><p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Evolution API</p>' + statusPill(evolutionOk) + '</div><p class="mt-3 text-sm font-semibold">' + connected + ' / ' + instances.length + ' connected</p><p class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">' + esc(config.evolution.url || 'EVOLUTION_API_URL missing') + '</p></div>'
        + '<div class="' + cardCls + ' p-4"><div class="flex items-start justify-between gap-2"><p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">AI keys (server)</p>' + statusPill(ai.groq || ai.openrouter) + '</div><p class="mt-3 text-sm font-semibold">Groq ' + (ai.groq ? '✓ server' : 'missing') + ' · OpenRouter ' + (ai.openrouter ? '✓ server' : 'optional') + '</p><p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Voice TTS: ' + esc(ai.tts || 'unavailable') + '</p></div>'
        + '</div>'
        + '<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">'
        + stat('Agents', counts.agents || 0, 'AI personas with models and media')
        + stat('Chats', counts.chats || 0, 'Conversations seen in the inbox')
        + stat('Groups', counts.groups || 0, 'Synced from Evolution')
        + stat('Messages', counts.messages || 0, supabaseOk ? 'Stored in Supabase' : 'Temporary in-memory messages')
        + '</div>'
        + '<div class="grid gap-4 lg:grid-cols-3">'
        + '<div class="' + cardCls + ' p-5 lg:col-span-2"><h2 class="text-sm font-bold">Quick start</h2><div class="mt-4 grid gap-3 sm:grid-cols-2">'
        + '<a href="/connect" data-link class="rounded-xl border border-slate-200 p-4 transition hover:border-emerald-500/50 hover:bg-emerald-500/5 dark:border-slate-800"><p class="text-sm font-semibold">1. Connect WhatsApp</p><p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Create an instance and link it with a QR code or an 8-digit pairing code.</p></a>'
        + '<a href="/agents" data-link class="rounded-xl border border-slate-200 p-4 transition hover:border-emerald-500/50 hover:bg-emerald-500/5 dark:border-slate-800"><p class="text-sm font-semibold">2. Create an agent</p><p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Pick a free Groq or OpenRouter model and write its instructions.</p></a>'
        + '<a href="/inbox" data-link class="rounded-xl border border-slate-200 p-4 transition hover:border-emerald-500/50 hover:bg-emerald-500/5 dark:border-slate-800"><p class="text-sm font-semibold">3. Reply from the inbox</p><p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Assign an agent to a chat, or answer it yourself.</p></a>'
        + '<a href="/groups" data-link class="rounded-xl border border-slate-200 p-4 transition hover:border-emerald-500/50 hover:bg-emerald-500/5 dark:border-slate-800"><p class="text-sm font-semibold">4. Host a group</p><p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Sync groups and let an agent answer inside them.</p></a>'
        + '</div></div>'
        + '<div class="' + cardCls + ' p-5"><h2 class="text-sm font-bold">AI model catalog</h2><p class="mt-1 text-xs text-slate-500 dark:text-slate-400">' + (config.modelsSource === 'live' ? 'Live from OpenRouter' : 'Built-in fallback list') + '</p>'
        + '<div class="mt-4 space-y-2 text-sm"><div class="flex justify-between"><span class="text-slate-500 dark:text-slate-400">Free models</span><span class="font-semibold">' + state.catalog.free.length + '</span></div>'
        + '<div class="flex justify-between"><span class="text-slate-500 dark:text-slate-400">Paid models</span><span class="font-semibold">' + state.catalog.paid.length + '</span></div>'
        + '<div class="flex justify-between"><span class="text-slate-500 dark:text-slate-400">Voice replies</span><span class="font-semibold">' + (config.ai.groq ? 'ready' : 'needs Groq key') + '</span></div></div>'
        + '<a href="/settings" data-link class="' + btnGhost + ' mt-5 w-full">Manage keys</a></div>'
        + '</div>'
        + '</div>';
      return loadCatalog().catch(() => null);
    }

    /* -------------------------------- connect ----------------------------- */
    const CONNECT_INSTANCE_KEY = 'wa-router:selected-instance';

    /** Evolution connection states mapped to the three labels the Connect page shows. */
    function connectStatusMeta(status) {
      const value = String(status || '').toLowerCase();
      if (/open|connected/.test(value)) {
        return { key: 'open', label: 'Connected', pill: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' };
      }
      if (/connecting|qr|pair/.test(value)) {
        return { key: 'connecting', label: 'Connecting', pill: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' };
      }
      return { key: 'close', label: 'Not connected', pill: 'border-slate-300 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400', dot: 'bg-slate-400' };
    }

    function connectStatusBadge(status) {
      const meta = connectStatusMeta(status);
      return '<span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ' + meta.pill + '"><span class="h-1.5 w-1.5 rounded-full ' + meta.dot + '"></span>' + esc(meta.label) + '</span>';
    }

    async function connectPage(el) {
      const initial = await loadInstances();
      let instances = initial.instances || [];
      let instance = '';
      let timer = null;
      let pairBusy = false;
      let pairCooldownUntil = 0;
      let pairCooldownTimer = null;
      const CODE_COOLDOWN_MS = 60000;
      // Ones that were already open on load do not get a "Connected" toast again.
      const connectedNotified = new Set(instances.filter((item) => isInstanceConnected(item.status)).map((item) => item.name));

      // The last selected instance survives a reload.
      let stored = '';
      try { stored = localStorage.getItem(CONNECT_INSTANCE_KEY) || ''; } catch { stored = ''; }
      const preferred = instances.find((item) => item.name === stored)
        || instances.find((item) => isInstanceConnected(item.status))
        || instances[0]
        || null;
      instance = preferred ? preferred.name : '';

      el.innerHTML = '<div class="space-y-5">'
        + '<div class="' + cardCls + ' p-5"><h2 class="text-sm font-bold">Link your WhatsApp</h2>'
        + '<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Enter your WhatsApp number with the country code. The Evolution instance is created automatically as <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">wa-&lt;digits&gt;</code> — you never type an instance name.</p>'
        + '<div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"><div class="w-full sm:max-w-sm"><label class="' + labelCls + '" for="pair-phone">WhatsApp number (digits only)</label><input id="pair-phone" class="' + inputCls + '" inputmode="numeric" autocomplete="off" placeholder="2348027899720" value="' + esc(instanceNumber(instance) || '234') + '" /></div><div class="flex flex-wrap gap-2"><button id="get-code" class="' + btnPrimary + '">Get pairing code</button><button id="retry-code" class="' + btnGhost + '">Try Pairing Code Again</button></div></div>'
        + '<div id="pair-result" class="mt-4"></div></div>'
        + '<div class="grid gap-5 lg:grid-cols-2">'
        + '<div class="' + cardCls + ' p-5"><div class="flex items-center justify-between gap-3"><h2 class="text-sm font-bold">Link with QR</h2><span id="qr-status"></span></div>'
        + '<div id="qr-content" class="qr-box mt-4 flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400">Enter your number above, then generate a QR code.</div>'
        + '<button id="get-qr" class="' + btnPrimary + ' mt-4 w-full">Generate QR code</button></div>'
        + '<div class="' + cardCls + ' p-5"><div class="flex items-center justify-between"><h2 class="text-sm font-bold">Connection status</h2><button id="refresh-status" class="text-xs font-semibold text-emerald-600 hover:underline dark:text-emerald-400">Refresh</button></div>'
        + '<div id="status-box" class="mt-4 space-y-3 text-sm"><p class="text-slate-500 dark:text-slate-400">No WhatsApp linked yet.</p></div>'
        + '<div class="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950"><p class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Account</p><p id="selected-instance" class="mt-1 font-mono text-sm font-bold">—</p></div>'
        + '</div></div>'
        + '<div class="' + cardCls + ' overflow-hidden"><div class="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800"><h2 class="text-sm font-bold">Linked numbers</h2><span class="text-xs text-slate-500 dark:text-slate-400" id="instance-count">' + instances.length + '</span></div><div id="instance-list" class="divide-y divide-slate-200 dark:divide-slate-800"></div></div>'
        + '</div>';

      const phoneInput = $('#pair-phone', el);
      const qrContent = $('#qr-content', el);
      const statusBox = $('#status-box', el);
      const accountLabel = $('#selected-instance', el);
      const resultBox = $('#pair-result', el);
      const listEl = $('#instance-list', el);

      function setText(node, value) {
        if (node) node.textContent = String(value);
      }

      function phoneDigits() {
        return String(phoneInput.value || '').replace(/\D/g, '');
      }

      function instanceFromPhone() {
        const phone = phoneDigits();
        return phone.length >= 8 ? 'wa-' + phone : null;
      }

      function findInstance(name) {
        return instances.find((item) => item.name === name) || null;
      }

      function currentStatus() {
        const found = findInstance(instance);
        return found ? found.status : 'not_found';
      }

      function remember(name) {
        instance = name || '';
        try {
          if (instance) localStorage.setItem(CONNECT_INSTANCE_KEY, instance);
          else localStorage.removeItem(CONNECT_INSTANCE_KEY);
        } catch { /* storage disabled - the selection just will not survive reload */ }
        const number = instanceNumber(instance);
        if (number && phoneInput) phoneInput.value = number;
        setText(accountLabel, number || instance || '—');
      }

      /** "Connected as X" only when Evolution really reports open. */
      function renderStatus(status) {
        const meta = connectStatusMeta(status);
        const number = instanceNumber(instance);
        $('#qr-status', el).innerHTML = connectStatusBadge(status);
        statusBox.innerHTML = '<div class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800"><div class="min-w-0"><p class="truncate font-semibold">'
          + esc(meta.key === 'open' ? 'Connected as ' + (number || instance) : 'Not connected')
          + '</p><p class="text-xs text-slate-500 dark:text-slate-400">state: ' + esc(status || 'unknown') + '</p></div>'
          + '<span class="h-2.5 w-2.5 flex-none rounded-full ' + meta.dot + '"></span></div>'
          + (meta.key === 'open'
            ? '<p class="text-xs text-emerald-600 dark:text-emerald-400">Ready - messages are routed to your hosted agent.</p>'
            : '<p class="text-xs text-slate-500 dark:text-slate-400">Enter the pairing code on WhatsApp, then wait for “open”.</p>');
        setText(accountLabel, number || instance || '—');
      }

      function renderInstances() {
        setText($('#instance-count', el), instances.length);
        if (!instances.length) {
          listEl.innerHTML = '<p class="px-5 py-8 text-center text-sm text-slate-500 dark:text-slate-400">No WhatsApp number linked yet. Enter your number above.</p>';
          return;
        }
        listEl.innerHTML = instances.map((item) => {
          const meta = connectStatusMeta(item.status);
          const number = instanceNumber(item.name) || String(item.number || '').replace(/\D/g, '');
          const active = item.name === instance;
          return '<div class="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between' + (active ? ' bg-emerald-500/5' : '') + '">'
            + '<div class="min-w-0"><p class="truncate font-mono text-sm font-bold">' + esc(number || item.name) + '</p><p class="truncate text-[11px] text-slate-500 dark:text-slate-400">' + esc(item.profileName || 'No profile name') + '</p></div>'
            + '<div class="flex flex-wrap items-center gap-2">'
            + connectStatusBadge(item.status)
            + '<button data-select="' + esc(item.name) + '" class="' + btnGhost + ' !px-2.5 !py-1 !text-xs">Select</button>'
            + (meta.key === 'open'
              ? ''
              : '<button data-reconnect="' + esc(item.name) + '" class="' + btnGhost + ' !px-2.5 !py-1 !text-xs text-emerald-600 dark:text-emerald-400">Reconnect</button><button data-delete="' + esc(item.name) + '" class="' + btnGhost + ' !px-2.5 !py-1 !text-xs text-rose-600 dark:text-rose-400">Delete</button>')
            + '</div></div>';
        }).join('');

        $$('[data-select]', listEl).forEach((button) => {
          button.addEventListener('click', async () => {
            remember(button.dataset.select);
            renderInstances();
            renderStatus(currentStatus());
            startPolling();
            await syncFromEvolution();
          });
        });

        $$('[data-delete]', listEl).forEach((button) => {
          button.addEventListener('click', async () => {
            const name = button.dataset.delete;
            if (!confirm('Delete instance ' + name + '?')) return;
            button.disabled = true;
            try {
              await api('/api/instance/delete/' + encodeURIComponent(name), { method: 'DELETE' });
              connectedNotified.delete(name);
              if (instance === name) remember('');
              toast('Instance deleted');
              await syncFromEvolution();
              startPolling();
            } catch (error) {
              toast(error.message, 'error');
              button.disabled = false;
            }
          });
        });

        $$('[data-reconnect]', listEl).forEach((button) => {
          button.addEventListener('click', async () => {
            const name = button.dataset.reconnect;
            button.disabled = true;
            try {
              await api('/api/instance/reconnect/' + encodeURIComponent(name), { method: 'POST' });
              toast('Reconnecting…');
              startPolling();
              await syncFromEvolution();
            } catch (error) {
              toast(error.message, 'error');
              button.disabled = false;
            }
          });
        });
      }

      function startPolling() {
        if (timer) return;
        timer = setInterval(() => {
          if (!document.hidden) syncFromEvolution();
        }, 5000);
      }

      function stopPolling() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
      }

      /** Real state from Evolution: GET /instance/fetchInstances + connectionState. */
      async function syncFromEvolution() {
        try {
          const data = await api('/api/instances');
          instances = data.instances || [];
          state.instances = instances;
        } catch (error) {
          console.error('[connect] /api/instances failed', error);
          return;
        }
        if (!instance && instances.length) remember(instances[0].name);
        renderInstances();

        let status = currentStatus();
        if (instance && !isInstanceConnected(status)) {
          try {
            const live = await api('/api/instance/status/' + encodeURIComponent(instance));
            if (live && live.state) {
              status = live.state;
              const found = findInstance(instance);
              if (found) found.status = live.state;
              renderInstances();
            }
          } catch (error) {
            console.warn('[connect] status check failed:', error.message);
          }
        }
        renderStatus(status);

        if (instance && isInstanceConnected(status)) {
          stopPolling();
          if (!connectedNotified.has(instance)) {
            connectedNotified.add(instance);
            toast('Connected');
          }
        }
      }

      async function getQR() {
        const target = instanceFromPhone() || instance;
        if (!target) return toast('Enter your WhatsApp number first', 'info');
        remember(target);
        renderInstances();
        qrContent.innerHTML = spinner('Generating QR');
        try {
          const number = instanceNumber(instance) || phoneDigits();
          const result = await api('/api/instance/connect/' + encodeURIComponent(instance) + (number ? '?number=' + encodeURIComponent(number) : ''));
          const raw = result.base64 || '';
          if (!raw) {
            qrContent.innerHTML = '<div class="text-sm text-slate-500 dark:text-slate-400">No QR yet. If the number is already linked, status will show <b>Connected</b>.<br /><button id="retry-qr" class="mt-3 text-emerald-600 underline dark:text-emerald-400">Try again</button></div>';
            const retry = $('#retry-qr', qrContent);
            if (retry) retry.addEventListener('click', getQR);
          } else {
            const src = raw.startsWith('data:') ? raw : 'data:image/png;base64,' + raw;
            qrContent.innerHTML = '<div class="text-center"><img src="' + src + '" alt="WhatsApp QR code" class="mx-auto h-56 w-56 rounded-lg bg-white p-2" /><p class="mt-3 text-xs text-slate-500 dark:text-slate-400">WhatsApp → Linked devices → Link a device</p></div>';
          }
          startPolling();
          await syncFromEvolution();
        } catch (error) {
          qrContent.innerHTML = '<div class="text-sm text-rose-500">' + esc(error.message) + '</div>';
        }
      }

      /** WhatsApp codes are 8 characters and may contain letters (e.g. 6DAQQ8N2). */
      function paintPairCode(code) {
        const raw = String(code || '').trim().toUpperCase();
        const pretty = raw.length === 8 && /^\d{8}$/.test(raw) ? raw.replace(/(\d{4})(\d{4})/, '$1-$2') : raw;
        resultBox.innerHTML = '<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5 text-center"><p class="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Pairing code</p>'
          + '<p class="mt-3 select-all font-mono text-4xl font-extrabold tracking-[0.18em] text-emerald-700 dark:text-emerald-300 sm:text-5xl">' + esc(pretty) + '</p>'
          + '<button id="copy-code" class="' + btnGhost + ' mt-4 !py-1.5 !text-xs">Copy code</button>'
          + '<p class="mt-3 text-xs text-slate-600 dark:text-slate-300">WhatsApp → Linked devices → Link with phone number</p></div>';
        const copy = $('#copy-code', resultBox);
        if (copy) {
          copy.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(raw);
              toast('Pairing code copied');
            } catch {
              toast('Copy failed - select the code and copy it', 'error');
            }
          });
        }
      }

      // One pairing request at a time. A second connect call invalidates the first
      // code, so the buttons stay locked for 60s after a successful request only.
      const idleCodeLabels = { 'get-code': 'Get pairing code', 'retry-code': 'Try Pairing Code Again' };

      function paintCodeButtons() {
        const remaining = Math.max(0, Math.ceil((pairCooldownUntil - Date.now()) / 1000));
        Object.keys(idleCodeLabels).forEach((id) => {
          const button = $('#' + id, el);
          if (!button) return;
          const locked = pairBusy || remaining > 0;
          button.disabled = locked;
          button.classList.toggle('opacity-50', locked);
          button.classList.toggle('cursor-not-allowed', locked);
          button.textContent = pairBusy
            ? 'Requesting code…'
            : remaining > 0
              ? idleCodeLabels[id] + ' (' + remaining + 's)'
              : idleCodeLabels[id];
        });
      }

      function startCodeCooldown() {
        pairCooldownUntil = Date.now() + CODE_COOLDOWN_MS;
        clearInterval(pairCooldownTimer);
        paintCodeButtons();
        pairCooldownTimer = setInterval(() => {
          paintCodeButtons();
          if (Date.now() >= pairCooldownUntil) clearInterval(pairCooldownTimer);
        }, 1000);
      }

      async function getCode() {
        if (pairBusy || Date.now() < pairCooldownUntil) return;
        const phone = phoneDigits();
        if (phone.length < 8) return toast('Enter the full international number', 'error');
        const target = 'wa-' + phone;
        pairBusy = true;
        paintCodeButtons();
        resultBox.innerHTML = spinner('Requesting pairing code');
        let failed = false;
        try {
          // Server-side ladder: reset a closed instance, create it with the number,
          // then read the code from create (or one connect call, then the QR).
          const result = await api('/api/instance/pair/' + encodeURIComponent(target), {
            method: 'POST',
            body: { number: phone },
            timeoutMs: 150000,
          });
          remember(result.instance || target);
          renderInstances();
          const code = result.pairingCode ? String(result.pairingCode) : '';
          if (code) {
            paintPairCode(code);
          } else {
            const raw = String(result.qr || result.base64 || '');
            if (raw) {
              const src = raw.startsWith('data:') ? raw : 'data:image/png;base64,' + raw;
              resultBox.innerHTML = '<div class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-center"><p class="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">No pairing code from Evolution - scan this QR instead</p><img src="' + src + '" alt="WhatsApp QR code" class="mx-auto mt-3 h-48 w-48 rounded-lg bg-white p-2" /></div>';
            } else {
              resultBox.innerHTML = '<p class="text-sm text-amber-600 dark:text-amber-400">Evolution returned neither a pairing code nor a QR. Its raw response is in the server log, so try again in a moment.</p>';
            }
          }
          startPolling();
          await syncFromEvolution();
        } catch (error) {
          failed = true;
          resultBox.innerHTML = '<p class="text-sm text-rose-500">' + esc(error.message) + '</p>';
        } finally {
          pairBusy = false;
          // No cooldown when the call itself failed: the user can retry immediately.
          if (failed) paintCodeButtons();
          else startCodeCooldown();
        }
      }

      remember(instance);
      renderInstances();
      renderStatus(currentStatus());
      paintCodeButtons();

      $('#get-qr', el).addEventListener('click', getQR);
      $('#get-code', el).addEventListener('click', getCode);
      $('#retry-code', el).addEventListener('click', getCode);
      $('#refresh-status', el).addEventListener('click', async () => {
        startPolling();
        await syncFromEvolution();
      });

      await syncFromEvolution();
      if (!isInstanceConnected(currentStatus())) startPolling();

      return () => {
        stopPolling();
        clearInterval(pairCooldownTimer);
      };
    }
