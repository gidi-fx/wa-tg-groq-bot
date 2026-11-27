/**
 * Temporary in-memory store used when Supabase is not configured.
 * Everything here is lost when the process restarts.
 */
export const mem = {
  agents: new Map(), // id -> agent row (snake_case, same shape as Supabase)
  groups: [], // [{ jid, name, participants }]
  hosts: new Map(), // group jid -> agent id
  assignments: new Map(), // chat jid -> agent id
  inbox: [], // inbox message rows
  history: [], // [{ jid, role, content, timestamp }]
  media: new Map(), // object path -> { buffer, contentType }
};

export const MEMORY_WARNING =
  'Inbox/Groups require Supabase for persistence, currently temporary';

export function memoryCounts(instance = '') {
  const rows = instance ? mem.inbox.filter((row) => row.instance === instance) : mem.inbox;
  return {
    agents: mem.agents.size,
    chats: new Set(rows.map((message) => message.remote_jid).filter(Boolean)).size,
    groups: mem.groups.length,
    messages: rows.length,
  };
}

/** JSON-safe snapshot of the temporary store (never exposes raw keys). */
export function memorySnapshot(instance = '') {
  const rows = instance ? mem.inbox.filter((row) => row.instance === instance) : mem.inbox;
  return {
    agents: [...mem.agents.values()].map((row) => ({ ...row })),
    groups: mem.groups.map((group) => ({
      ...group,
      agentId: mem.hosts.get(group.jid) || null,
    })),
    hosts: Object.fromEntries(mem.hosts),
    assignments: Object.fromEntries(mem.assignments),
    inbox: rows.slice(-200),
    instance: instance || null,
    counts: memoryCounts(instance),
    temporary: true,
    note: 'Temporary in-memory data. Restarting the server clears it.',
  };
}
