    /* --------------------------------- inbox ------------------------------ */
    async function inboxPage(el) {
      await Promise.all([loadAgents(), getConfig()]);
      let selected = state.currentJid || null;
      let timer = null;
      let searchTerm = '';
      let searchTimer = null;

      el.innerHTML = '<div class="grid gap-4 lg:grid-cols-[340px_1fr]">'
        + '<div class="' + cardCls + ' flex max-h-[78vh] min-h-[420px] flex-col overflow-hidden">'
        + '<div class="border-b border-slate-200 p-3 dark:border-slate-800"><div class="flex gap-2"><input id="inbox-search" class="' + inputCls + '" placeholder="Search chats…" /><button id="inbox-refresh" class="' + btnGhost + ' !px-2.5" title="Refresh">↻</button></div>'
        + '<div class="mt-2 flex items-center justify-between"><p class="text-[11px] text-slate-500 dark:text-slate-400" id="inbox-count">—</p><div class="flex items-center gap-2"><select id="sync-instance" class="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold dark:border-slate-700 dark:bg-slate-950"></select><button id="inbox-sync" class="text-[11px] font-semibold text-emerald-600 hover:underline dark:text-emerald-400">Sync</button></div></div></div>'
        + '<div id="chat-list" class="scroll-thin flex-1 overflow-y-auto"></div></div>'
        + '<div class="' + cardCls + ' flex max-h-[78vh] min-h-[420px] flex-col overflow-hidden">'
        + '<div id="thread-header" class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800"><div class="min-w-0"><p class="truncate text-sm font-bold" id="thread-name">Select a chat</p><p class="truncate text-[11px] text-slate-500 dark:text-slate-400" id="thread-jid">Messages from Supabase inbox</p></div><div class="flex items-center gap-2"><select id="assign-agent" class="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold dark:border-slate-700 dark:bg-slate-950"><option value="">No agent</option></select></div></div>'
        + '<div id="thread" class="scroll-thin flex-1 overflow-y-auto px-4 py-4"></div>'
        + '<form id="reply-form" class="flex items-end gap-2 border-t border-slate-200 p-3 dark:border-slate-800"><textarea id="reply-text" rows="1" class="' + inputCls + ' resize-none" placeholder="Type a reply…"></textarea><button type="submit" class="' + btnPrimary + ' !px-4">Send</button></form>'
        + '</div></div>';

      const listEl = $('#chat-list', el);
      const threadEl = $('#thread', el);
      const assignEl = $('#assign-agent', el);
      const syncSelect = $('#sync-instance', el);

      function paintAgents() {
        assignEl.innerHTML = '<option value="">No agent</option>' + state.agents.map((agent) => '<option value="' + esc(agent.id) + '">' + esc(agent.name) + '</option>').join('');
      }

      async function loadInstanceOptions() {
        const data = await loadInstances().catch(() => ({ instances: [] }));
        const list = data.instances || [];
        syncSelect.innerHTML = list.length
          ? list.map((item) => '<option value="' + esc(item.name) + '">' + esc(item.name) + '</option>').join('')
          : '<option value="">no instance</option>';
      }

      function paintConversations() {
        $('#inbox-count', el).textContent = state.inbox.conversations.length + ' chat' + (state.inbox.conversations.length === 1 ? '' : 's');
        if (!state.inbox.conversations.length) {
          listEl.innerHTML = '<div class="p-6 text-center text-sm text-slate-500 dark:text-slate-400"><p>No conversations yet.</p><p class="mt-1 text-xs">Send a WhatsApp message to a connected instance, or press Sync.</p></div>';
          return;
        }
        listEl.innerHTML = state.inbox.conversations.map((chat) => {
          const active = selected === chat.jid;
          const initials = String(chat.pushName || chat.jid).slice(0, 2).toUpperCase();
          return '<button data-chat="' + esc(chat.jid) + '" class="flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left transition hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40 ' + (active ? 'bg-emerald-500/10' : '') + '">'
            + '<div class="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-slate-200 text-[11px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">' + esc(initials) + '</div>'
            + '<div class="min-w-0 flex-1"><div class="flex items-center justify-between gap-2"><p class="truncate text-sm font-semibold">' + esc(chat.pushName) + (chat.isGroup ? ' <span class="rounded bg-sky-500/10 px-1 text-[9px] font-bold uppercase text-sky-600 dark:text-sky-400">group</span>' : '') + '</p><span class="flex-none text-[10px] text-slate-400">' + esc(timeAgo(chat.lastAt)) + '</span></div>'
            + '<p class="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">' + esc(chat.lastMessage || '—') + '</p>'
            + '<div class="mt-1 flex items-center gap-2">' + (chat.agentName ? '<span class="truncate text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">' + esc(chat.agentName) + '</span>' : '<span class="text-[10px] text-slate-400">unassigned</span>') + (chat.unread ? '<span class="ml-auto rounded-full bg-emerald-500 px-1.5 text-[10px] font-bold text-slate-950">' + chat.unread + '</span>' : '') + '</div></div></button>';
        }).join('');
        $$('[data-chat]', listEl).forEach((button) => button.addEventListener('click', () => selectChat(button.dataset.chat)));
      }

      function bubble(message) {
        const out = message.direction === 'out';
        return '<div class="mb-3 flex ' + (out ? 'justify-end' : 'justify-start') + '"><div class="max-w-[85%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ' + (out ? 'rounded-br-md bg-emerald-500 text-slate-950' : 'rounded-bl-md bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100') + '">'
          + (message.mediaUrl ? '<a href="' + esc(message.mediaUrl) + '" target="_blank" rel="noopener" class="mb-1 block break-all text-xs underline ' + (out ? 'text-slate-900' : 'text-emerald-700 dark:text-emerald-400') + '">' + esc(message.type === 'audio' ? '🎧 voice note' : '📎 ' + message.type) + '</a>' : '')
          + '<p class="whitespace-pre-wrap break-words">' + esc(message.content || '') + '</p>'
          + '<p class="mt-1 text-right text-[9px] ' + (out ? 'text-slate-800/60' : 'text-slate-400') + '">' + esc(timeAgo(message.timestamp)) + '</p></div></div>';
      }

      async function paintThread() {
        const chat = state.inbox.conversations.find((item) => item.jid === selected);
        $('#thread-name', el).textContent = chat?.pushName || selected || 'Select a chat';
        $('#thread-jid', el).textContent = selected || 'Messages from Supabase inbox';
        assignEl.value = chat?.agentId || '';

        if (!selected) {
          threadEl.innerHTML = '<div class="flex h-full flex-col items-center justify-center py-16 text-center"><p class="text-3xl">✉</p><p class="mt-3 text-sm font-semibold">Pick a conversation</p><p class="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">Incoming messages, AI replies and manual replies appear here.</p></div>';
          return;
        }

        try {
          const data = await api('/api/inbox/messages?jid=' + encodeURIComponent(selected));
          state.inbox.messages = data.messages || [];
          threadEl.innerHTML = state.inbox.messages.length
            ? state.inbox.messages.map(bubble).join('')
            : '<p class="py-12 text-center text-sm text-slate-500 dark:text-slate-400">No messages stored for this chat.</p>';
          threadEl.scrollTop = threadEl.scrollHeight;
        } catch (error) {
          threadEl.innerHTML = '<p class="py-8 text-center text-sm text-rose-500">' + esc(error.message) + '</p>';
        }
      }

      async function refresh(silent = true) {
        try {
          const query = searchTerm ? '?search=' + encodeURIComponent(searchTerm) : '';
          const data = await api('/api/inbox/conversations' + query);
          state.inbox.conversations = data.conversations || [];
          paintConversations();
          if (selected) {
            if (!silent) await paintThread();
            else {
              const chat = state.inbox.conversations.find((item) => item.jid === selected);
              if (chat) assignEl.value = chat.agentId || '';
            }
          }
        } catch (error) {
          if (!silent) toast(error.message, 'error');
        }
      }

      async function selectChat(jid) {
        selected = jid;
        state.currentJid = jid;
        paintConversations();
        await paintThread();
        await refresh(false);
      }

      $('#inbox-search', el).addEventListener('input', (event) => {
        searchTerm = event.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => refresh(false), 320);
      });

      $('#inbox-refresh', el).addEventListener('click', () => refresh(false));

      $('#inbox-sync', el).addEventListener('click', async (event) => {
        const instance = syncSelect.value;
        if (!instance) return toast('No Evolution instance — connect one first', 'error');
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Syncing…';
        try {
          const result = await api('/api/inbox/sync', { method: 'POST', body: { instance } });
          toast('Synced ' + result.synced + ' of ' + result.chats + ' chats');
          await refresh(false);
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          button.disabled = false;
          button.textContent = 'Sync';
        }
      });

      assignEl.addEventListener('change', async () => {
        if (!selected) return;
        try {
          await api('/api/inbox/assign', { method: 'POST', body: { jid: selected, agentId: assignEl.value || null } });
          await refresh(false);
          toast(assignEl.value ? 'Agent assigned to this chat' : 'Agent removed from this chat');
        } catch (error) { toast(error.message, 'error'); }
      });

      $('#reply-form', el).addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!selected) return toast('Select a chat first', 'error');
        const input = $('#reply-text', el);
        const text = input.value.trim();
        if (!text) return;
        const button = event.currentTarget.querySelector('button');
        button.disabled = true;
        try {
          await api('/api/inbox/reply', { method: 'POST', body: { jid: selected, text } });
          input.value = '';
          await refresh(false);
          toast('Reply sent');
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          button.disabled = false;
        }
      });

      $('#reply-text', el).addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          $('#reply-form', el).requestSubmit();
        }
      });

      paintAgents();
      await loadInstanceOptions();
      await refresh(false);
      if (selected) await paintThread();

      // Optional Supabase Realtime; polling remains the fallback.
      let channel = null;
      let realtimeClient = null;
      try {
        const config = state.config || (await getConfig());
        if (config.realtime?.url && config.realtime?.anonKey) {
          const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
          realtimeClient = createClient(config.realtime.url, config.realtime.anonKey);
          channel = realtimeClient
            .channel('inbox-live')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_messages' }, () => refresh(true))
            .subscribe();
        }
      } catch (error) {
        console.warn('Realtime unavailable, polling instead:', error.message);
      }

      timer = setInterval(() => {
        if (!document.hidden) refresh(true);
      }, 5000);

      return () => {
        clearInterval(timer);
        clearTimeout(searchTimer);
        if (channel && realtimeClient) {
          realtimeClient.removeChannel(channel).catch(() => null);
        }
      };
    }

    /* -------------------------------- groups ------------------------------ */
    async function groupsPage(el) {
      const [groupsData] = await Promise.all([api('/api/groups'), loadInstances().catch(() => ({ instances: [] }))]);
      await loadAgents();
      let groups = groupsData.groups || [];
      const selected = new Set();

      el.innerHTML = '<div class="space-y-5">'
        + '<div class="' + cardCls + ' p-5"><div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div class="w-full sm:max-w-xs"><label class="' + labelCls + '" for="group-instance">Evolution instance</label><select id="group-instance" class="' + inputCls + '">' + (state.instances.length ? state.instances.map((item) => '<option value="' + esc(item.name) + '">' + esc(item.name) + ' (' + esc(item.status) + ')</option>').join('') : '<option value="">No instance — connect first</option>') + '</select></div><button id="sync-groups" class="' + btnPrimary + '">Sync groups</button></div><p class="mt-3 text-xs text-slate-500 dark:text-slate-400">Groups come from <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">GET /group/fetchAllGroups/:instance</code>. Only groups with a host agent answer messages.</p></div>'
        + '<div class="' + cardCls + ' overflow-hidden"><div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800"><div><h2 class="text-sm font-bold">Synced groups</h2><p class="text-xs text-slate-500 dark:text-slate-400" id="group-count">' + groups.length + ' groups</p></div><div id="bulk-bar" class="hidden flex-wrap items-center gap-2"><span id="bulk-count" class="text-xs font-semibold text-emerald-600 dark:text-emerald-400"></span><select id="bulk-agent" class="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold dark:border-slate-700 dark:bg-slate-950"></select><button id="bulk-host" class="' + btnPrimary + ' !py-1.5 !text-xs">Host selected</button></div></div>'
        + '<div id="group-list"></div></div></div>';

      const list = $('#group-list', el);
      const bulkBar = $('#bulk-bar', el);
      const bulkAgent = $('#bulk-agent', el);
      const bulkCount = $('#bulk-count', el);

      bulkAgent.innerHTML = state.agents.map((agent) => '<option value="' + esc(agent.id) + '">' + esc(agent.name) + '</option>').join('');

      function paint() {
        $('#group-count', el).textContent = groups.length + ' groups';
        bulkBar.classList.toggle('hidden', selected.size === 0);
        bulkBar.classList.toggle('flex', selected.size > 0);
        bulkCount.textContent = selected.size + ' selected';

        if (!groups.length) {
          list.innerHTML = '<div class="p-10 text-center"><p class="text-3xl">⊞</p><p class="mt-3 text-sm font-semibold">No groups synced</p><p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Pick an instance above and press Sync groups.</p></div>';
          return;
        }

        list.innerHTML = groups.map((group) => {
          const checked = selected.has(group.jid);
          return '<div class="border-b border-slate-200 px-4 py-3 last:border-0 dark:border-slate-800"><div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">'
            + '<div class="flex min-w-0 items-start gap-3"><input type="checkbox" data-check="' + esc(group.jid) + '"' + (checked ? ' checked' : '') + ' class="mt-1 h-4 w-4 rounded border-slate-300 accent-emerald-500" />'
            + '<div class="min-w-0"><p class="truncate text-sm font-semibold">' + esc(group.name) + '</p><p class="truncate text-[11px] text-slate-500 dark:text-slate-400">' + esc(group.jid) + ' · ' + group.participantCount + ' participants</p></div></div>'
            + '<div class="flex flex-wrap items-center gap-2 pl-7 sm:pl-0">'
            + (group.agentName
              ? '<span class="truncate rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">' + esc(group.agentName) + '</span><button data-unhost="' + esc(group.jid) + '" class="text-[11px] font-semibold text-rose-500 hover:underline">Clear</button>'
              : '<select data-host-agent="' + esc(group.jid) + '" class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold dark:border-slate-700 dark:bg-slate-950"><option value="">Select agent…</option>' + state.agents.map((agent) => '<option value="' + esc(agent.id) + '">' + esc(agent.name) + '</option>').join('') + '</select><button data-host="' + esc(group.jid) + '" class="' + btnGhost + ' !px-2 !py-1 !text-[11px]">Host</button>')
            + '<button data-create-agent="' + esc(group.jid) + '" data-group-name="' + esc(group.name) + '" class="text-[11px] font-semibold text-emerald-600 hover:underline dark:text-emerald-400">Create agent</button>'
            + '</div></div></div>';
        }).join('');

        $$('[data-check]', list).forEach((box) =>
          box.addEventListener('change', () => {
            if (box.checked) selected.add(box.dataset.check);
            else selected.delete(box.dataset.check);
            paint();
          }),
        );
        $$('[data-host]', list).forEach((button) =>
          button.addEventListener('click', () => {
            const select = $$('[data-host-agent]', list).find((el) => el.dataset.hostAgent === button.dataset.host);
            host(button.dataset.host, select?.value);
          }),
        );
        $$('[data-unhost]', list).forEach((button) =>
          button.addEventListener('click', async () => {
            try {
              await api('/api/groups/host/' + encodeURIComponent(button.dataset.unhost), { method: 'DELETE' });
              await reload();
              toast('Group unhosted');
            } catch (error) { toast(error.message, 'error'); }
          }),
        );
        $$('[data-create-agent]', list).forEach((button) =>
          button.addEventListener('click', async () => {
            button.disabled = true;
            button.textContent = 'Creating…';
            try {
              await api('/api/groups/create-agent', { method: 'POST', body: { groupJid: button.dataset.createAgent, name: button.dataset.groupName } });
              await loadAgents();
              await reload();
              toast('Agent created and hosted');
            } catch (error) {
              toast(error.message, 'error');
              button.disabled = false;
              button.textContent = 'Create agent';
            }
          }),
        );
      }

      async function reload() {
        const data = await api('/api/groups');
        groups = data.groups || [];
        paint();
      }

      async function host(groupJid, agentId) {
        if (!agentId) return toast('Select an agent first', 'info');
        try {
          await api('/api/groups/host', { method: 'POST', body: { groupJid, agentId } });
          await reload();
          toast('Group hosted');
        } catch (error) { toast(error.message, 'error'); }
      }

      $('#sync-groups', el).addEventListener('click', async (event) => {
        const instance = $('#group-instance', el).value;
        if (!instance) return toast('Connect an Evolution instance first', 'error');
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Syncing…';
        try {
          const result = await api('/api/groups/sync', { method: 'POST', body: { instance } });
          groups = result.groups || [];
          selected.clear();
          paint();
          toast('Synced ' + groups.length + ' groups');
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          button.disabled = false;
          button.textContent = 'Sync groups';
        }
      });

      $('#bulk-host', el).addEventListener('click', async () => {
        const agentId = bulkAgent.value;
        if (!agentId) return toast('Select an agent first', 'info');
        let ok = 0;
        for (const jid of selected) {
          try {
            await api('/api/groups/host', { method: 'POST', body: { groupJid: jid, agentId } });
            ok += 1;
          } catch (error) { console.warn(error.message); }
        }
        selected.clear();
        await reload();
        toast('Hosted ' + ok + ' group' + (ok === 1 ? '' : 's'));
      });

      paint();
    }
