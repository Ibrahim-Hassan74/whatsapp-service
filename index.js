/**
 * WhatsApp Service — Entry Point
 *
 * Production-ready WhatsApp Web gateway integrated with ASP.NET backend.
 * Uses whatsapp-web.js + Puppeteer with system Chromium.
 *
 * IMPORTANT: The HTTP server starts FIRST so that Render's health check
 * receives a response immediately. WhatsApp client initialization happens
 * AFTER the server is listening — this prevents Render from killing the
 * process during the (potentially long) QR-scan wait.
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
let isShuttingDown = false;

async function gracefulShutdown(signal) {
    if (isShuttingDown) return; // Prevent double-shutdown
    isShuttingDown = true;

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
    // Do NOT exit — unhandled rejections are recoverable.
    // The heartbeat will detect any WhatsApp disconnection.
});

process.on('uncaughtException', (err) => {
    logger.error('FATAL: Uncaught exception — process will exit', {
        error: err.message,
        stack: err.stack,
    });
    // Per Node.js docs, continuing after uncaughtException is unsafe.
    // Give the logger time to flush, then exit.
    // Render (or Docker) will restart the process automatically.
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
    memoryLimitMB: process.env.NODE_OPTIONS || 'default',
    startedAt: new Date().toISOString(),
});

// Start HTTP server FIRST — this ensures Render's health check
// gets a response immediately, preventing premature process kills.
const server = app.listen(config.port, () => {
    logger.info(`Server listening on port ${config.port}`);

    // THEN initialize the WhatsApp client.
    // forceNew: false → reuses existing LocalAuth session from disk.
    // This means no QR re-scan is needed after restarts/deploys.
    logger.info('Starting WhatsApp client initialization (session reuse enabled)...');
    whatsapp.initializeClient({ forceNew: false });
});