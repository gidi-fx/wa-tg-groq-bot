# wa-tg-groq-bot

A Node.js (ESM) service that puts one Groq-powered AI assistant on **both WhatsApp and Telegram**, with a **shared conversation history per phone number**.

- **WhatsApp** via [Evolution API](https://github.com/EvolutionAPI/evolution-api) webhooks (`messages.upsert`).
- **Telegram** via **MTProto** using [GramJS](https://github.com/gram-js/gramjs) and a **real phone login** — no bot token, no Telegraf.
- Voice notes on either platform are transcribed with Groq `whisper-large-v3` and answered as text.
- Text replies use Groq `qwen/qwen3-32b`.

```
WhatsApp --(Evolution webhook)--> server.js --\
                                              >-- agents.js (Groq) --> users.json (per-phone history)
Telegram --(GramJS MTProto)----> telegramClient.js --/
```

## Files

| File | Purpose |
| --- | --- |
| `server.js` | Express app: WhatsApp webhook, Telegram auth routes, `/users`, startup |
| `telegramClient.js` | GramJS client, MTProto phone login, incoming-message handler, `sendTelegram` |
| `userStore.js` | `users.json` store, `normalizePhone`, lookup/merge by phone, history |
| `agents.js` | Groq chat agent + Whisper transcription |
| `render.yaml` | Render blueprint (Node web service) |

## Requirements

- Node.js 18 or newer
- An Evolution API instance with a connected WhatsApp number
- A Groq API key — https://console.groq.com/keys
- Telegram `api_id` / `api_hash` — https://my.telegram.org
- A phone number with an active Telegram account (this becomes the "assistant" account that replies)

## Environment variables

Copy `.env.example` to `.env` and fill it in.

| Variable | Description |
| --- | --- |
| `PORT` | HTTP port, default `3000` (Render sets this automatically) |
| `EVOLUTION_API_URL` | Base URL of your Evolution API, e.g. `https://evo.example.com` |
| `EVOLUTION_API_KEY` | Global API key (`AUTHENTICATION_API_KEY` in Evolution) |
| `EVOLUTION_INSTANCE` | Instance name, e.g. `my-bot` |
| `GROQ_API_KEY` | Groq API key |
| `TELEGRAM_API_ID` | Numeric `api_id` from my.telegram.org |
| `TELEGRAM_API_HASH` | `api_hash` from my.telegram.org |
| `TELEGRAM_PHONE` | Phone of the Telegram account that will be logged in (`+234...`) |
| `TELEGRAM_SESSION` | `StringSession` string — empty on first run, filled after login |

## 1. Get Telegram API_ID / API_HASH

1. Open https://my.telegram.org and log in with the phone number you want the bot to use.
2. Go to **API development tools**.
3. Create an app (any name, platform "Other" is fine).
4. Copy **App api_id** and **App api_hash** into `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.

These identify the *application*, not the account. The account is the phone number you log in with.

## 2. First-time Telegram login (get `TELEGRAM_SESSION`)

Start the server (locally or on Render) with `TELEGRAM_SESSION` empty — you will see `Go to /auth/telegram to login`.

```bash
# Step 1: instructions and current status
curl https://YOUR-APP/auth/telegram

# Step 2: ask Telegram to send a login code
curl -X POST https://YOUR-APP/auth/telegram/send-code \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+2348012345678"}'

# Step 3: submit the code Telegram sent you inside the Telegram app
curl -X POST https://YOUR-APP/auth/telegram/verify-code \
  -H 'Content-Type: application/json' \
  -d '{"code":"12345"}'
```

- If the account has **2FA enabled**, the third call returns `{"needsPassword":true}`. Repeat it with the password:
  `-d '{"code":"12345","password":"your-2fa-password"}'`
- On success the response contains `session` and the server log prints:

  ```
  [telegram] LOGIN OK. Save this value as TELEGRAM_SESSION: 1BVtsOK...
  ```

- Put that string into `TELEGRAM_SESSION`, restart/redeploy. The client now connects on boot and listens for incoming messages.
- Keep the session secret — it is a full login for that Telegram account. The auth endpoints are unauthenticated, so remove/disable them (or protect them) once you have your session.

Incoming messages to the logged-in account are answered as that account. Outgoing messages are ignored, so the bot never replies to itself.

## 3. Evolution API webhook

Create/connect an instance in Evolution (QR scan), then point its webhook at this app:

```bash
curl -X POST "https://YOUR-EVOLUTION/api/v1/webhook/set/YOUR_INSTANCE" \
  -H "apikey: YOUR_EVOLUTION_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "https://YOUR-APP/webhook/evolution",
      "events": ["MESSAGES_UPSERT"]
    }
  }'
