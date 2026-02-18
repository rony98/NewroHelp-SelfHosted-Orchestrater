'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Audio conversion utilities
//
// Sample rate notes:
//   Twilio MediaStream  →  8kHz mulaw (8-bit, G.711)
//   VAD / STT input     →  16kHz PCM16 (upsampled from Twilio via interpolation)
//   Kokoro TTS output   →  24kHz float32 (native), resampled to 8kHz by GPU
//                          server via soxr before streaming to Node.js
//   Twilio media send   →  8kHz mulaw (direct mulaw encode — no decimation here)
// ─────────────────────────────────────────────────────────────────────────────

// ─── mulaw codec ─────────────────────────────────────────────────────────────

function mulawDecode(byte) {
    byte = ~byte;
    const sign     = byte & 0x80;
    const exponent = (byte >> 4) & 0x07;
    const mantissa = byte & 0x0F;
    let   sample   = ((mantissa << 1) + 33) << exponent;
    sample -= 33;
    return sign ? -sample : sample;
}

function mulawEncode(sample) {
    const MAX  = 32767;
    const BIAS = 0x84;
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > MAX) sample = MAX;
    sample += BIAS;
    const exponent = Math.floor(Math.log(sample) / Math.log(2)) - 5;
    const mantissa = (sample >> (exponent + 1)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// ─── Twilio → VAD/STT ────────────────────────────────────────────────────────

/**
 * Convert Twilio mulaw buffer (8kHz) to PCM16 buffer (16kHz)
 * Upsample 8kHz → 16kHz via linear interpolation for VAD/STT input.
 *
 * @param {Buffer} mulawBuffer - Raw mulaw bytes from Twilio MediaStream
 * @returns {Buffer} - PCM16 LE buffer at 16kHz
 */
function twilioMulawToPcm16(mulawBuffer) {
    const pcm8k = [];

    for (let i = 0; i < mulawBuffer.length; i++) {
        pcm8k.push(mulawDecode(mulawBuffer[i]));
    }

    // Upsample 8kHz → 16kHz by linear interpolation
    const pcm16k = [];
    for (let i = 0; i < pcm8k.length - 1; i++) {
        pcm16k.push(pcm8k[i]);
        pcm16k.push(Math.round((pcm8k[i] + pcm8k[i + 1]) / 2));
    }
    pcm16k.push(pcm8k[pcm8k.length - 1]);
    pcm16k.push(pcm8k[pcm8k.length - 1]);

    const buf = Buffer.allocUnsafe(pcm16k.length * 2);
    for (let i = 0; i < pcm16k.length; i++) {
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, pcm16k[i])), i * 2);
    }
    return buf;
}

// ─── TTS → Twilio ────────────────────────────────────────────────────────────

/**
 * Convert PCM16 buffer to Twilio mulaw buffer.
 *
 * The GPU server now handles all resampling via soxr (professional-grade
 * resampler used in broadcast/DAW equipment). It streams at 8kHz PCM16
 * directly, so this function just mulaw-encodes sample by sample — no
 * decimation or filtering needed here at all.
 *
 * @param {Buffer} pcm16Buffer - PCM16 LE buffer at 8kHz (from GPU server)
 * @returns {Buffer} - Raw mulaw bytes for Twilio at 8kHz
 */
function pcm16ToTwilioMulaw(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    const mulaw   = Buffer.allocUnsafe(samples);

    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2);
        mulaw[i] = mulawEncode(sample);
    }

    return mulaw;
}

// ─── PCM ↔ WAV / base64 ──────────────────────────────────────────────────────

/**
 * Convert PCM16 buffer to base64 WAV string for GPU server endpoints.
 *
 * @param {Buffer} pcm16Buffer - PCM16 LE samples
 * @param {number} sampleRate  - Sample rate (default 16000 for VAD/STT)
 * @returns {string} - Base64 encoded WAV file
 */
function pcm16ToBase64Wav(pcm16Buffer, sampleRate = 16000) {
    const numChannels  = 1;
    const bitsPerSample = 16;
    const byteRate     = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign   = numChannels * (bitsPerSample / 8);
    const dataSize     = pcm16Buffer.length;
    const headerSize   = 44;

    const wav = Buffer.allocUnsafe(headerSize + dataSize);

    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(numChannels, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(byteRate, 28);
    wav.writeUInt16LE(blockAlign, 32);
    wav.writeUInt16LE(bitsPerSample, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(dataSize, 40);
    pcm16Buffer.copy(wav, headerSize);

    return wav.toString('base64');
}

/**
 * Convert base64 WAV/PCM from GPU server back to raw PCM16 buffer.
 *
 * @param {string} base64Audio - Base64 encoded audio from GPU server
 * @returns {Buffer} - Raw PCM16 LE buffer
 */
function base64ToPcm16(base64Audio) {
    const wavBuffer = Buffer.from(base64Audio, 'base64');
    if (wavBuffer.toString('ascii', 0, 4) === 'RIFF') {
        return wavBuffer.slice(44);
    }
    return wavBuffer;
}

/**
 * Encode PCM16 buffer to base64 string.
 */
function bufferToBase64(buffer) {
    return buffer.toString('base64');
}

module.exports = {
    twilioMulawToPcm16,
    pcm16ToTwilioMulaw,
    pcm16ToBase64Wav,
    base64ToPcm16,
    bufferToBase64,
};