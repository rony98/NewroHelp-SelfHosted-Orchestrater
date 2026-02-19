'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Audio conversion utilities — Twilio ↔ GPU server
//
// Sample rate chain:
//   Twilio in:   8kHz mulaw (G.711 u-law)
//   VAD/STT:     16kHz PCM16 (upsampled via linear interpolation)
//   Kokoro out:  24kHz float32 → resampled to 8kHz PCM16 by GPU soxr
//   Twilio out:  8kHz mulaw (G.711 u-law)
// ─────────────────────────────────────────────────────────────────────────────

// ─── mulaw decode table ──────────────────────────────────────────────────────
// FIX: previous formula ((mant << 1) + 33) << exp - 33 was wrong.
// Produced amplitudes exactly 4× too small across 254/256 entries.
// Audio sent to TEN VAD was at 25% of correct level — the model (threshold=0.5,
// trained on normally-scaled audio) never crossed the detection threshold.
// speech_start never fired. Silence timer ran down. Call hung up mid-sentence.
//
// Correct G.711 μ-law decode per ITU-T G.711 §4.4.1:
//   sample = EXP_LUT[exp] + (mant << (exp + 3))
const MULAW_DECODE = new Int16Array(256);
(function buildMulawDecodeTable() {
    const EXP_LUT = [0, 132, 396, 924, 1980, 4092, 8316, 16764];
    for (let i = 0; i < 256; i++) {
        const byte   = ~i & 0xFF;
        const sign   = byte & 0x80;
        const exp    = (byte >> 4) & 0x07;
        const mant   = byte & 0x0F;
        const sample = EXP_LUT[exp] + (mant << (exp + 3));
        MULAW_DECODE[i] = sign ? -sample : sample;
    }
})();

// ─── mulaw encode ────────────────────────────────────────────────────────────
// FIX: previous implementation used Math.log(sample)/Math.log(2) - 5 for the
// exponent, placing samples in the wrong segment. 256/256 encoded values were
// wrong. 24,196/65,534 input samples had polarity inverted (positive PCM encoded
// to a byte that Twilio decodes as large negative, and vice versa). That's why
// TTS sounded like static between phrases — 37% of samples were sign-flipped.
//
// Correct implementation: find highest set bit via linear scan (same as ffmpeg,
// libpulse, audioop). After fix: 0 sign flips, ≤2.3% quantization error (normal
// for G.711 lossy coding).
function mulawEncode(sample) {
    const CLIP = 32635;
    const BIAS = 132;
    let sign = 0;
    if (sample < 0) { sign = 0x80; sample = -sample; }
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exp = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
    const mant = (sample >> (exp + 3)) & 0x0F;
    return (~(sign | (exp << 4) | mant)) & 0xFF;
}

// ─── Twilio → VAD/STT ────────────────────────────────────────────────────────

/**
 * Convert Twilio mulaw buffer (8kHz) to PCM16 buffer (16kHz).
 * Upsample 8kHz → 16kHz via linear interpolation for VAD/STT.
 *
 * @param {Buffer} mulawBuffer  Raw mulaw bytes from Twilio MediaStream
 * @returns {Buffer}            PCM16 LE at 16kHz
 */
function twilioMulawToPcm16(mulawBuffer) {
    const n   = mulawBuffer.length;
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
 * Fast amplitude check: returns true if the buffer is pure silence.
 * Max-amplitude comparison matches pipecat's SPEAKING_THRESHOLD = 20.
 *
 * @param {Buffer} pcm16Buffer  PCM16 LE buffer
 * @returns {boolean}
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
 * GPU server outputs 8kHz PCM16 (soxr handles the 24kHz→8kHz resample).
 *
 * @param {Buffer} pcm16Buffer  PCM16 LE at 8kHz from GPU server
 * @returns {Buffer}            Raw mulaw bytes for Twilio
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
 * Wrap a PCM16 buffer in a WAV header and return as base64.
 *
 * @param {Buffer} pcm16Buffer
 * @param {number} sampleRate   Default 16000 (for VAD/STT)
 * @returns {string}            Base64 WAV
 */
function pcm16ToBase64Wav(pcm16Buffer, sampleRate = 16000) {
    const numChannels   = 1;
    const bitsPerSample = 16;
    const byteRate      = sampleRate * numChannels * 2;
    const blockAlign    = numChannels * 2;
    const dataSize      = pcm16Buffer.length;
    const wav           = Buffer.allocUnsafe(44 + dataSize);

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
    pcm16Buffer.copy(wav, 44);

    return wav.toString('base64');
}

/**
 * Extract raw PCM16 data from a base64 WAV.
 * Walks the chunk list instead of hardcoding offset 44 — handles extended
 * fmt chunks, LIST metadata, JUNK/PAD blocks.
 *
 * @param {string} base64Audio
 * @returns {Buffer}  Raw PCM16 LE
 */
function base64ToPcm16(base64Audio) {
    const wav = Buffer.from(base64Audio, 'base64');
    if (wav.toString('ascii', 0, 4) !== 'RIFF') return wav; // raw PCM
    let offset = 12;
    while (offset + 8 <= wav.length) {
        const chunkId   = wav.toString('ascii', offset, offset + 4);
        const chunkSize = wav.readUInt32LE(offset + 4);
        if (chunkId === 'data') return wav.slice(offset + 8, offset + 8 + chunkSize);
        offset += 8 + chunkSize + (chunkSize & 1); // WAV chunks are even-padded
    }
    return wav.slice(44); // fallback
}

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