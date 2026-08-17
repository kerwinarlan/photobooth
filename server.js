"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const MAX_ROOM_SIZE = 2;
const MAX_PHOTOS = 6;
const LEAVE_GRACE_MS = 8000;
const MAX_PHOTO_DATA_LENGTH = 1_500_000;
const MAX_PREVIEW_FRAME_LENGTH = 200_000;
const INDEX_PATH = path.join(__dirname, "public", "index.html");

const rooms = new Map();
const memberships = new Map();

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    fs.createReadStream(INDEX_PATH)
      .on("error", () => {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal server error");
      })
      .pipe(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, rooms: rooms.size, now: Date.now() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/ice-config") {
    const iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ];
    if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      iceServers.push({
        urls: process.env.TURN_URL.split(",").map((value) => value.trim()).filter(Boolean),
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL
      });
    }
    json(res, 200, { iceServers });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

const io = new Server(server, {
  maxHttpBufferSize: 2_000_000,
  cors: { origin: process.env.ALLOWED_ORIGIN || true, methods: ["GET", "POST"] }
});

function sanitizeRoom(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function sanitizeName(value) {
  return String(value || "Guest").trim().replace(/\s+/g, " ").slice(0, 30) || "Guest";
}

function sanitizeDeviceId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function publicUsers(room) {
  const users = rooms.get(room);
  if (!users) return [];
  return [...users.entries()].map(([id, user]) => ({ id, name: user.name, photos: user.photos }));
}

// Remove a connected socket's membership immediately (explicit room switch).
// The user slot is keyed by deviceId, so a reconnect reuses it without churn.
function removeFromRoom(socket) {
  const m = memberships.get(socket.id);
  if (!m) return;
  const users = rooms.get(m.room);
  const user = users?.get(m.deviceId);
  if (user?.socketId === socket.id) users.delete(m.deviceId);
  if (users && users.size === 0) rooms.delete(m.room);
  memberships.delete(socket.id);
  socket.leave(m.room);
  socket.to(m.room).emit("user_left", { userId: m.deviceId, name: user?.name || "Guest" });
}

io.on("connection", (socket) => {
  socket.on("join", ({ room: rawRoom, name: rawName, deviceId: rawDeviceId } = {}, callback = () => {}) => {
    try {
      const room = sanitizeRoom(rawRoom);
      const name = sanitizeName(rawName);
      const deviceId = sanitizeDeviceId(rawDeviceId);
      if (!room) return callback({ ok: false, error: "Enter a valid room name." });
      if (!deviceId) return callback({ ok: false, error: "Missing device id." });

      const previous = memberships.get(socket.id);
      if (previous && previous.room !== room) removeFromRoom(socket);

      let users = rooms.get(room);
      if (!users) { users = new Map(); rooms.set(room, users); }

      const existing = users.get(deviceId);
      if (!existing && users.size >= MAX_ROOM_SIZE) return callback({ ok: false, error: "This booth already has two people." });

      // A reconnect (or a second tab) reuses the deviceId slot silently, so the
      // partner keeps its live tile and peer instead of a leave/join churn.
      users.set(deviceId, { name, photos: existing?.photos || [], socketId: socket.id });
      memberships.set(socket.id, { room, deviceId });
      socket.join(room);

      callback({ ok: true, room, selfId: deviceId, users: publicUsers(room), serverNow: Date.now() });
      if (!existing) socket.to(room).emit("user_joined", { userId: deviceId, name });
    } catch (error) {
      console.error("join failed", error);
      callback({ ok: false, error: "Could not join the room." });
    }
  });

  socket.on("sync_clock", (_payload, callback = () => {}) => callback({ ok: true, serverNow: Date.now() }));

  socket.on("signal", ({ targetId, signal } = {}) => {
    const m = memberships.get(socket.id);
    const target = m && rooms.get(m.room)?.get(String(targetId));
    if (!target?.socketId || !signal) return;
    io.to(target.socketId).emit("signal", { from: m.deviceId, signal });
  });

  socket.on("retry_peer", ({ targetId } = {}) => {
    const m = memberships.get(socket.id);
    const target = m && rooms.get(m.room)?.get(String(targetId));
    if (!target?.socketId) return;
    io.to(target.socketId).emit("retry_peer", { from: m.deviceId });
  });

  socket.on("start_countdown", ({ delayMs } = {}, callback = () => {}) => {
    const m = memberships.get(socket.id);
    if (!m) return callback({ ok: false, error: "Join a room first." });
    const safeDelay = Math.max(1200, Math.min(10_000, Number(delayMs) || 3000));
    const payload = { captureId: crypto.randomUUID(), captureAt: Date.now() + safeDelay };
    io.to(m.room).emit("countdown_start", payload);
    callback({ ok: true, ...payload });
  });

  socket.on("preview_frame", ({ frame } = {}) => {
    const m = memberships.get(socket.id);
    if (!m || !frame || typeof frame.dataURL !== "string" || !frame.dataURL.startsWith("data:image/jpeg") || frame.dataURL.length > MAX_PREVIEW_FRAME_LENGTH) return;
    socket.to(m.room).emit("preview_frame", { from: m.deviceId, dataURL: frame.dataURL });
  });

  socket.on("photo", ({ photo } = {}) => {
    const m = memberships.get(socket.id);
    const user = m && rooms.get(m.room)?.get(m.deviceId);
    if (!user || !photo) return;
    if (typeof photo.dataURL !== "string" || !photo.dataURL.startsWith("data:image/") || photo.dataURL.length > MAX_PHOTO_DATA_LENGTH) return;

    const safePhoto = {
      id: String(photo.id || crypto.randomUUID()).slice(0, 80),
      dataURL: photo.dataURL,
      takenAt: Number(photo.takenAt) || Date.now(),
      captureId: photo.captureId ? String(photo.captureId).slice(0, 80) : null
    };
    user.photos = [...user.photos.filter((item) => item.id !== safePhoto.id), safePhoto].slice(-MAX_PHOTOS);
    socket.to(m.room).emit("user_photo", { userId: m.deviceId, name: user.name, photo: safePhoto });
  });

  socket.on("clear_photos", () => {
    const m = memberships.get(socket.id);
    const user = m && rooms.get(m.room)?.get(m.deviceId);
    if (!user) return;
    user.photos = [];
    socket.to(m.room).emit("user_cleared", { userId: m.deviceId });
  });

  socket.on("disconnect", () => {
    const m = memberships.get(socket.id);
    if (!m) return;
    memberships.delete(socket.id);
    const users = rooms.get(m.room);
    const user = users?.get(m.deviceId);
    if (!user || user.socketId !== socket.id) return; // slot taken over by a newer socket
    user.socketId = null;
    // Grace period: a transient blip usually reconnects within seconds. Only
    // announce the leave (and drop the slot) once it is truly abandoned.
    setTimeout(() => {
      const current = users.get(m.deviceId);
      if (!current || current.socketId !== null) return; // rejoined in time
      users.delete(m.deviceId);
      if (users.size === 0) rooms.delete(m.room);
      io.to(m.room).emit("user_left", { userId: m.deviceId, name: current.name || "Guest" });
    }, LEAVE_GRACE_MS);
  });
});

server.listen(PORT, () => {
  console.log(`Photobooth running on http://localhost:${PORT}`);
  if (!process.env.TURN_URL) console.log("TURN is not configured. STUN-only WebRTC may fail on restrictive networks; live preview will use server relay.");
});

function shutdown() {
  io.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
