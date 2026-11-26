# wa-tg-groq-bot

WhatsApp (Evolution API) and Telegram (MTProto user login) bridge with Groq agents for text and voice.

- **No bot.** No bot token, no Telegraf. Telegram runs as real user accounts over MTProto.
- **Multi-user Telegram.** One `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` for the whole app; every user logs in with their own phone number and login code.
- **No instance name in env.** WhatsApp instances are created on demand and taken from the webhook payload.
- **Voice notes** are transcribed with Groq `whisper-large-v3` and answered with a voice note (Groq TTS `playai-tts`); replies come from the free Groq model in `GROQ_MODEL` (default `openai/gpt-oss-120b`, falling back to `openai/gpt-oss-20b` and then `llama-3.3-70b-versatile`).
- **Phone linking.** WhatsApp and Telegram with the same phone number share one user record and one conversation history.

## Environment

```bash
PORT=10000
EVOLUTION_API_URL=https://your-evolution-host
EVOLUTION_API_KEY=your-evolution-api-key
GROQ_API_KEY=your-groq-api-key
GROQ_MODEL=openai/gpt-oss-120b
TELEGRAM_API_ID=1234567
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
# Optional: public webhook Evolution calls (default below)
WEBHOOK_URL=https://wa-tg-groq-bot.onrender.com/webhook/evolution
```

That is the complete list. There is **no** `EVOLUTION_INSTANCE`, no `TELEGRAM_PHONE`, and no `TELEGRAM_SESSION` to configure - sessions are created per user at login and stored in `telegram_sessions.json`.

One optional variable exists for hosts with an ephemeral disk (Render free tier):

```bash
# Optional. Restores sessions after a redeploy. Fill it in AFTER the first login.
TELEGRAM_SESSIONS_JSON=eyJzZXNzaW9ucyI6e319
```

`TELEGRAM_SESSION` (a single legacy session string) is still accepted and is loaded as `{ "default": "<session>" }`.

## Run locally

```bash
cp .env.example .env    # then fill in the values
npm install
npm start
```

## Telegram: every user logs in with their own phone

`telegram_sessions.json` holds one session string per phone:

```json
{ "sessions": { "2348021234567": "1BVtsOK4Bu..." } }
```

It is gitignored; it contains account credentials, so never commit or share it.

### 1. Send the code

```bash
curl -X POST http://localhost:3000/telegram/send-code \
  -H 'Content-Type: application/json' \
  -d '{"phone":"2348021234567"}'
```

```json
{
  "success": true,
  "phone": "2348021234567",
  "phoneCodeHash": "8f3c...",
  "message": "Code sent to Telegram"
}
```

The code arrives in the user's Telegram app (or by SMS).

### 2. Verify the code

```bash
curl -X POST http://localhost:3000/telegram/verify-code \
  -H 'Content-Type: application/json' \
  -d '{"phone":"2348021234567","code":"12345","phoneCodeHash":"8f3c..."}'
```

`{"success":true,"sessionSaved":true,...}` means the session was saved and the client is now listening for incoming messages. If the account has 2FA, the first response is `{"success":false,"needsPassword":true}`; repeat the same request with the extra field `"password":"your-2fa-password"`.

The successful response also carries the backup value for ephemeral hosts:

```json
{
  "success": true,
  "sessionSaved": true,
  "session": "1BVtsOK4Bu...",
  "envValue": "eyJzZXNzaW9ucyI6eyIyMzQ4MDIxMjM0NTY3IjoiMUJWdHNPSzRCdSJ9fQ==",
  "instruction": "Copy this base64 to Render env TELEGRAM_SESSIONS_JSON to survive redeploys"
}
```

The same base64 is printed in the server log between `=== PERSIST THIS TO RENDER ENV ===` markers, and `GET /` exposes it under `envBackup`.

### 3. Manage sessions

```bash
curl http://localhost:3000/telegram/sessions                       # logged-in phones
curl -X POST http://localhost:3000/telegram/logout \
  -H 'Content-Type: application/json' -d '{"phone":"2348021234567"}'
```

On startup the app reconnects every saved session and re-registers its message handler, so no re-login is needed after a normal restart.

### How replies work

For each logged-in account the app listens for incoming messages (`NewMessage({ incoming: true })`), ignores its own outgoing messages, resolves the sender, transcribes voice notes when needed, asks the Groq agent, and replies in the same chat. The identity used for memory is the **logged-in account's phone**, which is what links Telegram to WhatsApp.

## WhatsApp: no instance name

Instances are created through this app:

```bash
curl -X POST http://localhost:3000/instance/create \
  -H 'Content-Type: application/json' \
  -d '{"instanceName":"my-phone"}'
```

The Evolution response (including the QR code) is returned as `evolution`. Scan it with WhatsApp, then point the instance webhook at:

