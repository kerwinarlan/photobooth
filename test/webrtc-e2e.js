"use strict";
// E2E check: two headless browsers join a room; report WebRTC state per side.
// Run: node test/webrtc-e2e.js

const { spawn } = require("child_process");
const WebSocket = require("ws");

const SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const PORT = 3999;
const ROOM = `e2e-${Date.now() % 100000}`;
const ROUNDS = Number(process.env.ROUNDS || 3);
const STUB_PC = process.env.STUB_PC === "1";

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
  const consoleLines = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      consoleLines.push(`[console.${msg.params.type}] ${text}`);
    }
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
    consoleLines,
    close() { ws.close(); }
  };
}

const STUB_PC_CODE = `
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

const INJECT = `
  ${STUB_PC ? STUB_PC_CODE : ""}
  window.__trace = [];
  const log = (ev, detail) => window.__trace.push([ev, Date.now(), detail]);
  const pcProto = window.RTCPeerConnection.prototype;
  const origAdd = pcProto.addIceCandidate;
  pcProto.addIceCandidate = function (c) {
    log("addIceCandidate", JSON.stringify(c && c.candidate ? c.candidate.slice(0, 60) : c));
    return origAdd.apply(this, arguments);
  };
  const origSetRemote = pcProto.setRemoteDescription;
  pcProto.setRemoteDescription = function (d) { log("setRemote", d && d.type); return origSetRemote.apply(this, arguments); };
  const origSetLocal = pcProto.setLocalDescription;
  pcProto.setLocalDescription = function (d) { log("setLocal", d && d.type); return origSetLocal.apply(this, arguments); };
  const origCreateOffer = pcProto.createOffer;
  pcProto.createOffer = function () { log("createOffer", "start"); return origCreateOffer.apply(this, arguments); };
  const origCreateAnswer = pcProto.createAnswer;
  pcProto.createAnswer = function () { log("createAnswer", "start"); return origCreateAnswer.apply(this, arguments); };
  const origIo = window.io;
  window.io = function (...args) {
    const sock = origIo.apply(this, args);
    const emit = sock.emit.bind(sock);
    sock.emit = (ev, ...rest) => {
      if (ev === "signal") log("emit-signal", JSON.stringify(rest[0]).slice(0, 160));
      return emit(ev, ...rest);
    };
    const on = sock.on.bind(sock);
    sock.on = (ev, fn) => on(ev, (payload, ...rest) => {
      if (ev === "signal") log("recv-signal", JSON.stringify(payload).slice(0, 160));
      return fn(payload, ...rest);
    });
    return sock;
  };
`;

async function evaluate(c, expression) {
  const result = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function runRound(serverRunning, round) {
  const room = `${ROOM}-r${round}`;
  const browserA = await launchBrowser(9222, `/tmp/pb-e2e-a-${round}`);
  const browserB = await launchBrowser(9223, `/tmp/pb-e2e-b-${round}`);
  const result = { round, connected: false };
  try {
    const a = cdp(await getPageWs(9222));
    const b = cdp(await getPageWs(9223));
    await Promise.all([
      a.send("Page.enable"), b.send("Page.enable"),
      a.send("Runtime.enable"), b.send("Runtime.enable"),
      a.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT }),
      b.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT })
    ]);
    for (const [c, name] of [[a, "Alice"], [b, "Bob"]]) {
      await c.send("Page.navigate", { url: `http://localhost:${PORT}/?room=${room}` });
      await sleep(1200);
    }
    // Join both at the same time to maximize any signaling race.
    await Promise.all([
      evaluate(a, `document.getElementById("nameInput").value = "Alice"; document.getElementById("joinBtn").click();`),
      evaluate(b, `document.getElementById("nameInput").value = "Bob"; document.getElementById("joinBtn").click();`)
    ]);
    await sleep(9000);

    const report = async (c) => evaluate(c, `(() => ({
      userId: state.userId,
      participants: [...state.participants.keys()],
      peers: [...state.peers.entries()].map(([id, p]) => ({ id, signaling: p.pc.signalingState, ice: p.pc.iceConnectionState, conn: p.pc.connectionState })),
      tiles: [...state.remoteTiles.entries()].map(([id, t]) => ({ id, pill: t.connection.textContent, tracks: t.video.srcObject ? t.video.srcObject.getTracks().length : 0 }))
    }))()`);
    const infoA = await report(a);
    const infoB = await report(b);
    result.alice = infoA; result.bob = infoB;
    result.connected = infoA.peers.every((p) => p.conn === "connected") && infoB.peers.every((p) => p.conn === "connected");

    if (STUB_PC) {
      // WebRTC is stubbed dead: relay fallback must be showing frames on both tiles.
      const relayA = await evaluate(a, `(() => { const t = [...state.remoteTiles.values()][0]; return t ? { hidden: t.preview.hidden, hasSrc: (t.preview.src || "").startsWith("data:image/jpeg"), pill: t.connection.textContent } : null; })()`);
      const relayB = await evaluate(b, `(() => { const t = [...state.remoteTiles.values()][0]; return t ? { hidden: t.preview.hidden, hasSrc: (t.preview.src || "").startsWith("data:image/jpeg"), pill: t.connection.textContent } : null; })()`);
      result.relayA = relayA; result.relayB = relayB;
      result.connected = Boolean(relayA && relayB && !relayA.hidden && relayA.hasSrc && !relayB.hidden && relayB.hasSrc && relayA.pill === "relay preview" && relayB.pill === "relay preview");
    } else if (process.env.PHOTOS === "1" && result.connected) {
      // Full capture flow: Alice presses shutter; both sides must end with 1 photo.
      await evaluate(a, `document.getElementById("captureBtn").click()`);
      await sleep(7000);
      const photosA = await evaluate(a, `state.myPhotos.length`);
      const photosB = await evaluate(b, `state.myPhotos.length`);
      result.photos = { alice: photosA, bob: photosB };
      result.connected = photosA === 1 && photosB === 1;
    }

    if (!result.connected) {
      result.traceA = await evaluate(a, "window.__trace");
      result.traceB = await evaluate(b, "window.__trace");
      result.consoleA = a.consoleLines;
      result.consoleB = b.consoleLines;
    }
    a.close(); b.close();
  } finally {
    browserA.kill(); browserB.kill();
  }
  return result;
}

async function main() {
  const server = startServer();
  try {
    await waitForServer();
    let failures = 0;
    for (let round = 1; round <= ROUNDS; round += 1) {
      const r = await runRound(server, round);
      const aliceConn = r.alice.peers[0]?.conn;
      const bobConn = r.bob.peers[0]?.conn;
      const aliceExtra = STUB_PC ? ` relay=${JSON.stringify(r.relayA)}` : process.env.PHOTOS === "1" ? ` photos=${JSON.stringify(r.photos)}` : "";
      console.log(`round ${round}: alice=${aliceConn}${aliceExtra} bob=${bobConn} -> ${r.connected ? "OK" : "STUCK"}`);
      if (!r.connected) {
        failures += 1;
        console.log("--- Alice trace ---");
        console.log(JSON.stringify(r.traceA, null, 1));
        console.log("--- Bob trace ---");
        console.log(JSON.stringify(r.traceB, null, 1));
        console.log("--- Alice console ---");
        console.log(r.consoleA.join("\n"));
        console.log("--- Bob console ---");
        console.log(r.consoleB.join("\n"));
      }
    }
    console.log(`\n${ROUNDS - failures}/${ROUNDS} rounds connected on first try`);
    if (failures) process.exitCode = 2;
  } finally {
    server.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