```

You can do the same from the Evolution manager UI (Webhook section). On boot the app logs the instance connection state by calling `GET /instance/connectionState/{instance}`.

The webhook handler:

- ignores `fromMe` and group/broadcast JIDs,
- reads text from `conversation`, `extendedTextMessage.text`, or an image/video/document caption,
- for `audioMessage`, calls `POST /chat/getBase64FromMediaMessage/{instance}` with the raw message, then transcribes the base64 audio with Groq,
- replies with `POST /message/sendText/{instance}`.

## 4. Phone linking

`users.json` holds one record per person:

```json
{
  "users": [
    {
      "phone": "2348021234567",
      "waJid": "2348021234567@s.whatsapp.net",
      "telegramId": "123456789",
      "telegramChatId": "123456789",
      "name": "Ada",
      "history": [{ "role": "user", "content": "hi", "at": "..." }]
    }
  ]
}
```

- `normalizePhone` strips `+`, spaces and dashes, and converts a leading `0` to `234` (`0802...` → `234802...`).
- A WhatsApp message from `2348021234567@s.whatsapp.net` creates/updates the user keyed by `2348021234567`.
- A Telegram message is matched by the sender's phone number, so the same number on both apps is **one user with one shared history** (last 20 messages).
- Telegram only exposes a sender's phone if that person is in the logged-in account's contacts (or their privacy allows it). If the phone is unavailable, the Telegram user id is used as the identifier — add the person to the account's contacts if you need cross-platform linking.
- `GET /users` lists linked users.

## 5. Run locally

```bash
npm install
cp .env.example .env   # then edit .env
npm start
```

Open http://localhost:3000 — it returns status, model names and links.

## 6. Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Status + links |
| GET | `/health` | Health check (used by Render) |
| POST | `/webhook/evolution` | Evolution API webhook |
| GET | `/auth/telegram` | Login instructions and status |
| POST | `/auth/telegram/send-code` | Request a Telegram login code |
| POST | `/auth/telegram/verify-code` | Submit code (and 2FA password) → session string |
| GET | `/users` | Linked users summary |

## 7. Deploy on Render

**Option A — Blueprint**

1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo. `render.yaml` defines the web service (`npm install` / `npm start`, health check `/health`).
3. Fill in the secret env vars when prompted (they are marked `sync: false`).
4. Deploy, then do the Telegram login flow against the public URL and add `TELEGRAM_SESSION`; Render redeploys automatically when you save it.

**Option B — Manual**

1. Render → **New → Web Service** → connect the repo.
2. Runtime **Node**, Build Command `npm install`, Start Command `npm start`.
3. Add all env vars from `.env.example` under **Environment**.
4. Deploy, then set the Evolution webhook to `https://YOUR-APP.onrender.com/webhook/evolution`.
5. Visit `https://YOUR-APP.onrender.com/auth/telegram` to complete the Telegram login and copy the session into `TELEGRAM_SESSION`.

Notes:

- Render provides `PORT`; the app listens on `0.0.0.0`.
- Free instances sleep when idle (the first webhook may be slow) and the filesystem is ephemeral, so `users.json` resets on redeploy/restart. For durable history, attach a Render disk and keep `users.json` on it, or move the store to a database.
- `TELEGRAM_SESSION` must be stored as a secret env var so the Telegram account stays logged in across restarts.
