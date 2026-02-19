'use strict';

const axios                          = require('axios');
const OpenAIRealtimeClient           = require('../openai/realtime');
const gpuClient                      = require('../gpu/client');
const { buildTools, execute: executeFn } = require('./functions');
const { twilioMulawToPcm16, pcm16ToBase64Wav, pcm16ToTwilioMulaw, isSilence } = require('../utils/audio');
const logger                         = require('../utils/logger');

// ─── Sentence chunking for TTS ────────────────────────────────────────────────
// Handles common LLM abbreviation false positives. Not as complete as NLTK
// (pipecat's approach) but avoids adding a Python dep to Node.js.
const SENTENCE_RE = /(?<![A-Z][a-z]{0,3}|\d)[.!?]+(?:\s|$)/;

// ─── VAD / speech detection constants ────────────────────────────────────────
const VAD_BATCH_CHUNKS = 10; // 10 × 20ms = 200ms per VAD call

// FIX (interrupt threshold 2→1):
// Old VAD had zero confirmation delay → a cough could instantly fire speech_start →
//   requiring 2 consecutive events (400ms window) prevented false interruptions.
// New per-session VAD state machine requires SPEECH_CONFIRM_FRAMES=12 consecutive
//   speech frames (~192ms) before emitting speech_start. That already provides the
//   false-positive protection. Keeping threshold=2 would mean 192ms + 400ms =
//   ~592ms before interrupt — noticeably laggy.
// With threshold=1: 192ms (VAD confirm) + 200ms (one batch) = ~392ms. Correct.
const INTERRUPT_THRESHOLD = 1;

const PRE_ROLL_BATCHES = 2;    // 2 × 200ms = 400ms pre-roll on speech onset
const MAX_SPEECH_MS    = 8000; // force transcription if VAD stuck hot

