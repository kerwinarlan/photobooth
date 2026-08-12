"use strict";
// Visual check: headless browser with fake camera; dumps PNGs of each view to /tmp.
// Run: node test/screenshot.js

const { spawn } = require("child_process");
const WebSocket = require("ws");
const fs = require("fs");

const SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const PORT = 3998;
const OUT = "/tmp/booth-shots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn("node", ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error("server did not start");
}

async function launchBrowser(port) {
  const child = spawn(SHELL, [
    "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
    "--window-size=1280,1000",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/pb-shots-${Date.now()}`,
    "about:blank"
  ], { stdio: "ignore" });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://localhost:${port}/json`)).ok) return child; } catch {}
    await sleep(200);
  }
  throw new Error("browser did not start");
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

async function evaluate(c, expression) {
  const result = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function shot(c, name) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
  console.log("saved", name);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = startServer();
  try {
    await waitForServer();
    const browser = await launchBrowser(9224);
    const c = cdp(await (await fetch(`http://localhost:9224/json`)).json().then((l) => l.find((t) => t.type === "page").webSocketDebuggerUrl));
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 2, mobile: false });
    await c.send("Page.navigate", { url: `http://localhost:${PORT}/?room=visual` });
    await sleep(1500);
    await shot(c, "1-join");

    await evaluate(c, `document.getElementById("nameInput").value = "You"; document.getElementById("joinBtn").click();`);
    await sleep(3500);
    await shot(c, "2-camera");

    // Inject photos for both users (self + partner) so every template has content.
    await evaluate(c, `(() => {
      const mk = (label, n) => {
        const cv = document.createElement("canvas"); cv.width = 480; cv.height = 640;
        const x = cv.getContext("2d");
        const g = x.createLinearGradient(0, 0, 0, 640);
        g.addColorStop(0, label === "you" ? "#3a1d6e" : "#7e2413");
        g.addColorStop(1, label === "you" ? "#12081f" : "#1a0502");
        x.fillStyle = g; x.fillRect(0, 0, 480, 640);
        x.fillStyle = "rgba(255,255,255,.85)"; x.font = "700 44px system-ui"; x.textAlign = "center";
        x.fillText(label + " " + n, 240, 330);
        x.fillStyle = "rgba(255,214,10,.9)"; x.font = "700 18px system-ui";
        x.fillText("TOGETHERBOOTH", 240, 610);
        return cv.toDataURL("image/jpeg", .8);
      };
      for (let i = 0; i < 4; i += 1) state.myPhotos.push({ id: "me" + i, dataURL: mk("you", i + 1), takenAt: Date.now() - (3 - i) * 60000, captureId: "c" + i });
      state.participants.set("partner", { name: "Them", photos: [] });
      for (let i = 0; i < 3; i += 1) state.participants.get("partner").photos.push({ id: "them" + i, dataURL: mk("them", i + 1), takenAt: Date.now() - (3 - i) * 60000, captureId: "c" + i });
    })()`);
    await evaluate(c, `document.getElementById("finalBtn").click()`);
    await sleep(1200);
    await shot(c, "3-filmStrip");

    const check = async (label) => {
      const stats = await evaluate(c, `(() => {
        const cv = document.getElementById("finalCanvas");
        const ctx = cv.getContext("2d");
        const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
        const colors = new Set();
        let light = 0, dark = 0;
        for (let i = 0; i < data.length; i += 4 * 97) {
          const key = data[i] + "," + data[i + 1] + "," + data[i + 2];
          colors.add(key);
          const luma = .3 * data[i] + .59 * data[i + 1] + .11 * data[i + 2];
          if (luma > 200) light += 1; else if (luma < 60) dark += 1;
        }
        return { colors: colors.size, light, dark };
      })()`);
      console.log(label, JSON.stringify(stats));
    };
    await check("filmStrip");

    for (const t of ["coupleStrip", "grid2x2", "grid3x2", "polaroid"]) {
      await evaluate(c, `document.querySelector('[data-template="${t}"]').click()`);
      await sleep(800);
      await shot(c, `4-${t}`);
      await check(t);
    }
    c.close();
    browser.kill();
  } finally {
    server.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
