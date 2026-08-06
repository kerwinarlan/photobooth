const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files (this will serve your index.html from the same folder)
app.use(express.static(path.join(__dirname, 'public')));

// Provide ICE server configuration (TURN/STUN) to the client
app.get('/ice-config', (req, res) => {
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  });
});

// In‑memory room storage
const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentName = '';

  // ---- join ----
  socket.on('join', ({ room, name }, callback) => {
    currentRoom = room;
    currentName = name;

    if (!rooms[room]) {
      rooms[room] = { users: {} };
    }
    // Store user data
    rooms[room].users[socket.id] = {
      name: name,
      photos: []
    };
    socket.join(room);

    // Send the full room state to the new user
    const userList = Object.entries(rooms[room].users).map(([id, user]) => ({
      id,
      name: user.name,
      photos: user.photos
    }));
    callback({ ok: true, users: userList });

    // Broadcast to others in the room that a new user joined
    socket.to(room).emit('user_joined', {
      userId: socket.id,
      name: name
    });
  });

  // ---- sync_clock ----
  socket.on('sync_clock', (_, callback) => {
    callback({ serverNow: Date.now() });
  });

  // ---- signal (WebRTC) ----
  socket.on('signal', ({ targetId, signal }) => {
    io.to(targetId).emit('signal', { from: socket.id, signal });
  });

  // ---- retry_peer ----
  socket.on('retry_peer', ({ targetId }) => {
    io.to(targetId).emit('retry_peer', { from: socket.id });
  });

  // ---- start_countdown ----
  socket.on('start_countdown', ({ delayMs }, callback) => {
    if (!currentRoom) {
      return callback({ ok: false, error: 'Not in a room' });
    }
    const captureId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const captureAt = Date.now() + delayMs;
    io.to(currentRoom).emit('countdown_start', { captureId, captureAt });
    callback({ ok: true, captureId });
  });

  // ---- photo ----
  socket.on('photo', ({ photo }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const user = room.users[socket.id];
    if (!user) return;

    // Store the photo (limit to 6)
    user.photos.push(photo);
    if (user.photos.length > 6) user.photos.shift();

    // Broadcast to everyone else in the room
    socket.to(currentRoom).emit('user_photo', {
      userId: socket.id,
      name: user.name,
      photo: photo
    });
  });

  // ---- clear_photos ----
  socket.on('clear_photos', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const user = room.users[socket.id];
    if (user) user.photos = [];
    socket.to(currentRoom).emit('user_cleared', { userId: socket.id });
  });

  // ---- disconnect ----
  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const name = rooms[currentRoom].users[socket.id]?.name || 'Someone';
      delete rooms[currentRoom].users[socket.id];
      socket.to(currentRoom).emit('user_left', { userId: socket.id, name });
      // Clean up empty rooms
      if (Object.keys(rooms[currentRoom].users).length === 0) {
        delete rooms[currentRoom];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});