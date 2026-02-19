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

// ─── mulaw decode table ──────────────────────────────────────────────────────
// Pre-compute the full 256-entry mulaw → PCM16 lookup table at startup.
// Pipecat uses audioop.ulaw2lin (C extension). We don't have that in Node.js,
// but a lookup table is the next best thing: O(1) per sample, no branches,
// no log/exp math, no JS array allocations on the hot path.
const MULAW_DECODE = new Int16Array(256);
(function buildMulawDecodeTable() {
    for (let i = 0; i < 256; i++) {
        let byte    = ~i & 0xFF;
        const sign  = byte & 0x80;
        const exp   = (byte >> 4) & 0x07;
        const mant  = byte & 0x0F;
        let sample  = ((mant << 1) + 33) << exp;
        sample -= 33;
        MULAW_DECODE[i] = sign ? -sample : sample;
    }
})();

// ─── mulaw encode ────────────────────────────────────────────────────────────
// Kept as a function (not a table) because encode runs only on TTS output,
// which is already batched — it is not the bottleneck.
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
 * Convert Twilio mulaw buffer (8kHz) to PCM16 buffer (16kHz).
 * Upsample 8kHz → 16kHz via linear interpolation for VAD/STT input.
 *
 * Previously used push() to three intermediate JS arrays (pcm8k, pcm16k).
 * Now pre-allocates the exact output buffer and writes in-place — no GC
 * pressure on a path called ~50×/second per active call.
 *
 * @param {Buffer} mulawBuffer - Raw mulaw bytes from Twilio MediaStream
 * @returns {Buffer} - PCM16 LE buffer at 16kHz
 */
function twilioMulawToPcm16(mulawBuffer) {
    const n   = mulawBuffer.length;        // number of 8kHz samples
    const out = Buffer.allocUnsafe(n * 4); // 2× upsample × 2 bytes/sample

    let outIdx = 0;
    for (let i = 0; i < n - 1; i++) {
        const s0 = MULAW_DECODE[mulawBuffer[i]];
        const s1 = MULAW_DECODE[mulawBuffer[i + 1]];
        out.writeInt16LE(s0, outIdx);
        out.writeInt16LE(Math.round((s0 + s1) / 2), outIdx + 2);
        outIdx += 4;
    }
    // Replicate last sample at boundary
    const last = MULAW_DECODE[mulawBuffer[n - 1]];
    out.writeInt16LE(last, outIdx);
    out.writeInt16LE(last, outIdx + 2);

    return out;
}

// ─── silence pre-filter ──────────────────────────────────────────────────────

/**
 * Fast amplitude-based silence check on a PCM16 buffer.
 * Returns true if the buffer contains only silence (below threshold).
 *
 * Pipecat uses the same pattern (SPEAKING_THRESHOLD = 20 / max abs amplitude)
 * before running the Silero VAD model, eliminating the GPU HTTP call for
 * silent batches entirely. On phone calls, silence dominates — before the
 * caller speaks, between turns, hold music periods, etc.
 *
 * @param {Buffer} pcm16Buffer - PCM16 LE buffer
 * @returns {boolean} true if silent
 */
const SPEAKING_THRESHOLD = 20;
function isSilence(pcm16Buffer) {
    const samples = pcm16Buffer.length >> 1;
    for (let i = 0; i < samples; i++) {
        if (Math.abs(pcm16Buffer.readInt16LE(i * 2)) > SPEAKING_THRESHOLD) return false;
    }
    return true;
}

// ─── TTS → Twilio ────────────────────────────────────────────────────────────

/**
 * Convert PCM16 buffer to Twilio mulaw buffer.
 *
 * The GPU server handles all resampling via soxr.ResampleStream (stateful,
 * continuous filter across chunks). It streams 8kHz PCM16 directly, so
 * this function just mulaw-encodes sample by sample.
 *
 * @param {Buffer} pcm16Buffer - PCM16 LE buffer at 8kHz (from GPU server)
 * @returns {Buffer} - Raw mulaw bytes for Twilio at 8kHz
 */
function pcm16ToTwilioMulaw(pcm16Buffer) {
    const samples = pcm16Buffer.length >> 1;
    const mulaw   = Buffer.allocUnsafe(samples);

    for (let i = 0; i < samples; i++) {
        mulaw[i] = mulawEncode(pcm16Buffer.readInt16LE(i * 2));
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
    const numChannels   = 1;
    const bitsPerSample = 16;
    const byteRate      = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign    = numChannels * (bitsPerSample / 8);
    const dataSize      = pcm16Buffer.length;
    const headerSize    = 44;

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
 * Walks the WAV chunk list to find the 'data' chunk rather than hardcoding
 * offset 44. Standard WAV headers are 44 bytes, but extended fmt chunks,
 * LIST metadata, and JUNK/PAD chunks can push the data offset higher.
 * Hardcoding 44 silently returns garbage bytes in those cases.
 *
 * @param {string} base64Audio - Base64 encoded audio from GPU server
 * @returns {Buffer} - Raw PCM16 LE buffer
 */
function base64ToPcm16(base64Audio) {
    const wav = Buffer.from(base64Audio, 'base64');
    if (wav.toString('ascii', 0, 4) !== 'RIFF') {
        return wav; // not a WAV file — treat as raw PCM
    }

    // Walk chunk list starting after the RIFF header (12 bytes)
    let offset = 12;
    while (offset + 8 <= wav.length) {
        const chunkId   = wav.toString('ascii', offset, offset + 4);
        const chunkSize = wav.readUInt32LE(offset + 4);
        if (chunkId === 'data') {
            return wav.slice(offset + 8, offset + 8 + chunkSize);
        }
        // WAV chunks are padded to even byte boundaries
        offset += 8 + chunkSize + (chunkSize & 1);
    }

    return wav.slice(44); // fallback for malformed headers
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
    isSilence,
    bufferToBase64,
};