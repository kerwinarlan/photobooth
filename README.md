# TogetherBooth

A two-person online photobooth for long-distance couples. Partners join a private room, see each other live, and capture synchronized photos that render into a shared photostrip.

## Overview

TogetherBooth turns two phones or laptops into one shared photo booth. Each person sees the other's live video preview, presses the shutter together, and both devices capture at the same moment using a server-synchronized countdown. The paired shots assemble into a downloadable couple strip.

The app runs on a single Node.js server. The browser handles everything else: camera capture, video streaming, photo compression, and strip rendering use native web platform APIs only.

## Tech Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Server | Node.js (>= 18) + Socket.IO | Room signaling, synchronized countdown, photo relay |
| Live video | WebRTC (RTCPeerConnection) | P2P media with STUN, optional TURN relay |
| Camera | `MediaDevices.getUserMedia()` | Native browser API, no camera library |
| Rendering | HTML5 Canvas | Photo compression and photostrip templates |
| Client | Vanilla JavaScript, zero dependencies | Single `index.html`, no build step |

The only runtime dependency is `socket.io`. All camera, video, and image work uses native browser APIs.

## Features

- **Private rooms** - Up to two people per room. Share a link or room name.
- **Live partner preview** - WebRTC video with automatic connection retry, plus a server-relayed low-fps preview fallback when peer-to-peer can't connect.
- **Synchronized capture** - Server-timestamped countdown with per-client clock-offset estimation.
- **Dual capture** - Front or back camera, switched live without freezing the partner's preview.
- **Shared photo tray** - Each person sees both sets of shots, up to six each.
- **Photostrip builder** - Seven templates: classic 35mm-style film strip (default), long 6-frame film strip, Instax instant print, couple strip, 2 x 2, 3 x 2, and a dramatic dark polaroid. Film-stock color grades (Fuji, Instax, clean DSLR), grain, and vignettes are applied per template.
- **Screen flash** - Optional flash effect that fires in sync with every capture.
- **Resilient connections** - Auto-reconnect, room-full handling, and graceful cleanup on leave.

## Getting Started

### Prerequisites

- Node.js 18 or newer (Node 20+ recommended)
- npm

### Install and run

```bash
npm install
npm start
```

Open `http://localhost:3000` in two browser windows, enter the same room name, and press the shutter together.

### Development

```bash
npm run dev    # restarts the server on file changes
npm run check  # syntax-check server.js
```

## How It Works

1. Each client joins a room through the Socket.IO server.
2. Clients exchange WebRTC offers, answers, and ICE candidates through the server. Video flows directly between peers.
3. The shutter asks the server for a capture deadline. Each client estimates the server clock offset and counts down locally.
4. Each client compresses its video frame to a JPEG data URL and sends it to the server, which relays it to the partner.
5. Photos pair by capture ID and render into the selected strip template on a canvas.

## Deployment

- **HTTPS is required** for camera access anywhere except `localhost`. Use a reverse proxy (Caddy, nginx, or a PaaS TLS terminator) in front of the Node server.
- **TURN servers** are required for reliable connections across restrictive NATs and mobile carriers. Configure via environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `3000`) |
| `TURN_URL` | Comma-separated TURN URLs, e.g. `turn:turn.example.com:3478` |
| `TURN_USERNAME` | TURN credential username |
| `TURN_CREDENTIAL` | TURN credential password |
| `ALLOWED_ORIGIN` | CORS origin override for the Socket.IO handshake |

Without TURN, connections work on open networks but may fail between restrictive networks; in that case the app automatically falls back to relaying low-fps preview frames through the server, so the live preview still works.

## Project Structure

```
photobooth-app/
├── server.js            # HTTP + Socket.IO signaling server
├── public/
│   └── index.html       # Entire client: UI, WebRTC, capture, strip rendering
├── package.json
└── .gitignore
```

## Limitations

- Room state and photos live in server memory. Up to six compressed photos per person, per room. Restarting the server clears all rooms.
- Production deployments should move room state and photos to Redis or an object store, with expiry.

## License

ISC
