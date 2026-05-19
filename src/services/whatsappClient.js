/**
 * WhatsApp Client Service
 *
 * Optimized for Azure B2ats v2 (2 vCPU, 1GB RAM).
 *
 * Key design decisions:
 * 1. Multi-process Chromium — 2 vCPUs can handle a separate renderer.
 *    This eliminates "detached Frame" and "auth timeout" errors that
 *    plagued single-process mode on low-CPU hosts.
 * 2. Gentle heartbeat — with proper CPU, getState() is reliable.
 *    5 consecutive failures required before triggering reconnect.
 * 3. Session reuse by default — never destroy sessions unless explicitly
 *    logged out or auth_failure occurs.
 * 4. Zombie detection — if the browser crashes, auto-recover by creating
 *    a fresh client while preserving the session on disk.
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
let heartbeatTimer = null;
let initLock = false;
let consecutiveHeartbeatFails = 0;
let lastReadyTimestamp = 0;
let isShuttingDown = false;

// ─── Constants ────────────────────────────────────────────────────
const MAX_RETRIES = config.maxRetries || 5;
const HEARTBEAT_FAIL_THRESHOLD = 5;        // 5 consecutive failures before action
const READY_GRACE_PERIOD_MS = 60000;       // 60s grace — no restarts after READY
const INIT_TIMEOUT_MS = 5 * 60 * 1000;    // 5 minutes max for initialize()
const MIN_RESTART_DELAY_MS = 10000;        // 10s between restarts
const MAX_RESTART_DELAY_MS = 120000;       // Max 2 minutes
const HEARTBEAT_INTERVAL_MS = config.heartbeatIntervalMs || 45000; // 45s
const HEARTBEAT_START_DELAY_MS = 30000;    // Wait 30s after READY before heartbeat

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
            signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
            logger.warn('ASP.NET responded with error', {
                endpoint,
                status: response.status,
            });
        }
    } catch (err) {
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

// ─── Heartbeat ────────────────────────────────────────────────────
function startHeartbeat() {
    stopHeartbeat();
    consecutiveHeartbeatFails = 0;

    heartbeatTimer = setInterval(async () => {
        if (state !== State.CONNECTED || !client || isShuttingDown) return;

        try {
            const wState = await client.getState();
            if (wState === 'CONNECTED') {
                consecutiveHeartbeatFails = 0;
                return;
            }

            consecutiveHeartbeatFails++;
            logger.warn('Heartbeat: unexpected WhatsApp state', {
                wState,
                consecutiveFails: consecutiveHeartbeatFails,
                threshold: HEARTBEAT_FAIL_THRESHOLD,
            });

            if (consecutiveHeartbeatFails >= HEARTBEAT_FAIL_THRESHOLD) {
                logger.error('Heartbeat: too many consecutive failures — triggering reconnect');
                consecutiveHeartbeatFails = 0;
                await markAsZombie('heartbeat-disconnect');
            }
        } catch (err) {
            // Only count non-transient errors
            if (isTransientError(err.message)) {
                logger.warn('Heartbeat: transient error (ignoring)', {
                    error: err.message,
                });
                return;
            }

            consecutiveHeartbeatFails++;
            logger.warn('Heartbeat check failed', {
                error: err.message,
                consecutiveFails: consecutiveHeartbeatFails,
                threshold: HEARTBEAT_FAIL_THRESHOLD,
            });

            if (consecutiveHeartbeatFails >= HEARTBEAT_FAIL_THRESHOLD) {
                logger.error('Heartbeat: too many consecutive errors — triggering reconnect');
                consecutiveHeartbeatFails = 0;
                await markAsZombie('heartbeat-error');
            }
        }
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    consecutiveHeartbeatFails = 0;
}

// ─── Client Factory ───────────────────────────────────────────────
function createClient() {
    logger.info('Creating new WhatsApp client', {
        chromiumPath: config.chromiumPath,
        sessionPath: config.sessionDataPath,
    });

    // Balanced Chromium flags for Azure B2ats v2 (2 vCPU, 1GB RAM)
    // No longer ultra-aggressive — we have real CPU now
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
        // Memory optimization (still needed for 1GB RAM)
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--js-flags=--max-old-space-size=128',
        '--disable-features=TranslateUI',
        '--disable-canvas-aa',
        '--disable-remote-fonts',
        '--disable-permissions-api',
        '--disk-cache-size=10485760',
        '--media-cache-size=1',
        '--mute-audio',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-print-preview',
        '--no-pings',
        // Prevent Chromium profile lock errors on container restart
        '--user-data-dir=/tmp/chromium-profile',
    ];

    // Linux: --no-zygote saves memory.
    // NOTE: --single-process is NOT used — with 2 vCPUs we can afford
    // a separate renderer process, which is MUCH more stable.
    if (isLinux) {
        puppeteerArgs.push('--no-zygote');
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

        // Start heartbeat after a stabilization delay
        logger.info(`Heartbeat will start in ${HEARTBEAT_START_DELAY_MS / 1000}s`);
        setTimeout(() => {
            if (state === State.CONNECTED && !isShuttingDown) {
                startHeartbeat();
                logger.info('Heartbeat started', {
                    intervalMs: HEARTBEAT_INTERVAL_MS,
                    failThreshold: HEARTBEAT_FAIL_THRESHOLD,
                });
            }
        }, HEARTBEAT_START_DELAY_MS);
    });

    // ── Authenticated ──
    newClient.on('authenticated', () => {
        logger.info('WhatsApp client authenticated (session restored from disk)');
    });

    // ── Auth Failure ──
    newClient.on('auth_failure', (msg) => {
        if (isShuttingDown) return;
        state = State.DISCONNECTED;
        stopHeartbeat();
        logger.error('Authentication failure — session invalid, will create fresh session', {
            message: msg,
        });
        postToAspNet('/update-status', { isConnected: false });
        scheduleRestart('auth-failure', { forceNew: true });
    });

    // ── Disconnected ──
    newClient.on('disconnected', (reason) => {
        if (isShuttingDown) return;
        state = State.DISCONNECTED;
        stopHeartbeat();
        logger.warn('WhatsApp client disconnected', { reason });
        postToAspNet('/update-status', { isConnected: false });

        if (reason === 'NAVIGATION') {
            logger.info('Disconnected due to NAVIGATION — not restarting (transient)');
            return;
        }

        scheduleRestart('disconnect');
    });

    // ── Change State ──
    newClient.on('change_state', (newState) => {
        logger.info('WhatsApp state changed', { newState });
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
 * Destroys the broken client and schedules a soft reconnect.
 * LocalAuth session data persists on disk → no new QR scan needed.
 */
