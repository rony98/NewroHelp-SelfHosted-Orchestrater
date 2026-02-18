'use strict';

/**
 * Audio conversion utilities
 * Twilio uses mulaw 8kHz, GPU server expects PCM 16kHz
 */

/**
 * Decode mulaw (u-law) encoded byte to linear PCM sample
 */
function mulawDecode(mulawByte) {
    mulawByte = ~mulawByte;
    const sign = mulawByte & 0x80;
    const exponent = (mulawByte >> 4) & 0x07;
    const mantissa = mulawByte & 0x0F;
    let sample = ((mantissa << 1) + 33) << exponent;
    sample -= 33;
    return sign ? -sample : sample;
}

/**
 * Encode linear PCM sample to mulaw (u-law) byte
 */
function mulawEncode(sample) {
    const MAX = 32767;
    const BIAS = 0x84;
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > MAX) sample = MAX;
    sample += BIAS;
    const exponent = Math.floor(Math.log(sample) / Math.log(2)) - 5;
    const mantissa = (sample >> (exponent + 1)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

/**
 * Convert Twilio mulaw buffer (8kHz) to PCM16 buffer (16kHz)
 * Upsample 8kHz → 16kHz by linear interpolation
 *
 * @param {Buffer} mulawBuffer - Raw mulaw bytes from Twilio MediaStream
 * @returns {Buffer} - PCM16 LE buffer at 16kHz
 */
function twilioMulawToPcm16(mulawBuffer) {
    const pcm8k = [];

    // Step 1: mulaw → linear PCM at 8kHz
    for (let i = 0; i < mulawBuffer.length; i++) {
        pcm8k.push(mulawDecode(mulawBuffer[i]));
    }

    // Step 2: upsample 8kHz → 16kHz (linear interpolation)
    const pcm16k = [];
    for (let i = 0; i < pcm8k.length - 1; i++) {
        pcm16k.push(pcm8k[i]);
        // Interpolate midpoint
        pcm16k.push(Math.round((pcm8k[i] + pcm8k[i + 1]) / 2));
    }
    pcm16k.push(pcm8k[pcm8k.length - 1]);
    pcm16k.push(pcm8k[pcm8k.length - 1]); // duplicate last sample

    // Step 3: write as Int16LE buffer
    const buf = Buffer.allocUnsafe(pcm16k.length * 2);
    for (let i = 0; i < pcm16k.length; i++) {
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, pcm16k[i])), i * 2);
    }
    return buf;
}

/**
 * Convert PCM16 buffer (16kHz) to Twilio mulaw buffer (8kHz)
 * Downsample 16kHz → 8kHz by taking every other sample
 *
 * @param {Buffer} pcm16Buffer - PCM16 LE buffer at 16kHz
 * @returns {Buffer} - Raw mulaw bytes for Twilio
 */
function pcm16ToTwilioMulaw(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    const mulaw = [];

    for (let i = 0; i < samples; i += 2) { // take every other sample (downsample 16k→8k)
        const sample = pcm16Buffer.readInt16LE(i * 2);
        mulaw.push(mulawEncode(sample));
    }

    return Buffer.from(mulaw);
}

/**
 * Convert PCM16 buffer to base64 WAV string for GPU server
 *
 * @param {Buffer} pcm16Buffer - PCM16 LE samples
 * @param {number} sampleRate - Sample rate (default 16000)
 * @returns {string} - Base64 encoded WAV file
 */
function pcm16ToBase64Wav(pcm16Buffer, sampleRate = 16000) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcm16Buffer.length;
    const headerSize = 44;

    const wav = Buffer.allocUnsafe(headerSize + dataSize);

    // RIFF header
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write('WAVE', 8);

    // fmt chunk
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);              // chunk size
    wav.writeUInt16LE(1, 20);               // PCM format
    wav.writeUInt16LE(numChannels, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(byteRate, 28);
    wav.writeUInt16LE(blockAlign, 32);
    wav.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    wav.write('data', 36);
    wav.writeUInt32LE(dataSize, 40);
    pcm16Buffer.copy(wav, headerSize);

    return wav.toString('base64');
}

/**
 * Convert base64 WAV/PCM from GPU server back to raw PCM16 buffer
 *
 * @param {string} base64Audio - Base64 encoded audio from GPU server
 * @returns {Buffer} - Raw PCM16 LE buffer
 */
function base64ToPcm16(base64Audio) {
    const wavBuffer = Buffer.from(base64Audio, 'base64');

    // Check for WAV header and strip it
    if (wavBuffer.toString('ascii', 0, 4) === 'RIFF') {
        const dataOffset = 44; // standard WAV header size
        return wavBuffer.slice(dataOffset);
    }

    // Raw PCM - return as-is
    return wavBuffer;
}

/**
 * Encode PCM16 buffer to base64 string (for sending to GPU server)
 */
function bufferToBase64(buffer) {
    return buffer.toString('base64');
}

module.exports = {
    twilioMulawToPcm16,
    pcm16ToTwilioMulaw,
    pcm16ToBase64Wav,
    base64ToPcm16,
    bufferToBase64
};