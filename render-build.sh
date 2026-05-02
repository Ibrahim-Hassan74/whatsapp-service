#!/usr/bin/env bash
set -o errexit

echo "==> Installing dependencies..."
npm install

echo "==> Installing Chromium for Puppeteer..."
export PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p "$PUPPETEER_CACHE_DIR"
npx puppeteer browsers install chrome

echo "==> Chromium installed at: $PUPPETEER_CACHE_DIR"
ls -R "$PUPPETEER_CACHE_DIR" | head -20

echo "==> Build complete!"
