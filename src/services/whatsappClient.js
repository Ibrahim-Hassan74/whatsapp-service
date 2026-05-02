const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('../config');
const logger = require('../utils/logger');

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
    heartbeatTimer = setInterval(async () => {
        if (state !== State.CONNECTED || !client) return;

        try {
            const wState = await client.getState();
            if (wState !== 'CONNECTED') {
                logger.warn('Heartbeat detected disconnected state', { wState });
                state = State.DISCONNECTED;
                postToAspNet('/update-status', { isConnected: false });
                scheduleRestart('heartbeat-disconnect');
            }
        } catch (err) {
            logger.warn('Heartbeat check failed', { error: err.message });
            state = State.DISCONNECTED;
            postToAspNet('/update-status', { isConnected: false });
            scheduleRestart('heartbeat-error');
        }
    }, config.heartbeatIntervalMs);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// ─── Client Factory ───────────────────────────────────────────────
function createClient() {
    logger.info('Creating new WhatsApp client', {
        chromiumPath: config.chromiumPath,
        sessionPath: config.sessionDataPath,
    });

    const newClient = new Client({
        authStrategy: new LocalAuth({ dataPath: config.sessionDataPath }),
        puppeteer: {
            headless: true,
            executablePath: config.chromiumPath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-software-rasterizer',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
            ],
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
        logger.info('WhatsApp client is READY and connected');
        postToAspNet('/update-status', { isConnected: true });
        startHeartbeat();
    });

    // ── Authenticated ──
    newClient.on('authenticated', () => {
        logger.info('WhatsApp client authenticated successfully');
    });

    // ── Auth Failure ──
    newClient.on('auth_failure', (msg) => {
        state = State.DISCONNECTED;
        stopHeartbeat();
        logger.error('Authentication failure', { message: msg });
        postToAspNet('/update-status', { isConnected: false });

        // Auth failures often need a fresh session
        scheduleRestart('auth-failure');
    });

    // ── Disconnected ──
    newClient.on('disconnected', (reason) => {
        state = State.DISCONNECTED;
        stopHeartbeat();
        logger.warn('WhatsApp client disconnected', { reason });
        postToAspNet('/update-status', { isConnected: false });
        scheduleRestart('disconnect');
    });

    // ── Change State ──
    newClient.on('change_state', (newState) => {
        logger.info('WhatsApp state changed', { newState });
    });

    return newClient;
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
}

// ─── Initialize ───────────────────────────────────────────────────
async function initializeClient({ forceNew = false } = {}) {
    if (state === State.INITIALIZING || state === State.RECONNECTING) {
        logger.warn('Client initialization already in progress — skipping');
        return;
    }

    state = forceNew ? State.INITIALIZING : State.RECONNECTING;
    clearTimeout(restartTimer);
    restartTimer = null;

    try {
        if (forceNew || !client) {
            await destroyClient();
            client = createClient();
        }

        logger.info('Initializing WhatsApp client...', { attempt: retryCount + 1 });
        await client.initialize();
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
    }
}

// ─── Schedule Restart (Exponential Backoff) ───────────────────────
function scheduleRestart(reason) {
    if (restartTimer || state === State.INITIALIZING || state === State.RECONNECTING) {
        return;
    }

    retryCount++;
    // Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped)
    const delay = Math.min(5000 * Math.pow(2, retryCount - 1), 60000);

    logger.info('Scheduling restart', {
        reason,
        attempt: retryCount,
        delaySeconds: delay / 1000,
    });

    restartTimer = setTimeout(() => {
        restartTimer = null;
        initializeClient({ forceNew: true });
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
