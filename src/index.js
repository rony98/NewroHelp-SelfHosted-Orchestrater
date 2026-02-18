'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const logger = require('./utils/logger');
const twimlRouter = require('./twilio/twiml');
const { attachMediaStreamHandler } = require('./twilio/mediastream');
const { callManager } = require('./orchestrator/callmanager');
const gpuClient = require('./gpu/client');
const fs = require('fs');

// ----------------------------------------------------------------
// Ensure log directory exists
// ----------------------------------------------------------------
if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs');
}

// ----------------------------------------------------------------
// Express app
// ----------------------------------------------------------------
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check (for monitoring)
app.get('/health', async (req, res) => {
    try {
        const gpuHealth = await gpuClient.health();
        res.json({
            status: 'healthy',
            active_calls: callManager.count(),
            gpu_server: gpuHealth
        });
    } catch (err) {
        res.status(503).json({
            status: 'degraded',
            active_calls: callManager.count(),
            gpu_server: 'unreachable',
            error: err.message
        });
    }
});

// Twilio webhooks
app.use('/twilio', twimlRouter);

// ----------------------------------------------------------------
// HTTP server (needed for WS upgrade)
// ----------------------------------------------------------------
const server = http.createServer(app);

// Attach Twilio MediaStream WebSocket handler
attachMediaStreamHandler(server);

// ----------------------------------------------------------------
// Start
// ----------------------------------------------------------------
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    logger.info(`Main server listening on port ${PORT}`);

    // Check GPU server on startup
    try {
        const gpuHealth = await gpuClient.health();
        logger.info('GPU server reachable', {
            status: gpuHealth.status,
            gpu: gpuHealth.gpu_utilization ? `${gpuHealth.gpu_utilization}%` : 'N/A',
            models: gpuHealth.models_loaded
        });
    } catch (err) {
        logger.warn('GPU server not reachable on startup - will retry on first call', { error: err.message });
    }
});

// ----------------------------------------------------------------
// Graceful shutdown
// ----------------------------------------------------------------
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
});

module.exports = { app, server };