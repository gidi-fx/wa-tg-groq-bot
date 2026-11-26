# WhatsApp Groq Router v2

Production WhatsApp AI router with multi-agent support, a WhatsApp-Web-style inbox, Supabase persistence, real file media, voice replies, group hosting, a playground, and a free/paid model chooser. **BYOK** — every user adds their own Groq and (optionally) OpenRouter keys.

> This build is **WhatsApp only**, through the Evolution API. There is no Telegram code.

## Stack

- Node.js + Express
- Supabase (Postgres + Storage, bucket `agent-media`) — **optional**, falls back to an in-memory store
- Evolution API v2 (WhatsApp)
- Groq API (free models, Whisper, TTS)
- OpenRouter API (free `:free` models and paid models)

## Environment

### requires

```env
PORT=3000

EVOLUTION_API_URL=https://your-evolution-host
EVOLUTION_API_KEY=your-evolution-api-key

GROQ_API_KEY=put_yours_here
```

### optional_env

```env
# Omit both to run without Supabase (temporary in-memory data).
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-supabase-service-role-key
SUPABASE_MEDIA_BUCKET=agent-media

# Only for browser Realtime in the inbox; polling is used otherwise.
SUPABASE_ANON_KEY=

OPENROUTER_API_KEY=put_yours_here
PUBLIC_URL=https://your-app.example.com
ELEVENLABS_API_KEY=
```

Users can also save keys in **Settings** (stored in Supabase, or in memory) or per agent, so the environment keys are only fallbacks.

## Supabase is optional

- With `SUPABASE_URL` + `SUPABASE_KEY` the app uses the Supabase tables and the `agent-media` bucket for permanent storage.
- Without them the app keeps everything in memory (`agents`, `groups`, `group_hosts`, `chat_assignments`, `inbox_messages`, `chat_history`, `settings`, media buffers) and resets on restart.
- The UI shows a yellow banner on every page while running in memory mode.
- `GET /api/inbox` and `POST /api/groups/sync` return `{ hasSupabase: false, warning, data }` in memory mode.

## Setup

1. `npm install`
2. Optional: run `supabase/schema.sql` in the Supabase SQL editor for persistence. It creates:
   - `agents`, `groups`, `group_hosts`, `chat_history`, `inbox_messages`
   - `chat_assignments` (inbox agent assignment) and `settings` (global BYOK)
   - indexes, the public `agent-media` bucket, and the optional realtime policy
3. `npm start` → open `http://localhost:3000`
4. Go to **Connect**, create an Evolution instance, then link WhatsApp by QR or by an 8-digit pairing code.
5. Go to **Agents**, create an agent and pick a model. Free Groq models are the default.
6. Messages arrive at `POST /webhook/:instance`; direct chats use the assigned agent (or the first agent), groups use the host from **Groups**.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness + config flags |
| GET | `/api/config` | Status and counts |
| GET | `/api/models` | Live-tested catalog (`groqAllowed` = the 2 Groq models) |
| GET | `/api/openrouter/models` | Full OpenRouter catalog for the searchable picker |
| POST | `/api/transcribe` | Groq Whisper STT (`file`, `audioBase64` or `audioUrl`) |
| GET | `/api/instance/qr/:instance` | Latest QR / pairing code pushed by `qrcode.updated` |
| GET/POST | `/api/agents` | List / create agents |
| GET/PUT/DELETE | `/api/agents/:id` | Read / update / delete |
| POST | `/api/agents/:id/media` | Upload media (max 20 MB, 10 files) |
| DELETE | `/api/agents/:id/media?path=` | Remove a media file |
| GET/PUT | `/api/settings` | Global BYOK keys (masked on read) |
| POST | `/api/instance/create` | Create Evolution instance + webhook |
| GET/POST | `/api/instance/connect/:instance` | QR base64 and/or pairing code (`POST { number }`) |
| GET | `/api/instance/status/:instance` | Connection status |
| POST | `/webhook/:instance` | Evolution `messages.upsert` |
| GET | `/api/inbox/conversations` | Chats grouped by JID |
| GET | `/api/inbox/messages?jid=` | Thread history |
| GET | `/api/inbox` | Snapshot; `{ hasSupabase:false, warning, data }` in memory mode |
| POST | `/api/inbox/reply` | Send a manual reply |
| POST | `/api/inbox/assign` | Assign/clear an agent |
| POST | `/api/inbox/sync` | Import recent Evolution chats |
| GET | `/api/groups` | Synced groups + hosts |
| POST | `/api/groups/sync` | `fetchAllGroups` → Supabase |
| POST | `/api/groups/host` | Host a group with an agent |
| POST | `/api/groups/create-agent` | Auto-create + host an agent |
| POST | `/api/playground` | Test an agent, returns token usage |

## Model routing

- `groq/<model>` → `https://api.groq.com/openai/v1/chat/completions`
  - allowed: `groq/openai/gpt-oss-120b` (label “1. gpt-oss-120b - BEST (Sales/Coding)”) and `groq/openai/gpt-oss-20b` (“2. gpt-oss-20b - FASTEST”) — nothing else; other ids return `groq_model_not_allowed`
  - if Groq says the model does not exist, retried without the `openai/` prefix (`gpt-oss-120b` / `gpt-oss-20b`)
- `openrouter/<model>` → `https://openrouter.ai/api/v1/chat/completions` — any model id is accepted, no whitelist
- Fallback chain: **selected → `groq/openai/gpt-oss-20b` → error message**
- Paid model without an OpenRouter key → `Add OpenRouter key in Settings to use paid models`

## Media and voice

- Agent uploads are stored in Supabase Storage (`agent-media`) when configured, otherwise in memory for the session, and sent as real files via Evolution `POST /message/sendMedia/:instance` with base64.
- If `media_enabled`, the agent can request a file with `[[SEND_MEDIA: file-name]]`.
- Incoming voice notes are downloaded from Evolution and transcribed by Groq Whisper (`whisper-large-v3`, fallback `whisper-large-v3-turbo`).
- If `voice_enabled` (“Reply as Voice Note (uses Groq TTS)”), replies are rendered to speech with Groq TTS — `canopylabs/orpheus-v1-english`, voice `troy`, `wav` (`playai-tts` was retired 2025-12-31) — and sent via `POST /message/sendWhatsAppAudio/:instance`. On TTS failure the reply falls back to text.
- Full loop: voice in → STT → `gpt-oss-120b` → TTS → voice note out.

## Pairing code (Evolution)

- `connectInstance()` calls `POST /instance/connect/<instance>` with `{ "number": "234..." }` and only falls back to `GET ...?number=` when that fails. Older GET-only calls returned a QR with `pairingCode: null`.
- Webhook events `qrcode.updated` and `connection.update` are no longer ignored: the app caches `pairingCode`/`base64` per instance, serves it on `GET /api/instance/qr/:instance` and reuses it in the connect response.
- The Connect page has **Try Pairing Code Again** and polls the cached endpoint for ~36 s after each request.
- Evolution env needed for pairing: `AUTH_TYPE=baileys`, `ENABLE_PAIRING_CODE=true`, `QRCODE_LIMIT=5`, `QRCODE_COLOR=#198754`, `CACHE_ENABLED=false`, `DATABASE_ENABLED=false` (memory).

## Notes

- Use the Supabase **service_role** key on the server; never expose it in the browser.
- Uploaded files are capped at 20 MB each.
