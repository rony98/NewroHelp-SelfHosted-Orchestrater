'use strict';

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

/**
 * Represents one active phone call's state.
 */
class CallSession extends EventEmitter {
    constructor({ callSid, callerPhone, assistantId, organizationId, systemPrompt, language, voice, assistantConfig, twilioAccountSid, twilioAuthToken }) {
        super();

        // Identity
        this.callSid = callSid;
        this.callerPhone = callerPhone;
        this.assistantId = assistantId;
        this.organizationId = organizationId;
        this.sessionId = uuidv4();

        // Full assistant config (tools, transfer rules, flags, etc.)
        this.assistantConfig = assistantConfig || {};

        // Twilio credentials — fetched from DB via Laravel, not from .env
        // These are per-account credentials stored in twilio_account table
        this.twilioAccountSid = twilioAccountSid;
        this.twilioAuthToken = twilioAuthToken;

        // Language + active Kokoro voice
        this.language = language || 'en';
        this.voice = voice || null; // null = GPU server uses its language default

        // Prompt
        this.systemPrompt = systemPrompt;

        // State
        this.status = 'connecting';     // connecting | active | ending | ended
        this.isSpeaking = false;
        this.isAISpeaking = false;

        // Dynamic variables extracted from custom tool responses
        this.dynamicVariables = {};

        // Audio buffer for accumulating speech between VAD events
        this.speechBuffer = [];

        // Timers
        this.silenceTimer = null;
        this.maxDurationTimer = null;
        this.startTime = Date.now();

        // References set by pipeline
        this.openaiClient = null;
        this.mediaStreamWs = null;
        this.twilioStreamSid = null;
    }

    appendSpeechBuffer(chunk) {
        this.speechBuffer.push(chunk);
    }

    flushSpeechBuffer() {
        if (this.speechBuffer.length === 0) return Buffer.alloc(0);
        const combined = Buffer.concat(this.speechBuffer);
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
            logger.info('Silence timeout - ending call', { callSid: this.callSid });
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
        // Use assistant's max_duration_seconds if set, otherwise .env default
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

/**
 * CallManager - singleton registry of all active call sessions
 */
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