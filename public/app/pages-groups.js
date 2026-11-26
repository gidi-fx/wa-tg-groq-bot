    /* -------------------------------- groups ------------------------------ */
    async function groupsPage(el) {
      await Promise.all([loadAgents(), loadInstances(), getConfig().catch(() => null)]);

      const openInstances = () => (state.instances || []).filter((item) => isInstanceConnected(item.status));
      let selectedInstance = openInstances()[0]?.name || '';
      let groups = [];
      let busy = false;

      function badge(status) {
        const cls = status === 'open'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : status === 'connecting'
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300'
            : 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400';
        return '<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ' + cls + '">' + esc(status || 'unknown') + '</span>';
      }

      function instanceSelect() {
        const list = openInstances();
        if (!list.length) {
          return '<p class="text-xs text-slate-500 dark:text-slate-400">No open WhatsApp number. <a href="/connect" data-link class="underline">Connect one first</a>.</p>';
        }
        return '<select id="groups-instance" class="' + inputCls + ' !py-1.5 !text-xs">'
          + list.map((item) => '<option value="' + esc(item.name) + '"' + (item.name === selectedInstance ? ' selected' : '') + '>' + esc(instanceNumber(item.name) || item.name) + ' · ' + esc(item.status) + '</option>').join('')
          + '</select>';
      }

      function agentOptions(group) {
        return '<option value="">No bot</option>'
          + (state.agents || []).map((agent) =>
            '<option value="' + esc(agent.id) + '"' + (group.agentId === agent.id ? ' selected' : '') + '>'
            + esc(agent.name) + (agent.connectedInstance ? ' (' + esc(instanceNumber(agent.connectedInstance) || agent.connectedInstance) + ')' : '')
            + '</option>').join('');
      }

      function groupRow(group) {
        const agent = (state.agents || []).find((item) => item.id === group.agentId) || null;
        const answersFrom = agent ? (instanceNumber(agent.connectedInstance) || agent.connectedInstance || 'not set') : 'nobody';
        return '<div class="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 last:border-0 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between">'
          + '<div class="min-w-0"><p class="truncate text-sm font-semibold">' + esc(group.name || group.jid) + '</p>'
          + '<p class="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">' + (group.participantCount || 0) + ' participants · answers from <b>' + esc(answersFrom) + '</b></p></div>'
          + '<div class="flex flex-wrap items-center gap-2">'
          + '<select data-group="' + esc(group.jid) + '" class="' + inputCls + ' !w-auto !py-1.5 !text-xs">' + agentOptions(group) + '</select>'
          + '<label class="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold dark:border-slate-800">'
          + '<input type="checkbox" data-toggle="' + esc(group.jid) + '" class="accent-emerald-500"' + (group.agentId ? ' checked' : '') + ' /> Bot on</label>'
          + '</div></div>';
      }

      function paint(state_) {
        const list = openInstances();
        el.innerHTML = '<div class="space-y-5">'
          + '<div class="' + cardCls + ' p-4">'
          + '<div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">'
          + '<div class="w-full sm:max-w-xs"><label class="' + labelCls + '" for="groups-instance">WhatsApp number</label>' + instanceSelect() + '</div>'
          + '<div class="flex items-center gap-2"><button id="groups-sync" class="' + btnPrimary + '"' + (list.length && !busy ? '' : ' disabled') + '>' + (busy ? 'Syncing…' : 'Sync groups') + '</button>'
          + '<span id="groups-status" class="text-[11px] text-slate-500 dark:text-slate-400">' + esc(state_ || '') + '</span></div>'
          + '</div></div>'
          + '<div class="' + cardCls + ' overflow-hidden"><div class="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800"><h2 class="text-sm font-bold">Groups</h2><span class="text-xs text-slate-500 dark:text-slate-400">' + groups.length + '</span></div>'
          + '<div id="groups-list">'
          + (groups.length
            ? groups.map(groupRow).join('')
            : '<p class="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">' + (list.length ? 'No groups synced yet. Pick a number and press Sync groups.' : 'Connect a WhatsApp number first.') + '</p>')
          + '</div></div></div>';

        const select = $('#groups-instance', el);
        if (select) {
          select.addEventListener('change', (event) => {
            selectedInstance = event.target.value;
            groups = [];
            paint('');
          });
        }

        const syncButton = $('#groups-sync', el);
        if (syncButton) syncButton.addEventListener('click', syncGroups);

        $$('[data-group]', el).forEach((node) => node.addEventListener('change', () => assign(node.dataset.group, node.value)));
        $$('[data-toggle]', el).forEach((node) => node.addEventListener('change', () => assign(node.dataset.toggle, node.checked ? ($('[data-group="' + node.dataset.toggle.replace(/"/g, '\\"') + '"]', el)?.value || '') : '')));
      }

      async function reload() {
        const data = await api('/api/groups').catch(() => null);
        if (data && Array.isArray(data.groups)) groups = data.groups;
        if (data && Array.isArray(data.agents)) state.agents = data.agents;
      }

      async function syncGroups() {
        if (busy || !selectedInstance) return;
        busy = true;
        paint('Syncing groups from ' + (instanceNumber(selectedInstance) || selectedInstance) + '…');
        try {
          const data = await api('/api/groups/sync', { method: 'POST', body: { instance: selectedInstance } });
          if (Array.isArray(data.groups)) groups = data.groups;
          await reload();
          busy = false;
          if (!groups.length) {
            paint('No groups found for this number');
            toast('No groups found for this number', 'info');
          } else {
            paint('Synced ' + groups.length + ' group(s)');
            toast('Synced ' + groups.length + ' group(s)');
          }
        } catch (error) {
          busy = false;
          paint('Sync failed: ' + error.message);
          toast(error.message, 'error');
        }
      }

      async function assign(groupJid, agentId) {
        try {
          if (agentId) {
            await api('/api/groups/host', { method: 'POST', body: { groupJid, agentId } });
            toast('Bot enabled for this group');
          } else {
            await api('/api/groups/host/' + encodeURIComponent(groupJid), { method: 'DELETE' });
            toast('Bot disabled for this group');
          }
          await reload();
          paint('');
        } catch (error) {
          toast(error.message, 'error');
          await reload();
          paint('');
        }
      }

      paint('Pick a number, then press Sync groups');
      await reload();
      paint('');
    }
