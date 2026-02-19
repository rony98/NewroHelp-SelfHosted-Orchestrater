require('dotenv').config();
const express = require('express');
const app     = express();
app.use(express.json());

const SECRET = process.env.MOCK_INTERNAL_SECRET || 'test-secret';
const PORT   = process.env.PORT || 4000;

app.use((req, res, next) => {
    if (req.headers['x-internal-secret'] !== SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// ── twiml.js calls this first on every incoming Twilio call ──────────────────
// Must return at minimum { assistant_id } — if missing, twiml.js plays an
// error message and hangs up. The full config is fetched separately by
// mediastream.js via GET /calls/:callSid/config once the WS opens.
app.post('/api/internal/calls/incoming', (req, res) => {
    const { call_sid, caller_phone, to_phone } = req.body;
    console.log(`[incoming] ${caller_phone} → ${to_phone} (${call_sid})`);

    // twilio_auth_token is returned here so twiml.js can validate
    // the Twilio signature immediately after this call.
    // In production Laravel looks this up via TwilioPhoneNumber → TwilioAccount.
    res.json({
        assistant_id:      'mock-assistant-1',
        organization_id:   'mock-org-1',
        twilio_auth_token: process.env.TWILIO_AUTH_TOKEN || 'your_twilio_auth_token',
    });
});

// ── twiml.js calls this on every Twilio status callback ──────────────────────
app.post('/api/internal/calls/status', (req, res) => {
    const { call_sid, call_status, call_duration } = req.body;
    console.log(`[status] ${call_sid}: ${call_status}${call_duration ? ` (${call_duration}s)` : ''}`);
    res.json({ ok: true });
});

// ── mediastream.js calls this once the WS is open ────────────────────────────
app.get('/api/internal/calls/:callSid/config', (req, res) => {
    console.log(`[config] ${req.params.callSid}`);

    res.json({
        assistant_id:     'mock-assistant-1',
        organization_id:  'mock-org-1',
        caller_phone:     req.query.caller_phone || '+10000000000',

        twilio_account_sid: process.env.TWILIO_ACCOUNT_SID || 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        twilio_auth_token:  process.env.TWILIO_AUTH_TOKEN  || 'your_twilio_auth_token',

        system_prompt: `You are a friendly AI receptionist for NewroHelp. \nKeep responses short and natural — one or two sentences maximum. \nBe warm, helpful, and professional.`,

        first_message:     'Hello! Thanks for calling NewroHelp. How can I help you today?',
        voicemail_message: null,

        language: 'en',
        voice:    'af_heart',
        language_voices: { en: 'af_heart' },

        silence_timeout_seconds: 10,
        max_duration_seconds:    600,

        voicemail_detection:   false,
        is_end_call_enabled:   true,
        is_transfer_to_number: false,
        is_transfer_to_agent:  false,
        is_custom_tools:       false,
        language_detection:    false,

        transfer_to_number: [],
        transfer_to_agent:  [],
        custom_tools:       [],

        // ── Filler phrases (pipeline.js: played during tool execution) ────────
        // enable_filler_phrases: true  → use DEFAULT_FILLER_PHRASES from pipeline.js
        // filler_phrases: [...]        → override with custom list (optional)
        // enable_filler_phrases: false → disable entirely
        enable_filler_phrases: true,
        filler_phrases: [],   // empty = use pipeline.js defaults

        // ── Context summarization (pipeline.js: summarizeContext) ─────────────
        // Summarizes and trims the OpenAI Realtime context when the transcript
        // exceeds ~1500 words. Opt-in because most calls never hit this limit.
        // Set to true to test with long calls.
        context_summarization: false,
    });
});

// ── pipeline.js calls this when call ends ────────────────────────────────────
app.post('/api/internal/calls/:callSid/complete', (req, res) => {
    console.log(`[complete] ${req.params.callSid}`, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
});

// ── pipeline.js calls this when transfer_to_agent tool fires ─────────────────
app.get('/api/internal/calls/:callSid/transfer-agent', (req, res) => {
    console.log(`[transfer-agent] ${req.params.callSid} agent:${req.query.agent_id}`);
    res.json({ twiml_url: '' });
});

app.listen(PORT, () => {
    console.log(`Mock Laravel running on port ${PORT}`);
    console.log(`X-Internal-Secret: ${SECRET}`);
});