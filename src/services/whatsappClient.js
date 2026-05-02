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
});

// ─── Module State ─────────────────────────────────────────────────
let client = null;
let state = State.DISCONNECTED;
let retryCount = 0;
let restartTimer = null;
let heartbeatTimer = null;
let initLock = false;              // Hard lock against concurrent init
let consecutiveHeartbeatFails = 0; // Track consecutive heartbeat failures
let lastReadyTimestamp = 0;        // Debounce restarts after connect

const HEARTBEAT_FAIL_THRESHOLD = 3;      // Failures before restart
const READY_GRACE_PERIOD_MS = 30000;      // 30s grace after becoming READY
const INIT_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes max for initialize()
const HEARTBEAT_STABILIZE_DELAY_MS = 15000; // Wait 15s after READY before heartbeat

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
        });

        if (!response.ok) {
            logger.warn('ASP.NET responded with error', {
                endpoint,
                status: response.status,
            });
        }
    } catch (err) {
        logger.error('Failed to reach ASP.NET backend', {
            endpoint,
            error: err.message,
        });
    }
}

// ─── Heartbeat ────────────────────────────────────────────────────
function startHeartbeat() {
    stopHeartbeat();
    consecutiveHeartbeatFails = 0;

    heartbeatTimer = setInterval(async () => {
        if (state !== State.CONNECTED || !client) return;

        try {
            const wState = await client.getState();
            if (wState === 'CONNECTED') {
                // Healthy — reset failure counter
                consecutiveHeartbeatFails = 0;
                return;
            }

            // Not CONNECTED but not necessarily fatal (e.g. OPENING, PAIRING)
            consecutiveHeartbeatFails++;
            logger.warn('Heartbeat: unexpected WhatsApp state', {
                wState,
                consecutiveFails: consecutiveHeartbeatFails,
                threshold: HEARTBEAT_FAIL_THRESHOLD,
            });

            if (consecutiveHeartbeatFails >= HEARTBEAT_FAIL_THRESHOLD) {
                logger.error('Heartbeat: too many consecutive failures — triggering reconnect');
                state = State.DISCONNECTED;
                consecutiveHeartbeatFails = 0;
                postToAspNet('/update-status', { isConnected: false });
                scheduleRestart('heartbeat-disconnect');
            }
        } catch (err) {
            consecutiveHeartbeatFails++;
            logger.warn('Heartbeat check failed', {
                error: err.message,
                consecutiveFails: consecutiveHeartbeatFails,
                threshold: HEARTBEAT_FAIL_THRESHOLD,
            });

            if (consecutiveHeartbeatFails >= HEARTBEAT_FAIL_THRESHOLD) {
                logger.error('Heartbeat: too many consecutive errors — triggering reconnect');
                state = State.DISCONNECTED;
                consecutiveHeartbeatFails = 0;
                postToAspNet('/update-status', { isConnected: false });
                scheduleRestart('heartbeat-error');
            }
        }
    }, config.heartbeatIntervalMs);
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

    // Base args that work on all platforms
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
        // Memory-saving flags for constrained environments (Render, Docker)
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--js-flags=--max-old-space-size=256',
    ];

    // These flags reduce memory but only work reliably on Linux (Docker)
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
        state = State.QR_PENDING;
        retryCount = 0;
        logger.info('QR code generated — waiting for scan');
        postToAspNet('/update-qr', { qrCode: qr });
    });

    // ── Ready ──
    newClient.on('ready', () => {
        state = State.CONNECTED;
        retryCount = 0;
        lastReadyTimestamp = Date.now();
        consecutiveHeartbeatFails = 0;
        logger.info('WhatsApp client is READY and connected', {
            pid: process.pid,
            uptime: Math.floor(process.uptime()),
        });
        postToAspNet('/update-status', { isConnected: true });

        // Delay heartbeat start to let the connection stabilize
        // This prevents false positives immediately after connect
        logger.info(`Heartbeat will start in ${HEARTBEAT_STABILIZE_DELAY_MS / 1000}s`);
        setTimeout(() => {
            if (state === State.CONNECTED) {
                startHeartbeat();
                logger.info('Heartbeat started');
            }
        }, HEARTBEAT_STABILIZE_DELAY_MS);
    });

    // ── Authenticated ──
    newClient.on('authenticated', () => {
        logger.info('WhatsApp client authenticated successfully (session loaded from disk)');
    });

    // ── Auth Failure ──
    newClient.on('auth_failure', (msg) => {
        state = State.DISCONNECTED;
        stopHeartbeat();
        logger.error('Authentication failure — will retry with fresh session', { message: msg });
        postToAspNet('/update-status', { isConnected: false });

        // Auth failures need a fresh session
        scheduleRestart('auth-failure', { forceNew: true });
    });

    // ── Disconnected ──
    newClient.on('disconnected', (reason) => {
        state = State.DISCONNECTED;
        stopHeartbeat();
        logger.warn('WhatsApp client disconnected', { reason });
        postToAspNet('/update-status', { isConnected: false });
        // Try to reconnect reusing the existing session first
        scheduleRestart('disconnect');
    });

    // ── Change State ──
    newClient.on('change_state', (newState) => {
        logger.info('WhatsApp state changed', { newState });
    });

    return newClient;
}

