# WhatsApp Groq Router v2

A single-codebase, production-ready WhatsApp AI router:

- **Evolution API v2** connection (QR code or 8-digit phone pairing code)
- **Supabase (optional)** for agents, groups, chat history, inbox, assignments, settings and real files — without it the app runs from a temporary in-memory store
- **Groq** free models + **OpenRouter** free `:free` / paid models, with a live catalog and prices
- **BYOK** — each user adds their own Groq and OpenRouter keys (globally or per agent)
- **Agents** with instructions, voice notes, media uploads and a model chooser
- **Inbox** like WhatsApp Web: chat list, threads, manual replies, agent assignment, search, sync
- **Groups** sync + host agents, including one-click “Create agent for group”
- **Playground** to test an agent and see token usage
- Real **media** files (not links), voice-note replies, typing presence and quoted replies

> **WhatsApp only.** This build talks to WhatsApp through the Evolution API. There is no Telegram support and no Telegram code in the repository.

---

## Quick start

```bash
npm install
cp .env.example .env      # fill in your values
npm start                 # http://localhost:3000
```

### 1. Supabase (optional)

Without `SUPABASE_URL` + `SUPABASE_KEY` the app still runs: agents, groups, host assignments, inbox, chat history and settings live in memory and reset when the server restarts. A yellow banner is shown on every page, and `GET /api/inbox` / `POST /api/groups/sync` return `{ hasSupabase: false, warning, data }`.

To persist, create a free project at <https://supabase.com>, open **SQL Editor**, and run [`supabase/schema.sql`](supabase/schema.sql). It creates the tables below, indexes, the public `agent-media` storage bucket, and the inbox realtime policy.

| Table | Purpose |
| --- | --- |
| `agents` | id, name, instruction, voice/media flags, model, media_files, per-agent keys |
| `groups` | jid, name, participants |
| `group_hosts` | group → agent |
| `chat_history` | AI memory per JID |
| `inbox_messages` | every inbound/outbound message |
| `chat_assignments` | direct chat → agent (used by the inbox) |
| `settings` | global BYOK keys |

Use the **service_role** key for `SUPABASE_KEY` on the server. Never expose it to the browser. Keys are optional; leave both blank to keep the in-memory mode.

### 2. Evolution API v2

Set `EVOLUTION_API_URL` and `EVOLUTION_API_KEY`, then open **Connect**:

1. Type an instance name and press **Create instance** (the webhook is registered automatically at `/webhook/<instance>`).
2. **QR Code** tab → scan with WhatsApp → Linked devices.
3. **Phone Number** tab → enter e.g. `2348012345678` → get the 8-digit pairing code → WhatsApp → Linked devices → Link with phone number.

Connection status polls every 5 seconds.

### 3. AI keys (BYOK)

Open **Settings** and paste your own keys:

- **Groq** — free at <https://console.groq.com/keys>. Powers free text models, Whisper transcription and voice replies.
- **OpenRouter** — optional at <https://openrouter.ai/keys>. Unlocks `:free` models and paid models. Paid models require a key; without one the app shows “Add OpenRouter key in Settings to use paid models”.

Keys can also be set per agent in the agent modal, or via `GROQ_API_KEY` / `OPENROUTER_API_KEY` in the environment.

### 4. Agents and models

Create agents in **/agents** with:

- Name + instruction
- **Voice Note** toggle (replies with a real WhatsApp voice note)
- **Media** toggle + multi-file upload (images, docs, audio; stored in Supabase Storage when configured, otherwise in memory; 20 MB/file)
- **Groq** is locked to exactly two models, tested live on the server:

  | Model id | Label |
  | --- | --- |
  | `groq/openai/gpt-oss-120b` | 1. gpt-oss-120b - BEST (Sales/Coding) |
  | `groq/openai/gpt-oss-20b` | 2. gpt-oss-20b - FASTEST |

  Both are sent to `POST https://api.groq.com/openai/v1/chat/completions`. If Groq answers that the model does not exist, the request is retried without the `openai/` prefix (`gpt-oss-120b` / `gpt-oss-20b`). Any other `groq/...` model is rejected by the API, so no qwen/llama/Gemma entries appear anywhere.
- **OpenRouter** accepts **any** model: a searchable picker over the full live catalog from `https://openrouter.ai/api/v1/models` (≈470 models) plus a free-text field for any id such as `anthropic/claude-3.5-sonnet` or `qwen/qwen3-32b`. Nothing is restricted there.

Free Groq models are the default. Re-testing is live: `/api/models` only lists models that actually replied.

### 5. Inbox, groups, playground

- **/inbox** — conversations grouped by JID, unread counts, search, manual replies (`sendText`), agent assignment, Evolution chat sync, and Supabase Realtime when `SUPABASE_ANON_KEY` is set (5-second polling otherwise).
- **/groups** — sync `GET /group/fetchAllGroups/:instance`, select groups, host an agent, or auto-create an agent for a group. Messages from a hosted group are answered by that agent.
- **/playground** — chat with an agent without WhatsApp; shows model, fallback and prompt/completion/total tokens.

