const express = require('express');
const logger = require('../utils/logger');
const whatsapp = require('../services/whatsappClient');

const router = express.Router();

// ─── Health Check ─────────────────────────────────────────────────
router.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();

    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        memory: {
            rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        },
        whatsapp: {
            state: whatsapp.getState(),
            ready: whatsapp.isReady(),
        },
        timestamp: new Date().toISOString(),
    });
});

// ─── Send Message ─────────────────────────────────────────────────
router.post('/send', async (req, res) => {
    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields: number, message',
        });
    }

    if (!whatsapp.isReady()) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready',
            state: whatsapp.getState(),
        });
    }

    try {
        const client = whatsapp.getClient();
        const chatId = `${number}@c.us`;

        await client.sendMessage(chatId, message);

        logger.info('Message sent successfully', { number: number.slice(-4) });
        res.json({ success: true });
    } catch (err) {
        logger.error('Failed to send message', {
            error: err.message,
            number: number.slice(-4),
        });
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

// ─── Client Status ────────────────────────────────────────────────
router.get('/status', async (req, res) => {
    try {
        const client = whatsapp.getClient();

        if (!client) {
            return res.json({
                connected: false,
                state: whatsapp.getState(),
            });
        }

        let wState = null;
        try {
            wState = await client.getState();
        } catch {
            // getState() can throw if client is not fully initialized
        }

        res.json({
            connected: wState === 'CONNECTED',
            state: wState || whatsapp.getState(),
        });
    } catch (err) {
        logger.error('Error getting status', { error: err.message });
        res.json({ connected: false, state: 'ERROR' });
    }
});

// ─── Logout ───────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
    try {
        logger.info('Logout requested');

        const client = whatsapp.getClient();
        if (client) {
            await client.logout();
        }

        whatsapp.resetRetries();
        await whatsapp.initializeClient({ forceNew: true });

        res.json({ success: true, message: 'Logged out and reinitializing' });
    } catch (err) {
        logger.error('Logout failed', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Restart Client ───────────────────────────────────────────────
router.post('/restart', async (req, res) => {
    try {
        logger.info('Manual restart requested');

        whatsapp.resetRetries();
        await whatsapp.initializeClient({ forceNew: true });

        res.json({ success: true, message: 'Client restart initiated' });
    } catch (err) {
        logger.error('Restart failed', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
