#!/usr/bin/env bash
set -o errexit

echo "==> Installing dependencies..."
npm install

echo "==> Installing Chromium for Puppeteer..."
# Install Chrome INTO the project directory so it ships with the deploy
# (Render's /opt/render/.cache/ may not persist into the runtime)
export PUPPETEER_CACHE_DIR="$(pwd)/.cache/puppeteer"
mkdir -p "$PUPPETEER_CACHE_DIR"
npx puppeteer browsers install chrome

echo "==> Chromium installed at: $PUPPETEER_CACHE_DIR"
find "$PUPPETEER_CACHE_DIR" -name "chrome" -type f 2>/dev/null || echo "(no binary found via find)"

echo "==> Build complete!"
