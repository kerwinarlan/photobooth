const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;
  let userName = '';

  socket.on('join', ({ room, name }) => {
    currentRoom = room;
    userName = name;
    if (!rooms[room]) rooms[room] = { users: {} };
    rooms[room].users[socket.id] = { name, photos: [] };
    socket.join(room);
    io.to(room).emit('room_state', rooms[room]);
    socket.to(room).emit('user_joined', { userId: socket.id, name });
  });

  // --- Photo sharing (unchanged) ---
  socket.on('photo', ({ photoData }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const user = room.users[socket.id];
    if (!user) return;
    user.photos.push(photoData);
    if (user.photos.length > 6) user.photos.shift();
    io.to(currentRoom).emit('user_photo', {
      userId: socket.id,
      photoData,
      name: user.name
    });
  });

  socket.on('cleared', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const user = room.users[socket.id];
    if (user) user.photos = [];
    io.to(currentRoom).emit('user_cleared', { userId: socket.id });
  });

  // --- WebRTC signalling ---
  socket.on('signal', ({ targetId, signal }) => {
    // relay signal to target user
    io.to(targetId).emit('signal', { from: socket.id, signal });
  });

  // --- Synchronised countdown ---
  socket.on('start_countdown', ({ delay = 3 }) => {
    if (!currentRoom) return;
    // broadcast to everyone in the room (including sender) 
    io.to(currentRoom).emit('countdown_start', { delay, from: socket.id });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].users[socket.id];
      io.to(currentRoom).emit('user_left', { userId: socket.id });
      // notify others to close peer connection
      io.to(currentRoom).emit('peer_disconnected', { userId: socket.id });
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