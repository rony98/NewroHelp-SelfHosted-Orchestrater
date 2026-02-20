'use strict';

const axios                          = require('axios');
const OpenAIRealtimeClient           = require('../openai/realtime');
const gpuClient                      = require('../gpu/client');
const { checkTurnComplete }          = gpuClient;
const { buildTools, execute: executeFn } = require('./functions');
const { twilioMulawToPcm16, pcm16ToBase64Wav, pcm16ToTwilioMulaw, isSilence } = require('../utils/audio');
const logger                         = require('../utils/logger');

// ─── Fast interrupt threshold ─────────────────────────────────────────────────
// When AI is speaking, we bypass the VAD state machine confirmation window and
// trigger interrupt directly from raw probability. A single 200ms batch with
// probability >= this threshold is enough to interrupt. Short words ("stop",
// "wait", "no") register easily at >= 0.6 even over PSTN noise.
// Only active when session.isAISpeaking=true — no false triggers during silence.
const FAST_INTERRUPT_PROB = 0.6;

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
const MAX_SPEECH_MS    = 20000; // force transcription if VAD stuck hot
// 20s covers any realistic utterance (orders, addresses,
// long questions). 8s was too short — callers giving
// a restaurant order or phone number exceed it naturally.

// ─── Minimum speech duration gate (pipecat: minimum_speech_duration) ─────────
// Ignore utterances shorter than this threshold. Coughs, breathing, and brief
// noise bursts that slip past RNNoise and VAD are typically < 200ms.
// 200ms matches pipecat's default minimum_speech_duration parameter.
const MIN_SPEECH_MS = 200;

// ─── Smart Turn silence fallback ──────────────────────────────────────────────
// Matches pipecat's SmartTurnParams.stop_secs (default 3.0s).
// When Smart Turn says INCOMPLETE, silence is accumulated frame-by-frame via
// VAD batch events (each 200ms). If total silence reaches this threshold
// without new speech, we force transcription — exactly like pipecat's
// append_audio() silence counter in base_smart_turn.py.
//
// This is NOT a setTimeout. speech_start resets the silence counter (like
// pipecat resetting _silence_ms when is_speech=True). No timer is ever set
// or cancelled. That's why our previous setTimeout approach broke: every
// "Hello?" reset the timer, creating an infinite loop until MAX_SPEECH_MS.
const SMART_TURN_STOP_MS = 3000;

// ─── Context summarization ────────────────────────────────────────────────────
// When the transcript exceeds this word count, summarize and trim the OpenAI
// context window. Per-assistant opt-in via assistantConfig.context_summarization.
// ~1500 words ≈ 2000 tokens — safe headroom before OpenAI Realtime context limit.
const CONTEXT_SUMMARIZE_WORDS = 1500;

