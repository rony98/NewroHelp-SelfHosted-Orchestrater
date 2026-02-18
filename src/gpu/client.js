'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

const GPU_URL = process.env.GPU_SERVER_URL;
const API_KEY = process.env.GPU_SERVER_API_KEY;

// Axios instance with auth header pre-set
const gpuClient = axios.create({
    baseURL: GPU_URL,
    headers: { 'X-API-Key': API_KEY },
    timeout: 30000
});

/**
 * Detect voice activity in an audio chunk
 *
 * @param {string} audioBase64 - Base64 WAV audio at 16kHz
 * @param {string} sessionId - Call SID for stateful VAD
 * @returns {Promise<{event: string, confidence: number, timestamp: number}>}
 */
async function detectVAD(audioBase64, sessionId) {
    try {
        const { data } = await gpuClient.post('/vad/detect', {
            audio: audioBase64,
            sample_rate: 16000,
            session_id: sessionId
        });
        return data;
    } catch (err) {
        logger.error('GPU VAD error', { callSid: sessionId, error: err.message });
        throw err;
    }
}

/**
 * Transcribe speech audio to text
 *
 * @param {string} audioBase64 - Base64 WAV audio at 16kHz
 * @param {string} language - 'en' or 'es'
 * @returns {Promise<{text: string, language: string, confidence: number, processing_time_ms: number}>}
 */
async function transcribe(audioBase64, language = 'en') {
    try {
        const { data } = await gpuClient.post('/stt/transcribe', {
            audio: audioBase64,
            language,
            sample_rate: 16000
        });
        logger.info(`STT result: "${data.text}" (${data.processing_time_ms}ms)`);
        return data;
    } catch (err) {
        logger.error('GPU STT error', { error: err.message });
        throw err;
    }
}

/**
 * Synthesize text to speech - non-streaming, returns base64 audio
 *
 * @param {string} text - Text to synthesize
 * @param {string} language - 'en' or 'es'
 * @param {string|null} voice - Override voice name, or null for language default
 * @returns {Promise<{audio: string, sample_rate: number, voice_used: string, processing_time_ms: number}>}
 */
async function synthesize(text, language = 'en', voice = null) {
    try {
        const payload = { text, language, streaming: false };
        if (voice) payload.voice = voice;

        const { data } = await gpuClient.post('/tts/synthesize', payload);
        logger.info(`TTS complete: ${data.audio_duration_ms}ms audio in ${data.processing_time_ms}ms`);
        return data;
    } catch (err) {
        logger.error('GPU TTS error', { error: err.message });
        throw err;
    }
}

/**
 * Synthesize text to speech - streaming, returns readable stream of PCM chunks
 *
 * @param {string} text - Text to synthesize
 * @param {string} language - 'en' or 'es'
 * @param {string|null} voice - Override voice name
 * @returns {Promise<Stream>} - Axios response stream
 */
async function synthesizeStream(text, language = 'en', voice = null) {
    try {
        const payload = { text, language, streaming: true };
        if (voice) payload.voice = voice;

        const response = await gpuClient.post('/tts/synthesize', payload, {
            responseType: 'stream'
        });

        return response.data; // Node.js readable stream
    } catch (err) {
        logger.error('GPU TTS stream error', { error: err.message });
        throw err;
    }
}

/**
 * Reset VAD state for a session (call end / new call)
 *
 * @param {string} sessionId - Call SID
 */
async function resetVAD(sessionId) {
    try {
        await gpuClient.post(`/vad/reset?session_id=${sessionId}`);
    } catch (err) {
        // Non-critical, log and continue
        logger.warn('GPU VAD reset failed', { callSid: sessionId, error: err.message });
    }
}

/**
 * Check GPU server health
 *
 * @returns {Promise<object>} - Health metrics
 */
async function health() {
    try {
        const { data } = await gpuClient.get('/health');
        return data;
    } catch (err) {
        logger.error('GPU health check failed', { error: err.message });
        throw err;
    }
}

module.exports = { detectVAD, transcribe, synthesize, synthesizeStream, resetVAD, health };