/**
 * WhatsApp Client Service
 *
 * Designed for stability on Render Free/Starter plans (512MB RAM, limited CPU).
 *
 * Key design decisions for low-resource environments:
 * 1. NO active heartbeat polling — client.getState() talks to Chromium which
 *    can be unresponsive under low resources, causing false disconnects.
 *    Instead, we rely on whatsapp-web.js's built-in events (disconnected,
 *    change_state, auth_failure) to detect real problems.
 * 2. Session reuse by default — never destroy sessions unless explicitly
 *    logged out or auth_failure occurs.
 * 3. Conservative restart policy — long cooldowns, max retry cap, and
 *    a shutdown flag to prevent restarts during SIGTERM.
 * 4. Single-process Chromium — essential to stay under 512MB.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('../config');
const logger = require('../utils/logger');
const os = require('os');

const isLinux = os.platform() === 'linux';

// ─── Client States ────────────────────────────────────────────────
const State = Object.freeze({
    DISCONNECTED: 'DISCONNECTED',
    INITIALIZING: 'INITIALIZING',
    QR_PENDING: 'QR_PENDING',
    CONNECTED: 'CONNECTED',
    RECONNECTING: 'RECONNECTING',
    SHUTTING_DOWN: 'SHUTTING_DOWN',
});

// ─── Module State ─────────────────────────────────────────────────
let client = null;
let state = State.DISCONNECTED;
let retryCount = 0;
let restartTimer = null;
let initLock = false;          // Hard lock against concurrent init
let lastReadyTimestamp = 0;    // Debounce restarts after connect
let isShuttingDown = false;    // Prevents any restart during shutdown

// ─── Constants ────────────────────────────────────────────────────
const MAX_RETRIES = config.maxRetries || 5;
const READY_GRACE_PERIOD_MS = 60000;      // 60s grace — no restarts after READY
const INIT_TIMEOUT_MS = 5 * 60 * 1000;    // 5 minutes max for initialize()
const MIN_RESTART_DELAY_MS = 15000;        // Minimum 15s between restarts
const MAX_RESTART_DELAY_MS = 120000;       // Max 2 minutes between restarts

// Transient Puppeteer errors that should NOT crash the process
const TRANSIENT_ERRORS = [
    'Target closed',
    'Session closed',
    'Protocol error',
    'Navigation failed',
    'Execution context was destroyed',
    'Cannot find context',
    'frame was detached',
    'Page crashed',
    'auth timeout',
    'detached Frame',
    'Attempted to use detached Frame',
];

function isTransientError(errorMessage) {
    if (!errorMessage) return false;
    return TRANSIENT_ERRORS.some((t) => errorMessage.includes(t));
}

// ─── ASP.NET Backend Communication ────────────────────────────────
async function postToAspNet(endpoint, data) {
    try {
        const url = `${config.aspNetBaseUrl}/api/WhatsApp${endpoint}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-node-token': config.nodeToken,
                'x-server-name': config.serverName,
            },
            body: JSON.stringify(data),
            signal: AbortSignal.timeout(10000), // 10s timeout for backend calls
        });

        if (!response.ok) {
            logger.warn('ASP.NET responded with error', {
                endpoint,
                status: response.status,
            });
        }
    } catch (err) {
        // Backend communication failures are non-fatal — just log
        logger.warn('Failed to reach ASP.NET backend', {
            endpoint,
            error: err.message,
        });
    }
}

// ─── Memory Logging ───────────────────────────────────────────────
function logMemory(context) {
    const mem = process.memoryUsage();
    logger.info(`Memory usage [${context}]`, {
        rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
    });
}

// ─── Client Factory ───────────────────────────────────────────────
function createClient() {
    logger.info('Creating new WhatsApp client', {
        chromiumPath: config.chromiumPath,
        sessionPath: config.sessionDataPath,
    });

    // Maximum memory optimization for Render Free/Starter (512MB total)
    // Memory budget: Node.js ~80MB + Chromium ~250MB = ~330MB (leaves ~180MB buffer)
    const puppeteerArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-software-rasterizer',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        // ── Critical memory flags ──
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--js-flags=--max-old-space-size=64',
        '--disable-features=site-per-process,TranslateUI,BlinkGenPropertyTrees',
        '--renderer-process-limit=1',
        '--disable-canvas-aa',
        '--disable-2d-canvas-clip-aa',
        '--disable-gl-drawing-for-tests',
        '--disable-font-subpixel-positioning',
        '--disable-remote-fonts',
        '--disable-logging',
        '--disable-permissions-api',
        '--aggressive-cache-discard',
        '--disk-cache-size=1',
        '--media-cache-size=1',
        '--disable-ipc-flooding-protection',
        '--mute-audio',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-print-preview',
        '--no-pings',
        // Force Chromium to use a temp dir for its internal profile.
        // This prevents "profile in use" lock errors on container restart.
        // LocalAuth session data is stored separately in SESSION_DATA_PATH.
        '--user-data-dir=/tmp/chromium-profile',
    ];

    // Linux: --single-process + --no-zygote saves ~100-150MB
    if (isLinux) {
        puppeteerArgs.push('--no-zygote', '--single-process');
    }

    const newClient = new Client({
        authStrategy: new LocalAuth({ dataPath: config.sessionDataPath }),
        puppeteer: {
            headless: true,
            executablePath: config.chromiumPath,
            args: puppeteerArgs,
        },
    });

    // ── QR Code ──
    newClient.on('qr', (qr) => {
        if (isShuttingDown) return;
        state = State.QR_PENDING;
        retryCount = 0;
        logger.info('QR code generated — waiting for scan');
        postToAspNet('/update-qr', { qrCode: qr });
    });

    // ── Ready ──
    newClient.on('ready', () => {
        if (isShuttingDown) return;
        state = State.CONNECTED;
        retryCount = 0;
        lastReadyTimestamp = Date.now();
        logMemory('READY');
        logger.info('WhatsApp client is READY and connected', {
            pid: process.pid,
            uptime: Math.floor(process.uptime()),
        });
        postToAspNet('/update-status', { isConnected: true });
        // NO heartbeat — we rely entirely on event-driven detection.
        // This avoids the #1 cause of false restarts on low-resource plans.
    });

    // ── Authenticated ──
    newClient.on('authenticated', () => {
        logger.info('WhatsApp client authenticated (session restored from disk)');
    });

    // ── Auth Failure ──
    // This is the ONLY case where we force a new session
    newClient.on('auth_failure', (msg) => {
        if (isShuttingDown) return;
        state = State.DISCONNECTED;
        logger.error('Authentication failure — session invalid, will create fresh session', {
            message: msg,
        });
        postToAspNet('/update-status', { isConnected: false });
        scheduleRestart('auth-failure', { forceNew: true });
    });

    // ── Disconnected ──
    // Real disconnect event from WhatsApp — try to reconnect with existing session
    newClient.on('disconnected', (reason) => {
        if (isShuttingDown) return;
        state = State.DISCONNECTED;
        logger.warn('WhatsApp client disconnected', { reason });
        postToAspNet('/update-status', { isConnected: false });

        // NAVIGATION is a known benign reason from whatsapp-web.js — skip restart
        if (reason === 'NAVIGATION') {
            logger.info('Disconnected due to NAVIGATION — not restarting (transient)');
            return;
        }

        scheduleRestart('disconnect');
    });

    // ── Change State ──
    newClient.on('change_state', (newState) => {
        logger.info('WhatsApp state changed', { newState });
        // TIMEOUT means WhatsApp lost connection — trigger soft reconnect
        if (newState === 'TIMEOUT' && state === State.CONNECTED && !isShuttingDown) {
            logger.warn('WhatsApp state TIMEOUT detected — will soft reconnect');
            markAsZombie('change_state_timeout');
        }
    });

    return newClient;
}

// ─── Helpers ──────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mark the client as a "zombie" — it thinks it's connected but the browser
 * is actually broken (detached frame, auth timeout, etc).
 * Triggers a soft reconnect (reuses session, does NOT force new QR).
 */
