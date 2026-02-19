'use strict';

const axios                          = require('axios');
const OpenAIRealtimeClient           = require('../openai/realtime');
const gpuClient                      = require('../gpu/client');
const { buildTools, execute: executeFn } = require('./functions');
const { twilioMulawToPcm16, pcm16ToBase64Wav, pcm16ToTwilioMulaw, isSilence } = require('../utils/audio');
const logger                         = require('../utils/logger');

// Sentence boundary detection for TTS chunking.
//
// The naive regex /[.!?]+(?:\s|$)/ fires on "Mr. Smith", "3.14", "e.g. this"
// — all wrong. The improved pattern requires sentence-ending punctuation to be:
//   (a) followed by whitespace or end of string, AND
//   (b) either not a single capital-letter abbreviation (Mr/Dr/vs etc.) OR
//       followed by a lowercase word (unambiguous end).
//
// This still isn't perfect for all edge cases — NLTK is the gold standard
// (what pipecat uses) — but it eliminates the most common false positives
// from LLM output without adding a dependency.
const SENTENCE_RE = /(?<![A-Z][a-z]{0,3}|\d)[.!?]+(?:\s|$)/;

// Twilio sends 20ms mulaw chunks. Accumulate 10 chunks (200ms) per VAD call.
// Require 2 consecutive speech_start batches (400ms total) before treating
// as real speech — filters out breathing, background noise, etc.
const VAD_BATCH_CHUNKS    = 10;
const INTERRUPT_THRESHOLD = 2;

// Keep the last 2 VAD batches (400ms) as a pre-roll buffer.
// When speech_start fires, prepend this audio so we don't miss the onset
// of short utterances that began during the preceding "silent" batch.
const PRE_ROLL_BATCHES = 2;

// If the user has been speaking for longer than this without a speech_end,
// force transcription anyway. Prevents missed turns when VAD never cleanly
// emits speech_end (e.g. background noise keeps the detector hot).
const MAX_SPEECH_MS = 8000;



const laravelClient = axios.create({
    baseURL: process.env.LARAVEL_API_URL,
    headers: { 'X-Internal-Secret': process.env.LARAVEL_API_SECRET },
    timeout: 10000,
});

// ─── Twilio REST client ───────────────────────────────────────────────────────
// Each call may use different Twilio credentials (multi-tenant). We cache the
// client on the session so it's constructed once per call, not once per REST
// operation. Without caching, endCall + executeTransferToNumber each call
// require('twilio')(sid, token) rebuilding the SDK object, validators, and
// HTTP pools on every API call — wasteful during a 15ms endCall window.
function getTwilioClient(session) {
    if (!session._twilioClient) {
        const twilio = require('twilio');
        session._twilioClient = twilio(session.twilioAccountSid, session.twilioAuthToken);
    }
    return session._twilioClient;
}

