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
        + '<div class="' + cardCls + ' p-4"><div class="flex items-start justify-between gap-2"><p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">AI keys (BYOK)</p>' + statusPill(ai.groq || ai.openrouter) + '</div><p class="mt-3 text-sm font-semibold">Groq ' + (ai.groq ? '✓' : '—') + ' · OpenRouter ' + (ai.openrouter ? '✓' : 'optional') + '</p><p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Voice TTS: ' + esc(ai.tts || 'unavailable') + '</p></div>'
        + '<div class="' + cardCls + ' border-amber-500/30 p-4"><div class="flex items-start justify-between gap-2"><p class="text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">Telegram</p><span class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700 dark:text-amber-300">Soon</span></div><p class="mt-3 text-sm font-semibold text-amber-700 dark:text-amber-300">' + TELEGRAM + '</p><p class="mt-1 text-xs text-amber-600/80 dark:text-amber-200/70">Not part of this build</p></div>'
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
        + '<div class="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm"><span class="font-semibold text-amber-700 dark:text-amber-300">' + TELEGRAM + '</span><span class="text-amber-700/80 dark:text-amber-200/70"> — Telegram MTProto is not included in this app. All Telegram endpoints return 410 Gone.</span></div>'
        + '</div>';
      return loadCatalog().catch(() => null);
    }

    /* -------------------------------- connect ----------------------------- */
    async function connectPage(el) {
      const data = await loadInstances();
      let instance = state.instances[0]?.name || '';
      let timer = null;
      let tab = 'qr';

      el.innerHTML = '<div class="space-y-5">'
        + '<div class="' + cardCls + ' p-5"><div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">'
        + '<div class="w-full sm:max-w-md"><label class="' + labelCls + '" for="instance-name">Evolution instance name</label><input id="instance-name" class="' + inputCls + '" placeholder="my-whatsapp" /></div>'
        + '<button id="create-instance" class="' + btnPrimary + '">Create instance</button></div>'
        + '<p class="mt-3 text-xs text-slate-500 dark:text-slate-400">The webhook is registered automatically at <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">/webhook/&lt;instance&gt;</code>. Existing instances are listed below.</p></div>'
        + '<div class="grid gap-5 lg:grid-cols-2">'
        + '<div class="' + cardCls + ' p-5"><div class="flex items-center justify-between gap-3"><h2 class="text-sm font-bold">Link with QR</h2><span id="qr-status"></span></div>'
        + '<div class="mt-3 flex rounded-lg bg-slate-100 p-1 text-xs font-semibold dark:bg-slate-800"><button data-tab="qr" class="tab-btn flex-1 rounded-md px-3 py-1.5">QR Code</button><button data-tab="phone" class="tab-btn flex-1 rounded-md px-3 py-1.5">Phone Number</button></div>'
        + '<div id="qr-panel" class="mt-4"><div class="qr-box flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400" id="qr-content">Create or select an instance, then generate a QR code.</div>'
        + '<button id="get-qr" class="' + btnPrimary + ' mt-4 w-full">Generate QR code</button></div>'
        + '<div id="phone-panel" class="mt-4 hidden"><label class="' + labelCls + '" for="pair-phone">WhatsApp number (international, digits only)</label>'
        + '<input id="pair-phone" class="' + inputCls + '" value="234" placeholder="2348012345678" inputmode="numeric" />'
        + '<button id="get-code" class="' + btnPrimary + ' mt-3 w-full">Get 8-digit pairing code</button>'
        + '<div id="pair-result" class="mt-4"></div>'
        + '<p class="mt-3 text-xs text-slate-500 dark:text-slate-400">WhatsApp → Linked devices → Link with phone number → enter the code.</p></div>'
        + '</div>'
        + '<div class="' + cardCls + ' p-5"><div class="flex items-center justify-between"><h2 class="text-sm font-bold">Connection status</h2><button id="refresh-status" class="text-xs font-semibold text-emerald-600 hover:underline dark:text-emerald-400">Refresh</button></div>'
        + '<div id="status-box" class="mt-4 space-y-3 text-sm"><p class="text-slate-500 dark:text-slate-400">No instance selected.</p></div>'
        + '<div class="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400"><p class="font-semibold text-slate-700 dark:text-slate-200">Selected instance</p><p id="selected-instance" class="mt-1">—</p></div>'
        + '</div></div>'
        + '<div class="' + cardCls + ' overflow-hidden"><div class="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800"><h2 class="text-sm font-bold">Instances</h2><span class="text-xs text-slate-500 dark:text-slate-400" id="instance-count">' + state.instances.length + '</span></div><div id="instance-list" class="divide-y divide-slate-200 dark:divide-slate-800"></div></div>'
        + '</div>';

      const qrContent = $('#qr-content', el);
      const statusBox = $('#status-box', el);
      const selectedLabel = $('#selected-instance', el);
      const nameInput = $('#instance-name', el);

      function setTab(next) {
        tab = next;
        $$('.tab-btn', el).forEach((button) => {
          const active = button.dataset.tab === tab;
          button.classList.toggle('bg-white', active);
          button.classList.toggle('shadow-sm', active);
          button.classList.toggle('dark:bg-slate-700', active);
        });
        $('#qr-panel', el).classList.toggle('hidden', tab !== 'qr');
        $('#phone-panel', el).classList.toggle('hidden', tab !== 'phone');
      }

      function renderStatus(status) {
        const connected = isInstanceConnected(status);
        $('#qr-status', el).innerHTML = statusPill(connected, 'Connected', connected ? '' : 'Waiting');
        statusBox.innerHTML = '<div class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800"><div><p class="font-semibold">' + esc(instance || 'No instance') + '</p><p class="text-xs text-slate-500 dark:text-slate-400">state: ' + esc(status || 'unknown') + '</p></div>'
          + '<span class="h-2.5 w-2.5 rounded-full ' + (connected ? 'bg-emerald-500' : 'bg-amber-500') + '"></span></div>'
          + (connected ? '<p class="text-xs text-emerald-600 dark:text-emerald-400">Ready — messages are routed to your hosted agent.</p>' : '<p class="text-xs text-slate-500 dark:text-slate-400">Scan the QR or use a pairing code, then wait for “open”.</p>');
        selectedLabel.textContent = instance || '—';
      }

      async function refreshStatus() {
        if (!instance) return;
        try {
          const status = await api('/api/instance/status/' + encodeURIComponent(instance));
          renderStatus(status.state);
        } catch (error) {
          $('#qr-status', el).innerHTML = statusPill(false, '', 'Error');
          statusBox.innerHTML = '<p class="text-xs text-rose-500">' + esc(error.message) + '</p>';
        }
      }

      function renderInstances() {
        const list = $('#instance-list', el);
        $('#instance-count', el).textContent = state.instances.length;
        if (!state.instances.length) {
          list.innerHTML = '<p class="px-5 py-8 text-center text-sm text-slate-500 dark:text-slate-400">No instances yet. Create one above.</p>';
          return;
        }
        list.innerHTML = state.instances.map((item) => {
          const connected = isInstanceConnected(item.status);
          return '<div class="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">'
            + '<div class="min-w-0"><p class="truncate text-sm font-semibold">' + esc(item.name) + '</p><p class="truncate text-xs text-slate-500 dark:text-slate-400">' + esc(item.profileName || item.number || '—') + '</p></div>'
            + '<div class="flex items-center gap-2"><span class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ' + (connected ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-slate-300 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400') + '">' + esc(item.status || 'unknown') + '</span>'
            + '<button data-select="' + esc(item.name) + '" class="' + btnGhost + ' !px-2.5 !py-1 !text-xs">Select</button></div></div>';
        }).join('');
        $$('[data-select]', list).forEach((button) =>
          button.addEventListener('click', () => {
            instance = button.dataset.select;
            nameInput.value = instance;
            setTab('qr');
            renderStatus('');
            refreshStatus();
            getQR();
          }),
        );
      }

      async function getQR() {
        if (!instance) return toast('Create or select an instance first', 'info');
        qrContent.innerHTML = spinner('Generating QR');
        try {
          const result = await api('/api/instance/connect/' + encodeURIComponent(instance));
          const raw = result.base64 || '';
          if (!raw) {
            qrContent.innerHTML = '<div class="text-sm text-slate-500 dark:text-slate-400">No QR yet. If the instance is already linked, status will show <b>open</b>.<br /><button id="retry-qr" class="mt-3 text-emerald-600 underline dark:text-emerald-400">Try again</button></div>';
            const retry = $('#retry-qr', qrContent);
            if (retry) retry.addEventListener('click', getQR);
            return;
          }
          const src = raw.startsWith('data:') ? raw : 'data:image/png;base64,' + raw;
          qrContent.innerHTML = '<div class="text-center"><img src="' + src + '" alt="WhatsApp QR code" class="mx-auto h-56 w-56 rounded-lg bg-white p-2" /><p class="mt-3 text-xs text-slate-500 dark:text-slate-400">WhatsApp → Linked devices → Link a device</p></div>';
          refreshStatus();
        } catch (error) {
          qrContent.innerHTML = '<div class="text-sm text-rose-500">' + esc(error.message) + '</div>';
        }
      }

      async function getCode() {
        const phone = String($('#pair-phone', el).value || '').replace(/\D/g, '');
        const box = $('#pair-result', el);
        if (phone.length < 8) return toast('Enter the full international number', 'error');
        box.innerHTML = spinner('Requesting pairing code');
        try {
          const result = await api('/api/instance/connect/' + encodeURIComponent(instance) + '?number=' + encodeURIComponent(phone));
          if (!result.pairingCode) {
            box.innerHTML = '<p class="text-sm text-amber-600 dark:text-amber-400">No pairing code returned. Use the QR tab instead.</p>';
          } else {
            box.innerHTML = '<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center"><p class="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Pairing code</p><p class="mt-2 font-mono text-3xl font-extrabold tracking-[0.3em] text-emerald-700 dark:text-emerald-300">' + esc(String(result.pairingCode).replace(/(\d{4})(\d{4})/, '$1-$2')) + '</p><p class="mt-2 text-xs text-slate-600 dark:text-slate-300">WhatsApp → Linked devices → Link with phone number</p></div>';
            refreshStatus();
          }
        } catch (error) {
          box.innerHTML = '<p class="text-sm text-rose-500">' + esc(error.message) + '</p>';
        }
      }

      nameInput.value = instance;
      renderInstances();
      renderStatus('');
      if (instance) refreshStatus();
      setTab('qr');

      $$('.tab-btn', el).forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));
      $('#get-qr', el).addEventListener('click', getQR);
      $('#get-code', el).addEventListener('click', getCode);
      $('#refresh-status', el).addEventListener('click', refreshStatus);

      $('#create-instance', el).addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const name = String(nameInput.value || '').trim();
        if (!name) return toast('Instance name is required', 'error');
        button.disabled = true;
        button.textContent = 'Creating…';
        try {
          const result = await api('/api/instance/create', { method: 'POST', body: { instanceName: name } });
          instance = result.instance;
          nameInput.value = instance;
          await loadInstances();
          renderInstances();
          renderStatus('');
          if (result.webhook && result.webhook.ok === false) toast('Instance created, webhook failed: ' + result.webhook.error, 'error');
          else toast('Instance created and webhook registered');
          getQR();
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          button.disabled = false;
          button.textContent = 'Create instance';
        }
      });

      timer = setInterval(() => {
        if (document.hidden) return;
        if (instance) refreshStatus();
      }, 5000);

      return () => clearInterval(timer);
    }
