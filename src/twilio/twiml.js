'use strict';

const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const logger = require('../utils/logger');
const { callManager } = require('../orchestrator/callmanager');

const router = express.Router();

const LARAVEL_URL = process.env.LARAVEL_API_URL;
const LARAVEL_SECRET = process.env.LARAVEL_API_SECRET;

const laravelClient = axios.create({
    baseURL: LARAVEL_URL,
    headers: { 'X-Internal-Secret': LARAVEL_SECRET },
    timeout: 10000
});

/**
 * POST /twilio/incoming
 * Twilio calls this when a call comes in.
 * We look up the assistant config from Laravel, then respond with TwiML
 * that connects the call to our MediaStream WebSocket.
 */
router.post('/incoming', async (req, res) => {
    const callSid = req.body.CallSid;
    const callerPhone = req.body.From;
    const toPhone = req.body.To;

    logger.info(`Incoming call: ${callerPhone} → ${toPhone}`, { callSid });

    try {
        // Fetch assistant config from Laravel based on the phone number called
        const { data: config } = await laravelClient.post('/calls/incoming', {
            call_sid: callSid,
            caller_phone: callerPhone,
            to_phone: toPhone,
            call_status: req.body.CallStatus
        });

        if (!config || !config.assistant_id) {
            logger.warn('No assistant configured for number', { callSid, toPhone });
            return respondNotConfigured(res);
        }

        // Build the WebSocket URL for MediaStream
        const wsHost = req.headers.host;
        const wsUrl = `wss://${wsHost}/twilio/stream/${callSid}`;

        // Respond with TwiML to start MediaStream
        const VoiceResponse = twilio.twiml.VoiceResponse;
        const response = new VoiceResponse();

        const start = response.start();
        start.stream({ url: wsUrl });

        // Keep call alive while WebSocket is open
        response.pause({ length: 60 });

        logger.info('Responding with TwiML MediaStream', { callSid, wsUrl });

        res.type('text/xml');
        res.send(response.toString());

    } catch (err) {
        logger.error('Error handling incoming call', { callSid, error: err.message });
        respondError(res);
    }
});

/**
 * POST /twilio/status
 * Twilio status callback - notifies us when call status changes
 */
router.post('/status', async (req, res) => {
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;

    logger.info(`Call status: ${callStatus}`, { callSid });

    // Notify Laravel of status change
    try {
        await laravelClient.post('/calls/status', {
            call_sid: callSid,
            call_status: callStatus,
            call_duration: req.body.CallDuration || null
        });
    } catch (err) {
        logger.warn('Failed to update call status in Laravel', { callSid, error: err.message });
    }

    // If call ended externally (e.g. caller hung up), clean up our session
    if (['completed', 'failed', 'busy', 'no-answer'].includes(callStatus)) {
        const session = callManager.get(callSid);
        if (session && session.status !== 'ended') {
            logger.info('Call ended externally, cleaning up session', { callSid });
            callManager.remove(callSid);
        }
    }

    res.sendStatus(200);
});

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function respondNotConfigured(res) {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say('Sorry, this number is not configured. Please try again later.');
    response.hangup();
    res.type('text/xml');
    res.send(response.toString());
}

function respondError(res) {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say('Sorry, we encountered an error. Please try again later.');
    response.hangup();
    res.type('text/xml');
    res.send(response.toString());
}

module.exports = router;