// ─── Filler phrases (pipecat: LLMUserContextAggregatorProcessor pattern) ──────
// Played immediately when a tool call starts, before the HTTP response arrives.
// Gives the caller something to hear during tool execution latency.
const DEFAULT_FILLER_PHRASES = [
    "One moment.",
    "Let me check that for you.",
    "Sure, give me just a second.",
    "Let me look that up.",
    "One second.",
];

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

        // ── Filler phrase (pipecat: pre-tool-call filler audio) ───────────────
        // Play a brief phrase immediately while the tool HTTP call is in flight.
        // The tool result and AI response queue naturally after the filler via
        // ttsSentenceQueue, so ordering is preserved.
        //
        // Enabled if assistantConfig.enable_filler_phrases = true (default: true)
        // or assistantConfig.filler_phrases = ['custom phrase', ...] (custom list).
        // Disabled explicitly with enable_filler_phrases: false.
        const fillerEnabled = session.assistantConfig.enable_filler_phrases !== false;
        if (fillerEnabled && !session.isAISpeaking && session.status === 'active') {
            const phrases = Array.isArray(session.assistantConfig.filler_phrases) && session.assistantConfig.filler_phrases.length > 0
                ? session.assistantConfig.filler_phrases
                : DEFAULT_FILLER_PHRASES;
            const filler = phrases[Math.floor(Math.random() * phrases.length)];
            // Queue filler TTS exactly like a normal AI sentence — non-blocking
            session.ttsSentenceQueue = session.ttsSentenceQueue.then(async () => {
                if (session.status === 'ending' || session.status === 'ended') return;
                logger.info(`Filler phrase: "${filler}"`, { callSid });
                await speakToTwilio(session, filler);
            });
        }

        try {
            const result = await executeFn(name, args, session);
            openaiClient.sendFunctionResult(call_id, result);
        } catch (err) {
            logger.error(`Function ${name} failed`, { callSid, error: err.message });
            openaiClient.sendFunctionResult(call_id, { error: err.message });
        }
    });

    // ── Conversation item tracking (for context summarization) ────────────────
    // OpenAI Realtime emits conversation.item.created for every message,
    // function call, and function result. We track their IDs so context
    // summarization can delete old items after injecting a summary.
    openaiClient.on('item_created', (itemId, role) => {
        session.conversationItemIds.push(itemId);

        // Trigger summarization when transcript word count exceeds threshold.
        // assistantConfig.context_summarization must be true (opt-in, default off).
        // Most calls (<10 min) never hit this. Long calls and edge cases are covered.
        if (session.assistantConfig.context_summarization) {
            const wordCount = session.transcript.reduce((sum, t) => sum + (t.message || '').split(' ').length, 0);
            if (wordCount >= CONTEXT_SUMMARIZE_WORDS) {
                summarizeContext(session).catch(err =>
                    logger.error('Context summarization failed', { callSid, error: err.message })
                );
            }
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
    // Also pass through during awaitingTurnConfirmation so VAD can detect if the
    // user starts speaking again during the Smart Turn hold window.
    if (isSilence(batchBuf) && !session.isSpeaking && !session.awaitingTurnConfirmation) return;

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

        // ── Fast interrupt path ───────────────────────────────────────────────
        // When AI is speaking, don't wait for SPEECH_CONFIRM_FRAMES (96ms of
        // consecutive speech frames) before triggering interrupt. Short words
        // like "stop" or "wait" may not sustain long enough to cross the state
        // machine threshold. Use raw probability directly: a single 200ms batch
        // at >= FAST_INTERRUPT_PROB is enough to cut the AI off.
        //
        // Reset the counter on any non-speech batch so a single noisy frame
        // doesn't accumulate across silence gaps.
        if (session.isAISpeaking) {
            if (vadResult.probability >= FAST_INTERRUPT_PROB) {
                session.fastInterruptCount++;
                if (session.fastInterruptCount >= 1) {
                    session.fastInterruptCount = 0;
                    interruptAI(session);
                    // Don't return — let the normal speech pipeline run so the
                    // user's audio is captured into the speech buffer for STT.
                }
            } else {
                session.fastInterruptCount = 0;
            }
        } else {
            session.fastInterruptCount = 0;
        }

        if (event === 'speech_start') {
            session.speechStartCount++;

            if (session.awaitingTurnConfirmation) {
                // ── Smart Turn hold: user spoke again ─────────────────────────
                // Mirrors pipecat base_smart_turn.py append_audio() when is_speech=True:
                //   self._silence_ms = 0  (reset silence counter)
                // We do NOT cancel any timer here — there is no timer. Silence is
                // tracked via VAD batch events in the 'silence' handler below.
                session.turnSilenceMs = 0;
                if (!session.isSpeaking) {
                    session.isSpeaking      = true;
                    session.speechStartedAt = Date.now();
                    session.clearSilenceTimer();
                }
                session.appendSpeechBuffer(batchBuf);

            } else if (!session.isSpeaking) {
                // ── Normal new turn start ─────────────────────────────────────
                session.isSpeaking      = true;
                session.speechStartedAt = Date.now();
                session.clearSilenceTimer();
                session.speechStartedDuringAI = session.isAISpeaking;

                if (session.preRollBuffer.length > 0) {
                    session.appendSpeechBuffer(Buffer.concat(session.preRollBuffer));
                }
                session.appendSpeechBuffer(batchBuf);

            } else {
                session.appendSpeechBuffer(batchBuf);
            }

            if (session.speechStartCount >= INTERRUPT_THRESHOLD && session.isAISpeaking) {
                session.speechStartedDuringAI = false;
                interruptAI(session);
            }

            if (!session.awaitingTurnConfirmation &&
                session.speechStartedAt &&
                (Date.now() - session.speechStartedAt) > MAX_SPEECH_MS) {
                logger.warn('Max speech duration reached — forcing transcription', { callSid: session.callSid });
                const speechAudio = session.flushSpeechBuffer();
                session.isSpeaking              = false;
                session.speechStartedAt         = null;
                session.speechStartCount        = 0;
                session.speechStartedDuringAI   = false;
                session.awaitingTurnConfirmation = false;
                session.turnSilenceMs           = 0;
                if (speechAudio.length > 0) await transcribeAndRespond(session, speechAudio);
            }

        } else if (event === 'silence') {
            if (!session.awaitingTurnConfirmation) {
                session.speechStartCount = 0;
            } else {
                // ── Smart Turn silence accumulation ───────────────────────────
                // Mirrors pipecat base_smart_turn.py append_audio() when is_speech=False:
                //   chunk_duration_ms = len(audio) / (sample_rate / 1000)
                //   self._silence_ms += chunk_duration_ms
                //   if self._silence_ms >= self._stop_ms: COMPLETE (force transcribe)
                //
                // Each 'silence' VAD batch = 200ms. We accumulate until SMART_TURN_STOP_MS.
                // When user speaks again, speech_start resets turnSilenceMs to 0.
                session.turnSilenceMs += 200;
                if (session.turnSilenceMs >= SMART_TURN_STOP_MS) {
                    logger.info(
                        `Smart Turn silence fallback fired (${session.turnSilenceMs}ms >= ${SMART_TURN_STOP_MS}ms) — forcing transcription`,
                        { callSid: session.callSid }
                    );
                    session.awaitingTurnConfirmation = false;
                    session.turnSilenceMs            = 0;
                    const audio = session.flushSpeechBuffer();
                    session.isSpeaking       = false;
                    session.speechStartedAt  = null;
                    session.speechStartCount = 0;
                    if (audio.length > 0) await transcribeAndRespond(session, audio);
                    session.startSilenceTimer(() => endCall(session, 'no_response'));
                }
            }

        } else if (event === 'speech_end') {
            const isConfirmationContinuation = session.awaitingTurnConfirmation;

            const speechDurationMs = session.speechStartedAt
                ? Date.now() - session.speechStartedAt
                : 0;

            const speechAudio = session.flushSpeechBuffer();

            session.speechStartCount = 0;
            session.isSpeaking       = false;
            session.speechStartedAt  = null;

            // ── Minimum speech duration gate ──────────────────────────────────
            // Skip for continuation turns — buffer already has substantial audio.
            if (!isConfirmationContinuation && speechDurationMs < MIN_SPEECH_MS) {
                logger.debug(
                    `Speech too short (${speechDurationMs}ms < ${MIN_SPEECH_MS}ms) — discarding`,
                    { callSid: session.callSid }
                );
                session.speechStartedDuringAI    = false;
                session.awaitingTurnConfirmation  = false;
                session.turnSilenceMs             = 0;
                session.startSilenceTimer(() => endCall(session, 'no_response'));
                return;
            }

            // ── STT mute during AI speaking ───────────────────────────────────
            // Skip for continuation turns — intent already established.
            if (!isConfirmationContinuation &&
                session.speechStartedDuringAI &&
                session.speechStartCount < INTERRUPT_THRESHOLD) {
                logger.debug('Speech during AI playback below interrupt threshold — discarding', {
                    callSid: session.callSid,
                });
                session.speechStartedDuringAI    = false;
                session.awaitingTurnConfirmation  = false;
                session.turnSilenceMs             = 0;
                session.startSilenceTimer(() => endCall(session, 'no_response'));
                return;
            }
            session.speechStartedDuringAI = false;

            if (speechAudio.length === 0) {
                session.awaitingTurnConfirmation = false;
                session.turnSilenceMs            = 0;
                session.startSilenceTimer(() => endCall(session, 'no_response'));
                return;
            }

            // ── Smart Turn Detection ──────────────────────────────────────────
            // ── KEY OPTIMIZATION: run Smart Turn and STT in parallel ──────────
            // Both take the same base64 audio as input. Previously they ran
            // serially: Smart Turn (~50ms + RTT) then STT (~250ms). Running
            // concurrently removes ~250ms from perceived response delay every turn.
            //
            // If Smart Turn returns INCOMPLETE, discard the STT result and
            // preserve the buffer. The cost is one wasted STT call — acceptable.
            // If COMPLETE, the transcript is already ready with no extra wait.
            const audioB64ForTurn = pcm16ToBase64Wav(speechAudio);

            const [turnResult, sttResultEarly] = await Promise.all([
                checkTurnComplete(audioB64ForTurn),
                gpuClient.transcribe(audioB64ForTurn, session.language).catch(err => {
                    logger.error('Parallel STT failed', { callSid: session.callSid, error: err.message });
                    return null;
                }),
            ]);

            if (!turnResult.complete) {
                logger.info(
                    `Smart Turn: INCOMPLETE (confidence=${turnResult.confidence?.toFixed(3)}) — holding, silence counter at ${session.turnSilenceMs}ms`,
                    { callSid: session.callSid }
                );
                // Preserve buffer. Discard the early STT result — user isn't done.
                session.appendSpeechBuffer(speechAudio);
                session.awaitingTurnConfirmation = true;
                session.turnSilenceMs            = 0;

            } else {
                logger.info(
                    `Smart Turn: COMPLETE (confidence=${turnResult.confidence?.toFixed(3)}) — using parallel STT result for ${speechDurationMs}ms`,
                    { callSid: session.callSid }
                );
                session.awaitingTurnConfirmation = false;
                session.turnSilenceMs            = 0;

                // Use the pre-computed STT result — no additional wait.
                // Guard against concurrent transcription (e.g. silence fallback fired simultaneously).
                if (!session.transcribeInFlight && sttResultEarly?.text !== undefined) {
                    session.transcribeInFlight = true;
                    try {
                        const transcript = sttResultEarly.text?.trim();
                        if (transcript) {
                            logger.info(`User: "${transcript.slice(0, 100)}"`, { callSid: session.callSid });
                            session.transcript.push({ role: 'user', message: transcript, time_in_call_secs: session.getDurationSeconds() });
                            try {
                                session.openaiClient.sendUserMessage(transcript);
                            } catch (err) {
                                logger.error('OpenAI send failed', { callSid: session.callSid, error: err.message });
                            }
                        }
                    } finally {
                        session.transcribeInFlight = false;
                    }
                } else if (!session.transcribeInFlight) {
                    // Parallel STT failed — fall back to sequential transcription
                    await transcribeAndRespond(session, speechAudio);
                }
                session.startSilenceTimer(() => endCall(session, 'no_response'));
            }
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
        const data     = await gpuClient.transcribe(audioB64, session.language);
        transcript     = data.text?.trim();
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

/**
 * Context summarization (pipecat: LLMContextSummarizationConfig).
 *
 * When the session transcript grows beyond CONTEXT_SUMMARIZE_WORDS, we:
 *   1. Make a one-off call to the OpenAI Chat Completions API to summarize
 *      the full transcript so far into a concise paragraph.
 *   2. Inject the summary into the Realtime session as a system message
 *      ("Earlier in this call: [summary]").
 *   3. Delete all tracked conversation items older than the summary injection
 *      to free context window space.
 *
 * This keeps the Realtime session's effective context bounded regardless of
 * call duration. Opt-in via assistantConfig.context_summarization: true.
 *
 * Guards:
 *   - Only runs once per call (once summarized, transcript is cleared and
 *     the word count won't re-trigger immediately)
 *   - Re-entrant: if a summarization is already in flight, skip
 */
let _summarizationInFlight = false;  // module-level flag (per-session guard via session flag)

async function summarizeContext(session) {
    const { callSid } = session;

    // Per-session re-entrant guard
    if (session._summarizationInFlight) return;
    session._summarizationInFlight = true;

    try {
        logger.info('Context summarization triggered', {
            callSid,
            transcriptWords: session.transcript.reduce((s, t) => s + (t.message || '').split(' ').length, 0),
            itemCount: session.conversationItemIds.length,
        });

        // Build readable transcript for the summarizer
        const transcriptText = session.transcript
            .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.message}`)
            .join('\n');

        // Call standard OpenAI Chat Completions (not Realtime) for summarization
        const { data: summaryResponse } = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',  // cheap, fast — summarization doesn't need gpt-4o
                max_tokens: 300,
                messages: [
                    {
                        role: 'system',
                        content: 'Summarize the following phone call transcript in 2-4 sentences. ' +
                            'Focus on what the caller needed and what was resolved or agreed upon. ' +
                            'Be concise and factual.',
                    },
                    { role: 'user', content: transcriptText },
                ],
            },
            {
                headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                timeout: 15000,
            }
        );

        const summary = summaryResponse.choices?.[0]?.message?.content?.trim();
        if (!summary) {
            logger.warn('Summarization returned empty result', { callSid });
            return;
        }

        logger.info(`Summarized ${session.conversationItemIds.length} items`, { callSid, summary: summary.slice(0, 100) });

        // Inject summary as system context into the Realtime session
        session.openaiClient.injectContext(`Earlier in this call: ${summary}`);

        // Delete all old conversation items to free context window
        const idsToDelete = [...session.conversationItemIds];
        for (const itemId of idsToDelete) {
            session.openaiClient.deleteItem(itemId);
        }
        session.conversationItemIds = [];

        // Clear the local transcript (it's been summarized; fresh turns will re-populate)
        session.transcript = [];

        logger.info('Context summarization complete', { callSid });

    } catch (err) {
        logger.error('Context summarization error', { callSid, error: err.message });
    } finally {
        session._summarizationInFlight = false;
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