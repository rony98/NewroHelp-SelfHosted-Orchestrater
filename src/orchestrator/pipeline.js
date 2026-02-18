'use strict';

const axios                          = require('axios');
const OpenAIRealtimeClient           = require('../openai/realtime');
const gpuClient                      = require('../gpu/client');
const { buildTools, execute: executeFn } = require('./functions');
const { twilioMulawToPcm16, pcm16ToBase64Wav, pcm16ToTwilioMulaw } = require('../utils/audio');
const logger                         = require('../utils/logger');

const SENTENCE_RE = /[.!?]+(?:\s|$)/;
const PCM_CHUNK   = 320;

// Twilio sends 20ms mulaw chunks. VAD needs ~100ms of audio for reliable
// speech detection. Accumulate 5 chunks (100ms) before each VAD call.
const VAD_BATCH_CHUNKS = 5;

const laravelClient = axios.create({
    baseURL: process.env.LARAVEL_API_URL,
    headers: { 'X-Internal-Secret': process.env.LARAVEL_API_SECRET },
    timeout: 10000,
});

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
                if (msg.mark?.name === 'ai_speech_end') session.isAISpeaking = false;
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

    // Only call VAD once we have enough audio (100ms = 5 x 20ms chunks)
    if (session.vadAccumulator.length < VAD_BATCH_CHUNKS) return;

    // Grab the batch and reset accumulator immediately so next chunks start fresh
    const batch     = session.vadAccumulator;
    session.vadAccumulator = [];
    const batchBuf  = Buffer.concat(batch);
    const audioB64  = pcm16ToBase64Wav(batchBuf);

    gpuClient.detectVAD(audioB64, session.callSid).then(async (vadResult) => {
        if (session.status !== 'active') return;

        const { event } = vadResult;

        if (event === 'speech_start') {
            session.isSpeaking = true;
            session.clearSilenceTimer();
            if (session.isAISpeaking) interruptAI(session);
            // batchBuf already covers these chunks - add it to speech buffer
            if (!session.isSpeakingBuffered) {
                session.appendSpeechBuffer(batchBuf);
                session.isSpeakingBuffered = true;
            }

        } else if (event === 'silence') {
            session.isSpeakingBuffered = false;
            if (!session.isSpeaking) {
                // True silence - nothing buffered
            }

        } else if (event === 'speech_end') {
            session.isSpeaking        = false;
            session.isSpeakingBuffered = false;
            const speechAudio = session.flushSpeechBuffer();
            if (speechAudio.length > 0) await transcribeAndRespond(session, speechAudio);
            session.startSilenceTimer(() => endCall(session, 'no_response'));
        }
    }).catch(() => {});
}

async function transcribeAndRespond(session, pcm16Buffer) {
    const { callSid } = session;

    let transcript;
    try {
        const audioB64 = pcm16ToBase64Wav(pcm16Buffer);
        const { data } = await axios.post(
            `${process.env.GPU_SERVER_URL}/process/audio`,
            { audio: audioB64, language: session.language, sample_rate: 16000, session_id: callSid },
            { headers: { 'X-API-Key': process.env.GPU_SERVER_API_KEY }, timeout: 30000 }
        );
        transcript = data.transcript?.trim();
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
                data:         { text, voice: session.voice, language: session.language, sample_rate: 16000, streaming: true },
                responseType: 'stream',
                timeout:      15000,
            });
            logger.info(`TTS response headers received — status: ${response.status}`, { callSid });
        } catch (err) {
            logger.error(`TTS axios error: ${err.message}`, { callSid });
            session.isAISpeaking = false;
            return;
        }

        // Step 2: consume the stream
        await new Promise((resolve, reject) => {
            let pcmBuffer    = Buffer.alloc(0);
            let bytesReceived = 0;

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
                    logger.info(`TTS first chunk received — ${chunk.length} bytes, ${Date.now() - ttsStart}ms`, { callSid });
                }

                pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

                while (pcmBuffer.length >= PCM_CHUNK) {
                    const pcmSlice   = pcmBuffer.slice(0, PCM_CHUNK);
                    pcmBuffer        = pcmBuffer.slice(PCM_CHUNK);
                    const mulawSlice = pcm16ToTwilioMulaw(pcmSlice);

                    if (session.mediaStreamWs?.readyState === 1) {
                        session.mediaStreamWs.send(JSON.stringify({
                            event:     'media',
                            streamSid: session.twilioStreamSid,
                            media:     { payload: mulawSlice.toString('base64') },
                        }));
                    }
                }
            });

            response.data.on('end', () => {
                // Flush remaining bytes
                if (pcmBuffer.length > 0 && session.mediaStreamWs?.readyState === 1) {
                    const mulawSlice = pcm16ToTwilioMulaw(pcmBuffer);
                    session.mediaStreamWs.send(JSON.stringify({
                        event:     'media',
                        streamSid: session.twilioStreamSid,
                        media:     { payload: mulawSlice.toString('base64') },
                    }));
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
    session.isAISpeaking = false;
    session.ttsBuffer    = '';
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
        const twilio = require('twilio')(session.twilioAccountSid, session.twilioAuthToken);
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

        const twilio = require('twilio')(session.twilioAccountSid, session.twilioAuthToken);
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

        const twilio = require('twilio')(session.twilioAccountSid, session.twilioAuthToken);
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