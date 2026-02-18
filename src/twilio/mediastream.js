'use strict';

const WebSocket = require('ws');
const axios = require('axios');
const logger = require('../utils/logger');
const { callManager } = require('../orchestrator/callmanager');
const { initPipeline } = require('../orchestrator/pipeline');

const LARAVEL_URL = process.env.LARAVEL_API_URL;
const LARAVEL_SECRET = process.env.LARAVEL_API_SECRET;

const laravelClient = axios.create({
    baseURL: LARAVEL_URL,
    headers: { 'X-Internal-Secret': LARAVEL_SECRET },
    timeout: 10000
});

/**
 * Attach the MediaStream WebSocket handler to an HTTP server.
 * Each call gets its own WS path: /twilio/stream/:callSid
 *
 * @param {http.Server} server
 */
function attachMediaStreamHandler(server) {
    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
        if (!request.url.startsWith('/twilio/stream/')) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            const callSid = request.url.split('/twilio/stream/')[1];
            wss.emit('connection', ws, request, callSid);
        });
    });

    wss.on('connection', async (ws, request, callSid) => {
        logger.info('MediaStream WebSocket connected', { callSid });

        try {
            // Laravel returns a slim, pre-processed config.
            // The system_prompt is already fully built server-side (dynamic variables
            // injected, business context included, tool instructions appended).
            // This server just uses it as-is — no prompt building here.
            const { data: config } = await laravelClient.get(`/calls/${callSid}/config`);

            if (!config || !config.system_prompt) {
                logger.error('No config or system_prompt returned for call', { callSid });
                ws.close();
                return;
            }

            const session = callManager.create({
                callSid,
                callerPhone: config.caller_phone,
                assistantId: config.assistant_id,
                organizationId: config.organization_id,
                systemPrompt: config.system_prompt,
                language: config.language || 'en',
                voice: config.voice || null,
                twilioAccountSid: config.twilio_account_sid,
                twilioAuthToken: config.twilio_auth_token,
                assistantConfig: config
            });

            await initPipeline(session, ws, {
                systemPrompt: config.system_prompt,
                language: session.language
            });

        } catch (err) {
            logger.error('Failed to initialize pipeline for call', { callSid, error: err.message });
            ws.close();
        }
    });

    logger.info('MediaStream WebSocket handler attached');
}

module.exports = { attachMediaStreamHandler };