async function initPipeline(session, mediaStreamWs, pipelineConfig) {
    const { callSid } = session;

    logger.info('Initializing pipeline', { callSid });

    session.mediaStreamWs = mediaStreamWs;
    session.status        = 'active';
    session.transcript    = [];

    const tools = buildTools(session.assistantConfig);
    logger.info(`Loaded ${tools.length} tools`, { callSid, tools: tools.map(t => t.name) });

    // ── Attach message listener BEFORE connecting to OpenAI ──────────────────
    // The Twilio 'start' event fires as soon as the WebSocket connects.
    // If we wait until after openaiClient.connect() to attach the listener,
    // the 'start' event arrives while we're awaiting and is silently dropped,
    // leaving session.twilioStreamSid undefined and all outbound audio ignored.
    //
    // Solution: attach the listener now, buffer 'media' events until the
    // pipeline is fully ready, then drain the buffer.
    const mediaQueue = [];
    let   pipelineReady = false;

    mediaStreamWs.on('message', async (rawMsg) => {
        let msg;
        try { msg = JSON.parse(rawMsg); } catch { return; }

        switch (msg.event) {
            case 'start':
                // Capture streamSid immediately — cannot be missed
                session.twilioStreamSid = msg.start.streamSid;
                logger.info('Stream started', { callSid, streamSid: session.twilioStreamSid });
                break;

            case 'media':
                if (!pipelineReady) {
                    mediaQueue.push(msg.media.payload);
                } else {
                    await handleIncomingAudio(session, msg.media.payload);
                }
                break;

            case 'stop':
                logger.info('Stream stopped', { callSid });
                await cleanup(session, 'stream_stopped');
                break;

            case 'mark':
                if (msg.mark?.name === 'ai_speech_end') {
                    session.isAISpeaking = false;
                    // AI finished speaking — restart the silence timer so we
                    // detect if the user goes quiet without responding.
                    // (The timer was cleared in speakToTwilio to prevent it
                    // from firing during AI playback.)
                    session.startSilenceTimer(() => endCall(session, 'no_response'));
                }
                break;
        }
    });

    mediaStreamWs.on('close', () => {
        logger.info('Twilio WS closed', { callSid });
        cleanup(session, 'ws_closed');
    });

    const openaiClient = new OpenAIRealtimeClient(callSid, {
        systemPrompt: pipelineConfig.systemPrompt,
        tools,
        language: session.language,
    });

    session.openaiClient    = openaiClient;
    session.ttsBuffer       = '';
    session.ttsSentenceQueue = Promise.resolve();

    await openaiClient.connect();

    openaiClient.on('text_delta', (token) => {
        if (!token || session.status === 'ending' || session.status === 'ended') return;

        session.ttsBuffer += token;

        if (SENTENCE_RE.test(session.ttsBuffer)) {
            const sentence = session.ttsBuffer.trim();
            session.ttsBuffer = '';

            session.ttsSentenceQueue = session.ttsSentenceQueue.then(async () => {
                if (session.status === 'ending' || session.status === 'ended') return;
                session.transcript.push({ role: 'agent', message: sentence, time_in_call_secs: session.getDurationSeconds() });
                logger.info(`AI (sentence): "${sentence.slice(0, 80)}"`, { callSid });
                await speakToTwilio(session, sentence);
            });
        }
    });

    openaiClient.on('text_done', (fullText) => {
        if (!session.ttsBuffer.trim()) return;
        if (session.status === 'ending' || session.status === 'ended') return;

        const remainder = session.ttsBuffer.trim();
        session.ttsBuffer = '';

        session.ttsSentenceQueue = session.ttsSentenceQueue.then(async () => {
            if (session.status === 'ending' || session.status === 'ended') return;
            session.transcript.push({ role: 'agent', message: remainder, time_in_call_secs: session.getDurationSeconds() });
            logger.info(`AI (tail): "${remainder.slice(0, 80)}"`, { callSid });
            await speakToTwilio(session, remainder);
        });
    });

    openaiClient.on('function_call', async ({ call_id, name, args }) => {
        logger.info(`Function call: ${name}`, { callSid, args });
        try {
            const result = await executeFn(name, args, session);
            openaiClient.sendFunctionResult(call_id, result);
        } catch (err) {
            logger.error(`Function ${name} failed`, { callSid, error: err.message });
            openaiClient.sendFunctionResult(call_id, { error: err.message });
        }
    });

    openaiClient.on('error', (err) => {
        logger.error('OpenAI error', { callSid, error: err });
    });

    session.on('end_call_requested',  async (reason)       => endCall(session, reason));
    session.on('voicemail_requested', async ()             => handleVoicemail(session));
    session.on('transfer_to_number',  async (transferData) => executeTransferToNumber(session, transferData));
    session.on('transfer_to_agent',   async (transferData) => executeTransferToAgent(session, transferData));
    session.on('language_switched', ({ language, voice }) => {
        session.language = language;
        session.voice    = voice;
        logger.info(`Language switched to ${language}, voice ${voice}`, { callSid });
    });

    session.startMaxDurationTimer(() => endCall(session, 'max_duration'));
    session.startSilenceTimer(() => endCall(session, 'no_response'));

    // ── Pipeline is ready — drain buffered media and speak first message ───────
    pipelineReady = true;

    if (session.assistantConfig.first_message) {
        await speakToTwilio(session, session.assistantConfig.first_message);
    }

    // Drain any media chunks that arrived while OpenAI was connecting
    if (mediaQueue.length > 0) {
        logger.info(`Draining ${mediaQueue.length} buffered audio chunks`, { callSid });
        for (const payload of mediaQueue) {
            await handleIncomingAudio(session, payload);
        }
        mediaQueue.length = 0;
    }

    logger.info('Pipeline ready', { callSid });
}

