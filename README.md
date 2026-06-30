# WhatsApp Service — Node.js Messaging Engine

> A self-healing WhatsApp Web automation service using Puppeteer + whatsapp-web.js, designed for production deployment on Render with persistent sessions.

This service is the **engine** of Wasla's WhatsApp messaging pipeline. It manages a headless Chromium browser that automates WhatsApp Web, handling message delivery, QR code generation, session persistence, and automatic recovery from browser crashes.

---

## Table of Contents

- [Architecture](#architecture)
- [How It Works](#how-it-works)
- [State Machine](#state-machine)
- [Zombie Detection & Self-Healing](#zombie-detection--self-healing)
- [Graceful Shutdown](#graceful-shutdown)
- [API Endpoints](#api-endpoints)
- [Configuration](#configuration)
- [Chromium Auto-Detection](#chromium-auto-detection)
- [Docker Deployment](#docker-deployment)
- [Project Structure](#project-structure)

---

## Architecture

```mermaid
graph TB
    subgraph "WhatsApp Service (Node.js)"
        EXPRESS["Express HTTP Server (Port from ENV)"]
        WJS["whatsapp-web.js Client (WhatsApp Web Protocol)"]
        PUPPET["Puppeteer (Headless Chromium)"]
        HB["Heartbeat Timer (Every 45 seconds)"]
        LOGGER["Winston Logger (JSON prod / Color dev)"]
    end

    subgraph "External"
        SENDER["WhatsApp Sender API (ASP.NET Core)"]
        DISK[("Render Persistent Disk (Session Data)")]
        WHATSAPP["WhatsApp Web Servers"]
    end

    SENDER -->|POST /send| EXPRESS
    SENDER -->|GET /status| EXPRESS
    EXPRESS --> WJS
    WJS --> PUPPET
    PUPPET --> WHATSAPP
    WJS -->|Save session| DISK
    HB -->|getState check| WJS
    WJS -->|POST /qr-update| SENDER
    WJS -->|POST /update-status| SENDER

    style EXPRESS fill:#68A063,color:#fff
    style WJS fill:#25D366,color:#fff
    style PUPPET fill:#4285F4,color:#fff
```

### Communication Flow

```mermaid
sequenceDiagram
    participant Sender as WhatsApp Sender (ASP.NET Core)
    participant Service as This Service (Node.js)
    participant Chrome as Headless Chromium
    participant WA as WhatsApp Web

    Note over Service: Startup
    Service->>Service: Detect Chromium path
    Service->>Chrome: Launch headless browser
    Chrome->>WA: Connect to WhatsApp Web
    WA-->>Chrome: Generate QR code
    Chrome-->>Service: "qr" event
    Service->>Sender: POST /api/whatsapp/qr-update {qr}
    
    Note over Service: User scans QR
    WA-->>Chrome: Session authenticated
    Chrome-->>Service: "ready" event
    Service->>Sender: POST /api/whatsapp/update-status {connected: true}
    Service->>Service: Start heartbeat (45s interval)

    Note over Sender: OTP Request
    Sender->>Service: POST /send {number, message}
    Service->>Service: Validate x-node-token
    Service->>Chrome: client.sendMessage()
    Chrome->>WA: Deliver message
    Service-->>Sender: 200 OK {success: true}
```

---

## How It Works

1. **Startup**: The service detects the Chromium binary path (cross-platform auto-detection), launches a headless browser via Puppeteer, and initializes the whatsapp-web.js client.

2. **QR Generation**: WhatsApp Web generates a QR code. The service pushes it to the Sender API via `POST /api/whatsapp/qr-update`, which caches it and broadcasts to the Angular dashboard via SignalR.

3. **Authentication**: An admin scans the QR code with their phone. The service receives the `ready` event and notifies the Sender API that the connection is active.

4. **Message Delivery**: When an OTP is needed, the Sender API calls `POST /send` with the phone number and message. The service validates the `x-node-token` header and uses the whatsapp-web.js client to deliver the message.

5. **Session Persistence**: Session data is saved to disk (`SESSION_DATA_PATH`) so that restarts don't require a new QR scan.

---

## State Machine

```mermaid
stateDiagram-v2
    [*] --> INITIALIZING: Service starts
    INITIALIZING --> QR_PENDING: QR code generated
    INITIALIZING --> INITIALIZING: Retry (backoff)
    INITIALIZING --> ZOMBIE: Init timeout (5 min)
    
    QR_PENDING --> CONNECTED: User scans QR
    QR_PENDING --> INITIALIZING: QR expires
    
    CONNECTED --> CONNECTED: Heartbeat OK
    CONNECTED --> ZOMBIE: 5 consecutive heartbeat failures
    CONNECTED --> DISCONNECTED: "disconnected" event
    
    DISCONNECTED --> INITIALIZING: Auto-reconnect
    
    ZOMBIE --> DESTROYING: Destroy browser
    DESTROYING --> INITIALIZING: Exponential backoff
    
    CONNECTED --> SHUTTING_DOWN: SIGTERM/SIGINT
    SHUTTING_DOWN --> [*]: Session saved
```

---

## Zombie Detection & Self-Healing

```mermaid
flowchart TD
    A["Heartbeat Timer (Every 45 seconds)"] --> B{"client.getState()"}
    B -->|Success| C["Reset failure counter (failCount = 0)"]
    B -->|Error| D["Increment failCount"]
    D --> E{"failCount >= 5?"}
    E -->|No| A
    E -->|Yes| F["🧟 Mark as ZOMBIE"]
    F --> G["Destroy browser instance"]
    G --> H["Calculate backoff delay (10s to 120s max)"]
    H --> I["Wait delay"]
    I --> J["Re-initialize client (Reuse session from disk)"]
    J --> A
```

**Why this exists**: Puppeteer's Chromium can crash (OOM, detached frame, protocol errors) while the Node.js process stays alive. Without zombie detection, the service would appear healthy but be unable to send messages.

**Key parameters**:
- Heartbeat interval: **45 seconds**
- Failure threshold: **5 consecutive failures**
- Backoff: **10s → 20s → 40s → 80s → 120s (max)**
- Grace period after READY: **60 seconds** (prevents restart loops)
- Init hard timeout: **5 minutes**

---

## Graceful Shutdown

```mermaid
sequenceDiagram
    participant OS
    participant Node as Node.js Process
    participant WJS as WhatsApp Client
    participant HTTP as HTTP Server

    OS->>Node: SIGTERM / SIGINT
    Node->>Node: Set isShuttingDown = true
    Node->>WJS: 1. client.destroy()
    Note over WJS: Flush session data to disk
    WJS-->>Node: Session saved
    Node->>HTTP: 2. server.close()
    Note over HTTP: Stop accepting connections
    HTTP-->>Node: Server closed
    Node->>Node: 3. process.exit(0)
```

**Order matters**: If the HTTP server closes first, the hosting platform (Render) may kill the process before the WhatsApp session saves — forcing a new QR scan on restart.

---

## API Endpoints

| Method | Path | Auth | Description |
|:--|:--|:--|:--|
| POST | `/send` | x-node-token | Send a WhatsApp message |
| GET | `/status` | x-node-token | Get connection status & state |
| POST | `/health` | x-node-token | Trigger zombie detection check |

### POST `/send`

```json
// Request
{ "number": "201234567890", "message": "Your OTP: 123456" }

// Response (success)
{ "success": true, "message": "Message sent successfully" }

// Response (not ready)
{ "success": false, "error": "WhatsApp client is not ready" }
```

---

## Configuration

| Env Variable | Required | Description |
|:--|:--|:--|
| `PORT` | No | HTTP server port (default: 3000) |
| `ASP_NET_BASE_URL` | Yes | WhatsApp Sender API base URL |
| `NODE_TOKEN` | Yes | Shared secret for M2M auth |
| `SESSION_DATA_PATH` | No | Path to persist WhatsApp session |
| `CHROMIUM_PATH` | No | Manual Chromium binary path |
| `NODE_ENV` | No | `production` or `development` |
| `LOG_LEVEL` | No | Winston log level (default: `info`) |

---

## Chromium Auto-Detection

```mermaid
flowchart TD
    A["Start: Find Chromium"] --> B{"CHROMIUM_PATH env set?"}
    B -->|Yes| C["Use CHROMIUM_PATH"]
    B -->|No| D{"Platform?"}
    D -->|Linux| E["Check common paths (e.g. /usr/bin/chromium)"]
    D -->|macOS| F["Check Mac App paths"]
    D -->|Windows| G["Check Program Files"]
    E --> H{"Found?"}
    F --> H
    G --> H
    H -->|Yes| I["Use detected path"]
    H -->|No| J["Use puppeteer bundled Chromium"]
```

---

## Docker Deployment

```dockerfile
FROM node:18-slim
# Install Chromium dependencies
RUN apt-get update && apt-get install -y chromium ...
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
CMD ["node", "--max-old-space-size=512", "index.js"]
```

### Render Deployment

The service deploys on Render with a **1GB persistent disk** mounted at the session data path. The `render.yaml` blueprint and `render-build.sh` handle Chromium installation.

---

## Error Handling

Known transient Puppeteer errors are caught and suppressed at the process level:

| Error Pattern | Action |
|:--|:--|
| `"Target closed"` | Suppress, trigger soft reconnect |
| `"Session closed"` | Suppress, trigger soft reconnect |
| `"detached Frame"` | Suppress, ignore |
| `"Protocol error"` | Suppress, trigger reconnect |
| All others | Log and let zombie detection handle |

These are caught at both `process.on('unhandledRejection')` and `process.on('uncaughtException')` levels.

---

## Project Structure

```
whatsapp-service/
├── index.js              # Entry point: server, shutdown, error handling
├── src/
│   ├── config/
│   │   └── index.js      # Chromium detection, env vars, Puppeteer args
│   ├── routes/
│   │   └── index.js      # Express routes: /send, /status, /health
│   ├── services/
│   │   └── whatsappClient.js  # State machine, zombie detection, reconnect
│   ├── middleware/
│   │   └── auth.js       # x-node-token validation middleware
│   └── utils/
│       └── logger.js     # Winston logger (JSON prod, color dev)
├── Dockerfile
├── render.yaml           # Render deployment blueprint
├── render-build.sh       # Chromium install script for Render
└── package.json
```

---

## Logging

Uses **Winston** with dual formats:

- **Production**: JSON structured logs with timestamps, PID, service name
- **Development**: Colorized console output with stack traces

```javascript
// Production output
{"level":"info","message":"WhatsApp client ready","service":"whatsapp-service","pid":1234,"timestamp":"2024-01-01 12:00:00"}

// Development output
12:00:00 info: WhatsApp client ready
```

