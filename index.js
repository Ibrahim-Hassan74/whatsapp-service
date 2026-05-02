/**
 * WhatsApp Service — Entry Point
 *
 * Production-ready WhatsApp Web gateway integrated with ASP.NET backend.
 * Uses whatsapp-web.js + Puppeteer with system Chromium.
 */

const config = require('./src/config');
const logger = require('./src/utils/logger');
const express = require('express');
const authMiddleware = require('./src/middleware/auth');
const routes = require('./src/routes');
const whatsapp = require('./src/services/whatsappClient');

// ─── Express Setup ────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Authentication middleware (skips /health automatically)
app.use(authMiddleware);

// Routes
app.use(routes);

// ─── Graceful Shutdown ────────────────────────────────────────────
async function gracefulShutdown(signal) {
    logger.info(`Received ${signal} — starting graceful shutdown`);

    await whatsapp.shutdown();

    server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
    });

    // Force exit after 10s if graceful shutdown hangs
    setTimeout(() => {
        logger.error('Forced exit after timeout');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Global Error Handlers ────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
        error: reason?.message || String(reason),
        stack: reason?.stack,
    });
});

process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', {
        error: err.message,
        stack: err.stack,
    });
    // Don't exit — let the heartbeat detect and restart the client
});

// ─── Start ────────────────────────────────────────────────────────
logger.info('Starting WhatsApp service', {
    env: config.nodeEnv,
    port: config.port,
    chromium: config.chromiumPath,
    sessionPath: config.sessionDataPath,
});

// Initialize WhatsApp client
whatsapp.initializeClient({ forceNew: true });

// Start HTTP server
const server = app.listen(config.port, () => {
    logger.info(`Server listening on port ${config.port}`);
});