function markAsZombie(reason) {
    if (isShuttingDown || state !== State.CONNECTED) return;
    logger.warn('Client marked as zombie — scheduling soft reconnect', { reason });
    state = State.DISCONNECTED;
    postToAspNet('/update-status', { isConnected: false });
    scheduleRestart(`zombie-${reason}`);
}

// ─── Destroy Client ───────────────────────────────────────────────
async function destroyClient() {
    if (!client) return;

    try {
        await Promise.race([
            client.destroy(),
            sleep(5000), // Don't hang more than 5s trying to destroy
        ]);
        logger.info('Previous client destroyed');
    } catch (err) {
        logger.warn('Error destroying client (ignored)', { error: err.message });
    }

    client = null;

    // Give Chrome time to fully release resources
    await sleep(3000);
}

// ─── Initialize ───────────────────────────────────────────────────
async function initializeClient({ forceNew = false } = {}) {
    // Block all init during shutdown
    if (isShuttingDown) {
        logger.warn('initializeClient() blocked — service is shutting down');
        return;
    }

    // Hard lock — prevent concurrent initialization
    if (initLock) {
        logger.warn('initializeClient() blocked — init lock held', {
            currentState: state,
        });
        return;
    }

    if (state === State.INITIALIZING || state === State.RECONNECTING) {
        logger.warn('Client initialization already in progress — skipping');
        return;
    }

    initLock = true;
    state = forceNew ? State.INITIALIZING : State.RECONNECTING;
    clearTimeout(restartTimer);
    restartTimer = null;

    try {
        if (forceNew || !client) {
            await destroyClient();
            client = createClient();
        }

        logMemory('pre-init');
        logger.info('Initializing WhatsApp client...', {
            attempt: retryCount + 1,
            forceNew,
        });

        // Wrap initialize() in a timeout to prevent hanging forever
        await Promise.race([
            client.initialize(),
            new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error(`Client init timed out after ${INIT_TIMEOUT_MS / 1000}s`)),
                    INIT_TIMEOUT_MS
                )
            ),
        ]);

        // If we get here without the ready event, state may still be
        // INITIALIZING. That's fine — the ready event will set CONNECTED.
    } catch (err) {
        state = State.DISCONNECTED;

        // Don't restart on transient Puppeteer errors if we just connected
        if (isTransientError(err.message)) {
            logger.warn('Client init hit transient error (not restarting)', {
                error: err.message,
            });
            return;
        }

        logger.error('Client initialization failed', {
            error: err.message,
            attempt: retryCount + 1,
            maxRetries: MAX_RETRIES,
        });

        if (retryCount < MAX_RETRIES) {
            scheduleRestart('init-failure');
        } else {
            logger.error('Max retries reached — service will stay idle. Use /restart to try again.');
            postToAspNet('/update-status', { isConnected: false });
        }
    } finally {
        initLock = false;
    }
}

