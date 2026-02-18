# NewroHelp Main Server

Real-time voice AI orchestration server. Bridges Twilio phone calls, OpenAI Realtime API, and the GPU inference server as a self-hosted replacement for ElevenLabs, mirroring the same feature set your existing `ai_assistants` configuration supports.

---

## Architecture

```
Incoming Call
     │
     ▼
Twilio ──── MediaStream WebSocket ────► Main Server (this repo)
                                              │
                              ┌───────────────┼───────────────┐
                              ▼               ▼               ▼
                        GPU Server        OpenAI          Laravel API
                     (VAD/STT/TTS)      (Realtime)    (ai_assistants + related models)
```

### Call Flow

```
1.  Twilio webhook  →  POST /twilio/incoming
2.  twiml.js calls  →  POST /api/internal/calls/incoming (Laravel)  → validates number is configured
3.  Main server responds with TwiML → opens MediaStream WebSocket
4.  WebSocket connects → GET /api/internal/calls/{sid}/config (Laravel) → full assistant config
5.  OpenAI session created with tools built from your assistant config
6.  first_message spoken if configured
7.  Audio chunks arrive from Twilio (mulaw 8kHz)
8.  Each chunk → GPU /vad/detect  (~12ms, CPU)
9.  On speech_end → GPU /process/audio  (VAD+STT combined, ~130ms, GPU)
10. Transcript → OpenAI Realtime text mode
11. OpenAI streams text back (may invoke tools)
12. Tool calls executed (built-in or custom HTTP tools)
13. Response text → GPU /tts/synthesize  (streaming, ~170ms, GPU)
14. Audio chunks → Twilio MediaStream as they arrive
```

---

## Repository Structure

```
newrohelp-main-server/
├── src/
│   ├── index.js                    # Express server, startup, health check
│   ├── twilio/
│   │   ├── twiml.js               # Incoming call webhook + status callback
│   │   └── mediastream.js         # Per-call WS handler, system prompt builder
│   ├── openai/
│   │   └── realtime.js            # OpenAI Realtime API WebSocket client
│   ├── gpu/
│   │   └── client.js              # GPU server HTTP client (VAD, STT, TTS)
│   ├── orchestrator/
│   │   ├── pipeline.js            # Core audio pipeline
│   │   ├── callmanager.js         # Session registry + timers
│   │   └── functions.js           # Tool builder + executor
│   └── utils/
│       ├── audio.js               # mulaw ↔ PCM16 ↔ base64
│       └── logger.js              # Winston logger
├── logs/                          # Auto-created on first run
├── package.json
├── setup.sh
├── env.example.txt                # Rename to .env and fill in
└── newrohelp-main-server.service.txt   # Systemd template
```

---

## Requirements

- **Node.js 20 LTS**
- **Ubuntu 22.04 LTS** (production)
- Running **GPU server** (see `gpu-server` repo)
- **Laravel app** with internal API endpoints implemented (see below)
- **Twilio** account + phone number
- **OpenAI** API key with Realtime API access

---

## Installation

### Automated

```bash
git clone <your-repo> newrohelp-main-server
cd newrohelp-main-server
chmod +x setup.sh
./setup.sh
```

### Manual

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install
cp env.example.txt .env
mkdir -p logs
npm start
```

---

## Configuration

```bash
cp env.example.txt .env
nano .env
```

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `TWILIO_ACCOUNT_SID` | Not needed — per-account credentials come from DB via Laravel |
| `TWILIO_AUTH_TOKEN` | Not needed — per-account credentials come from DB via Laravel |
| `OPENAI_API_KEY` | OpenAI key (Realtime API access required) |
| `OPENAI_MODEL` | Realtime model (default: `gpt-4o-realtime-preview-2024-12-17`) |
| `GPU_SERVER_URL` | GPU server URL e.g. `http://1.2.3.4:8000` |
| `GPU_SERVER_API_KEY` | API key set in gpu-server `.env` |
| `LARAVEL_API_URL` | Internal Laravel API base e.g. `http://localhost/api/internal` |
| `LARAVEL_API_SECRET` | Shared secret checked by Laravel middleware |