function handleIncomingAudio(session, mulawBase64) {
    if (session.status !== 'active') return;

    // Decode and convert this chunk
    const mulawBuf = Buffer.from(mulawBase64, 'base64');
    const pcm16Buf = twilioMulawToPcm16(mulawBuf);

    // Always accumulate into speech buffer when speaking (before VAD fires)
    // so we don't lose audio during the batching window
    if (session.isSpeaking) {
        session.appendSpeechBuffer(pcm16Buf);
    }

    // Accumulate chunks for VAD batching
    if (!session.vadAccumulator) session.vadAccumulator = [];
    session.vadAccumulator.push(pcm16Buf);

    // Only call VAD once we have enough audio (200ms = 10 x 20ms chunks)
    if (session.vadAccumulator.length < VAD_BATCH_CHUNKS) return;

    // Grab the batch and reset accumulator immediately so next chunks start fresh
    const batch     = session.vadAccumulator;
    session.vadAccumulator = [];
    const batchBuf  = Buffer.concat(batch);
    const audioB64  = pcm16ToBase64Wav(batchBuf);

    // Maintain a rolling pre-roll buffer of the last PRE_ROLL_BATCHES batches.
    // When speech_start fires we prepend this so the onset of the utterance
    // isn't clipped — critical for short words like "yes", "okay", "no".
    if (!session.preRollBuffer) session.preRollBuffer = [];
    session.preRollBuffer.push(batchBuf);
    if (session.preRollBuffer.length > PRE_ROLL_BATCHES) {
        session.preRollBuffer.shift();
    }

    // ── Silence pre-filter ────────────────────────────────────────────────────
    // Skip GPU VAD call entirely if the batch is pure silence.
    // Pipecat uses the same max-amplitude check (threshold = 20) before running
    // the Silero model. On phone calls silence is the majority of audio time —
    // before the caller speaks, between turns, hold periods — so this eliminates
    // most HTTP calls to the GPU server for free.
    if (isSilence(batchBuf)) return;

    // ── VAD in-flight guard ───────────────────────────────────────────────────
    // Allow only one pending VAD request per call at a time (serialized).
    // Without this, if the GPU is under load a backlog of concurrent requests
    // can build up and resolve out of order, causing stale speech_end events
    // that flush the buffer prematurely or trigger double transcriptions.
    // Pipecat enforces this via ThreadPoolExecutor(max_workers=1) per stream.
    if (session.vadInFlight) return;
    session.vadInFlight = true;

    gpuClient.detectVAD(audioB64, session.callSid).then(async (vadResult) => {
        if (session.status !== 'active') return;

        const { event } = vadResult;

        if (event === 'speech_start') {
            session.speechStartCount = (session.speechStartCount || 0) + 1;

            if (!session.isSpeaking) {
                session.isSpeaking      = true;
                session.speechStartedAt = Date.now();
                session.clearSilenceTimer();

                // Prepend pre-roll so we capture the onset of this utterance.
                // The pre-roll contains the batches just before speech_start
                // fired, including any partial speech at the tail of "silence".
                if (session.preRollBuffer?.length > 0) {
                    const preRoll = Buffer.concat(session.preRollBuffer);
                    session.appendSpeechBuffer(preRoll);
                }
            }
            session.appendSpeechBuffer(batchBuf);

            // Only interrupt the AI after INTERRUPT_THRESHOLD consecutive detections
            // — prevents breathing/noise from cutting off AI speech
            if (session.speechStartCount >= INTERRUPT_THRESHOLD && session.isAISpeaking) {
                interruptAI(session);
            }

            // Force transcription if the user has been "speaking" too long
            // without a speech_end. This fires when VAD stays hot due to
            // background noise, echo, or a very long utterance.
            if (session.speechStartedAt && (Date.now() - session.speechStartedAt) > MAX_SPEECH_MS) {
                logger.warn('Max speech duration reached — forcing transcription', { callSid: session.callSid });
                session.isSpeaking       = false;
                session.speechStartedAt  = null;
                session.speechStartCount = 0;
                const speechAudio = session.flushSpeechBuffer();
                if (speechAudio.length > 0) await transcribeAndRespond(session, speechAudio);
            }

        } else if (event === 'silence') {
            session.speechStartCount = 0;

        } else if (event === 'speech_end') {
            session.speechStartCount = 0;
            session.isSpeaking       = false;
            session.speechStartedAt  = null;
            const speechAudio = session.flushSpeechBuffer();
            if (speechAudio.length > 0) await transcribeAndRespond(session, speechAudio);
            session.startSilenceTimer(() => endCall(session, 'no_response'));
        }
    }).catch(() => {}).finally(() => {
        session.vadInFlight = false;
    });
}

