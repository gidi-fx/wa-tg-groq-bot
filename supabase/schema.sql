-- ---------------------------------------------------------------------------
-- Agents. connected_instance = the WhatsApp account (Evolution instance,
-- e.g. wa-2348027899720) this agent replies from. API keys NEVER live here:
-- Groq/OpenRouter keys are read from the server environment only.
-- ---------------------------------------------------------------------------
create table if not exists public.agents (
  id text primary key,
  name text not null,
  instruction text default '',
  voice_enabled boolean not null default false,
  voice_id text,
  reply_mode text not null default 'textOnly',
  media_enabled boolean not null default false,
  model text not null default 'groq/openai/gpt-oss-120b',
  media_files jsonb not null default '[]'::jsonb,
  connected_instance text,
  created_at timestamptz not null default now()
);

-- Existing installs created before connected_instance existed.
alter table public.agents add column if not exists connected_instance text;
alter table public.agents add column if not exists voice_id text;
alter table public.agents add column if not exists reply_mode text not null default 'textOnly';
-- Old BYOK columns (if any) are ignored by the app and left untouched.