```
POST https://YOUR-APP/webhook/evolution
```

Enable the `MESSAGES_UPSERT` event. The instance name is read from the webhook payload (`instance`, or `?instance=` as a fallback, otherwise `any`), and the same name is used to send the reply - nothing is hardcoded.

Text, captions and voice notes are supported. Group JIDs (`@g.us`) and status broadcasts are ignored, and messages sent by the account itself are skipped.

How a reply is delivered:

- A **typing indicator** (`POST /chat/sendPresence`) is shown before the Groq call and stays visible at least `WHATSAPP_TYPING_MS` (default 2500 ms), then `paused` is sent just before the reply.
- Replies are sent **quoted** to the incoming message.
- A **voice note gets a voice note back**: the reply is rendered with Groq TTS (`playai-tts`, ogg/opus) and sent with `POST /message/sendWhatsAppAudio`. If TTS fails the same reply goes out as text, so a voice note is never left unanswered.

## Phone linking

`users.json`:

```json
{
  "users": [
    {
      "phone": "2348021234567",
      "waJid": "2348021234567@s.whatsapp.net",
      "telegramPhone": "2348021234567",
      "name": "Ada",
      "history": [{ "role": "user", "content": "hi", "at": "2026-01-01T00:00:00.000Z" }]
    }
  ]
}
```

`phone` is the key. A WhatsApp message from `2348021234567@s.whatsapp.net` and a Telegram login for `2348021234567` resolve to the same record, so the agent keeps one 20-message history across both platforms.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Service info and links |
| GET | `/health` | Health check (used by Render) |
| POST | `/telegram/send-code` | Send a Telegram login code |
| POST | `/telegram/verify-code` | Verify code (+ 2FA password if needed), save session |
| GET | `/telegram/sessions` | List phones with saved sessions |
| POST | `/telegram/logout` | Delete a phone's session and disconnect it |
| POST | `/instance/create` | Create a WhatsApp instance and get its QR |
| POST | `/webhook/evolution` | Evolution `MESSAGES_UPSERT` webhook |
| GET | `/users` | List linked users and message counts |

## Deploy on Render

1. Render -> **New -> Blueprint** -> select this repository (`render.yaml` is read automatically).
2. Add `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `GROQ_API_KEY`, `GROQ_MODEL`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` in **Environment**.
3. Create/scan the WhatsApp instance and set its webhook to `https://YOUR-APP.onrender.com/webhook/evolution`.
4. Log in Telegram per user with `/telegram/send-code` then `/telegram/verify-code` on the deployed URL.

### Keep sessions across redeploys (Render free tier)

Render's free plan has an **ephemeral filesystem**: `telegram_sessions.json` and `users.json` are wiped on every redeploy or restart, so everyone would have to log in again.

The session store survives that because it can be seeded from an environment variable:

1. Log in once with `/telegram/send-code` then `/telegram/verify-code` on the deployed URL.
2. Copy the base64 value from the response (`envValue`), from `GET /` (`envBackup.value`), or from the log line `TELEGRAM_SESSIONS_JSON=...`.
3. In Render open your service -> **Environment** -> **Add Environment Variable**:
   - Key: `TELEGRAM_SESSIONS_JSON`
   - Value: the base64 you copied
4. **Save** (this triggers a deploy). On boot the log shows `Loaded N sessions from ENV` and every saved account reconnects without logging in again.

Details:

- `TELEGRAM_SESSIONS_JSON` accepts **base64** (anything starting with `eyJ`) or a **raw JSON** string such as `{"sessions":{"2348021234567":"1BVts..."}}` (a flat `{"2348021234567":"1BVts..."}` map also works).
- On startup the app loads ENV first, then fills any gaps from `telegram_sessions.json`, and rewrites the file so local development keeps working without the variable.
- Every save logs the current value as `TELEGRAM_SESSIONS_JSON=...`, so after another user logs in you can repeat step 2-4 to update it. Sessions are credentials: keep the variable private and never commit it.

## Limitations

- **Sessions need the ENV backup on free hosts.** `telegram_sessions.json` and `users.json` live in the service filesystem, and Render's free tier has an ephemeral disk. Set `TELEGRAM_SESSIONS_JSON` (see above) to restore Telegram sessions after a redeploy; chat history in `users.json` still resets unless you attach a persistent disk.
- **Phone visibility.** Telegram only reveals a sender's phone number when that person is in the account's contacts; otherwise the numeric user ID is used for logging.
- **The login endpoints are open.** Anyone who can reach `/telegram/send-code` can start a login and `/telegram/logout` can remove any phone's session. Put these behind auth before public use.
- **One session per phone.** Logging in the same phone again replaces its stored session; the previous pending client is discarded.
- WhatsApp linking depends on Evolution reporting the sender in `remoteJid`, which is standard for direct chats.
