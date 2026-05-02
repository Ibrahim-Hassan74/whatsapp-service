# Deployment Guide — WhatsApp Service

Production-ready deployment instructions for all supported platforms.

---

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **Docker** (optional but recommended for production)
- **Git** for version control

---

## 1. Local Development (Windows / macOS)

```bash
# Clone and install
git clone <your-repo-url>
cd whatsapp

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your values (ASP_NET_BASE_URL, NODE_TOKEN, etc.)

# Start in dev mode
npm run dev
```

> **Note:** Chrome/Chromium is auto-detected on your system. If you have Chrome installed in a non-standard location, set `CHROMIUM_PATH` in your `.env`.

---

## 2. Docker (Recommended for Production)

### Build & Run

```bash
# Build and start
docker compose up -d --build

# View logs
docker compose logs -f whatsapp

# Stop
docker compose down

# Restart (preserves sessions)
docker compose restart
```

### Session Persistence

Sessions are stored in a Docker volume (`whatsapp_sessions`). Your WhatsApp authentication persists across:
- Container restarts (`docker compose restart`)
- Rebuilds (`docker compose up -d --build`)
- Service stops/starts

To **wipe sessions** (force new QR scan):

```bash
docker compose down -v   # -v removes volumes
docker compose up -d --build
```

### Environment Variables

Set them in your `.env` file (it's loaded by `docker-compose.yml`):

```env
ASP_NET_BASE_URL=https://your-api.example.com
NODE_TOKEN=your-secure-token
SERVER_NAME=NODE_WHATSAPP_SERVICE
PORT=5000
```

---

## 3. Render.com

### Setup

1. Push your code to GitHub/GitLab
2. Create a new **Web Service** on Render
3. Connect your repository
4. Render auto-detects `render.yaml` — it will:
   - Build from `Dockerfile`
   - Attach a 1GB persistent disk at `/app/sessions`
   - Configure health checks

### Environment Variables

In the Render dashboard, set:

| Variable | Value |
|----------|-------|
| `ASP_NET_BASE_URL` | Your ASP.NET backend URL |
| `NODE_TOKEN` | Your shared secret token |
| `SERVER_NAME` | `NODE_WHATSAPP_SERVICE` |

### Auto-Deploy

Every `git push` to your default branch triggers an automatic rebuild and deploy.

### Important

> Render **requires a persistent disk** for WhatsApp session data. Without it, you'll need to re-scan the QR code after every deploy. The `render.yaml` handles this automatically.

---

## 4. Railway

### Setup

1. Push code to GitHub
2. Create a new project on Railway
3. Select **Deploy from GitHub repo**
4. Railway auto-detects the `Dockerfile`

### Add Volume

```bash
# In Railway CLI or Dashboard:
# Add a volume mounted at /app/sessions
```

In the Railway dashboard:
1. Go to your service → **Volumes**
2. Add a new volume
3. Mount path: `/app/sessions`

### Environment Variables

Add in the Railway dashboard:

```
NODE_ENV=production
ASP_NET_BASE_URL=https://your-api.example.com
NODE_TOKEN=your-secure-token
SERVER_NAME=NODE_WHATSAPP_SERVICE
SESSION_DATA_PATH=/app/sessions
PORT=5000
```

---

## 5. VPS (Ubuntu/Debian)

### Install Docker

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo apt install docker-compose-plugin -y

# Logout and login again for group changes
```

### Deploy

```bash
# Clone your repo
git clone <your-repo-url> /opt/whatsapp-service
cd /opt/whatsapp-service

# Configure
cp .env.example .env
nano .env   # Set your values

# Build and start
docker compose up -d --build

# Check status
docker compose ps
docker compose logs -f
```

### Auto-Deploy on Git Push

Create a simple deploy script at `/opt/whatsapp-service/deploy.sh`:

```bash
#!/bin/bash
cd /opt/whatsapp-service
git pull origin main
docker compose up -d --build
docker compose logs --tail=20
```

Then set up a webhook or cron, or use a CI/CD tool to call this script.

### Systemd Service (Alternative to Docker)

If you prefer running without Docker on a VPS:

```bash
# Install Chromium
sudo apt install -y chromium-browser

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Setup service
sudo nano /etc/systemd/system/whatsapp.service
```

```ini
[Unit]
Description=WhatsApp Service
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/whatsapp-service
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=CHROMIUM_PATH=/usr/bin/chromium-browser
EnvironmentFile=/opt/whatsapp-service/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable whatsapp
sudo systemctl start whatsapp
sudo systemctl status whatsapp

# View logs
sudo journalctl -u whatsapp -f
```

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | ❌ | Health check (uptime, memory, state) |
| `GET` | `/status` | ✅ | WhatsApp connection status |
| `POST` | `/send` | ✅ | Send a message |
| `POST` | `/logout` | ✅ | Logout and re-initialize |
| `POST` | `/restart` | ✅ | Force client restart |

### Authentication

All authenticated endpoints require these headers:

```
x-node-token: <your-NODE_TOKEN>
x-server-name: <your-SERVER_NAME>
```

### Example: Send Message

```bash
curl -X POST http://localhost:5000/send \
  -H "Content-Type: application/json" \
  -H "x-node-token: your-token" \
  -H "x-server-name: NODE_WHATSAPP_SERVICE" \
  -d '{"number": "1234567890", "message": "Hello from the API!"}'
```

---

## Troubleshooting

### "Chrome not found" Error

- **Docker:** Should never happen — Chromium is installed in the image
- **Local:** Set `CHROMIUM_PATH` in `.env` to your Chrome installation path
- **VPS:** Install Chromium: `sudo apt install chromium-browser`

### QR Code Not Appearing

1. Check logs: `docker compose logs -f`
2. Verify `ASP_NET_BASE_URL` is correct and reachable
3. Try restarting: `POST /restart`

### Session Lost After Restart

- **Docker:** Ensure the volume is mounted (`docker volume ls`)
- **Render:** Ensure persistent disk is attached in `render.yaml`
- **VPS:** Ensure the `sessions` directory is writable

### High Memory Usage

Chromium is memory-hungry. Recommended minimums:
- **512MB RAM** for basic operation
- **1GB RAM** for reliable production use
- The `--single-process` flag reduces memory but may impact stability
