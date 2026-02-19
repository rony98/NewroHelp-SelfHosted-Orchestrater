'use strict';

const WebSocket      = require('ws');
const { EventEmitter } = require('events');
const logger           = require('../utils/logger');

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime';

// Send a WebSocket ping every 25 seconds to prevent idle connection closure.
// OpenAI closes connections with no activity after ~60 seconds. On a quiet
// call (AI waiting for user to speak), there may be no traffic for 30+ seconds.
const KEEPALIVE_INTERVAL_MS = 25_000;

// Connection timeout: if OpenAI doesn't open the socket within 15 seconds,
// something is wrong. Without a timeout, the connect() promise hangs forever
// and holds the call session open indefinitely.
const CONNECT_TIMEOUT_MS = 15_000;

class OpenAIRealtimeClient extends EventEmitter {
    constructor(callSid, sessionConfig) {
        super();
        this.callSid        = callSid;
        this.sessionConfig  = sessionConfig;
        this.ws             = null;
        this.isConnected    = false;
        this.currentResponseId = null;

        // FIX: use a Map instead of a single object to handle parallel function
        // calls. The OpenAI Realtime API can emit multiple concurrent
        // function_call_arguments.delta streams (one per call_id). Storing only
        // one pendingFunctionCall meant the second call overwrote the first,
        // causing the first tool to never be called and the LLM to hang.
        this.pendingFunctionCalls = new Map(); // call_id → { name, args }

        this._keepaliveTimer = null;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            const model = process.env.OPENAI_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

            // FIX: promise settlement guard — without this, if the socket emits
            // both 'error' and 'close' before 'open', reject() could be called
            // multiple times, causing "UnhandledPromiseRejection" on the second call.
            let settled = false;
            const settle = (fn, val) => {
                if (settled) return;
                settled = true;
                clearTimeout(connectTimer);
                fn(val);
            };

            // FIX: connection timeout — if OpenAI doesn't respond in 15s, reject.
            const connectTimer = setTimeout(() => {
                if (this.ws) this.ws.terminate();
                settle(reject, new Error('OpenAI WebSocket connection timeout'));
            }, CONNECT_TIMEOUT_MS);

            this.ws = new WebSocket(`${OPENAI_WS_URL}?model=${model}`, {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'OpenAI-Beta':   'realtime=v1',
                },
            });

            this.ws.on('open', () => {
                logger.info('OpenAI WS connected', { callSid: this.callSid });
                this._configureSession();
                this._startKeepalive();
                settle(resolve);
            });

            this.ws.on('message', (data) => {
                try {
                    const event = JSON.parse(data.toString());
                    this._handleEvent(event);
                } catch (err) {
                    logger.error('OpenAI WS parse error', { callSid: this.callSid, error: err.message });
                }
            });

            this.ws.on('error', (err) => {
                logger.error('OpenAI WS error', { callSid: this.callSid, error: err.message });
                this.emit('error', err);
                settle(reject, err);
            });

