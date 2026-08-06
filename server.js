const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the static HTML file (and any assets)
app.use(express.static(path.join(__dirname, 'public')));

// In‑memory room storage
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
    // Send current room state to the new user
    io.to(room).emit('room_state', rooms[room]);
    // Tell others that someone joined
    socket.to(room).emit('user_joined', { userId: socket.id, name });
  });

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

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].users[socket.id];
      io.to(currentRoom).emit('user_left', { userId: socket.id });
      // Clean empty rooms
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