async function transcribeAndRespond(session, pcm16Buffer) {
    const { callSid } = session;

    let transcript;
    try {
        const audioB64 = pcm16ToBase64Wav(pcm16Buffer);
        // Use /stt/transcribe rather than /process/audio.
        // We only call this function at speech_end — VAD has already determined
        // this is speech. /process/audio runs the Silero model again on the full
        // buffer (needlessly, ~20–50ms of wasted GPU time), then runs Whisper.
        // /stt/transcribe skips the VAD pass and goes directly to Whisper.
        const { data } = await axios.post(
            `${process.env.GPU_SERVER_URL}/stt/transcribe`,
            { audio: audioB64, language: session.language, sample_rate: 16000 },
            { headers: { 'X-API-Key': process.env.GPU_SERVER_API_KEY }, timeout: 30000 }
        );
        transcript = data.text?.trim();
    } catch (err) {
        logger.error('STT failed', { callSid, error: err.message });
        return;
    }

    if (!transcript) return;

    logger.info(`User: "${transcript.slice(0, 100)}"`, { callSid });
    session.transcript.push({ role: 'user', message: transcript, time_in_call_secs: session.getDurationSeconds() });

    try {
        session.openaiClient.sendUserMessage(transcript);
    } catch (err) {
        logger.error('OpenAI send failed', { callSid, error: err.message });
    }
}

