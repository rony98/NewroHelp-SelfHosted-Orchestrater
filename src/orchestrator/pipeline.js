'use strict';

const axios                          = require('axios');
const OpenAIRealtimeClient           = require('../openai/realtime');
const gpuClient                      = require('../gpu/client');
const { buildTools, execute: executeFn } = require('./functions');
const { twilioMulawToPcm16, pcm16ToBase64Wav, pcm16ToTwilioMulaw } = require('../utils/audio');
const logger                         = require('../utils/logger');

const SENTENCE_RE = /[.!?]+(?:\s|$)/;
const PCM_CHUNK   = 320;

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

    mediaStreamWs.on('message', async (rawMsg) => {
        let msg;
        try { msg = JSON.parse(rawMsg); } catch { return; }

        switch (msg.event) {
            case 'start':
                session.twilioStreamSid = msg.start.streamSid;
                logger.info('Stream started', { callSid, streamSid: session.twilioStreamSid });
                if (session.assistantConfig.first_message) {
                    await speakToTwilio(session, session.assistantConfig.first_message);
                }
                break;

            case 'media':
                await handleIncomingAudio(session, msg.media.payload);
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

    logger.info('Pipeline ready', { callSid });
}

function handleIncomingAudio(session, mulawBase64) {
    if (session.status !== 'active') return;

    const mulawBuf = Buffer.from(mulawBase64, 'base64');
    const pcm16Buf = twilioMulawToPcm16(mulawBuf);
    const audioB64 = pcm16ToBase64Wav(pcm16Buf);

    gpuClient.detectVAD(audioB64, session.callSid).then(async (vadResult) => {
        if (session.status !== 'active') return;

        const { event } = vadResult;

        if (event === 'speech_start') {
            session.isSpeaking = true;
            session.clearSilenceTimer();
            if (session.isAISpeaking) interruptAI(session);
            session.appendSpeechBuffer(pcm16Buf);

        } else if (event === 'silence' && session.isSpeaking) {
            session.appendSpeechBuffer(pcm16Buf);

        } else if (event === 'speech_end') {
            session.isSpeaking = false;
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

    logger.info(`TTS called — voice: ${session.voice}, text: "${text.slice(0,50)}"`, { callSid });
    logger.info(`TTS URL: ${process.env.GPU_SERVER_URL}/tts/synthesize`, { callSid });

    try {
        const response = await axios({
            method:       'post',
            url:          `${process.env.GPU_SERVER_URL}/tts/synthesize`,
            headers:      { 'X-API-Key': process.env.GPU_SERVER_API_KEY },
            data:         { text, voice: session.voice, language: session.language, sample_rate: 16000, streaming: true },
            responseType: 'stream',
            timeout:      30000,
        });

        await new Promise((resolve, reject) => {
            let pcmBuffer = Buffer.alloc(0);

            response.data.on('data', (chunk) => {
                if (session.status === 'ending' || session.status === 'ended' || !session.isAISpeaking) {
                    response.data.destroy();
                    resolve();
                    return;
                }

                pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

                while (pcmBuffer.length >= PCM_CHUNK) {
                    const pcmSlice  = pcmBuffer.slice(0, PCM_CHUNK);
                    pcmBuffer       = pcmBuffer.slice(PCM_CHUNK);
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

                resolve();
            });

            response.data.on('error', (err) => {
                logger.error('TTS stream error', { callSid, error: err.message });
                session.isAISpeaking = false;
                reject(err);
            });
        });

    } catch (err) {
        logger.error('TTS failed', { callSid, error: err.message });
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