'use strict';

const express = require('express');
const twilio  = require('twilio');
const axios   = require('axios');
const logger  = require('../utils/logger');
const { callManager } = require('../orchestrator/callmanager');

const router = express.Router();

const laravelClient = axios.create({
    baseURL:  process.env.LARAVEL_API_URL,
    headers:  { 'X-Internal-Secret': process.env.LARAVEL_API_SECRET },
    timeout:  10000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Twilio Signature Validation
//
// Only runs when TWILIO_VALIDATE_SIGNATURES=true in .env AND the Laravel
// /calls/incoming response includes twilio_auth_token. Safe to enable once
// Laravel is updated to return the token.
// ─────────────────────────────────────────────────────────────────────────────
function validateTwilioSignature(req, authToken) {
    if (process.env.TWILIO_VALIDATE_SIGNATURES !== 'true') return true;
    if (!authToken) {
        logger.warn('Signature validation enabled but no auth token returned by Laravel — skipping');
        return true;
    }

    const signature = req.headers['x-twilio-signature'];
    if (!signature) {
        logger.warn('Missing X-Twilio-Signature header');
        return false;
    }

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host     = req.headers['x-forwarded-host'] || req.headers.host;
    const url      = `${protocol}://${host}${req.originalUrl}`;

    try {
        const callSid     = req.body.CallSid;
        const callerPhone = req.body.From;
        const toPhone     = req.body.To;

        logger.info(`Signature validation successful for incoming call: ${callerPhone} → ${toPhone}`, { callSid });
        return twilio.validateRequest(authToken, signature, url, req.body);
    } catch (err) {
        logger.error(`Signature validation threw: ${err.message}`);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /twilio/incoming
// ─────────────────────────────────────────────────────────────────────────────
router.post('/incoming', async (req, res) => {
    const callSid     = req.body.CallSid;
    const callerPhone = req.body.From;
    const toPhone     = req.body.To;

    logger.info(`Incoming call: ${callerPhone} → ${toPhone}`, { callSid });

    try {
        const { data: config } = await laravelClient.post('/calls/incoming', {
            call_sid:     callSid,
            caller_phone: callerPhone,
            to_phone:     toPhone,
            call_status:  req.body.CallStatus,
        });

        if (!config || !config.assistant_id) {
            logger.warn('No assistant configured for number', { callSid, toPhone });
            return respondNotConfigured(res);
        }

        if (!validateTwilioSignature(req, config.twilio_auth_token)) {
            logger.warn('Twilio signature validation failed — rejecting request', { callSid });
            return res.status(403).send('Forbidden');
        }

        const host  = req.headers['x-forwarded-host'] || req.headers.host;
        const wsUrl = `wss://${host}/twilio/stream/${callSid}`;

        const response = new twilio.twiml.VoiceResponse();
        const start    = response.start();
        start.stream({ url: wsUrl });
        response.pause({ length: 60 });

        logger.info('Responding with TwiML MediaStream', { callSid, wsUrl });

        res.type('text/xml');
        res.send(response.toString());

    } catch (err) {
        logger.error(`Error handling incoming call: ${err.message || err.code || JSON.stringify(err)}`, { callSid });
        respondError(res);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /twilio/status
// ─────────────────────────────────────────────────────────────────────────────
router.post('/status', async (req, res) => {
    const callSid    = req.body.CallSid;
    const callStatus = req.body.CallStatus;

    logger.info(`Call status: ${callStatus}`, { callSid });

    try {
        await laravelClient.post('/calls/status', {
            call_sid:      callSid,
            call_status:   callStatus,
            call_duration: req.body.CallDuration || null,
        });
    } catch (err) {
        logger.warn(`Failed to update call status in Laravel: ${err.message}`, { callSid });
    }

    if (['completed', 'failed', 'busy', 'no-answer'].includes(callStatus)) {
        const session = callManager.get(callSid);
        if (session && session.status !== 'ended') {
            logger.info('Call ended externally, cleaning up session', { callSid });
            callManager.remove(callSid);
        }
    }

    res.sendStatus(200);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function respondNotConfigured(res) {
    const r = new twilio.twiml.VoiceResponse();
    r.say('Sorry, this number is not configured. Please try again later.');
    r.hangup();
    res.type('text/xml');
    res.send(r.toString());
}

function respondError(res) {
    const r = new twilio.twiml.VoiceResponse();
    r.say('Sorry, we encountered an error. Please try again later.');
    r.hangup();
    res.type('text/xml');
    res.send(r.toString());
}

module.exports = router;