async function speakToTwilio(session, text) {
    const { callSid } = session;

    // Pause the silence timer while the AI is speaking.
    // Without this, the silence timer (which counts down from the last user
    // utterance) can fire mid-response and terminate the call — particularly
    // dangerous for short silence timeouts with long AI responses.
    // The timer is restarted when Twilio confirms AI speech is done (mark event).
    session.clearSilenceTimer();
    session.isAISpeaking = true;

    try {
        const ttsStart = Date.now();

        // Step 1: make the request — responseType:'stream' resolves as soon as
        // response headers arrive, before any body data flows
        let response;
        try {
            response = await axios({
                method:       'post',
                url:          `${process.env.GPU_SERVER_URL}/tts/synthesize`,
                headers:      { 'X-API-Key': process.env.GPU_SERVER_API_KEY },
                data:         { text, voice: session.voice, language: session.language, streaming: true },
                responseType: 'stream',
                timeout:      15000,
            });
            // GPU server resamples Kokoro 24kHz → 8kHz via soxr before streaming.
            // X-Sample-Rate will always be 8000. Node.js just mulaw-encodes directly.
            logger.info(`TTS response headers received — status: ${response.status}`, { callSid });
        } catch (err) {
            logger.error(`TTS axios error: ${err.message}`, { callSid });
            session.isAISpeaking = false;
            return;
        }

        // Step 2: consume the stream
        await new Promise((resolve, reject) => {
            // Accumulate incoming data as a list of chunks, slice off 320-byte
            // Twilio frames as they become available.
            //
            // Previous pattern: pcmBuffer = Buffer.concat([pcmBuffer, chunk])
            // on every data event. Each call copies the entire existing buffer
            // into a new allocation — O(n²) over the life of the stream.
            //
            // New pattern: push chunks into an array, track total bytes, only
            // concat when we have enough for a complete Twilio frame. GC sees
            // at most one allocation per 320-byte output frame instead of one
            // per incoming network packet.
            const TWILIO_FRAME = 320; // 160 samples × 2 bytes = 20ms at 8kHz
            const chunks       = [];
            let   totalBytes   = 0;
            let   bytesReceived = 0;

            const flushFrames = (ws, streamSid) => {
                while (totalBytes >= TWILIO_FRAME) {
                    // Assemble exactly one frame from the chunk list
                    const frame = Buffer.allocUnsafe(TWILIO_FRAME);
                    let   framePos = 0;
                    while (framePos < TWILIO_FRAME) {
                        const head = chunks[0];
                        const need = TWILIO_FRAME - framePos;
                        if (head.length <= need) {
                            head.copy(frame, framePos);
                            framePos   += head.length;
                            totalBytes -= head.length;
                            chunks.shift();
                        } else {
                            head.copy(frame, framePos, 0, need);
                            chunks[0]   = head.slice(need);
                            totalBytes -= need;
                            framePos    = TWILIO_FRAME;
                        }
                    }
                    const mulawSlice = pcm16ToTwilioMulaw(frame);
                    if (ws?.readyState === 1) {
                        ws.send(JSON.stringify({
                            event:     'media',
                            streamSid,
                            media:     { payload: mulawSlice.toString('base64') },
                        }));
                    }
                }
            };

            // Safety net: if stream goes silent for 10s, bail out
            let streamTimer = setTimeout(() => {
                logger.error(`TTS stream timeout after ${bytesReceived} bytes received`, { callSid });
                response.data.destroy();
                resolve(); // resolve not reject — partial audio is fine
            }, 10000);

            const done = (reason) => {
                clearTimeout(streamTimer);
                logger.info(`TTS stream ${reason} — ${bytesReceived} bytes, ${Date.now() - ttsStart}ms total`, { callSid });
                resolve();
            };

            response.data.on('data', (chunk) => {
                clearTimeout(streamTimer);
                streamTimer = setTimeout(() => {
                    logger.error(`TTS stream stalled mid-stream after ${bytesReceived} bytes`, { callSid });
                    response.data.destroy();
                    resolve();
                }, 10000);

                if (session.status === 'ending' || session.status === 'ended' || !session.isAISpeaking) {
                    response.data.destroy();
                    clearTimeout(streamTimer);
                    resolve();
                    return;
                }

                bytesReceived += chunk.length;
                if (bytesReceived === chunk.length) {
                    const header = chunk.slice(0, 16).toString('hex').match(/../g).join(' ');
                    logger.info(`TTS first chunk — ${chunk.length} bytes, ${Date.now() - ttsStart}ms, header: ${header}`, { callSid });
                }

                chunks.push(chunk);
                totalBytes += chunk.length;
                flushFrames(session.mediaStreamWs, session.twilioStreamSid);
            });

            response.data.on('end', () => {
                // Flush any remaining bytes (< 320) as a final partial frame
                if (totalBytes > 0) {
                    const remainder = Buffer.concat(chunks.splice(0), totalBytes);
                    if (remainder.length >= 2 && session.mediaStreamWs?.readyState === 1) {
                        const mulawSlice = pcm16ToTwilioMulaw(remainder);
                        session.mediaStreamWs.send(JSON.stringify({
                            event:     'media',
                            streamSid: session.twilioStreamSid,
                            media:     { payload: mulawSlice.toString('base64') },
                        }));
                    }
                }

                if (session.mediaStreamWs?.readyState === 1) {
                    session.mediaStreamWs.send(JSON.stringify({
                        event:     'mark',
                        streamSid: session.twilioStreamSid,
                        mark:      { name: 'ai_speech_end' },
                    }));
                }

                done('ended');
            });

            response.data.on('error', (err) => {
                clearTimeout(streamTimer);
                logger.error(`TTS stream error: ${err.message}`, { callSid });
                session.isAISpeaking = false;
                reject(err);
            });
        });

    } catch (err) {
        logger.error(`TTS failed: ${err.message}`, { callSid });
        session.isAISpeaking = false;
    }
}

