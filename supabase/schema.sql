-- ===========================================================================
-- WhatsApp Groq Router v2 - Supabase schema
-- Run this once in Supabase Dashboard -> SQL Editor.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Agents (BYOK keys can be stored globally in settings or per agent here)
-- ---------------------------------------------------------------------------
create table if not exists public.agents (
  id text primary key,
  name text not null,
  instruction text default '',
  voice_enabled boolean not null default false,
  media_enabled boolean not null default false,
  model text not null default 'groq/llama-3.3-70b-versatile',
  media_files jsonb not null default '[]'::jsonb,
  groq_key text,
  openrouter_key text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- WhatsApp groups synced from Evolution
-- ---------------------------------------------------------------------------
create table if not exists public.groups (
  jid text primary key,
  name text,
  participants jsonb not null default '[]'::jsonb
);

create table if not exists public.group_hosts (
  group_jid text primary key references public.groups(jid) on delete cascade,
  agent_id text references public.agents(id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Conversation history used as the AI memory
-- ---------------------------------------------------------------------------
create table if not exists public.chat_history (
  id uuid primary key default gen_random_uuid(),
  jid text not null,
  role text not null,
  content text,
  timestamp timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Inbox: every message that arrives or is sent from the dashboard
-- ---------------------------------------------------------------------------
create table if not exists public.inbox_messages (
  id uuid primary key default gen_random_uuid(),
  instance text,
  remote_jid text,
  push_name text,
  message_type text,
  content text,
  media_url text,
  timestamp timestamptz not null default now(),
  is_from_me boolean not null default false,
  -- extra column (not required by the UI) used to de-duplicate webhook retries
  wa_message_id text
);

-- ---------------------------------------------------------------------------
-- Direct-chat -> agent assignment (used by the inbox "Assign agent" control)
-- ---------------------------------------------------------------------------
create table if not exists public.chat_assignments (
  jid text primary key,
  agent_id text references public.agents(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Global BYOK settings (single row). Per-agent keys live in agents.*_key.
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists inbox_messages_remote_jid_idx
  on public.inbox_messages (remote_jid, timestamp desc);
create index if not exists inbox_messages_timestamp_idx
  on public.inbox_messages (timestamp desc);
create index if not exists chat_history_jid_idx
  on public.chat_history (jid, timestamp desc);
create unique index if not exists inbox_messages_wa_id_idx
  on public.inbox_messages (wa_message_id)
  where wa_message_id is not null;

-- ---------------------------------------------------------------------------
-- Storage bucket for real files (public so Evolution can fetch/upload by URL)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('agent-media', 'agent-media', true)
on conflict (id) do update set public = true;

-- ---------------------------------------------------------------------------
-- Realtime for the inbox (optional; the UI also polls every few seconds)
-- ---------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.inbox_messages;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- Row Level Security: the server uses the service_role key, which bypasses RLS.
-- This read policy only exists so an optional browser Realtime subscription
-- (SUPABASE_ANON_KEY) can receive inbox rows. Remove it if you don't use Realtime.
alter table public.inbox_messages enable row level security;
do $$
begin
  create policy "inbox realtime read" on public.inbox_messages
    for select using (true);
exception
  when duplicate_object then null;
end $$;

-- ===========================================================================
-- Done. Telegram tables are intentionally absent - Telegram MTProto Coming Soon.
-- ===========================================================================
