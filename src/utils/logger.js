const winston = require('winston');

const isProduction = process.env.NODE_ENV === 'production';

// ─── Formats ──────────────────────────────────────────────────────
const productionFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

const developmentFormat = winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        if (stack) {
            return `${timestamp} ${level}: ${message}\n${stack}${metaStr}`;
        }
        return `${timestamp} ${level}: ${message}${metaStr}`;
    })
);

// ─── Logger Instance ──────────────────────────────────────────────
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: isProduction ? productionFormat : developmentFormat,
    defaultMeta: {
        service: 'whatsapp-service',
        pid: process.pid,
    },
    transports: [
        new winston.transports.Console(),
    ],
});

module.exports = logger;
