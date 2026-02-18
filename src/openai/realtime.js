'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const logger = require('../utils/logger');

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime';

class OpenAIRealtimeClient extends EventEmitter {
    /**
     * @param {string} callSid - For logging
     * @param {object} sessionConfig - { systemPrompt, tools, language }
     */
    constructor(callSid, sessionConfig) {
        super();
        this.callSid = callSid;
        this.sessionConfig = sessionConfig;
        this.ws = null;
        this.isConnected = false;
        this.currentResponseId = null;
        this.pendingFunctionCall = null;
    }

    /**
     * Connect to OpenAI Realtime API
     */
    async connect() {
        return new Promise((resolve, reject) => {
            const model = process.env.OPENAI_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

            this.ws = new WebSocket(`${OPENAI_WS_URL}?model=${model}`, {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'OpenAI-Beta': 'realtime=v1'
                }
            });

            this.ws.on('open', () => {
                logger.info('OpenAI WS connected', { callSid: this.callSid });
                this._configureSession();
                resolve();
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
                reject(err);
            });

            this.ws.on('close', (code, reason) => {
                logger.info('OpenAI WS closed', { callSid: this.callSid, code });
                this.isConnected = false;
                this.emit('closed');
            });
        });
    }

    /**
     * Configure the OpenAI session with system prompt, tools, voice settings
     */
    _configureSession() {
        const { systemPrompt, tools, language } = this.sessionConfig;

        const sessionUpdate = {
            type: 'session.update',
            session: {
                modalities: ['text'],           // TEXT MODE ONLY - we handle our own TTS
                instructions: systemPrompt,
                input_audio_format: 'pcm16',    // not used in text mode but required
                output_audio_format: 'pcm16',
                turn_detection: null,            // we handle VAD ourselves
                tools: tools || [],
                tool_choice: 'auto',
                temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.8'),
                max_response_output_tokens: parseInt(process.env.OPENAI_MAX_TOKENS || '150')
            }
        };

        this._send(sessionUpdate);
        this.isConnected = true;
        logger.info('OpenAI session configured', { callSid: this.callSid, language });
    }

    /**
     * Send a user transcript to OpenAI and request a response
     *
     * @param {string} text - Transcribed user speech
     */
    sendUserMessage(text) {
        if (!this.isConnected) {
            logger.warn('OpenAI not connected, dropping message', { callSid: this.callSid });
            return;
        }

        // Add user message to conversation
        this._send({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text }]
            }
        });

        // Trigger LLM response
        this._send({ type: 'response.create' });

        logger.info(`User → OpenAI: "${text}"`, { callSid: this.callSid });
    }

    /**
     * Send function call result back to OpenAI
     *
     * @param {string} callId - Function call ID from OpenAI
     * @param {object} result - Result object to return
     */
    sendFunctionResult(callId, result) {
        this._send({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(result)
            }
        });

        // Ask LLM to continue after function result
        this._send({ type: 'response.create' });

        logger.info('Function result sent to OpenAI', { callSid: this.callSid, callId });
    }

    /**
     * Inject a context update into the conversation (e.g. after reservation created)
     *
     * @param {string} contextText - System context to inject
     */
    injectContext(contextText) {
        this._send({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: contextText }]
            }
        });
    }

    /**
     * Cancel the current in-progress response (for interruptions)
     */
    cancelResponse() {
        if (this.currentResponseId) {
            this._send({
                type: 'response.cancel',
                response_id: this.currentResponseId
            });
            logger.info('Response cancelled (interruption)', { callSid: this.callSid });
        }
    }

    /**
     * Handle incoming events from OpenAI
     */
    _handleEvent(event) {
        switch (event.type) {

            // Response text streaming
            case 'response.text.delta':
                this.emit('text_delta', event.delta);
                break;

            // Full response text complete
            case 'response.text.done':
                logger.info(`OpenAI → text done: "${event.text?.slice(0, 100)}"`, { callSid: this.callSid });
                this.emit('text_done', event.text);
                break;

            // Response object created - capture ID for cancellation
            case 'response.created':
                this.currentResponseId = event.response?.id;
                break;

            // Response fully complete (including any function calls)
            case 'response.done':
                this.currentResponseId = null;
                this.emit('response_done', event.response);
                break;

            // Function call arguments streaming
            case 'response.function_call_arguments.delta':
                // Accumulate function call args
                if (!this.pendingFunctionCall) {
                    this.pendingFunctionCall = { call_id: event.call_id, name: event.name, args: '' };
                }
                this.pendingFunctionCall.args += event.delta;
                break;

            // Function call arguments complete - ready to execute
            case 'response.function_call_arguments.done':
                if (this.pendingFunctionCall) {
                    try {
                        const args = JSON.parse(this.pendingFunctionCall.args);
                        this.emit('function_call', {
                            call_id: this.pendingFunctionCall.call_id,
                            name: this.pendingFunctionCall.name,
                            args
                        });
                    } catch (err) {
                        logger.error('Failed to parse function call args', { callSid: this.callSid, error: err.message });
                    }
                    this.pendingFunctionCall = null;
                }
                break;

            // Session ready
            case 'session.created':
            case 'session.updated':
                logger.info(`OpenAI session ${event.type}`, { callSid: this.callSid });
                break;

            // Errors
            case 'error':
                logger.error('OpenAI API error', { callSid: this.callSid, error: event.error });
                this.emit('error', event.error);
                break;

            default:
                // Silently ignore unknown events
                break;
        }
    }

    /**
     * Send a message to OpenAI WebSocket
     */
    _send(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        } else {
            logger.warn('OpenAI WS not open, cannot send', { callSid: this.callSid, type: payload.type });
        }
    }

    /**
     * Close the WebSocket connection
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
    }
}

module.exports = OpenAIRealtimeClient;