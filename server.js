"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const MAX_ROOM_SIZE = 2;
const MAX_PHOTOS = 6;
const MAX_PHOTO_DATA_LENGTH = 1_500_000;
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

function publicUsers(room) {
  const users = rooms.get(room);
  if (!users) return [];
  return [...users.entries()].map(([id, user]) => ({ id, name: user.name, photos: user.photos }));
}

function sameRoom(socketIdA, socketIdB) {
  const roomA = memberships.get(socketIdA);
  return Boolean(roomA && roomA === memberships.get(socketIdB));
}

function removeFromRoom(socket, announce = true) {
  const room = memberships.get(socket.id);
  if (!room) return;
  const users = rooms.get(room);
  const user = users?.get(socket.id);
  users?.delete(socket.id);
  memberships.delete(socket.id);
  socket.leave(room);
  if (users && users.size === 0) rooms.delete(room);
  if (announce) socket.to(room).emit("user_left", { userId: socket.id, name: user?.name || "Guest" });
}

io.on("connection", (socket) => {
  socket.on("join", ({ room: rawRoom, name: rawName } = {}, callback = () => {}) => {
    try {
      const room = sanitizeRoom(rawRoom);
      const name = sanitizeName(rawName);
      if (!room) return callback({ ok: false, error: "Enter a valid room name." });

      const previousRoom = memberships.get(socket.id);
      if (previousRoom && previousRoom !== room) removeFromRoom(socket);

      let users = rooms.get(room);
      if (!users) { users = new Map(); rooms.set(room, users); }
      if (!users.has(socket.id) && users.size >= MAX_ROOM_SIZE) return callback({ ok: false, error: "This booth already has two people." });

      users.set(socket.id, users.get(socket.id) || { name, photos: [] });
      users.get(socket.id).name = name;
      memberships.set(socket.id, room);
      socket.join(room);

      callback({ ok: true, room, users: publicUsers(room), serverNow: Date.now() });
      socket.to(room).emit("user_joined", { userId: socket.id, name });
    } catch (error) {
      console.error("join failed", error);
      callback({ ok: false, error: "Could not join the room." });
    }
  });

  socket.on("sync_clock", (_payload, callback = () => {}) => callback({ ok: true, serverNow: Date.now() }));

  socket.on("signal", ({ targetId, signal } = {}) => {
    if (!targetId || !signal || !sameRoom(socket.id, targetId)) return;
    io.to(targetId).emit("signal", { from: socket.id, signal });
  });

  socket.on("retry_peer", ({ targetId } = {}) => {
    if (!targetId || !sameRoom(socket.id, targetId)) return;
    io.to(targetId).emit("retry_peer", { from: socket.id });
  });

  socket.on("start_countdown", ({ delayMs } = {}, callback = () => {}) => {
    const room = memberships.get(socket.id);
    if (!room) return callback({ ok: false, error: "Join a room first." });
    const safeDelay = Math.max(1200, Math.min(10_000, Number(delayMs) || 3000));
    const payload = { captureId: crypto.randomUUID(), captureAt: Date.now() + safeDelay };
    io.to(room).emit("countdown_start", payload);
    callback({ ok: true, ...payload });
  });

  socket.on("photo", ({ photo } = {}) => {
    const room = memberships.get(socket.id);
    const user = rooms.get(room)?.get(socket.id);
    if (!room || !user || !photo) return;
    if (typeof photo.dataURL !== "string" || !photo.dataURL.startsWith("data:image/") || photo.dataURL.length > MAX_PHOTO_DATA_LENGTH) return;

    const safePhoto = {
      id: String(photo.id || crypto.randomUUID()).slice(0, 80),
      dataURL: photo.dataURL,
      takenAt: Number(photo.takenAt) || Date.now(),
      captureId: photo.captureId ? String(photo.captureId).slice(0, 80) : null
    };
    user.photos = [...user.photos.filter((item) => item.id !== safePhoto.id), safePhoto].slice(-MAX_PHOTOS);
    socket.to(room).emit("user_photo", { userId: socket.id, name: user.name, photo: safePhoto });
  });

  socket.on("clear_photos", () => {
    const room = memberships.get(socket.id);
    const user = rooms.get(room)?.get(socket.id);
    if (!room || !user) return;
    user.photos = [];
    socket.to(room).emit("user_cleared", { userId: socket.id });
  });

  socket.on("disconnect", () => removeFromRoom(socket));
});

server.listen(PORT, () => {
  console.log(`TogetherBooth running on http://localhost:${PORT}`);
  if (!process.env.TURN_URL) console.log("TURN is not configured. STUN-only WebRTC may fail on restrictive networks.");
});

function shutdown() {
  io.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
