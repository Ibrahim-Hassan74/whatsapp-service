# ──────────────────────────────────────────────────────────────────
# WhatsApp Service — Production Dockerfile
# Uses system Chromium instead of bundled Puppeteer browser
# ──────────────────────────────────────────────────────────────────
FROM node:20-slim

# Install system Chromium and all required dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Prevent puppeteer from downloading its own Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# Point to system-installed Chromium
ENV CHROMIUM_PATH=/usr/bin/chromium
# Production mode
ENV NODE_ENV=production

# Create app directory
WORKDIR /app

# Copy dependency manifests first (layer caching)
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source
COPY . .

# Create sessions directory (will be mounted as volume)
RUN mkdir -p /app/sessions && chown -R node:node /app

# Run as non-root user
USER node

# Expose HTTP port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://localhost:5000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the service (no memory restriction — Azure B2ats v2 has 1GB RAM)
CMD ["node", "--max-old-space-size=384", "index.js"]