function interruptAI(session) {
    logger.info('User interrupted AI', { callSid: session.callSid });
    if (session.openaiClient) session.openaiClient.cancelResponse();
    if (session.mediaStreamWs?.readyState === 1) {
        session.mediaStreamWs.send(JSON.stringify({
            event:     'clear',
            streamSid: session.twilioStreamSid,
        }));
    }
    session.isAISpeaking    = false;
    session.ttsBuffer       = '';
    session.preRollBuffer   = [];

    // Reset the sentence queue so already-queued sentences don't play after
    // the interrupt. Without this, any sentences that were chained onto
    // ttsSentenceQueue before the interrupt fire complete after the Twilio
    // 'clear' event, making it sound like the AI ignored the interruption.
    session.ttsSentenceQueue = Promise.resolve();
}

async function handleVoicemail(session) {
    const { callSid } = session;
    logger.info('Voicemail detected', { callSid });

    const message = session.assistantConfig.voicemail_message;
    if (message) {
        await speakToTwilio(session, message);
    }

    await endCall(session, 'voicemail_detected');
}

async function endCall(session, reason) {
    const { callSid } = session;
    if (session.status === 'ending' || session.status === 'ended') return;

    session.status = 'ending';
    logger.info(`Ending call: ${reason}`, { callSid });

    try {
        const twilio = getTwilioClient(session);
        await twilio.calls(callSid).update({ status: 'completed' });
    } catch (err) {
        logger.error('Twilio hangup failed', { callSid, error: err.message });
    } finally {
        await cleanup(session, reason);
    }
}

async function executeTransferToNumber(session, transferData) {
    const { callSid } = session;
    logger.info(`Transferring to number: ${transferData.phone_number}`, { callSid });

    try {
        if (transferData.enable_client_message && transferData.transfer_message) {
            await speakToTwilio(session, transferData.transfer_message);
        }

        const twilio = getTwilioClient(session);
        const twiml  = transferData.transfer_type === 'sip_refer'
            ? `<Response><Dial><Sip>${transferData.phone_number}</Sip></Dial></Response>`
            : `<Response><Dial><Number>${transferData.phone_number}</Number></Dial></Response>`;

        await twilio.calls(callSid).update({ twiml });
        await cleanup(session, 'transferred_to_number');
    } catch (err) {
        logger.error('Transfer to number failed', { callSid, error: err.message });
    }
}

async function executeTransferToAgent(session, transferData) {
    const { callSid } = session;
    logger.info(`Transferring to agent: ${transferData.agent_id}`, { callSid });

    try {
        if (transferData.enable_client_message && transferData.transfer_message) {
            await speakToTwilio(session, transferData.transfer_message);
        }

        const { data } = await laravelClient.get(`/calls/${callSid}/transfer-agent`, {
            params: { agent_id: transferData.agent_id },
        });

        const twilio = getTwilioClient(session);
        await twilio.calls(callSid).update({ url: data.twiml_url });
        await cleanup(session, 'transferred_to_agent');
    } catch (err) {
        logger.error('Transfer to agent failed', { callSid, error: err.message });
    }
}

async function cleanup(session, reason = 'completed') {
    if (session.status === 'ended') return;

    const { callSid } = session;
    session.end(reason);

    if (session.openaiClient) session.openaiClient.disconnect();

    try { await gpuClient.resetVAD(callSid); } catch {}

    await postCallComplete(session, reason);

    const { callManager } = require('./callmanager');
    callManager.remove(callSid);

    logger.info('Pipeline cleaned up', { callSid, reason });
}

async function postCallComplete(session, endReason) {
    const { callSid } = session;

    try {
        await laravelClient.post(`/calls/${callSid}/complete`, {
            call_sid:          callSid,
            assistant_id:      session.assistantConfig.assistant_id,
            organization_id:   session.assistantConfig.organization_id,
            status:            'done',
            end_reason:        endReason,
            duration_seconds:  session.getDurationSeconds(),
            transcript:        session.transcript || [],
            dynamic_variables: session.dynamicVariables || {},
        });

        logger.info('Post-call data sent to Laravel', { callSid });
    } catch (err) {
        logger.error('Failed to POST call complete to Laravel', { callSid, error: err.message });
    }
}

module.exports = { initPipeline };