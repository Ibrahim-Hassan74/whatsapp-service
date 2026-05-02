/**
 * WhatsApp Service — Entry Point
 *
 * Production-ready WhatsApp Web gateway integrated with ASP.NET backend.
 * Uses whatsapp-web.js + Puppeteer with system Chromium.
 *
 * Startup order (critical for Render):
 * 1. HTTP server starts FIRST → health check responds immediately
 * 2. WhatsApp client initializes AFTER → can take minutes (QR scan)
 *
 * Shutdown order (critical for session persistence):
 * 1. isShuttingDown flag set → blocks all restarts
 * 2. WhatsApp client destroyed → session saved to disk
 * 3. HTTP server closed → clean exit
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
app.use(authMiddleware);
app.use(routes);

// ─── Graceful Shutdown ────────────────────────────────────────────
let isShuttingDown = false;

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal} — starting graceful shutdown`, {
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
    });

    // Shutdown WhatsApp FIRST (saves session to disk)
    await whatsapp.shutdown();

    // Then close HTTP server
    server.close(() => {
        logger.info('HTTP server closed — exiting cleanly');
        process.exit(0);
    });

    // Force exit after 8s if shutdown hangs
    setTimeout(() => {
        logger.error('Forced exit after timeout');
        process.exit(1);
    }, 8000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Global Error Handlers ────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);

    // Ignore Puppeteer "Target closed" errors — these are expected
    // during page navigation and shutdown
    if (msg.includes('Target closed') || msg.includes('Protocol error')) {
        logger.warn('Suppressed transient Puppeteer rejection', { error: msg });
        return;
    }

    logger.error('Unhandled promise rejection', {
        error: msg,
        stack: reason?.stack,
    });
});

process.on('uncaughtException', (err) => {
    // Puppeteer transient errors should NOT crash the process
    if (err.message.includes('Target closed') || err.message.includes('Protocol error')) {
        logger.warn('Suppressed transient Puppeteer exception', { error: err.message });
        return;
    }

    logger.error('FATAL: Uncaught exception — process will exit', {
        error: err.message,
        stack: err.stack,
    });
    setTimeout(() => process.exit(1), 3000);
});

// ─── Start ────────────────────────────────────────────────────────
logger.info('Starting WhatsApp service', {
    pid: process.pid,
    env: config.nodeEnv,
    port: config.port,
    chromium: config.chromiumPath,
    sessionPath: config.sessionDataPath,
    nodeVersion: process.version,
    startedAt: new Date().toISOString(),
});

// Start HTTP server FIRST — health check responds immediately
const server = app.listen(config.port, () => {
    logger.info(`Server listening on port ${config.port}`);

    // THEN initialize WhatsApp (can take minutes for QR scan)
    // forceNew: false → reuse existing session from disk
    logger.info('Starting WhatsApp client initialization (session reuse enabled)...');
    whatsapp.initializeClient({ forceNew: false });
});