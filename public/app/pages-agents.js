    /* -------------------------------- agents ------------------------------ */
    async function agentsPage(el) {
      await Promise.all([loadAgents(), loadCatalog(), loadInstances(), getConfig().catch(() => null)]);
      let mediaFiles = [];
      let pollTimer = null;

      // Orpheus voices exposed by Groq TTS (env GROQ_TTS_VOICE overrides the default).
      // Declared at the top of the page scope: the create/edit form body uses it
      // while it is being built, so declaring it lower down threw a TDZ error and
      // the modal never opened.
      const VOICES = [
        { id: 'troy', label: 'Troy · English (US) · male, warm' },
        { id: 'hannah', label: 'Hannah · English (US) · female, calm' },
        { id: 'diana', label: 'Diana · English (US) · female, bright' },
        { id: 'austin', label: 'Austin · English (US) · male, deep' },
        { id: 'daniel', label: 'Daniel · English (US) · male, neutral' },
        { id: 'autumn', label: 'Autumn · English (US) · female, soft' },
        { id: 'leah', label: 'Leah · English (US) · female, lively' },
        { id: 'lucas', label: 'Lucas · English (US) · male, young' },
        { id: 'michael', label: 'Michael · English (US) · male, steady' },
        { id: 'david', label: 'David · English (US) · male, mature' },
      ];

      function connectedInstances() {
        return (state.instances || []).filter((item) => isInstanceConnected(item.status));
      }

      function accountOptionLabel(instance) {
        const number = instanceNumber(instance.name) || String(instance.number || '').replace(/\D/g, '');
        const state_ = String(instance.status || 'unknown');
        return instance.name + ' (' + state_ + ')' + (number ? ' — ' + number : '');
      }

      function repliesViaLabel(agent) {
        const number = agent.connectedNumber || instanceNumber(agent.connectedInstance) || '';
        return number || agent.connectedInstance || 'not set';
      }

      function renderList() {
        if (!state.agents.length) {
          return '<div class="' + cardCls + ' p-10 text-center"><p class="text-2xl">✦</p><p class="mt-3 text-sm font-semibold">No agents yet</p><p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Create your first agent, pick a model that really replies and choose the WhatsApp account it answers from.</p><button id="empty-create" class="' + btnPrimary + ' mt-5">Create agent</button></div>';
        }
        return '<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">' + state.agents.map((agent) =>
          '<div class="' + cardCls + ' flex flex-col p-5">'
          + '<div class="flex items-start justify-between gap-3"><div class="min-w-0"><h3 class="truncate text-sm font-bold">' + esc(agent.name) + '</h3><p class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">' + esc(modelLabel(agent.model)) + '</p></div>' + modelBadge(agent.model) + '</div>'
          + '<p class="mt-3 line-clamp-3 min-h-[3rem] text-xs leading-relaxed text-slate-600 dark:text-slate-300">' + esc(agent.instruction || 'No instruction set.') + '</p>'
          + '<div class="mt-3 flex flex-wrap gap-1.5 text-[10px] font-semibold">'
          + '<span class="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">Replies via: ' + esc(repliesViaLabel(agent)) + '</span>'
          + (agent.voiceEnabled ? '<span class="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-sky-600 dark:text-sky-400">VOICE</span>' : '')
          + (agent.mediaEnabled ? '<span class="rounded-md bg-violet-500/10 px-1.5 py-0.5 text-violet-600 dark:text-violet-400">MEDIA ' + agent.mediaFiles.length + '</span>' : '')
          + '</div>'
          + '<div class="mt-4 flex gap-2 border-t border-slate-200 pt-4 dark:border-slate-800"><button data-edit="' + esc(agent.id) + '" class="' + btnGhost + ' flex-1 !py-1.5 !text-xs">Edit</button><button data-delete="' + esc(agent.id) + '" class="' + btnDanger + ' !px-3 !py-1.5 !text-xs">Delete</button></div>'
          + '</div>').join('') + '</div>';
      }

      function paint() {
        const accounts = connectedInstances();
        el.innerHTML = '<div class="space-y-5"><div class="flex flex-wrap items-center justify-between gap-3"><div><p class="text-sm text-slate-500 dark:text-slate-400">Agents reply with the models that were tested live on the server, from the WhatsApp account you assign.</p></div><button id="create-agent" class="' + btnPrimary + '">+ Create agent</button></div>'
          + '<div class="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">🔑 AI keys are read only from the server environment (<code class="rounded bg-slate-200 px-1 dark:bg-slate-800">GROQ_API_KEY</code>, <code class="rounded bg-slate-200 px-1 dark:bg-slate-800">OPENROUTER_API_KEY</code>). Nothing is typed in the browser. '
          + (state.config?.ai?.groq ? '<b class="text-emerald-600 dark:text-emerald-400">Groq key: ready</b>' : '<b class="text-rose-600 dark:text-rose-400">GROQ_API_KEY missing on the server</b>')
          + ' · ' + (accounts.length ? accounts.length + ' connected WhatsApp account(s)' : '<b class="text-amber-600 dark:text-amber-400">no connected WhatsApp account</b>')
          + '</div>'
          + '<div id="agent-list">' + renderList() + '</div></div>';

        // Both "+ Create agent" (header) and "Create agent" (empty state) open the
        // same modal. Bound to click *and* touchend: some mobile browsers swallow
        // the synthesized click on buttons inside scrollable containers.
        const openCreate = (event) => {
          if (event) event.preventDefault();
          console.log('OPEN MODAL CLICKED');
          try {
            openAgentModal();
          } catch (error) {
            console.error('[agents] could not open the create modal', error);
            toast('Could not open the form: ' + error.message, 'error');
          }
        };
        const createButton = $('#create-agent', el);
        if (createButton) {
          createButton.style.pointerEvents = 'auto';
          createButton.addEventListener('click', openCreate);
          createButton.addEventListener('touchend', openCreate);
        }
        $$('[data-edit]', el).forEach((button) => button.addEventListener('click', () => openAgentModal(state.agents.find((a) => a.id === button.dataset.edit))));
        $$('[data-delete]', el).forEach((button) => button.addEventListener('click', () => deleteAgentById(button.dataset.delete)));
        const emptyButton = $('#empty-create', el);
        if (emptyButton) {
          emptyButton.style.pointerEvents = 'auto';
          emptyButton.addEventListener('click', openCreate);
          emptyButton.addEventListener('touchend', openCreate);
        }
      }

      function openAgentModal(agent = null) {
        const editing = Boolean(agent);
        mediaFiles = agent ? [...agent.mediaFiles] : [];

        const accounts = connectedInstances();
        const currentInstance = agent?.connectedInstance || '';
        const instanceField = accounts.length
          ? '<div><label class="' + labelCls + '" for="agent-instance">Connected WhatsApp account to reply from *</label><select id="agent-instance" required class="' + inputCls + '"><option value="">Select a connected account…</option>'
            + accounts.map((item) => '<option value="' + esc(item.name) + '"' + (item.name === currentInstance ? ' selected' : '') + '>' + esc(accountOptionLabel(item)) + '</option>').join('')
            + '</select><p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Replies are sent through this account via WhatsApp sendText / sendMedia.</p></div>'
          : '<div class="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-200"><p class="font-bold">Connect WhatsApp first in Connect page</p><p class="mt-1">No account with state <code>open</code> was found, so there is nowhere to send replies from.</p><a href="/connect" data-link class="' + btnPrimary + ' mt-3 !py-1.5 !text-xs">Go to Connect</a></div>';

        const body = '<form id="agent-form" class="space-y-4">'
          + '<div><label class="' + labelCls + '" for="agent-name">Name</label><input id="agent-name" type="text" inputmode="text" autocapitalize="sentences" autocomplete="off" style="pointer-events:auto" class="' + inputCls + '" required placeholder="Sales assistant" value="' + esc(agent?.name || '') + '" /></div>'
          + instanceField
          + '<div><label class="' + labelCls + '" for="agent-instruction">Instruction / system prompt</label><textarea id="agent-instruction" rows="4" class="' + inputCls + '" placeholder="You are a friendly support agent for ...">' + esc(agent?.instruction || '') + '</textarea></div>'
          + '<div class="rounded-xl border border-slate-200 p-4 dark:border-slate-800">'
          + '<div class="flex flex-wrap items-center justify-between gap-2"><p class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Model</p><span id="model-test-state" class="text-[11px] text-slate-500 dark:text-slate-400"></span></div>'
          + '<div id="provider-tabs" class="mt-2 flex flex-wrap gap-1.5"></div>'
          + '<div id="groq-panel" class="mt-2 space-y-1.5"></div>'
          + '<div id="openrouter-panel" class="mt-2 hidden space-y-1.5">'
          + '<input id="model-search" class="' + inputCls + ' !py-1.5 !text-xs" placeholder="Search OpenRouter models (claude, qwen, gemini…)" autocomplete="off" />'
          + '<input id="model-custom" class="' + inputCls + ' !py-1.5 !font-mono !text-xs" placeholder="Or type any model id: anthropic/claude-3.5-sonnet" autocomplete="off" />'
          + '<div id="model-list" class="max-h-64 space-y-1.5 overflow-y-auto pr-1"></div>'
          + '</div>'
          + '<div class="mt-3 flex flex-wrap items-center justify-between gap-2"><p id="model-meta" class="text-[11px] text-slate-500 dark:text-slate-400"></p><button type="button" id="retest-models" class="' + btnGhost + ' !py-1 !text-[11px]">Re-test models live</button></div>'
          + '</div>'
          + '<div class="grid gap-3 sm:grid-cols-2">'
          + '<label class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800"><span><span class="block text-sm font-semibold">Voice notes (Groq TTS)</span><span class="text-xs text-slate-500 dark:text-slate-400">Text → speech, sent with sendWhatsAppAudio</span></span><input type="checkbox" class="toggle" id="agent-voice"' + (agent?.voiceEnabled ? ' checked' : '') + ' /></label>'
          + '<label class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800"><span><span class="block text-sm font-semibold">Media files</span><span class="text-xs text-slate-500 dark:text-slate-400">Send real uploads</span></span><input type="checkbox" class="toggle" id="agent-media"' + (agent?.mediaEnabled ? ' checked' : '') + ' /></label>'
          + '</div>'
          + '<div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800"><label class="' + labelCls + '" for="agent-voice-id">Voice</label>'
          + '<div class="flex flex-col gap-2 sm:flex-row sm:items-center"><select id="agent-voice-id" class="' + inputCls + ' !py-1.5 !text-xs">' + VOICES.map((v) => '<option value="' + v.id + '"' + ((agent?.voiceId || 'troy') === v.id ? ' selected' : '') + '>' + v.label + '</option>').join('') + '</select>'
          + '<button type="button" id="preview-voice" class="' + btnGhost + ' whitespace-nowrap !py-1.5 !text-xs">▶ Play preview</button></div></div>'
          + '<div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800"><p class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Reply mode</p>'
          + '<div class="mt-2 flex flex-wrap gap-2">'
          + [['textOnly', 'Text only'], ['voiceOnly', 'Voice only'], ['both', 'Text + voice'], ['mirror', 'Mirror: voice for voice notes']].map(([value, label]) =>
            '<label class="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold dark:border-slate-800"><input type="radio" name="agent-reply-mode" value="' + value + '" class="accent-emerald-500"' + (((agent?.replyMode || 'textOnly') === value) ? ' checked' : '') + ' />' + label + '</label>').join('')
          + '</div></div>'
          + '<div id="media-section" class="' + (agent?.mediaEnabled ? '' : 'hidden') + ' rounded-xl border border-slate-200 p-4 dark:border-slate-800"><p class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Media (images, docs, audio · max 20 MB each)</p><div id="media-list" class="mt-3 space-y-2"></div><input id="agent-files" type="file" multiple class="mt-3 block w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-500 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-950 dark:text-slate-400" /></div>'
          + '<div class="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4 dark:border-slate-800"><button type="button" data-cancel class="' + btnGhost + '">Cancel</button><button type="submit" id="save-agent" class="' + btnPrimary + '"' + (accounts.length ? '' : ' disabled') + '>' + (editing ? 'Save changes' : 'Create agent') + '</button></div>'
          + '</form>';

        const modal = openModal({ title: editing ? 'Edit agent' : 'Create agent', body });
        modal.root.style.pointerEvents = 'auto';
        const form = $('#agent-form', modal.root);

        // Mobile: focus the name field explicitly and keep it tappable even when
        // an overlay style disables pointer events on its container.
        const nameInput = $('#agent-name', modal.root);
        if (nameInput) {
          nameInput.style.pointerEvents = 'auto';
          requestAnimationFrame(() => {
            try { nameInput.focus({ preventScroll: true }); } catch { nameInput.focus(); }
          });
        }
        const mediaSection = $('#media-section', form);
        const mediaList = $('#media-list', form);
        const listEl = $('#model-list', form);
        const tabsEl = $('#provider-tabs', form);
        const groqPanel = $('#groq-panel', form);
        const orPanel = $('#openrouter-panel', form);
        const stateEl = $('#model-test-state', form);
        const metaEl = $('#model-meta', form);

        // Groq is locked to exactly these 2 models - nothing else is offered.
        const GROQ_OPTIONS = [
          { id: 'groq/openai/gpt-oss-120b', label: '1. gpt-oss-120b - BEST (Sales/Coding)' },
          { id: 'groq/openai/gpt-oss-20b', label: '2. gpt-oss-20b - FASTEST' },
        ];

        let selectedModel = agent?.model || defaultModelId();
        let modelProvider = String(selectedModel).startsWith('openrouter/') ? 'openrouter' : 'groq';
        let modelQuery = '';
        let orCatalog = null;
        let orError = null;
        let orLoading = false;

        function providerButton(id, label) {
          const active = modelProvider === id;
          const cls = active
            ? 'rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-300'
            : 'rounded-full border border-slate-300 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800';
          return '<button type="button" data-provider="' + id + '" class="' + cls + '">' + label + '</button>';
        }

        function pickedRow(modelId, title, sub) {
          const checked = modelId === selectedModel;
          const border = checked
            ? 'border-emerald-500 bg-emerald-500/5'
            : 'border-slate-200 dark:border-slate-800';
          return '<label class="flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-xs ' + border + '">'
            + '<input type="radio" name="agent-model" value="' + esc(modelId) + '" class="accent-emerald-500"' + (checked ? ' checked' : '') + ' />'
            + '<span class="min-w-0 flex-1"><span class="block truncate font-semibold">' + esc(title) + '</span>'
            + '<span class="block truncate font-mono text-[10px] text-slate-500 dark:text-slate-400">' + esc(sub || modelId) + '</span></span>'
            + '<span class="flex flex-none items-center gap-1.5">' + modelBadge(modelId) + '</span></label>';
        }

        function bindRows(root) {
          $$('input[name="agent-model"]', root).forEach((input) =>
            input.addEventListener('change', () => {
              selectedModel = input.value;
              modelProvider = selectedModel.startsWith('openrouter/') ? 'openrouter' : 'groq';
              paintModelList();
            }),
          );
        }

        function paintMeta() {
          const info = modelInfo(selectedModel);
          metaEl.innerHTML = 'Selected: <b>' + esc(info?.displayName || modelLabel(selectedModel)) + '</b>'
            + (info ? ' · ' + esc(info.working ? 'tested, replies OK' : 'not working yet') : ' · not tested yet');
        }

        async function loadOpenRouterCatalog(force) {
          if (orLoading) return;
          if (orCatalog && !force) return;
          orLoading = true;
          listEl.innerHTML = spinner('Loading OpenRouter catalog');
          try {
            const data = await api('/api/openrouter/models' + (force ? '?refresh=1' : ''));
            orCatalog = Array.isArray(data.models) ? data.models : [];
            orError = data.ok === false ? (data.error || 'Could not load the OpenRouter catalog') : null;
          } catch (error) {
            orCatalog = [];
            orError = error.message;
          } finally {
            orLoading = false;
          }
        }

        function paintModelList() {
          tabsEl.innerHTML = providerButton('groq', 'Groq (2 models)') + providerButton('openrouter', 'OpenRouter (any model)');
          $$('[data-provider]', tabsEl).forEach((button) =>
            button.addEventListener('click', async () => {
              modelProvider = button.dataset.provider;
              if (modelProvider === 'openrouter' && !orCatalog) {
                await loadOpenRouterCatalog(false);
              }
              paintModelList();
            }),
          );

          groqPanel.classList.toggle('hidden', modelProvider !== 'groq');
          orPanel.classList.toggle('hidden', modelProvider !== 'openrouter');

          if (state.catalog.testing) {
            stateEl.textContent = 'Testing the Groq models live…';
            clearTimeout(pollTimer);
            pollTimer = setTimeout(async () => {
              await loadCatalog(true);
              if (!document.body.contains(tabsEl)) return;
              paintModelList();
            }, 5000);
          } else {
            stateEl.textContent = state.catalog.testedAt
              ? 'Tested ' + timeAgo(state.catalog.testedAt) + ' ago'
              : 'Not tested yet';
          }

          if (modelProvider === 'groq') {
            groqPanel.innerHTML = GROQ_OPTIONS.map((option) => pickedRow(option.id, option.label, option.id)).join('');
            bindRows(groqPanel);
            paintMeta();
            return;
          }

          const query = modelQuery.trim().toLowerCase();
          const customInput = $('#model-custom', form);
          const custom = String(customInput?.value || '').trim().replace(/^openrouter\//, '');

          let rows = '';
          if (custom) {
            rows += pickedRow('openrouter/' + custom, 'Use typed model: ' + custom, 'any OpenRouter model id');
          }

          if (!orCatalog) {
            rows += '<p class="rounded-lg border border-dashed border-slate-300 p-3 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">'
              + ('…') + '</p>';
          } else {
            const models = orCatalog.filter((model) =>
              !query || String(model.id + ' ' + (model.name || '')).toLowerCase().includes(query));
            if (!models.length) {
              rows += '<p class="rounded-lg border border-dashed border-slate-300 p-3 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">'
                + (query ? 'No catalog model matches “' + esc(modelQuery) + '”. Type the full id above to use it anyway.' : 'OpenRouter catalog is empty.')
                + '</p>';
            } else {
              rows += models.slice(0, 80).map((model) => pickedRow('openrouter/' + model.id, model.name || model.id, model.id)).join('');
              if (models.length > 80) {
                rows += '<p class="px-1 text-[10px] text-slate-500 dark:text-slate-400">Showing 80 of ' + models.length + ' matches — refine the search.</p>';
              }
            }
            if (orError) {
              rows += '<p class="text-[11px] text-rose-600 dark:text-rose-400">' + esc(orError) + '</p>';
            }
          }

          listEl.innerHTML = rows;
          bindRows(listEl);
          paintMeta();
        }

        $('#model-search', form).addEventListener('input', (event) => {
          modelQuery = event.target.value;
          paintModelList();
        });

        $('#model-custom', form).addEventListener('input', () => paintModelList());

        if (modelProvider === 'openrouter') {
          loadOpenRouterCatalog(false).then(paintModelList);
        }

        $('#retest-models', form).addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.textContent = 'Testing models…';
          try {
            const report = await api('/api/test-groq-models', { method: 'POST', timeoutMs: 240000 });
            state.catalog = {
              ...state.catalog,
              free: report.free || [],
              paid: report.paid || [],
              groups: report.groups || state.catalog.groups,
              testing: Boolean(report.testing),
              tested: Boolean(report.tested),
              testedAt: report.testedAt || null,
              errors: report.errors || [],
            };
            paintModelList();
            paintMeta();
            toast('Re-tested: ' + (report.counts?.freeWorking || 0) + ' free + ' + (report.counts?.paidWorking || 0) + ' paid working');
          } catch (error) {
            toast(error.message, 'error');
          } finally {
            button.disabled = false;
            button.textContent = 'Re-test models live';
          }
        });

        function paintMedia() {
          if (!mediaFiles.length) {
            mediaList.innerHTML = '<p class="text-xs text-slate-500 dark:text-slate-400">No files uploaded yet.</p>';
            return;
          }
          mediaList.innerHTML = mediaFiles.map((file, index) =>
            '<div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800"><div class="min-w-0"><p class="truncate text-xs font-semibold">' + esc(file.name) + '</p><p class="text-[10px] text-slate-500 dark:text-slate-400">' + esc(bytes(file.size)) + ' · ' + esc(file.type || 'file') + '</p></div>'
            + (editing ? '<button type="button" data-remove-media="' + index + '" class="text-xs font-semibold text-rose-500 hover:underline">Remove</button>' : '<span class="text-[10px] text-slate-400">uploads on save</span>') + '</div>').join('');

          if (editing) {
            $$('[data-remove-media]', mediaList).forEach((button) =>
              button.addEventListener('click', async () => {
                const file = mediaFiles[Number(button.dataset.removeMedia)];
                if (!file) return;
                try {
                  await api('/api/agents/' + encodeURIComponent(agent.id) + '/media?path=' + encodeURIComponent(file.path), { method: 'DELETE' });
                  mediaFiles = mediaFiles.filter((item) => item !== file);
                  paintMedia();
                  toast('Media removed');
                } catch (error) { toast(error.message, 'error'); }
              }),
            );
          }
        }

        paintModelList();
        paintMeta();
        paintMedia();

        $('#agent-media', form).addEventListener('change', (event) => {
          mediaSection.classList.toggle('hidden', !event.target.checked);
        });

        $('#preview-voice', form).addEventListener('click', () => {
          const voice = $('#agent-voice-id', form)?.value || 'troy';
          if (!('speechSynthesis' in window)) return toast('This browser cannot play a preview', 'info');
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance('Hi! This is the ' + voice + ' voice from your WhatsApp assistant.');
          window.speechSynthesis.speak(utterance);
        });

        $('[data-cancel]', form).addEventListener('click', () => {
          clearTimeout(pollTimer);
          modal.close();
        });

        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = $('#save-agent', form);
          const instanceEl = $('#agent-instance', form);
          const connectedInstance = instanceEl ? instanceEl.value : '';
          if (!connectedInstance) {
            return toast('Connect WhatsApp first in Connect page', 'error');
          }
          const payload = {
            name: $('#agent-name', form).value.trim(),
            instruction: $('#agent-instruction', form).value,
            model: selectedModel,
            voiceEnabled: $('#agent-voice', form).checked,
            voiceId: $('#agent-voice-id', form)?.value || null,
            replyMode: ($('input[name="agent-reply-mode"]:checked', form) || {}).value || 'textOnly',
            mediaEnabled: $('#agent-media', form).checked,
            connectedInstance,
          };
          if (!payload.name) return toast('Agent name is required', 'error');

          button.disabled = true;
          button.textContent = 'Saving…';
          try {
            const saved = editing
              ? await api('/api/agents/' + encodeURIComponent(agent.id), { method: 'PUT', body: payload })
              : await api('/api/agents', { method: 'POST', body: payload });

            const agentId = saved.agent.id;
            const files = $('#agent-files', form)?.files;
            if (files && files.length) {
              const formData = new FormData();
              Array.from(files).forEach((file) => formData.append('files', file));
              await api('/api/agents/' + encodeURIComponent(agentId) + '/media', { method: 'POST', body: formData });
            }

            clearTimeout(pollTimer);
            modal.close();
            await loadAgents();
            paint();
            toast(editing ? 'Agent updated' : 'Agent created');
          } catch (error) {
            toast(error.message, 'error');
            button.disabled = false;
            button.textContent = editing ? 'Save changes' : 'Create agent';
          }
        });
      }

      async function deleteAgentById(id) {
        const agent = state.agents.find((item) => item.id === id);
        if (!agent) return;
        if (!confirm('Delete agent “' + agent.name + '”? Its media files are removed too.')) return;
        try {
          await api('/api/agents/' + encodeURIComponent(id), { method: 'DELETE' });
          await loadAgents();
          paint();
          toast('Agent deleted');
        } catch (error) { toast(error.message, 'error'); }
      }

      paint();
    }
