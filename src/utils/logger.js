'use strict';

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize, errors } = format;

const logFormat = printf(({ level, message, timestamp, stack, callSid, ...meta }) => {
    let log = `${timestamp} [${level}]`;
    if (callSid) log += ` [${callSid.slice(-8)}]`; // last 8 chars of callSid for brevity
    log += ` ${stack || message}`;
    if (Object.keys(meta).length) log += ` ${JSON.stringify(meta)}`;
    return log;
});

const logger = createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        errors({ stack: true }),
        logFormat
    ),
    transports: [
        new transports.Console({
            format: combine(colorize(), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), logFormat)
        }),
        new transports.File({
            filename: 'logs/error.log',
            level: 'error'
        }),
        new transports.File({
            filename: 'logs/combined.log'
        })
    ]
});

module.exports = logger;