Call timeout settings (fallbacks if not set on the assistant):

| Variable | Default | Description |
|---|---|---|
| `MAX_CALL_DURATION_SECONDS` | `900` | Hard 15-min cutoff |
| `SILENCE_TIMEOUT_SECONDS` | `10` | Prompt caller after N sec silence |
| `SILENCE_HANGUP_SECONDS` | `15` | Hang up after N sec total silence |

> **Note:** `ai_assistants.silence_end_call_timeout` and `ai_assistants.max_duration_seconds` take priority over the `.env` fallbacks when set.

---

## Twilio Configuration

In Twilio console, for each phone number:

| Setting | Value |
|---|---|
| Voice webhook | `https://your-server.com/twilio/incoming` (POST) |
| Status callback | `https://your-server.com/twilio/status` (POST) |

> Twilio requires HTTPS. For local dev use `ngrok http 3000`.

---

## Tool System

Tools are built **dynamically per call** from the assistant's configuration. No tools are hardcoded — adding new tools only requires updating the assistant config in your Laravel admin.

### Built-in Tools (controlled by flags on `ai_assistants`)

| Tool | Enabled by | What it does |
|---|---|---|
| `end_call` | `is_end_call_enabled = true` | Ends the call gracefully |
| `transfer_to_number` | `is_transfer_to_number = true` + `AIAgentTransferToNumber` records | Transfers via Twilio Dial or SIP REFER |
| `transfer_to_agent` | `is_transfer_to_agent = true` + `AIAgentTransferToAgent` records | Transfers to another AI agent |
| `switch_language` | `language_detection = true` | Updates session language + TTS voice |

Voicemail detection (`voicemail_detection = true`) is handled via the system prompt — the LLM is instructed to detect answering machines and respond with `voicemail_message`, then call `end_call`.

### Custom HTTP Tools (from `ai_agent_custom_tools`)

Enabled when `is_custom_tools = true` on the assistant. Each tool in `ai_agent_custom_tools` becomes a callable OpenAI function. When the LLM calls it:

1. Path params `{placeholder}` in the URL are substituted
2. Query params are appended
3. Request headers are included
4. HTTP request is made to the configured URL + method
5. Response values extracted via assignments (dot-notation paths → dynamic variables)
6. Result returned to LLM to respond naturally

---

## Laravel API Endpoints

All requests from this server include `X-Internal-Secret` header. Implement these endpoints in your Laravel app:

### `POST /api/internal/calls/incoming`

Called by `twiml.js` the moment a Twilio call arrives, before TwiML is sent back. Laravel looks up the `to_phone` number to find which assistant owns it.

**Request:**
```json
{
  "call_sid":    "CAxxxxxxxx",
  "caller_phone": "+15551234567",
  "to_phone":    "+14385559876",
  "call_status": "ringing"
}
```

**Response** (must include `assistant_id` — if missing or null, the call plays an error message and hangs up):
```json
{
  "assistant_id":    42,
  "organization_id": 7
}
```

---

### `GET /api/internal/calls/{callSid}/config`

Called once per call when the MediaStream WebSocket opens. Laravel builds the `system_prompt` fully — dynamic variable substitution, caller context, tool instructions — all server-side. This server uses it as-is.

The `twilio_account_sid` and `twilio_auth_token` come from the `TwilioAccount` record linked to the dialled phone number via `TwilioPhoneNumber → TwilioAccount`.

