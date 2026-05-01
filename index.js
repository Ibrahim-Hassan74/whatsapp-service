require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const ASP_NET_BASE_URL = process.env.ASP_NET_BASE_URL;
const NODE_TOKEN = process.env.NODE_TOKEN;
const SERVER_NAME = process.env.SERVER_NAME;
const PORT = process.env.PORT || 5000;

let client = null;
let isClientReady = false;
let isInitializing = false;
let restartTimer = null;

async function postToAspNet(endpoint, data) {
    try {
        await fetch(`${ASP_NET_BASE_URL}/api/WhatsApp${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-node-token': NODE_TOKEN,
                'x-server-name': SERVER_NAME
            },
            body: JSON.stringify(data)
        });
    } catch (e) {
        console.error(`Failed to reach ASP.NET: ${endpoint}`, e.message);
    }
}

function createClient() {
    const nextClient = new Client({
        authStrategy: new LocalAuth({ dataPath: './sessions' }),
        puppeteer: {
            headless: true,
            executablePath: puppeteer.executablePath(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        }
    });

    nextClient.on('qr', (qr) => {
        console.log('QR Generated');
        postToAspNet('/update-qr', { qrCode: qr });
    });

    nextClient.on('ready', () => {
        isClientReady = true;
        console.log('WhatsApp READY');
        postToAspNet('/update-status', { isConnected: true });
    });

    nextClient.on('auth_failure', (msg) => {
        isClientReady = false;
        console.error('Auth failure:', msg);
        postToAspNet('/update-status', { isConnected: false });
    });

    nextClient.on('disconnected', (reason) => {
        isClientReady = false;
        console.log('Disconnected:', reason);
        postToAspNet('/update-status', { isConnected: false });
        scheduleRestart('disconnect');
    });

    return nextClient;
}

async function destroyClient() {
    if (!client) return;
    try {
        await client.destroy();
    } catch (err) {
        console.warn('Destroy error ignored:', err.message);
    }
}

async function initializeClient({ forceNew = false, retry = 0 } = {}) {
    if (isInitializing) return;

    isInitializing = true;
    clearTimeout(restartTimer);

    try {
        if (forceNew || !client) {
            await destroyClient();
            client = createClient();
        }

        console.log('Initializing WhatsApp...');
        await client.initialize();
    } catch (err) {
        isClientReady = false;
        console.error('Init failed:', err.message);

        if (retry < 3) {
            const delay = 3000 * (retry + 1);
            console.log(`Retry in ${delay / 1000}s`);

            restartTimer = setTimeout(() => {
                initializeClient({ forceNew: true, retry: retry + 1 });
            }, delay);
        } else {
            postToAspNet('/update-status', { isConnected: false });
        }
    } finally {
        isInitializing = false;
    }
}

function scheduleRestart(reason) {
    if (restartTimer || isInitializing) return;

    console.log(`Restart scheduled due to ${reason}`);
    restartTimer = setTimeout(() => {
        initializeClient({ forceNew: true });
    }, 5000);
}

app.use((req, res, next) => {
    if (req.path === '/health') return next();

    const token = req.headers['x-node-token'];
    const server = req.headers['x-server-name'];

    if (token !== NODE_TOKEN || server !== SERVER_NAME) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
});

app.post('/send', async (req, res) => {
    const { number, message } = req.body;

    if (!number || !message)
        return res.status(400).json({ error: 'Invalid payload' });

    if (!isClientReady || !client)
        return res.status(503).json({ error: 'Client not ready' });

    try {
        await client.sendMessage(`${number}@c.us`, message);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/status', async (req, res) => {
    try {
        if (!client) {
            return res.json({ connected: false, state: 'INIT' });
        }

        const state = await client.getState();

        res.json({
            connected: state === 'CONNECTED',
            state
        });
    } catch {
        res.json({ connected: false });
    }
});

app.post('/logout', async (req, res) => {
    try {
        isClientReady = false;

        if (client) {
            await client.logout();
        }

        await initializeClient({ forceNew: true });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled:', reason?.message || reason);
    isClientReady = false;
    scheduleRestart('error');
});

initializeClient({ forceNew: true });

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});