// ─── Schedule Restart (Exponential Backoff) ───────────────────────
function scheduleRestart(reason, { forceNew = false } = {}) {
    // Never restart during shutdown
    if (isShuttingDown) {
        logger.info('scheduleRestart() blocked — shutting down', { reason });
        return;
    }

    if (restartTimer) {
        logger.info('scheduleRestart() skipped — restart already pending', {
            reason,
        });
        return;
    }

    if (state === State.INITIALIZING || state === State.RECONNECTING) {
        logger.info('scheduleRestart() skipped — init in progress', { reason });
        return;
    }

    // Grace period: if we just became READY, don't restart for 60s
    const timeSinceReady = Date.now() - lastReadyTimestamp;
    if (lastReadyTimestamp > 0 && timeSinceReady < READY_GRACE_PERIOD_MS) {
        logger.info('scheduleRestart() skipped — within grace period after READY', {
            reason,
            timeSinceReadyMs: timeSinceReady,
            gracePeriodMs: READY_GRACE_PERIOD_MS,
        });
        return;
    }

    // Check retry cap
    if (retryCount >= MAX_RETRIES) {
        logger.error('scheduleRestart() blocked — max retries reached', {
            reason,
            retryCount,
            maxRetries: MAX_RETRIES,
        });
        return;
    }

    retryCount++;
    // Exponential backoff: 15s, 30s, 60s, 120s (capped)
    const delay = Math.min(MIN_RESTART_DELAY_MS * Math.pow(2, retryCount - 1), MAX_RESTART_DELAY_MS);

    logger.info('Scheduling restart', {
        reason,
        forceNew,
        attempt: retryCount,
        delaySeconds: delay / 1000,
    });

    restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!isShuttingDown) {
            initializeClient({ forceNew });
        }
    }, delay);
}

// ─── Graceful Shutdown ────────────────────────────────────────────
async function shutdown() {
    // Set flags FIRST to block all restarts / re-init
    isShuttingDown = true;
    state = State.SHUTTING_DOWN;

    logger.info('Shutting down WhatsApp client...');

    // Cancel any pending restart
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }

    // Destroy client with timeout
    try {
        if (client) {
            await Promise.race([
                client.destroy(),
                sleep(5000),
            ]);
            logger.info('Client destroyed on shutdown');
        }
    } catch (err) {
        logger.warn('Error during shutdown (ignored)', { error: err.message });
    }

    state = State.DISCONNECTED;
    client = null;
}

// ─── Public API ───────────────────────────────────────────────────
function getClient() {
    return client;
}

function getState() {
    return state;
}

function isReady() {
    return state === State.CONNECTED && client !== null;
}

function resetRetries() {
    retryCount = 0;
}

module.exports = {
    State,
    initializeClient,
    destroyClient,
    shutdown,
    getClient,
    getState,
    isReady,
    resetRetries,
    postToAspNet,
    markAsZombie,
};
