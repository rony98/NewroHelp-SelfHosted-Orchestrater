'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');

const GPU_URL = process.env.GPU_SERVER_URL;
const API_KEY = process.env.GPU_SERVER_API_KEY;

// ── FIX: per-endpoint timeouts ────────────────────────────────────────────────
// Previous code used a single axios instance with timeout=30000 for ALL requests.
// The problem: VAD is called ~5× per second per active call. If it's slow, you
// want to fail fast and drop that batch (the vadInFlight guard will skip it
// anyway). A 30-second timeout means a hung VAD request blocks the in-flight
// slot for 30 seconds — effectively killing speech detection for an entire call.
//
// Correct timeouts by endpoint:
//   VAD:  2s  — should complete in <100ms; anything over 1s indicates GPU issues
//   STT:  20s — Whisper on a long utterance (8s audio) takes 300–800ms; keep
//               generous headroom for cold-start or high load
//   TTS:  15s — streaming; this is the axios connection timeout, not stream timeout
//               (stream timeout is handled by the 10s idle timer in pipeline.js)
//   misc: 5s  — health, VAD reset — simple, should be instant

const gpuHttp = axios.create({
    baseURL: GPU_URL,
    headers: { 'X-API-Key': API_KEY },
});

async function detectVAD(audioBase64, sessionId) {
    try {
        const { data } = await gpuHttp.post('/vad/detect', {
            audio:       audioBase64,
            sample_rate: 16000,
            session_id:  sessionId,
        }, { timeout: 2000 });
        return data;
    } catch (err) {
        logger.error('GPU VAD error', { callSid: sessionId, error: err.message });
        throw err;
    }
}

async function transcribe(audioBase64, language = 'en') {
    try {
        const { data } = await gpuHttp.post('/stt/transcribe', {
            audio:       audioBase64,
            language,
            sample_rate: 16000,
        }, { timeout: 20000 });
        logger.info(`STT result: "${data.text}" (${data.processing_time_ms}ms)`);
        return data;
    } catch (err) {
        logger.error('GPU STT error', { error: err.message });
        throw err;
    }
}

async function synthesize(text, language = 'en', voice = null) {
    try {
        const payload = { text, language, streaming: false };
        if (voice) payload.voice = voice;
        const { data } = await gpuHttp.post('/tts/synthesize', payload, { timeout: 15000 });
        logger.info(`TTS complete: ${data.audio_duration_ms}ms audio in ${data.processing_time_ms}ms`);
        return data;
    } catch (err) {
        logger.error('GPU TTS error', { error: err.message });
        throw err;
    }
}

async function synthesizeStream(text, language = 'en', voice = null) {
    try {
        const payload = { text, language, streaming: true };
        if (voice) payload.voice = voice;
        const response = await gpuHttp.post('/tts/synthesize', payload, {
            responseType: 'stream',
            timeout:      15000,
        });
        return response.data;
    } catch (err) {
        logger.error('GPU TTS stream error', { error: err.message });
        throw err;
    }
}

async function resetVAD(sessionId) {
    try {
        await gpuHttp.post(`/vad/reset?session_id=${sessionId}`, {}, { timeout: 5000 });
    } catch (err) {
        logger.warn('GPU VAD reset failed', { callSid: sessionId, error: err.message });
    }
}

async function health() {
    try {
        const { data } = await gpuHttp.get('/health', { timeout: 5000 });
        return data;
    } catch (err) {
        logger.error('GPU health check failed', { error: err.message });
        throw err;
    }
}

module.exports = { detectVAD, transcribe, synthesize, synthesizeStream, resetVAD, health };