---

## How replies are produced

1. Evolution posts `messages.upsert` to `POST /webhook/:instance`.
2. The message is stored in `inbox_messages` + `chat_history` (Supabase, or in memory); media is downloaded via Evolution and uploaded to Supabase Storage when configured.
3. The agent is resolved:
   - group → `group_hosts`
   - direct chat → `chat_assignments`, falling back to the first agent
4. Voice notes are transcribed with Groq Whisper (`whisper-large-v3`, falling back to `whisper-large-v3-turbo`) via `POST /api/transcribe`.
5. `callAI()` routes by model prefix:
   - `groq/*` → `https://api.groq.com/openai/v1/chat/completions`
   - `openrouter/*` → `https://openrouter.ai/api/v1/chat/completions`
   - fallback chain: **selected → `groq/openai/gpt-oss-20b` → error message**
6. Reply delivery:
   - requested media (`[[SEND_MEDIA: file]]`) → `POST /message/sendMedia/:instance`
   - `voice_enabled` → Groq TTS (`canopylabs/orpheus-v1-english`, voice `troy`, wav) → `POST /message/sendWhatsAppAudio/:instance`, text fallback on failure
   - otherwise → quoted text via `POST /message/sendText/:instance`
7. Presence `composing` is shown while generating and `paused` afterwards.

## Endpoints

| Method | Path |
| --- | --- |
| GET | `/health`, `/api/config`, `/api/models` |
| GET | `/api/openrouter/models` |
| POST | `/api/transcribe` (multipart `file`, or JSON `audioBase64` / `audioUrl`) |
| GET | `/api/instance/qr/:instance` (latest QR from the webhook; never a pairing code) |
| GET/POST | `/api/agents` |
| GET/PUT/DELETE | `/api/agents/:id` |
| POST/DELETE | `/api/agents/:id/media` |
| GET/PUT | `/api/settings` |
| POST | `/api/instance/create`, `/instance/create` |
| GET/POST | `/api/instance/connect/:instance`, `/instance/connect/:instance` |
| GET | `/api/instance/status/:instance` |
| POST/GET | `/webhook/:instance` |
| GET | `/api/inbox` (snapshot with `hasSupabase` + `data`) |
| GET | `/api/inbox/conversations`, `/api/inbox/messages` |
| POST | `/api/inbox/reply`, `/api/inbox/assign`, `/api/inbox/sync` |
| GET | `/api/groups` |
| POST | `/api/groups/sync`, `/api/groups/host`, `/api/groups/create-agent` |
| DELETE | `/api/groups/host/:jid` |
| POST | `/api/playground` |

## Environment

See [`.env.example`](.env.example). Required: `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `GROQ_API_KEY` (or a key saved in Settings). Optional: `SUPABASE_URL`, `SUPABASE_KEY` (persistence; omit for in-memory), `OPENROUTER_API_KEY`, `PUBLIC_URL`. `PORT` defaults to `3000`. The server listens on `0.0.0.0` for hosts like Render.

Voice overrides: `GROQ_TRANSCRIBE_MODEL` (default `whisper-large-v3`), `GROQ_TRANSCRIBE_FALLBACK_MODEL` (default `whisper-large-v3-turbo`), `GROQ_TTS_MODEL` (default `canopylabs/orpheus-v1-english`), `GROQ_TTS_VOICE` (default `troy`; also `autumn`, `diana`, `hannah`, `austin`, `daniel`), `GROQ_TTS_FORMAT` (default `wav`). Groq retired `playai-tts` on 2025-12-31.

## Pairing code (Evolution)

Evolution v2.3.8 exposes pairing only on `GET /instance/connect/<instance>?number=<digits>` (country code, no `+`); the `POST` variant returns 404. The app therefore makes exactly one GET per button press and reads `pairingCode` from the response, falling back to `base64` (QR) only when no code is present. Pairing codes can contain letters (e.g. `6DAQQ8N2`), so they are passed through verbatim. The `code` field is the raw QR string and is never treated as a pairing code, and the `qrcode.updated` webhook is not used for pairing codes at all. A second connect call invalidates the first code, so the Connect page disables its buttons while a request is in flight and for 60 seconds afterwards, with no automatic retries.

## Security notes

- If you enable Supabase, the server needs its service_role key; treat it as a secret. In-memory mode stores nothing on disk.
- API keys saved in `settings.data` / `agents.*_key` are readable by anyone with database access — protect the project and never commit your `.env`.
- CORS is open by default so the dashboard can be used from any origin; restrict it in `src/index.js` if you deploy publicly.

## Deploy

`render.yaml` is included for a Render web service (`npm install` → `npm start`, health check `/health`). On Render, set `PUBLIC_URL` to your service URL so the webhook address registered with Evolution is correct.