async function markAsZombie(reason) {
    if (isShuttingDown || state !== State.CONNECTED) return;
    logger.warn('Client marked as zombie — destroying broken client', { reason });
    state = State.DISCONNECTED;
    stopHeartbeat();
    postToAspNet('/update-status', { isConnected: false });

    await destroyClient();
    scheduleRestart(`zombie-${reason}`);
}

// ─── Destroy Client ───────────────────────────────────────────────
async function destroyClient() {
    stopHeartbeat();

    if (!client) return;

    try {
        await Promise.race([
            client.destroy(),
            sleep(5000),
        ]);
        logger.info('Previous client destroyed');
    } catch (err) {
        logger.warn('Error destroying client (ignored)', { error: err.message });
    }

    client = null;
    await sleep(3000);
}

// ─── Initialize ───────────────────────────────────────────────────
async function initializeClient({ forceNew = false } = {}) {
    if (isShuttingDown) {
        logger.warn('initializeClient() blocked — service is shutting down');
        return;
    }

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

        await Promise.race([
            client.initialize(),
            new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error(`Client init timed out after ${INIT_TIMEOUT_MS / 1000}s`)),
                    INIT_TIMEOUT_MS
                )
            ),
        ]);
    } catch (err) {
        state = State.DISCONNECTED;

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
    if (isShuttingDown) {
        logger.info('scheduleRestart() blocked — shutting down', { reason });
        return;
    }

    if (restartTimer) {
        logger.info('scheduleRestart() skipped — restart already pending', { reason });
        return;
    }

    if (state === State.INITIALIZING || state === State.RECONNECTING) {
        logger.info('scheduleRestart() skipped — init in progress', { reason });
        return;
    }

    const timeSinceReady = Date.now() - lastReadyTimestamp;
    if (lastReadyTimestamp > 0 && timeSinceReady < READY_GRACE_PERIOD_MS) {
        logger.info('scheduleRestart() skipped — within grace period after READY', {
            reason,
            timeSinceReadyMs: timeSinceReady,
        });
        return;
    }

    if (retryCount >= MAX_RETRIES) {
        logger.error('scheduleRestart() blocked — max retries reached', {
            reason,
            retryCount,
        });
        return;
    }

    retryCount++;
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
    isShuttingDown = true;
    state = State.SHUTTING_DOWN;

    logger.info('Shutting down WhatsApp client...');
    stopHeartbeat();

    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }

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
