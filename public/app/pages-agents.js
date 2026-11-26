    /* -------------------------------- agents ------------------------------ */
    async function agentsPage(el) {
      await Promise.all([loadAgents(), loadCatalog(), getConfig().catch(() => null)]);
      let mediaFiles = [];

      function renderList() {
        if (!state.agents.length) {
          return '<div class="' + cardCls + ' p-10 text-center"><p class="text-2xl">✦</p><p class="mt-3 text-sm font-semibold">No agents yet</p><p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Create your first agent, pick a free model and give it instructions.</p><button id="empty-create" class="' + btnPrimary + ' mt-5">Create agent</button></div>';
        }
        return '<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">' + state.agents.map((agent) =>
          '<div class="' + cardCls + ' flex flex-col p-5">'
          + '<div class="flex items-start justify-between gap-3"><div class="min-w-0"><h3 class="truncate text-sm font-bold">' + esc(agent.name) + '</h3><p class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">' + esc(modelLabel(agent.model)) + '</p></div>' + modelBadge(agent.model) + '</div>'
          + '<p class="mt-3 line-clamp-3 min-h-[3rem] text-xs leading-relaxed text-slate-600 dark:text-slate-300">' + esc(agent.instruction || 'No instruction set.') + '</p>'
          + '<div class="mt-3 flex flex-wrap gap-1.5 text-[10px] font-semibold">'
          + (agent.voiceEnabled ? '<span class="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-sky-600 dark:text-sky-400">VOICE</span>' : '')
          + (agent.mediaEnabled ? '<span class="rounded-md bg-violet-500/10 px-1.5 py-0.5 text-violet-600 dark:text-violet-400">MEDIA ' + agent.mediaFiles.length + '</span>' : '')
          + (agent.hasGroqKey ? '<span class="rounded-md bg-slate-500/10 px-1.5 py-0.5 text-slate-600 dark:text-slate-300">OWN GROQ KEY</span>' : '')
          + (agent.hasOpenRouterKey ? '<span class="rounded-md bg-slate-500/10 px-1.5 py-0.5 text-slate-600 dark:text-slate-300">OWN OR KEY</span>' : '')
          + '</div>'
          + '<div class="mt-4 flex gap-2 border-t border-slate-200 pt-4 dark:border-slate-800"><button data-edit="' + esc(agent.id) + '" class="' + btnGhost + ' flex-1 !py-1.5 !text-xs">Edit</button><button data-delete="' + esc(agent.id) + '" class="' + btnDanger + ' !px-3 !py-1.5 !text-xs">Delete</button></div>'
          + '</div>').join('') + '</div>';
      }

      function paint() {
        el.innerHTML = '<div class="space-y-5"><div class="flex flex-wrap items-center justify-between gap-3"><div><p class="text-sm text-slate-500 dark:text-slate-400">Agents reply with your own Groq or OpenRouter keys. Free models are selected by default.</p></div><button id="create-agent" class="' + btnPrimary + '">+ Create agent</button></div>'
          + '<div class="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-xs text-sky-700 dark:text-sky-300">⚠️ Use YOUR OWN keys (not the developer’s) to avoid limits. Groq is free at console.groq.com/keys. OpenRouter offers <b>:free</b> models and paid models — add a key in Settings.</div>'
          + '<div id="agent-list">' + renderList() + '</div></div>';

        $('#create-agent', el).addEventListener('click', () => openAgentModal());
        $$('[data-edit]', el).forEach((button) => button.addEventListener('click', () => openAgentModal(state.agents.find((a) => a.id === button.dataset.edit))));
        $$('[data-delete]', el).forEach((button) => button.addEventListener('click', () => deleteAgentById(button.dataset.delete)));
        const emptyButton = $('#empty-create', el);
        if (emptyButton) emptyButton.addEventListener('click', () => openAgentModal());
      }

      function openAgentModal(agent = null) {
        const editing = Boolean(agent);
        mediaFiles = agent ? [...agent.mediaFiles] : [];
        const body = '<form id="agent-form" class="space-y-4">'
          + '<div><label class="' + labelCls + '" for="agent-name">Name</label><input id="agent-name" class="' + inputCls + '" required placeholder="Sales assistant" value="' + esc(agent?.name || '') + '" /></div>'
          + '<div><label class="' + labelCls + '" for="agent-instruction">Instruction / system prompt</label><textarea id="agent-instruction" rows="5" class="' + inputCls + '" placeholder="You are a friendly support agent for ...">' + esc(agent?.instruction || '') + '</textarea></div>'
          + '<div><label class="' + labelCls + '" for="agent-model">Model</label><select id="agent-model" class="' + inputCls + '">' + modelSelectOptions(agent?.model || 'groq/llama-3.3-70b-versatile') + '</select><div id="model-meta" class="mt-2 text-xs text-slate-500 dark:text-slate-400"></div></div>'
          + '<div class="grid gap-3 sm:grid-cols-2">'
          + '<label class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800"><span><span class="block text-sm font-semibold">Voice notes</span><span class="text-xs text-slate-500 dark:text-slate-400">Reply with real voice' + (state.config?.ai?.groq ? '' : ' (needs Groq key)') + '</span></span><input type="checkbox" class="toggle" id="agent-voice"' + (agent?.voiceEnabled ? ' checked' : '') + ' /></label>'
          + '<label class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800"><span><span class="block text-sm font-semibold">Media files</span><span class="text-xs text-slate-500 dark:text-slate-400">Send real uploads</span></span><input type="checkbox" class="toggle" id="agent-media"' + (agent?.mediaEnabled ? ' checked' : '') + ' /></label>'
          + '</div>'
          + '<div id="media-section" class="' + (agent?.mediaEnabled ? '' : 'hidden') + ' rounded-xl border border-slate-200 p-4 dark:border-slate-800"><p class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Media (images, docs, audio · max 20 MB each)</p><div id="media-list" class="mt-3 space-y-2"></div><input id="agent-files" type="file" multiple class="mt-3 block w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-500 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-950 dark:text-slate-400" /></div>'
          + '<details class="rounded-xl border border-slate-200 p-4 dark:border-slate-800"><summary class="cursor-pointer text-xs font-semibold text-slate-600 dark:text-slate-300">Agent keys (optional — overrides global BYOK)</summary><div class="mt-3 grid gap-3 sm:grid-cols-2"><div><label class="' + labelCls + '" for="agent-groq">Groq key</label><input id="agent-groq" type="password" autocomplete="off" class="' + inputCls + '" placeholder="' + (agent?.hasGroqKey ? 'saved — leave empty to keep' : 'gsk_...') + '" /></div><div><label class="' + labelCls + '" for="agent-or">OpenRouter key</label><input id="agent-or" type="password" autocomplete="off" class="' + inputCls + '" placeholder="' + (agent?.hasOpenRouterKey ? 'saved — leave empty to keep' : 'sk-or-...') + '" /></div></div><p class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">Leave empty to use the keys from Settings or the environment.</p></details>'
          + '<div class="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4 dark:border-slate-800"><button type="button" data-cancel class="' + btnGhost + '">Cancel</button><button type="submit" id="save-agent" class="' + btnPrimary + '">' + (editing ? 'Save changes' : 'Create agent') + '</button></div>'
          + '</form>';

        const modal = openModal({ title: editing ? 'Edit agent' : 'Create agent', body });
        const form = $('#agent-form', modal.root);
        const modelEl = $('#agent-model', form);
        const mediaSection = $('#media-section', form);
        const mediaList = $('#media-list', form);

        function updateModelMeta() {
          const info = modelInfo(modelEl.value);
          const free = modelEl.value.startsWith('groq/') || modelEl.value.endsWith(':free');
          $('#model-meta', form).innerHTML = (free ? '<span class="font-semibold text-emerald-600 dark:text-emerald-400">FREE</span>' : '<span class="font-semibold text-amber-600 dark:text-amber-400">PAID</span>')
            + ' · ' + esc(info?.label || modelEl.value.split('/').pop()) + (info && !free ? ' · ' + esc(priceLabel(info)) : '');
        }

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

        modelEl.addEventListener('change', updateModelMeta);
        updateModelMeta();
        paintMedia();

        $('#agent-media', form).addEventListener('change', (event) => {
          mediaSection.classList.toggle('hidden', !event.target.checked);
        });

        $('[data-cancel]', form).addEventListener('click', modal.close);

        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = $('#save-agent', form);
          const payload = {
            name: $('#agent-name', form).value.trim(),
            instruction: $('#agent-instruction', form).value,
            model: modelEl.value,
            voiceEnabled: $('#agent-voice', form).checked,
            mediaEnabled: $('#agent-media', form).checked,
          };
          const groqKey = $('#agent-groq', form).value.trim();
          const openrouterKey = $('#agent-or', form).value.trim();
          if (groqKey) payload.groqKey = groqKey;
          if (openrouterKey) payload.openrouterKey = openrouterKey;
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