// ─── Helpers ──────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Destroy Client ───────────────────────────────────────────────
async function destroyClient() {
    stopHeartbeat();

    if (!client) return;

    try {
        await client.destroy();
        logger.info('Previous client destroyed');
    } catch (err) {
        logger.warn('Error destroying client (ignored)', { error: err.message });
    }

    client = null;

    // Give Chrome time to fully release resources before re-launching
    await sleep(2000);
}

// ─── Initialize ───────────────────────────────────────────────────
async function initializeClient({ forceNew = false } = {}) {
    // Hard lock — absolutely prevent concurrent initialization
    if (initLock) {
        logger.warn('initializeClient() called but init lock is held — skipping', {
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

        logger.info('Initializing WhatsApp client...', {
            attempt: retryCount + 1,
            forceNew,
            hasExistingClient: !!client,
        });

        // Wrap initialize() in a timeout to prevent hanging forever
        await Promise.race([
            client.initialize(),
            new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error(`Client initialization timed out after ${INIT_TIMEOUT_MS / 1000}s`)),
                    INIT_TIMEOUT_MS
                )
            ),
        ]);
    } catch (err) {
        state = State.DISCONNECTED;
        logger.error('Client initialization failed', {
            error: err.message,
            attempt: retryCount + 1,
            maxRetries: config.maxRetries,
        });

        if (retryCount < config.maxRetries) {
            scheduleRestart('init-failure');
        } else {
            logger.error('Max retries reached — giving up. Manual restart required.');
            postToAspNet('/update-status', { isConnected: false });
        }
    } finally {
        initLock = false;
    }
}

// ─── Schedule Restart (Exponential Backoff) ───────────────────────
function scheduleRestart(reason, { forceNew = false } = {}) {
    if (restartTimer || state === State.INITIALIZING || state === State.RECONNECTING) {
        logger.info('scheduleRestart() skipped — already pending or initializing', {
            reason,
            hasTimer: !!restartTimer,
            state,
        });
        return;
    }

    // Debounce: if we just became READY, don't restart for a grace period.
    // This prevents false restarts from transient post-connect instability.
    const timeSinceReady = Date.now() - lastReadyTimestamp;
    if (lastReadyTimestamp > 0 && timeSinceReady < READY_GRACE_PERIOD_MS) {
        logger.info('scheduleRestart() skipped — within grace period after READY', {
            reason,
            timeSinceReadyMs: timeSinceReady,
            gracePeriodMs: READY_GRACE_PERIOD_MS,
        });
        return;
    }

    retryCount++;
    // Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped)
    const delay = Math.min(5000 * Math.pow(2, retryCount - 1), 60000);

    logger.info('Scheduling restart', {
        reason,
        forceNew,
        attempt: retryCount,
        delaySeconds: delay / 1000,
    });

    restartTimer = setTimeout(() => {
        restartTimer = null;
        initializeClient({ forceNew });
    }, delay);
}

// ─── Graceful Shutdown ────────────────────────────────────────────
async function shutdown() {
    logger.info('Shutting down WhatsApp client...');
    stopHeartbeat();
    clearTimeout(restartTimer);

    try {
        if (client) {
            await client.destroy();
            logger.info('Client destroyed on shutdown');
        }
    } catch (err) {
        logger.warn('Error during shutdown', { error: err.message });
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
};