            this.ws.on('close', (code, reason) => {
                logger.info('OpenAI WS closed', { callSid: this.callSid, code });
                this._stopKeepalive();
                this.isConnected = false;
                this.emit('closed');
                // If we close before 'open', treat as connection failure
                settle(reject, new Error(`OpenAI WebSocket closed before open (code ${code})`));
            });
        });
    }

    _configureSession() {
        const { systemPrompt, tools, language } = this.sessionConfig;

        this._send({
            type: 'session.update',
            session: {
                modalities:               ['text'],        // text mode — we handle our own TTS
                instructions:             systemPrompt,
                input_audio_format:       'pcm16',         // unused in text mode but required
                output_audio_format:      'pcm16',
                turn_detection:           null,            // we handle VAD ourselves
                tools:                    tools || [],
                tool_choice:              'auto',
                temperature:              parseFloat(process.env.OPENAI_TEMPERATURE || '0.8'),
                // FIX: 150 tokens is dangerously low for any real restaurant/real-estate
                // response. A single sentence explaining reservation options can be 30-50
                // tokens; a complete response with confirmation details can hit 200+.
                // Use 1024 as a safe default (matches pipecat's gpt-4o-realtime examples).
                // Set OPENAI_MAX_TOKENS in .env to override.
                max_response_output_tokens: parseInt(process.env.OPENAI_MAX_TOKENS || '1024'),
            },
        });

        this.isConnected = true;
        logger.info('OpenAI session configured', { callSid: this.callSid, language });
    }

    // ── Keepalive ─────────────────────────────────────────────────────────────
    // FIX: OpenAI closes idle connections. During a call where the AI is waiting
    // for the user to speak (silence timer running), there may be no WS traffic
    // for 20-30 seconds. A WebSocket ping keeps the TCP connection alive.
    _startKeepalive() {
        this._keepaliveTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, KEEPALIVE_INTERVAL_MS);
    }

    _stopKeepalive() {
        if (this._keepaliveTimer) {
            clearInterval(this._keepaliveTimer);
            this._keepaliveTimer = null;
        }
    }

    sendUserMessage(text) {
        if (!this.isConnected) {
            logger.warn('OpenAI not connected, dropping message', { callSid: this.callSid });
            return;
        }
        this._send({
            type: 'conversation.item.create',
            item: {
                type: 'message', role: 'user',
                content: [{ type: 'input_text', text }],
            },
        });
        this._send({ type: 'response.create' });
        logger.info(`User → OpenAI: "${text}"`, { callSid: this.callSid });
    }

    sendFunctionResult(callId, result) {
        this._send({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(result),
            },
        });
        this._send({ type: 'response.create' });
        logger.info('Function result sent to OpenAI', { callSid: this.callSid, callId });
    }

    injectContext(contextText) {
        this._send({
            type: 'conversation.item.create',
            item: {
                type: 'message', role: 'system',
                content: [{ type: 'input_text', text: contextText }],
            },
        });
    }

    cancelResponse() {
        if (this.currentResponseId) {
            this._send({ type: 'response.cancel', response_id: this.currentResponseId });
            logger.info('Response cancelled (interruption)', { callSid: this.callSid });
        }
    }

    _handleEvent(event) {
        switch (event.type) {

            case 'response.text.delta':
                this.emit('text_delta', event.delta);
                break;

            case 'response.text.done':
                logger.info(`OpenAI → text done: "${event.text?.slice(0, 100)}"`, { callSid: this.callSid });
                this.emit('text_done', event.text);
                break;

            case 'response.created':
                this.currentResponseId = event.response?.id;
                break;

            case 'response.done':
                this.currentResponseId = null;
                this.emit('response_done', event.response);
                break;

            // ── FIX: parallel function calls ──────────────────────────────────
            // Use a Map keyed by call_id so concurrent parallel tool calls
            // don't overwrite each other. OpenAI can stream multiple function
            // calls simultaneously within one response (e.g. calling both
            // "check_availability" and "get_price" at the same time).
            case 'response.function_call_arguments.delta':
                if (!this.pendingFunctionCalls.has(event.call_id)) {
                    this.pendingFunctionCalls.set(event.call_id, { name: event.name, args: '' });
                }
                this.pendingFunctionCalls.get(event.call_id).args += event.delta;
                break;

            case 'response.function_call_arguments.done': {
                const pending = this.pendingFunctionCalls.get(event.call_id);
                if (pending) {
                    this.pendingFunctionCalls.delete(event.call_id);
                    try {
                        const args = JSON.parse(pending.args);
                        this.emit('function_call', { call_id: event.call_id, name: pending.name, args });
                    } catch (err) {
                        logger.error('Failed to parse function call args', { callSid: this.callSid, error: err.message });
                    }
                }
                break;
            }

            case 'session.created':
            case 'session.updated':
                logger.info(`OpenAI session ${event.type}`, { callSid: this.callSid });
                break;

            case 'error':
                logger.error('OpenAI API error', { callSid: this.callSid, error: event.error });
                this.emit('error', event.error);
                break;

            default:
                break;
        }
    }

    _send(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        } else {
            logger.warn('OpenAI WS not open, cannot send', { callSid: this.callSid, type: payload.type });
        }
    }

    disconnect() {
        this._stopKeepalive();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
    }
}

module.exports = OpenAIRealtimeClient;