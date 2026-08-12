<div align="center">

# 📸 TogetherBooth

**Two-person online photobooth for long-distance couples**

[![Node.js](https://img.shields.io/badge/Node.js%2018+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-010101?logo=socketdotio&logoColor=white)](https://socket.io)
[![WebRTC](https://img.shields.io/badge/WebRTC-333333?logo=webrtc&logoColor=white)](https://webrtc.org)
[![Vanilla JS](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Canvas](https://img.shields.io/badge/HTML5%20Canvas-E34F26?logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)

</div>

Two phones, one booth. Partners join a private room, see each other live,
and press the shutter together - a server-synchronized countdown fires both
cameras at the same instant, and the paired shots render into a shared,
downloadable photostrip.

---

## Table of Contents

- [Why it exists: the long-distance photobooth problem](#why-it-exists-the-long-distance-photobooth-problem)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Repository Layout](#repository-layout)
- [How It Works](#how-it-works)
- [Local Setup](#local-setup)
- [Deployment](#deployment)
- [Validation](#validation)
- [Notes & Roadmap](#notes--roadmap)
- [License](#license)

---

## Why it exists: the long-distance photobooth problem

A photobooth is a two-person machine - and long-distance couples can never
stand in front of one together. Video calls feel like calls, not shared
moments; the magic of a booth is the synchronized flash and the strip you
split afterward. TogetherBooth removes the distance:

| Problem | Solution | Result |
|---|---|---|
| Couples live apart, so a shared booth is impossible | Each person's device **is** the booth, joined over the internet | A couple strip made from two different cities |
| Two shutters must fire at the exact same instant | Server-synchronized countdown with per-client clock-offset estimation | Paired shots taken at the same moment |
| WebRTC can fail between restrictive networks | Server-relayed low-fps preview fallback | The live preview still works, always |

Result: the photobooth experience with zero photo-booth hardware, zero
accounts, and zero fees - just two browsers and a small Node.js server.
Everything on the client (camera, video, compression, strip rendering) uses
native web platform APIs; the only runtime dependency is `socket.io`.

## Features

- **Private rooms** - Up to two people per room. Share a link or room name.
- **Live partner preview** - WebRTC video with automatic connection retry,
  plus a server-relayed low-fps preview fallback when peer-to-peer can't
  connect.
- **Synchronized capture** - Server-timestamped countdown with per-client
  clock-offset estimation.
- **Dual capture** - Front or back camera, switched live without freezing the
  partner's preview.
- **Shared photo tray** - Each person sees both sets of shots, up to six
  each.
- **Photostrip builder** - Seven templates: classic 35mm-style film strip
  (default), long 6-frame film strip, Instax instant print, couple strip,
  2 x 2, 3 x 2, and a dramatic dark polaroid. Film-stock color grades (Fuji,
  Instax, clean DSLR), grain, and vignettes are applied per template.
- **Screen flash** - Optional flash effect that fires in sync with every
  capture.
- **Resilient connections** - Auto-reconnect, room-full handling, and
  graceful cleanup on leave.

## Tech Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Server | Node.js (>= 18) + Socket.IO | Room signaling, synchronized countdown, photo relay |
| Live video | WebRTC (RTCPeerConnection) | P2P media with STUN, optional TURN relay |
| Camera | `MediaDevices.getUserMedia()` | Native browser API, no camera library |
| Rendering | HTML5 Canvas | Photo compression and photostrip templates |
| Client | Vanilla JavaScript, zero dependencies | Single `index.html`, no build step |

## Repository Layout

```
photobooth-app/
├── server.js            # HTTP + Socket.IO signaling server
├── public/
│   └── index.html       # Entire client: UI, WebRTC, capture, strip rendering
├── test/
│   ├── screenshot.js    # headless-browser visual check (PNGs per view)
│   └── webrtc-e2e.js    # two-headless-browser WebRTC E2E check
├── package.json
└── .gitignore
```

## How It Works

1. Each client joins a room through the Socket.IO server.
2. Clients exchange WebRTC offers, answers, and ICE candidates through the
   server. Video flows directly between peers.
3. The shutter asks the server for a capture deadline. Each client estimates
   the server clock offset and counts down locally.
4. Each client compresses its video frame to a JPEG data URL and sends it to
   the server, which relays it to the partner.
5. Photos pair by capture ID and render into the selected strip template on a
   canvas.

## Local Setup

```bash
npm install
npm start        # http://localhost:3000
```

Open `http://localhost:3000` in two browser windows, enter the same room
name, and press the shutter together.

```bash
npm run dev      # restarts the server on file changes
npm run check    # syntax-check server.js
```

## Deployment

- **HTTPS is required** for camera access anywhere except `localhost`. Use a
  reverse proxy (Caddy, nginx, or a PaaS TLS terminator) in front of the Node
  server.
- **TURN servers** are required for reliable connections across restrictive
  NATs and mobile carriers. Configure via environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `3000`) |
| `TURN_URL` | Comma-separated TURN URLs, e.g. `turn:turn.example.com:3478` |
| `TURN_USERNAME` | TURN credential username |
| `TURN_CREDENTIAL` | TURN credential password |
| `ALLOWED_ORIGIN` | CORS origin override for the Socket.IO handshake |

Without TURN, connections work on open networks but may fail between
restrictive networks; in that case the app automatically falls back to
relaying low-fps preview frames through the server, so the live preview still
works.

## Validation

```bash
npm run check    # syntax-check server.js
node test/webrtc-e2e.js   # two headless browsers join a room; reports WebRTC state per side
node test/screenshot.js   # headless browser with fake camera; dumps PNGs of each view to /tmp
```

## Notes & Roadmap

- Room state and photos live in server memory. Up to six compressed photos
  per person, per room. Restarting the server clears all rooms.
- **Roadmap (not yet built):** production room state and photos in Redis or
  an object store with expiry, and a shareable strip URL for each capture.

## License

ISC