const laravelClient = axios.create({
    baseURL: process.env.LARAVEL_API_URL,
    headers: { 'X-Internal-Secret': process.env.LARAVEL_API_SECRET },
    timeout: 10000,
});

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

    // Attach message listener BEFORE connecting to OpenAI — the Twilio 'start'
    // event fires immediately on WS connect, before any await completes.
    const mediaQueue  = [];
    let pipelineReady = false;

    mediaStreamWs.on('message', async (rawMsg) => {
        let msg;
        try { msg = JSON.parse(rawMsg); } catch { return; }

        switch (msg.event) {
            case 'start':
                session.twilioStreamSid = msg.start.streamSid;
                logger.info('Stream started', { callSid, streamSid: session.twilioStreamSid });
                break;
            case 'media':
                if (!pipelineReady) mediaQueue.push(msg.media.payload);
                else await handleIncomingAudio(session, msg.media.payload);
                break;
            case 'stop':
                logger.info('Stream stopped', { callSid });
                await cleanup(session, 'stream_stopped');
                break;
            case 'mark':
                if (msg.mark?.name === 'ai_speech_end') {
                    session.isAISpeaking = false;
                    session.startSilenceTimer(() => endCall(session, 'no_response'));
                }
                break;
        }
    });

    // FIX: 'error' event must be handled — Node.js throws if no listener exists.
    mediaStreamWs.on('error', (err) => {
        logger.error('Twilio WS error', { callSid, error: err.message });
        cleanup(session, 'ws_error');
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

    session.openaiClient     = openaiClient;
    session.ttsBuffer        = '';
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

    openaiClient.on('error', (err) => logger.error('OpenAI error', { callSid, error: err }));

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

    pipelineReady = true;

    if (session.assistantConfig.first_message) {
        await speakToTwilio(session, session.assistantConfig.first_message);
    }

    if (mediaQueue.length > 0) {
        logger.info(`Draining ${mediaQueue.length} buffered audio chunks`, { callSid });
        for (const payload of mediaQueue) await handleIncomingAudio(session, payload);
        mediaQueue.length = 0;
    }

    logger.info('Pipeline ready', { callSid });
}

function handleIncomingAudio(session, mulawBase64) {
    if (session.status !== 'active') return;

    const mulawBuf = Buffer.from(mulawBase64, 'base64');
    const pcm16Buf = twilioMulawToPcm16(mulawBuf);

    // ── FIX: removed chunk-by-chunk speech buffer accumulation ───────────────
    // The previous code did `if (session.isSpeaking) appendSpeechBuffer(pcm16Buf)`
    // here for every 20ms chunk, then also added the full 200ms batch inside the
    // VAD speech_start handler. That caused every batch after the first to be
    // written twice: 200ms added 10× chunk-by-chunk + once as a batch = 400ms per
    // 200ms of actual speech. For a 3-batch utterance: 1400ms buffer vs 1000ms
    // actual — Whisper received 400ms of duplicate audio.
    //
    // Fix: accumulate audio ONLY via the VAD handler (batches). To preserve audio
    // that arrives during the vadInFlight drop window, we capture those batches
    // explicitly in the guard block below.

    session.vadAccumulator.push(pcm16Buf);
    if (session.vadAccumulator.length < VAD_BATCH_CHUNKS) return;

    const batch    = session.vadAccumulator.splice(0);
    const batchBuf = Buffer.concat(batch);
    const audioB64 = pcm16ToBase64Wav(batchBuf);

    // Update rolling pre-roll (last 400ms before speech onset)
    session.preRollBuffer.push(batchBuf);
    if (session.preRollBuffer.length > PRE_ROLL_BATCHES) session.preRollBuffer.shift();

    // ── FIX: silence pre-filter — only skip when NOT tracking speech ─────────
    // Previous: `if (isSilence(batchBuf)) return;`
    // Problem: the new vad.py state machine needs SPEECH_END_FRAMES=12 consecutive
    // silent batches to confirm speech_end. Skipping silent batches during active
    // speech (isSpeaking=true) prevented stop_count from incrementing → speech_end
    // never fired → buffer grew 8 seconds every turn.
    if (isSilence(batchBuf) && !session.isSpeaking) return;

    // ── VAD in-flight guard ───────────────────────────────────────────────────
    // One pending VAD request per call at a time (pipecat uses max_workers=1).
    // FIX: if speaking, capture the dropped batch so speech is gapless for Whisper.
    if (session.vadInFlight) {
        if (session.isSpeaking) session.appendSpeechBuffer(batchBuf);
        return;
    }
    session.vadInFlight = true;

    gpuClient.detectVAD(audioB64, session.callSid).then(async (vadResult) => {
        if (session.status !== 'active') return;
        const { event } = vadResult;

        if (event === 'speech_start') {
            session.speechStartCount++;

            if (!session.isSpeaking) {
                session.isSpeaking      = true;
                session.speechStartedAt = Date.now();
                session.clearSilenceTimer();
                // Pre-roll: audio from before speech_start so short words aren't clipped
                if (session.preRollBuffer.length > 0) {
                    session.appendSpeechBuffer(Buffer.concat(session.preRollBuffer));
                }
                session.appendSpeechBuffer(batchBuf);  // first batch
            } else {
                // Each subsequent batch is added here exactly once.
                // (Not at the top of handleIncomingAudio — that was the double-write.)
                session.appendSpeechBuffer(batchBuf);
            }

            if (session.speechStartCount >= INTERRUPT_THRESHOLD && session.isAISpeaking) {
                interruptAI(session);
            }

            if (session.speechStartedAt && (Date.now() - session.speechStartedAt) > MAX_SPEECH_MS) {
                logger.warn('Max speech duration reached — forcing transcription', { callSid: session.callSid });
                const speechAudio = session.flushSpeechBuffer();
                session.isSpeaking       = false;
                session.speechStartedAt  = null;
                session.speechStartCount = 0;
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

    // Guard against concurrent transcriptions
    if (session.transcribeInFlight) return;
    session.transcribeInFlight = true;

    let transcript;
    try {
        const audioB64 = pcm16ToBase64Wav(pcm16Buffer);
        const { data } = await axios.post(
            `${process.env.GPU_SERVER_URL}/stt/transcribe`,
            { audio: audioB64, language: session.language, sample_rate: 16000 },
            { headers: { 'X-API-Key': process.env.GPU_SERVER_API_KEY }, timeout: 30000 }
        );
        transcript = data.text?.trim();
    } catch (err) {
        logger.error('STT failed', { callSid, error: err.message });
        return;
    } finally {
        session.transcribeInFlight = false;
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

    // Skip empty/whitespace (LLM can return whitespace-only deltas)
    if (!text || !text.trim()) return;

    session.clearSilenceTimer();
    session.isAISpeaking = true;

    try {
        const ttsStart = Date.now();
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
            logger.info(`TTS response headers received — status: ${response.status}`, { callSid });
        } catch (err) {
            logger.error(`TTS axios error: ${err.message}`, { callSid });
            session.isAISpeaking = false;
            return;
        }

        await new Promise((resolve, reject) => {
            const TWILIO_FRAME  = 320;
            const chunks        = [];
            let   totalBytes    = 0;
            let   bytesReceived = 0;

            const flushFrames = (ws, streamSid) => {
                while (totalBytes >= TWILIO_FRAME) {
                    const frame    = Buffer.allocUnsafe(TWILIO_FRAME);
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
                            event: 'media', streamSid,
                            media: { payload: mulawSlice.toString('base64') },
                        }));
                    }
                }
            };

            let streamTimer = setTimeout(() => {
                logger.error(`TTS stream timeout after ${bytesReceived} bytes received`, { callSid });
                response.data.destroy();
                resolve();
            }, 10000);

            const done = (reason) => {
                clearTimeout(streamTimer);
                logger.info(`TTS stream ${reason} — ${bytesReceived} bytes, ${Date.now() - ttsStart}ms total`, { callSid });
                resolve();
            };

            response.data.on('data', (chunk) => {
                clearTimeout(streamTimer);
                streamTimer = setTimeout(() => {
                    logger.error(`TTS stream stalled after ${bytesReceived} bytes`, { callSid });
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
                if (totalBytes > 0) {
                    const remainder = Buffer.concat(chunks.splice(0), totalBytes);
                    if (remainder.length >= 2 && session.mediaStreamWs?.readyState === 1) {
                        const mulawSlice = pcm16ToTwilioMulaw(remainder);
                        session.mediaStreamWs.send(JSON.stringify({
                            event: 'media', streamSid: session.twilioStreamSid,
                            media: { payload: mulawSlice.toString('base64') },
                        }));
                    }
                }
                if (session.mediaStreamWs?.readyState === 1) {
                    session.mediaStreamWs.send(JSON.stringify({
                        event: 'mark', streamSid: session.twilioStreamSid,
                        mark:  { name: 'ai_speech_end' },
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
        session.mediaStreamWs.send(JSON.stringify({ event: 'clear', streamSid: session.twilioStreamSid }));
    }
    session.isAISpeaking     = false;
    session.ttsBuffer        = '';
    session.preRollBuffer    = [];
    // Reset queue so already-queued sentences don't play after the interrupt
    session.ttsSentenceQueue = Promise.resolve();
}

async function handleVoicemail(session) {
    logger.info('Voicemail detected', { callSid: session.callSid });
    const message = session.assistantConfig.voicemail_message;
    if (message) await speakToTwilio(session, message);
    await endCall(session, 'voicemail_detected');
}

async function endCall(session, reason) {
    if (session.status === 'ending' || session.status === 'ended') return;
    session.status = 'ending';
    logger.info(`Ending call: ${reason}`, { callSid: session.callSid });
    try {
        const twilio = getTwilioClient(session);
        await twilio.calls(session.callSid).update({ status: 'completed' });
    } catch (err) {
        logger.error('Twilio hangup failed', { callSid: session.callSid, error: err.message });
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
    const { callManager } = require('./callmanager'); // lazy to avoid circular dep
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