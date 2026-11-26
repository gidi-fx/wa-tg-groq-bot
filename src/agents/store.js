import { randomUUID } from 'crypto';

import { AppError } from '../errors.js';
import { mem } from '../memory.js';
import {
  dbError,
  downloadMediaByPath,
  hasSupabase,
  mediaObjectPath,
  removeMediaByPath,
  requireSupabase,
  uploadMedia,
} from '../supabase.js';

const AGENT_COLUMNS =
  'id,name,instruction,voice_enabled,media_enabled,model,media_files,connected_instance,created_at';
const DEFAULT_MODEL = 'groq/openai/gpt-oss-120b';
const DEFAULT_INSTRUCTION =
  'You are a helpful WhatsApp assistant. Answer clearly, keep replies short and use plain text.';

/* ------------------------------- helpers ---------------------------------- */

function mapAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    instruction: row.instruction || '',
    voiceEnabled: Boolean(row.voice_enabled),
    mediaEnabled: Boolean(row.media_enabled),
    model: row.model || DEFAULT_MODEL,
    mediaFiles: Array.isArray(row.media_files) ? row.media_files : [],
    // WhatsApp account this agent replies from (Evolution instance, e.g. wa-234...).
    connectedInstance: row.connected_instance || null,
    connectedNumber: /^wa-(\d+)$/.exec(String(row.connected_instance || ''))?.[1] || null,
    createdAt: row.created_at,
  };
}

function requireConnectedInstance(value) {
  const instance = String(value || '').trim();
  if (!instance) {
    throw new AppError('Connect WhatsApp first in Connect page', 400, 'no_connected_instance');
  }
  return instance;
}

function normalizeMediaFiles(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((file) => file && typeof file === 'object' && file.url)
    .map((file) => ({
      name: String(file.name || 'file'),
      path: String(file.path || ''),
      url: String(file.url),
      type: String(file.type || 'application/octet-stream'),
      size: Number(file.size || 0),
    }));
}

function byCreatedAt(a, b) {
  return String(a.created_at || '').localeCompare(String(b.created_at || ''));
}

