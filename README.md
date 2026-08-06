# TogetherBooth

A two-person online photobooth with live WebRTC previews, synchronized countdowns, shared photos, and downloadable couple strips.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` in two browser windows or devices and join the same room.

## Important deployment notes

- Camera access requires HTTPS outside `localhost`.
- Socket.IO must run on a persistent Node server. A static-only host cannot provide room signaling.
- Configure a TURN server through `.env` for reliable connections between different homes, mobile carriers, office networks, or restrictive NATs. STUN-only mode may work during testing but is not dependable for a real LDR product.
- This demo keeps up to six compressed photos per person in server memory. For production, move room state/photos to Redis or a database/object store and add expiry.

## Main fixes from the original

- Dynamic live video tile for every remote participant instead of one hard-coded `remoteVideo`.
- Modern `addTrack` and `ontrack` WebRTC APIs.
- Queues ICE candidates until a remote description exists.
- Deterministic offer creator to reduce offer glare.
- Camera switching uses `RTCRtpSender.replaceTrack`, so the partner's preview does not freeze.
- Server-timestamped countdown with client clock-offset estimation for closer synchronized captures.
- Captures are compressed and grouped by `captureId` for paired couple strips.
- Reconnection, room-full handling, cleanup, XSS-safe rendering, and mobile-safe camera behavior.
