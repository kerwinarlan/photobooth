"use strict";
// E2E check: a transient socket drop must not churn the partner's tile.
// Asserts the 8s server grace: Bob keeps Alice's tile through her blip,
// and only sees user_left once she truly abandons the room.
// Run: node test/reconnect-e2e.js

const { spawn } = require("child_process");
const WebSocket = require("ws");

const SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const PORT = 3998;
const ROOM = `reconn-${Date.now() % 100000}`;
const GRACE = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn("node", ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("server did not start");
}

async function launchBrowser(port, userDataDir) {
  const child = spawn(SHELL, [
    "--headless", "--no-sandbox", "--disable-gpu",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], { stdio: "ignore" });
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://localhost:${port}/json`);
      if (res.ok) return child;
    } catch {}
    await sleep(200);
  }
  throw new Error(`browser ${port} did not start`);
}

async function getPageWs(port) {
  const list = await (await fetch(`http://localhost:${port}/json`)).json();
  return list.find((t) => t.type === "page").webSocketDebuggerUrl;
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const ready = new Promise((resolve) => ws.on("open", resolve));
  return {
    send(method, params = {}) {
      return ready.then(() => new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      }));
    },
    close() { ws.close(); }
  };
}

const INJECT = `
  class StubPC {
    constructor() {
      this.signalingState = "stable"; this.connectionState = "new"; this.iceConnectionState = "new";
      this.localDescription = null; this.remoteDescription = null; this.senders = [];
      this.onicecandidate = null; this.ontrack = null; this.onconnectionstatechange = null; this.oniceconnectionstatechange = null;
    }
    addTrack(track) { const s = { track, kind: track.kind }; this.senders.push(s); return s; }
    getSenders() { return this.senders; }
    async createOffer() { return { type: "offer", sdp: "stub" }; }
    async createAnswer() { return { type: "answer", sdp: "stub" }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async addIceCandidate() {}
    close() {}
  }
  window.RTCPeerConnection = StubPC;
`;

async function evaluate(c, expression) {
  const result = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function main() {
  const server = startServer();
  try {
    await waitForServer();
    const browserA = await launchBrowser(9224, `/tmp/pb-reconn-a-${Date.now()}`);
    const browserB = await launchBrowser(9225, `/tmp/pb-reconn-b-${Date.now()}`);
    const a = cdp(await getPageWs(9224));
    const b = cdp(await getPageWs(9225));
    await Promise.all([
      a.send("Page.enable"), b.send("Page.enable"),
      a.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT }),
      b.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT })
    ]);
    await Promise.all([
      a.send("Page.navigate", { url: `http://localhost:${PORT}/?room=${ROOM}` }),
      b.send("Page.navigate", { url: `http://localhost:${PORT}/?room=${ROOM}` })
    ]);
    await sleep(1500);
    await Promise.all([
      evaluate(a, `document.getElementById("nameInput").value = "Alice"; document.getElementById("joinBtn").click();`),
      evaluate(b, `document.getElementById("nameInput").value = "Bob"; document.getElementById("joinBtn").click();`)
    ]);
    await sleep(4000);

    const bobSees = () => evaluate(b, `(() => ({ ids: [...state.participants.keys()], tiles: state.remoteTiles.size, userId: state.userId }))()`);
    const aliceSees = () => evaluate(a, `(() => ({ ids: [...state.participants.keys()], userId: state.userId }))()`);

    const joined = await bobSees();
    if (joined.ids.length !== 1) throw new Error(`expected Bob to see Alice after join, got ${JSON.stringify(joined)}`);
    const aliceId = joined.ids[0];
    console.log(`step 1: both joined, Bob sees Alice as ${aliceId.slice(0, 8)}…`);

    // Alice's transport drops; she must not look gone to Bob during the grace.
    await evaluate(a, `state.socket.disconnect(); true`);
    await sleep(1500);
    const duringGrace = await bobSees();
    if (duringGrace.ids[0] !== aliceId || duringGrace.tiles !== 1) throw new Error(`grace failed: Bob lost Alice ${JSON.stringify(duringGrace)}`);
    console.log("step 2: Alice dropped; Bob kept her tile (grace holds)");

    // Alice reconnects: same deviceId -> silent slot takeover, no churn.
    await evaluate(a, `state.socket.connect(); true`);
    await sleep(3500);
    const afterRejoin = await bobSees();
    if (afterRejoin.ids[0] !== aliceId || afterRejoin.tiles !== 1) throw new Error(`rejoin churned Bob ${JSON.stringify(afterRejoin)}`);
    const aliceAfter = await aliceSees();
    if (aliceAfter.ids.length !== 1) throw new Error(`Alice did not see Bob after rejoin ${JSON.stringify(aliceAfter)}`);
    console.log("step 3: Alice reconnected; same id on both sides, no leave/join");

    // Alice abandons the room for real: Bob must see user_left after the grace.
    await evaluate(a, `state.socket.disconnect(); true`);
    await sleep(GRACE + 2500);
    const afterAbandon = await bobSees();
    if (afterAbandon.ids.length !== 0 || afterAbandon.tiles !== 0) throw new Error(`leave not announced ${JSON.stringify(afterAbandon)}`);
    console.log("step 4: Alice abandoned; Bob cleaned up after grace");

    console.log("reconnect-e2e: OK");
    a.close(); b.close();
    browserA.kill(); browserB.kill();
  } finally {
    server.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