function dataUrl(buffer, contentType = 'application/octet-stream') {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

/* --------------------------------- agents --------------------------------- */

export async function listAgents() {
  if (!hasSupabase) {
    return [...mem.agents.values()].sort(byCreatedAt).map((row) => mapAgent(row));
  }
  const db = requireSupabase();
  const { data, error } = await db
    .from('agents')
    .select(AGENT_COLUMNS)
    .order('created_at', { ascending: true });
  if (error) throw dbError(error, 'Could not load agents');
  return (data || []).map((row) => mapAgent(row));
}

export async function getAgent(id) {
  if (!hasSupabase) return mapAgent(mem.agents.get(id));
  const db = requireSupabase();
  const { data, error } = await db.from('agents').select(AGENT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw dbError(error, 'Could not load agent');
  return mapAgent(data);
}

export async function createAgent(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new AppError('Agent name is required', 400, 'invalid_agent');
  const connectedInstance = requireConnectedInstance(input.connectedInstance);

  const row = {
    id: `ag_${randomUUID()}`,
    name,
    instruction: String(input.instruction || DEFAULT_INSTRUCTION).trim(),
    voice_enabled: Boolean(input.voiceEnabled),
    media_enabled: Boolean(input.mediaEnabled),
    model: String(input.model || DEFAULT_MODEL),
    media_files: normalizeMediaFiles(input.mediaFiles),
    connected_instance: connectedInstance,
    created_at: new Date().toISOString(),
  };

  if (!hasSupabase) {
    mem.agents.set(row.id, row);
    console.log(`[agents] created ${name} (${row.id}) replies via ${connectedInstance} in memory (temporary)`);
    return mapAgent(row);
  }

  const db = requireSupabase();
  const { created_at, ...insert } = row;
  const { data, error } = await db.from('agents').insert(insert).select(AGENT_COLUMNS).single();
  if (error) throw dbError(error, 'Could not create agent');
  console.log(`[agents] created ${name} (${row.id}) model=${row.model} replies via ${connectedInstance}`);
  return mapAgent(data);
}

export async function updateAgent(id, input = {}) {
  const patch = {};

  if (input.name !== undefined) {
    const name = String(input.name || '').trim();
    if (!name) throw new AppError('Agent name cannot be empty', 400, 'invalid_agent');
    patch.name = name;
  }
  if (input.instruction !== undefined) patch.instruction = String(input.instruction || '');
  if (input.voiceEnabled !== undefined) patch.voice_enabled = Boolean(input.voiceEnabled);
  if (input.mediaEnabled !== undefined) patch.media_enabled = Boolean(input.mediaEnabled);
  if (input.model !== undefined) patch.model = String(input.model || DEFAULT_MODEL);
  if (input.mediaFiles !== undefined) patch.media_files = normalizeMediaFiles(input.mediaFiles);
  if (input.connectedInstance !== undefined) {
    patch.connected_instance = requireConnectedInstance(input.connectedInstance);
  }

  if (!Object.keys(patch).length) return getAgent(id);

  if (!hasSupabase) {
    const current = mem.agents.get(id);
    if (!current) throw new AppError('Agent not found', 404, 'agent_not_found');
    const next = { ...current, ...patch };
    mem.agents.set(id, next);
    return mapAgent(next);
  }

  const db = requireSupabase();
  const { data, error } = await db
    .from('agents')
    .update(patch)
    .eq('id', id)
    .select(AGENT_COLUMNS)
    .maybeSingle();
  if (error) throw dbError(error, 'Could not update agent');
  if (!data) throw new AppError('Agent not found', 404, 'agent_not_found');
  return mapAgent(data);
}

export async function deleteAgent(id) {
  const agent = await getAgent(id);
  if (!agent) throw new AppError('Agent not found', 404, 'agent_not_found');

  for (const file of agent.mediaFiles) {
    if (file.path) {
      if (hasSupabase) await removeMediaByPath(file.path);
      else mem.media.delete(file.path);
    }
  }

  if (!hasSupabase) {
    mem.agents.delete(id);
    for (const [jid, agentId] of [...mem.hosts.entries()]) {
      if (agentId === id) mem.hosts.delete(jid);
    }
    for (const [jid, agentId] of [...mem.assignments.entries()]) {
      if (agentId === id) mem.assignments.delete(jid);
    }
    console.log(`[agents] deleted ${id} (memory)`);
    return { id };
  }

  const db = requireSupabase();
  const { error } = await db.from('agents').delete().eq('id', id);
  if (error) throw dbError(error, 'Could not delete agent');
  console.log(`[agents] deleted ${id}`);
  return { id };
}

/* ------------------------------ agent media ------------------------------- */

export async function addAgentMedia(agentId, files = []) {
  const agent = await getAgent(agentId);
  if (!agent) throw new AppError('Agent not found', 404, 'agent_not_found');
  if (!files.length) throw new AppError('No files received', 400, 'missing_files');

  const uploaded = [];
  for (const file of files) {
    const objectPath = mediaObjectPath(`agents/${agentId}`, file.originalname);
    if (!hasSupabase) {
      const contentType = file.mimetype || 'application/octet-stream';
      mem.media.set(objectPath, { buffer: file.buffer, contentType });
      uploaded.push({
        name: file.originalname,
        path: objectPath,
        url: dataUrl(file.buffer, contentType),
        type: contentType,
        size: file.size || file.buffer.length,
      });
      continue;
    }
    const url = await uploadMedia(file.buffer, objectPath, file.mimetype);
    uploaded.push({
      name: file.originalname,
      path: objectPath,
      url,
      type: file.mimetype || 'application/octet-stream',
      size: file.size || file.buffer.length,
    });
  }

  const mediaFiles = [...agent.mediaFiles, ...uploaded];

  if (!hasSupabase) {
    const current = mem.agents.get(agentId);
    current.media_files = mediaFiles;
    mem.agents.set(agentId, current);
    console.log(`[agents] ${agentId} media +${uploaded.length} in memory (${mediaFiles.length} total)`);
    return mapAgent(current);
  }

  const db = requireSupabase();
  const { data, error } = await db
    .from('agents')
    .update({ media_files: mediaFiles })
    .eq('id', agentId)
    .select(AGENT_COLUMNS)
    .single();
  if (error) throw dbError(error, 'Could not save agent media');
  console.log(`[agents] ${agentId} media +${uploaded.length} (${mediaFiles.length} total)`);
  return mapAgent(data);
}

export async function removeAgentMedia(agentId, filePath) {
  const agent = await getAgent(agentId);
  if (!agent) throw new AppError('Agent not found', 404, 'agent_not_found');

  const target = agent.mediaFiles.find((file) => file.path === filePath || file.url === filePath);
  if (!target) throw new AppError('Media file not found on this agent', 404, 'media_not_found');

  if (hasSupabase) await removeMediaByPath(target.path);
  else mem.media.delete(target.path);

  const mediaFiles = agent.mediaFiles.filter((file) => file !== target);

  if (!hasSupabase) {
    const current = mem.agents.get(agentId);
    current.media_files = mediaFiles;
    mem.agents.set(agentId, current);
    return mapAgent(current);
  }

  const db = requireSupabase();
  const { data, error } = await db
    .from('agents')
    .update({ media_files: mediaFiles })
    .eq('id', agentId)
    .select(AGENT_COLUMNS)
    .single();
  if (error) throw dbError(error, 'Could not update agent media');
  return mapAgent(data);
}

/* ------------------------------ group hosts ------------------------------- */

export async function upsertGroups(groups = []) {
  if (!groups.length) return [];
  const rows = groups.map((group) => ({
    jid: String(group.jid),
    name: String(group.name || group.jid),
    participants: Array.isArray(group.participants) ? group.participants : [],
  }));

  if (!hasSupabase) {
    for (const row of rows) {
      const index = mem.groups.findIndex((group) => group.jid === row.jid);
      if (index >= 0) mem.groups[index] = { ...mem.groups[index], ...row };
      else mem.groups.push(row);
    }
    return rows;
  }

  const db = requireSupabase();
  const { error } = await db.from('groups').upsert(rows, { onConflict: 'jid' });
  if (error) throw dbError(error, 'Could not save groups');
  return rows;
}

export async function listGroups() {
  let groups;
  let hosts;
  let agents;

  if (!hasSupabase) {
    groups = mem.groups;
    hosts = [...mem.hosts.entries()].map(([group_jid, agent_id]) => ({ group_jid, agent_id }));
    agents = [...mem.agents.values()].map(({ id, name }) => ({ id, name }));
  } else {
    const db = requireSupabase();
    const groupsResult = await db.from('groups').select('jid,name,participants').order('name');
    if (groupsResult.error) throw dbError(groupsResult.error, 'Could not load groups');
    const hostsResult = await db.from('group_hosts').select('group_jid,agent_id');
    if (hostsResult.error) throw dbError(hostsResult.error, 'Could not load group hosts');
    const agentsResult = await db.from('agents').select('id,name');
    if (agentsResult.error) throw dbError(agentsResult.error, 'Could not load agents');
    groups = groupsResult.data || [];
    hosts = hostsResult.data || [];
    agents = agentsResult.data || [];
  }

  const agentsById = new Map((agents || []).map((agent) => [agent.id, agent]));
  const hostsByJid = new Map((hosts || []).map((host) => [host.group_jid, host.agent_id]));

  return (groups || [])
    .map((group) => {
      const agentId = hostsByJid.get(group.jid) || null;
      return {
        jid: group.jid,
        name: group.name || group.jid,
        participants: Array.isArray(group.participants) ? group.participants : [],
        participantCount: Array.isArray(group.participants) ? group.participants.length : 0,
        agentId,
        agentName: agentId ? agentsById.get(agentId)?.name || null : null,
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function hostGroup(groupJid, agentId) {
  if (!groupJid) throw new AppError('groupJid is required', 400, 'invalid_group');
  if (!agentId) throw new AppError('agentId is required', 400, 'invalid_agent');

  const agent = await getAgent(agentId);
  if (!agent) throw new AppError('Agent not found', 404, 'agent_not_found');

  if (!hasSupabase) {
    if (!mem.groups.some((group) => group.jid === groupJid)) {
      mem.groups.push({ jid: groupJid, name: groupJid, participants: [] });
    }
    mem.hosts.set(groupJid, agentId);
    return { groupJid, agentId };
  }

  const db = requireSupabase();
  const { error: groupError } = await db.from('groups').upsert(
    { jid: groupJid, name: groupJid, participants: [] },
    { onConflict: 'jid', ignoreDuplicates: true },
  );
  if (groupError) throw dbError(groupError, 'Could not save group');

  const { error } = await db
    .from('group_hosts')
    .upsert({ group_jid: groupJid, agent_id: agentId }, { onConflict: 'group_jid' });
  if (error) throw dbError(error, 'Could not host group');
  return { groupJid, agentId };
}

export async function unhostGroup(groupJid) {
  if (!hasSupabase) {
    mem.hosts.delete(groupJid);
    return { groupJid };
  }
  const db = requireSupabase();
  const { error } = await db.from('group_hosts').delete().eq('group_jid', groupJid);
  if (error) throw dbError(error, 'Could not unhost group');
  return { groupJid };
}

export async function getGroupAgent(groupJid) {
  if (!hasSupabase) {
    const agentId = mem.hosts.get(groupJid);
    if (!agentId) return null;
    return getAgent(agentId);
  }
  const db = requireSupabase();
  const { data, error } = await db
    .from('group_hosts')
    .select('agent_id')
    .eq('group_jid', groupJid)
    .maybeSingle();
  if (error) throw dbError(error, 'Could not resolve group agent');
  if (!data?.agent_id) return null;
  return getAgent(data.agent_id);
}

/* --------------------------- chat assignments ----------------------------- */

export async function assignChat(jid, agentId) {
  if (!jid) throw new AppError('jid is required', 400, 'invalid_jid');

  if (!agentId) {
    if (!hasSupabase) {
      mem.assignments.delete(jid);
      return { jid, agentId: null };
    }
    const db = requireSupabase();
    const { error } = await db.from('chat_assignments').delete().eq('jid', jid);
    if (error) throw dbError(error, 'Could not clear chat assignment');
    return { jid, agentId: null };
  }

  const agent = await getAgent(agentId);
  if (!agent) throw new AppError('Agent not found', 404, 'agent_not_found');

  if (!hasSupabase) {
    mem.assignments.set(jid, agentId);
    return { jid, agentId };
  }

  const db = requireSupabase();
  const { error } = await db
    .from('chat_assignments')
    .upsert({ jid, agent_id: agentId, updated_at: new Date().toISOString() }, { onConflict: 'jid' });
  if (error) throw dbError(error, 'Could not assign chat');
  return { jid, agentId };
}

export async function getAssignedAgent(jid) {
  if (!hasSupabase) {
    const agentId = mem.assignments.get(jid);
    if (!agentId) return null;
    return getAgent(agentId);
  }
  const db = requireSupabase();
  const { data, error } = await db
    .from('chat_assignments')
    .select('agent_id')
    .eq('jid', jid)
    .maybeSingle();
  if (error) throw dbError(error, 'Could not resolve chat agent');
  if (!data?.agent_id) return null;
  return getAgent(data.agent_id);
}

/** Fallback agent for direct chats that have no explicit assignment. */
export async function getDefaultAgent() {
  if (!hasSupabase) {
    const first = [...mem.agents.values()].sort(byCreatedAt)[0];
    return mapAgent(first);
  }
  const db = requireSupabase();
  const { data, error } = await db
    .from('agents')
    .select(AGENT_COLUMNS)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw dbError(error, 'Could not load default agent');
  return mapAgent(data);
}

/* --------------------------------- inbox ---------------------------------- */

export async function saveInboxMessage({
  instance,
  remoteJid,
  pushName,
  messageType,
  content,
  mediaUrl,
  isFromMe = false,
  timestamp,
  waMessageId,
}) {
  if (!hasSupabase) {
    if (waMessageId) {
      const existing = mem.inbox.find((row) => row.wa_message_id === waMessageId);
      if (existing) return existing.id;
    }
    const row = {
      id: `msg_${randomUUID()}`,
      instance: instance || null,
      remote_jid: remoteJid,
      push_name: pushName || null,
      message_type: messageType || 'text',
      content: content ?? null,
      media_url: mediaUrl || null,
      timestamp: timestamp || new Date().toISOString(),
      is_from_me: Boolean(isFromMe),
      wa_message_id: waMessageId || null,
    };
    mem.inbox.push(row);
    return row.id;
  }

  const db = requireSupabase();

  if (waMessageId) {
    const { data: existing, error: findError } = await db
      .from('inbox_messages')
      .select('id')
      .eq('wa_message_id', waMessageId)
      .maybeSingle();
    if (findError) throw dbError(findError, 'Could not check inbox message');
    if (existing) return existing.id;
  }

  const row = {
    instance: instance || null,
    remote_jid: remoteJid,
    push_name: pushName || null,
    message_type: messageType || 'text',
    content: content ?? null,
    media_url: mediaUrl || null,
    timestamp: timestamp || new Date().toISOString(),
    is_from_me: Boolean(isFromMe),
    wa_message_id: waMessageId || null,
  };

  const { data, error } = await db.from('inbox_messages').insert(row).select('id').single();
  if (error) throw dbError(error, 'Could not save inbox message');
  return data.id;
}

/** Last instance that saw this chat (used for manual replies). */
export async function getInstanceForJid(jid) {
  if (!hasSupabase) {
    const row = [...mem.inbox].reverse().find((message) => message.remote_jid === jid);
    return row?.instance || null;
  }
  const db = requireSupabase();
  const { data, error } = await db
    .from('inbox_messages')
    .select('instance')
    .eq('remote_jid', jid)
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw dbError(error, 'Could not resolve chat instance');
  return data?.instance || null;
}

export async function saveHistory(jid, role, content) {
  if (!jid) return;
  if (!hasSupabase) {
    mem.history.push({
      jid,
      role,
      content: String(content || ''),
      timestamp: new Date().toISOString(),
    });
    if (mem.history.length > 2000) mem.history.splice(0, mem.history.length - 2000);
    return;
  }
  const db = requireSupabase();
  const { error } = await db.from('chat_history').insert({ jid, role, content: String(content || '') });
  if (error) throw dbError(error, 'Could not save chat history');
}

export async function getHistory(jid, limit = 20) {
  if (!hasSupabase) {
    return mem.history
      .filter((row) => row.jid === jid)
      .slice(-Math.min(Number(limit) || 20, 200));
  }
  const db = requireSupabase();
  const { data, error } = await db
    .from('chat_history')
    .select('role,content,timestamp')
    .eq('jid', jid)
    .order('timestamp', { ascending: false })
    .limit(limit);
  if (error) throw dbError(error, 'Could not load chat history');
  return (data || []).reverse();
}

/** Group inbox rows into one conversation per JID. */
function summarizeConversations(rows, assignedByJid, agentNamesById) {
  const conversations = new Map();
  for (const row of rows || []) {
    const jid = row.remote_jid;
    if (!jid) continue;
    let conversation = conversations.get(jid);
    if (!conversation) {
      conversation = {
        jid,
        pushName: row.push_name || jid.split('@')[0],
        instance: row.instance || null,
        isGroup: jid.endsWith('@g.us'),
        lastMessage: row.content || (row.message_type ? `[${row.message_type}]` : ''),
        lastAt: row.timestamp,
        unread: 0,
        count: 0,
      };
      conversations.set(jid, conversation);
    }
    conversation.count += 1;
    if (!row.is_from_me) conversation.unread += 1;
    else conversation.unread = 0;
  }

  return [...conversations.values()].map((conversation) => {
    const agentId = assignedByJid.get(conversation.jid) || null;
    return {
      ...conversation,
      agentId,
      agentName: agentId ? agentNamesById.get(agentId) || null : null,
    };
  });
}

export async function getConversations({ search = '', limit = 1000 } = {}) {
  let rows;
  let assignedByJid;
  let agentNamesById;

  if (!hasSupabase) {
    rows = [...mem.inbox]
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, Math.min(Number(limit) || 1000, 3000));
    assignedByJid = mem.assignments;
    agentNamesById = new Map([...mem.agents.values()].map((agent) => [agent.id, agent.name]));
  } else {
    const db = requireSupabase();
    const { data, error } = await db
      .from('inbox_messages')
      .select('id,instance,remote_jid,push_name,message_type,content,media_url,timestamp,is_from_me')
      .order('timestamp', { ascending: false })
      .limit(Math.min(Number(limit) || 1000, 3000));
    if (error) throw dbError(error, 'Could not load inbox');

    const [assignmentsResult, agentsResult] = await Promise.all([
      db.from('chat_assignments').select('jid,agent_id'),
      db.from('agents').select('id,name'),
    ]);
    rows = data || [];
    assignedByJid = new Map((assignmentsResult.data || []).map((row) => [row.jid, row.agent_id]));
    agentNamesById = new Map((agentsResult.data || []).map((agent) => [agent.id, agent.name]));
  }

  const list = summarizeConversations(rows, assignedByJid, agentNamesById);

  const query = String(search || '').trim().toLowerCase();
  const filtered = query
    ? list.filter(
        (item) =>
          item.jid.toLowerCase().includes(query) ||
          String(item.pushName).toLowerCase().includes(query) ||
          String(item.lastMessage).toLowerCase().includes(query),
      )
    : list;

  return filtered.slice(0, 300);
}

export async function getInboxMessages(jid, limit = 200) {
  if (!hasSupabase) {
    const rows = mem.inbox
      .filter((row) => row.remote_jid === jid)
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
      .slice(0, Math.min(Number(limit) || 200, 500));
    if (rows.length) {
      return rows.map((row) => ({
        id: row.id,
        direction: row.is_from_me ? 'out' : 'in',
        content: row.content || '',
        mediaUrl: row.media_url || null,
        type: row.message_type || 'text',
        timestamp: row.timestamp,
        pushName: row.push_name || null,
        instance: row.instance || null,
      }));
    }
    const history = await getHistory(jid, 200);
    return history.map((row, index) => ({
      id: `history-${index}`,
      direction: row.role === 'assistant' ? 'out' : 'in',
      content: row.content || '',
      mediaUrl: null,
      type: 'text',
      timestamp: row.timestamp,
      pushName: null,
      instance: null,
    }));
  }

  const db = requireSupabase();
  const { data, error } = await db
    .from('inbox_messages')
    .select('id,instance,remote_jid,push_name,message_type,content,media_url,timestamp,is_from_me')
    .eq('remote_jid', jid)
    .order('timestamp', { ascending: true })
    .limit(Math.min(Number(limit) || 200, 500));
  if (error) throw dbError(error, 'Could not load messages');

  const messages = (data || []).map((row) => ({
    id: row.id,
    direction: row.is_from_me ? 'out' : 'in',
    content: row.content || '',
    mediaUrl: row.media_url || null,
    type: row.message_type || 'text',
    timestamp: row.timestamp,
    pushName: row.push_name || null,
    instance: row.instance || null,
  }));

  if (messages.length) return messages;

  // Fall back to the AI memory if the inbox has no rows for this chat yet.
  const history = await getHistory(jid, 200);
  return history.map((row, index) => ({
    id: `history-${index}`,
    direction: row.role === 'assistant' ? 'out' : 'in',
    content: row.content || '',
    mediaUrl: null,
    type: 'text',
    timestamp: row.timestamp,
    pushName: null,
    instance: null,
  }));
}

/** Download a stored agent media file for Evolution sendMedia. */
export async function agentMediaBuffer(file) {
  if (!file) throw new AppError('Media file not found', 404, 'media_not_found');
  if (hasSupabase) return downloadMediaByPath(file.path);

  const stored = mem.media.get(file.path);
  if (!stored) throw new AppError('Media file not found in memory', 404, 'media_not_found');
  return { buffer: stored.buffer, contentType: stored.contentType };
}
