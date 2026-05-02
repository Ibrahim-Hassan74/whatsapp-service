require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ─── Chromium Path Auto-Detection ─────────────────────────────────
function detectChromiumPath() {
    // 1. Explicit env var takes priority
    if (process.env.CHROMIUM_PATH) {
        return process.env.CHROMIUM_PATH;
    }

    // 2. Docker / Linux — system Chromium
    const linuxPaths = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
    ];

    // 3. Windows — common Chrome locations
    const windowsPaths = [
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];

    // 4. macOS
    const macPaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];

    const candidates = [...linuxPaths, ...windowsPaths, ...macPaths];

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

// ─── Validate Required Env Vars ───────────────────────────────────
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        console.error(`❌ Missing required environment variable: ${name}`);
        console.error(`   Please set it in your .env file or environment.`);
        process.exit(1);
    }
    return value;
}

// ─── Build Config ─────────────────────────────────────────────────
const chromiumPath = detectChromiumPath();

if (!chromiumPath) {
    console.error('❌ Chromium/Chrome not found!');
    console.error('   Set CHROMIUM_PATH in your .env or install Chrome/Chromium.');
    console.error('   In Docker, this is handled automatically.');
    process.exit(1);
}

const config = Object.freeze({
    // Server
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 5000,
    logLevel: process.env.LOG_LEVEL || 'info',

    // ASP.NET Integration
    aspNetBaseUrl: requireEnv('ASP_NET_BASE_URL'),
    nodeToken: requireEnv('NODE_TOKEN'),
    serverName: requireEnv('SERVER_NAME'),

    // WhatsApp / Puppeteer
    sessionDataPath: process.env.SESSION_DATA_PATH || './sessions',
    chromiumPath,

    // Reconnection
    maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 5,
    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10) || 30000,

    // Derived
    isProduction: (process.env.NODE_ENV || 'development') === 'production',
});

module.exports = config;
