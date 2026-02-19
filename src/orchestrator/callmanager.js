'use strict';

const { EventEmitter } = require('events');
const { v4: uuidv4 }   = require('uuid');
const logger            = require('../utils/logger');

class CallSession extends EventEmitter {
    constructor({ callSid, callerPhone, assistantId, organizationId, systemPrompt, language, voice, assistantConfig, twilioAccountSid, twilioAuthToken }) {
        super();

        // Identity
        this.callSid        = callSid;
        this.callerPhone    = callerPhone;
        this.assistantId    = assistantId;
        this.organizationId = organizationId;
        this.sessionId      = uuidv4();

        // Config
        this.assistantConfig  = assistantConfig || {};
        this.twilioAccountSid = twilioAccountSid;
        this.twilioAuthToken  = twilioAuthToken;

        // Language / voice
        this.language = language || 'en';
        this.voice    = voice    || null;

        // Prompt
        this.systemPrompt = systemPrompt;

        // Lifecycle
        this.status = 'connecting';   // connecting | active | ending | ended

        // AI speaking / user speaking flags
        this.isSpeaking   = false;
        this.isAISpeaking = false;

        // Dynamic variables from custom tool responses
        this.dynamicVariables = {};

        // ── FIX: initialize all pipeline state in constructor ─────────────────
        // Previously these were initialized lazily with patterns like:
        //   `if (!session.vadAccumulator) session.vadAccumulator = [];`
        // inside the hot audio path. Lazy init is fragile: if any code path
        // reads the property before the first write, it gets undefined instead
        // of the expected empty collection. Move all of it here so every session
        // starts with a clean, well-typed state.

        // Audio pipeline state
        this.speechBuffer         = [];   // PCM16 buffers during active speech
        this.vadAccumulator       = [];   // 20ms chunks accumulating toward 200ms batch
        this.preRollBuffer        = [];   // last 2 batches (400ms) before speech onset

        // VAD coordination
        this.vadInFlight          = false;  // true while one VAD HTTP call is pending
        this.speechStartCount     = 0;      // consecutive speech_start events in current turn
        this.speechStartedAt      = null;   // Date.now() when current turn started
        this.transcribeInFlight   = false;  // guards against concurrent STT calls

        // ── STT mute during AI speaking (pipecat: STTMuteFilter) ──────────────
        // Track whether user speech was first detected while the AI was playing.
        // If the AI finishes before the user reaches INTERRUPT_THRESHOLD, the
        // buffered audio is almost certainly the AI's echo or background noise —
        // not a real user turn. Discard it instead of sending to Whisper.
        this.speechStartedDuringAI = false;

        // ── Smart Turn Detection (pipecat: LocalSmartTurnAnalyzerV3) ──────────
        // After VAD emits speech_end, we ask the Smart Turn model if the user
        // actually finished their sentence (vs. pausing mid-utterance).
        // If incomplete, we hold the buffer and wait up to TURN_FALLBACK_MS for
        // more speech before forcing transcription.
        this.awaitingTurnConfirmation = false;
        this.turnConfirmationTimer    = null;

        // ── Context summarization ─────────────────────────────────────────────
        // Tracks OpenAI conversation item IDs so we can delete old items after
        // summarizing. Populated by realtime.js item_created events.
        this.conversationItemIds = [];

        // Timers
        this.silenceTimer      = null;
        this.maxDurationTimer  = null;
        this.startTime         = Date.now();

        // References set by pipeline
        this.openaiClient    = null;
        this.mediaStreamWs   = null;
        this.twilioStreamSid = null;
        this._twilioClient   = null;  // cached Twilio REST client
    }

    appendSpeechBuffer(chunk) {
        this.speechBuffer.push(chunk);
    }

    flushSpeechBuffer() {
        if (this.speechBuffer.length === 0) return Buffer.alloc(0);
        const combined    = Buffer.concat(this.speechBuffer);
        this.speechBuffer = [];
        return combined;
    }

    startSilenceTimer(onHangup) {
        this.clearSilenceTimer();
        const configuredTimeout = this.assistantConfig.silence_timeout_seconds;
        const timeoutMs = (configuredTimeout && configuredTimeout > 0)
            ? configuredTimeout * 1000
            : parseInt(process.env.SILENCE_TIMEOUT_SECONDS || '10') * 1000;
        this.silenceTimer = setTimeout(() => {
            logger.info('Silence timeout — ending call', { callSid: this.callSid });
            onHangup();
        }, timeoutMs);
    }

    clearSilenceTimer() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
    }

    startMaxDurationTimer(onExpire) {
        const configuredMax = this.assistantConfig.max_duration_seconds;
        const maxMs = (configuredMax && configuredMax > 0)
            ? configuredMax * 1000
            : parseInt(process.env.MAX_CALL_DURATION_SECONDS || '900') * 1000;
        this.maxDurationTimer = setTimeout(() => {
            logger.info('Max call duration reached', { callSid: this.callSid });
            onExpire();
        }, maxMs);
    }

    clearAllTimers() {
        this.clearSilenceTimer();
        if (this.maxDurationTimer) {
            clearTimeout(this.maxDurationTimer);
            this.maxDurationTimer = null;
        }
        if (this.turnConfirmationTimer) {
            clearTimeout(this.turnConfirmationTimer);
            this.turnConfirmationTimer = null;
        }
    }

    getDurationSeconds() {
        return Math.round((Date.now() - this.startTime) / 1000);
    }

    end(reason = 'completed') {
        this.status = 'ended';
        this.clearAllTimers();
        logger.info(`Call ended: ${reason} (${this.getDurationSeconds()}s)`, { callSid: this.callSid });
    }
}

class CallManager {
    constructor() {
        this.sessions = new Map();
    }

    create(params) {
        const session = new CallSession(params);
        this.sessions.set(params.callSid, session);
        logger.info('Call session created', { callSid: params.callSid });
        return session;
    }

    get(callSid) {
        return this.sessions.get(callSid) || null;
    }

    remove(callSid) {
        const session = this.sessions.get(callSid);
        if (session) {
            session.end();
            this.sessions.delete(callSid);
            logger.info('Call session removed', { callSid });
        }
    }

    count() {
        return this.sessions.size;
    }
}

const callManager = new CallManager();
module.exports = { callManager, CallSession };