**Response:**
```json
{
  "assistant_id": 42,
  "organization_id": 7,
  "caller_phone": "+15551234567",

  "twilio_account_sid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "twilio_auth_token": "your_auth_token",

  "system_prompt": "You are Sophie, a receptionist for Sésame Restaurant...",

  "first_message": "Thank you for calling Sésame! How can I help you?",

  "language": "en",
  "voice": "af_sarah",
  "language_voices": {
    "en": "af_sarah",
    "es": "ef_dora"
  },

  "silence_timeout_seconds": 10,
  "max_duration_seconds": 600,

  "is_end_call_enabled": true,
  "is_transfer_to_number": true,
  "is_transfer_to_agent": false,
  "is_custom_tools": true,
  "language_detection": true,

  "transfer_to_number": [
    {
      "phone_number": "+15141112222",
      "condition": "caller wants to speak to a human",
      "transfer_type": "conference",
      "enable_client_message": true
    }
  ],

  "transfer_to_agent": [],

  "custom_tools": [
    {
      "name": "check_hours",
      "description": "Get current business hours",
      "url": "https://yourapp.com/api/hours",
      "method": "GET",
      "is_path_params": false,
      "is_query_params": false,
      "is_request_headers": true,
      "is_assignments": false,
      "response_timeout_secs": 10,
      "disable_interruptions": false,
      "path_params": [],
      "query_params": [],
      "request_headers": [
        { "key": "Authorization", "value": "Bearer your-token" }
      ],
      "assignments": []
    }
  ]
}
```

> **`language_voices`** maps language codes to Kokoro voice names. When `switch_language` fires, the session immediately updates both `session.language` and `session.voice`. If a language has no entry in the map, the GPU server falls back to its default for that language.

---

### `POST /api/internal/calls/status`

Called on every Twilio status callback to update the call record.

**Request:**
```json
{
  "call_sid": "CAxxxxxxxx",
  "call_status": "completed",
  "call_duration": "143"
}
```

---

### `GET /api/internal/calls/{callSid}/transfer-agent`

Called by `pipeline.js` when the `transfer_to_agent` tool fires. Query param: `agent_id`. Returns the Twilio webhook URL for the target agent.

**Response:**
```json
{
  "twiml_url": "https://your-laravel-app.com/twilio/incoming"
}
```

---

## Running the Server

### Development

```bash
npm run dev
```

### Production (direct)

```bash
npm start
```

### Production (systemd)

```bash
sudo cp newrohelp-main-server.service.txt /etc/systemd/system/newrohelp-main-server.service
# Edit the service file to set User and WorkingDirectory
sudo systemctl daemon-reload
sudo systemctl enable newrohelp-main-server
sudo systemctl start newrohelp-main-server

# Logs
sudo journalctl -u newrohelp-main-server -f
tail -f logs/combined.log
```

---

## Health Check

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "healthy",
  "active_calls": 2,
  "gpu_server": {
    "status": "healthy",
    "gpu_utilization": 42.0,
    "vram_used_gb": 2.8,
    "models_loaded": { "vad": true, "stt": true, "tts": true }
  }
}
```

---

## Logs

```bash
tail -f logs/combined.log
tail -f logs/error.log

# Filter by call (last 8 chars of SID shown in brackets)
grep "a1b2c3d4" logs/combined.log
```

---

## Troubleshooting

### GPU server not connecting on startup
The server will log a warning and retry on the first call. Verify `GPU_SERVER_URL` and `GPU_SERVER_API_KEY` in `.env`.

### Twilio MediaStream not connecting
- Confirm the server is accessible over HTTPS (Twilio requires it)
- Check Twilio webhook URL is set to `https://your-domain.com/twilio/incoming`
- Check firewall allows port 443 (or your reverse proxy port)

### OpenAI Realtime API errors
- Ensure your OpenAI account has Realtime API access enabled
- Verify `OPENAI_MODEL` matches an available Realtime model
- Check your API key has sufficient quota

### Laravel API returning errors
- Verify `LARAVEL_API_SECRET` matches `X-Internal-Secret` check in Laravel middleware
- Ensure all internal API endpoints are implemented
- Check Laravel logs for errors

### Audio quality issues
- Confirm GPU server is running and models are loaded (`/health` endpoint)
- Check GPU server logs for TTS/STT errors
- Verify audio conversion is correct (mulaw 8kHz ↔ PCM16 16kHz)

---

## Related Repositories

- **`gpu-server`** — Python/FastAPI inference server (VAD, STT, TTS)
- **`newrohelp-laravel`** — Main Laravel application (business logic, database, admin dashboard)