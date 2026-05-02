require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ─── Puppeteer Cache Scanner ──────────────────────────────────────
// Finds Chrome binary inside Puppeteer's versioned cache directory
// e.g. /opt/render/.cache/puppeteer/chrome/linux-131.0.6778.85/chrome-linux64/chrome
function findChromeInPuppeteerCache(cacheDir) {
    if (!cacheDir || !fs.existsSync(cacheDir)) return null;

    const chromeDir = path.join(cacheDir, 'chrome');
    if (!fs.existsSync(chromeDir)) return null;

    try {
        const versions = fs.readdirSync(chromeDir);
        for (const version of versions) {
            const candidates = [
                path.join(chromeDir, version, 'chrome-linux64', 'chrome'),
                path.join(chromeDir, version, 'chrome-linux', 'chrome'),
                path.join(chromeDir, version, 'chrome-win64', 'chrome.exe'),
                path.join(chromeDir, version, 'chrome-win', 'chrome.exe'),
            ];
            for (const candidate of candidates) {
                if (fs.existsSync(candidate)) return candidate;
            }
        }
    } catch {
        // Ignore read errors
    }

    return null;
}

// ─── Chromium Path Auto-Detection ─────────────────────────────────
function detectChromiumPath() {
    const debug = (msg) => console.log(`[chromium-detect] ${msg}`);

    // 1. Explicit env var takes priority
    if (process.env.CHROMIUM_PATH) {
        debug(`Using CHROMIUM_PATH env var: ${process.env.CHROMIUM_PATH}`);
        return process.env.CHROMIUM_PATH;
    }

    // 2. Puppeteer cache directories (project-local first, then system)
    const projectRoot = path.resolve(__dirname, '..', '..');
    const puppeteerCacheDirs = [
        path.join(projectRoot, '.cache', 'puppeteer'),           // Project-local (render-build.sh)
        process.env.PUPPETEER_CACHE_DIR,                          // Explicit env var
        '/opt/render/.cache/puppeteer',                           // Render system cache
        '/opt/render/project/src/.cache/puppeteer',               // Render project path
        path.join(process.env.HOME || '', '.cache', 'puppeteer'), // User home cache
    ];

    for (const cacheDir of puppeteerCacheDirs) {
        if (!cacheDir) continue;
        debug(`Scanning cache: ${cacheDir} (exists: ${fs.existsSync(cacheDir)})`);
        const found = findChromeInPuppeteerCache(cacheDir);
        if (found) {
            debug(`Found Chrome in cache: ${found}`);
            return found;
        }
    }

    // 3. Docker / Linux — system Chromium
    const linuxPaths = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
    ];

    // 4. Windows — common Chrome locations
    const windowsPaths = [
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];

    // 5. macOS
    const macPaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];

    const candidates = [...linuxPaths, ...windowsPaths, ...macPaths];

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            debug(`Found system Chrome: ${candidate}`);
            return candidate;
        }
    }

    debug('No Chrome/Chromium binary found anywhere!');
    debug(`Project root: ${projectRoot}`);
    debug(`HOME: ${process.env.HOME}`);
    debug(`CWD: ${process.cwd()}`);
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
