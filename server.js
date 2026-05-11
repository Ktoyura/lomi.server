const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ── In-memory rooms ───────────────────────────────────────────────
const rooms = {}; // roomCode -> Room

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function makeRoom(code) {
  return {
    code,
    players: [],   // [{id, username, ready}]
    state: null,   // game state synced from host
    started: false,
    createdAt: Date.now(),
  };
}

// Clean up stale rooms every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    if (now - rooms[code].createdAt > 60 * 60 * 1000) {
      delete rooms[code];
    }
  }
}, 10 * 60 * 1000);

// ── Socket events ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Create room
  socket.on('create_room', ({ username }) => {
    let code = makeCode();
    while (rooms[code]) code = makeCode();
    const room = makeRoom(code);
    room.players.push({ id: socket.id, username, ready: false });
    rooms[code] = room;
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_created', { code, playerIndex: 0 });
    console.log(`Room ${code} created by ${username}`);
  });

  // Join room
  socket.on('join_room', ({ code, username }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('error', { message: 'Комната не найдена' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Комната уже полная' });
      return;
    }
    if (room.started) {
      socket.emit('error', { message: 'Игра уже началась' });
      return;
    }
    room.players.push({ id: socket.id, username, ready: false });
    socket.join(code);
    socket.roomCode = code;
    const playerIndex = 1;
    socket.emit('room_joined', { code, playerIndex, opponentName: room.players[0].username });
    // Notify host
    io.to(room.players[0].id).emit('opponent_joined', { opponentName: username });
    console.log(`${username} joined room ${code}`);
  });

  // Player ready → start game
  socket.on('player_ready', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.ready = true;
    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      room.started = true;
      // Host is player 0 (goes first)
      io.to(room.code).emit('game_start', {
        player0: room.players[0].username,
        player1: room.players[1].username,
      });
    }
  });

  // Move: player moved their piece
  socket.on('move', ({ r, c }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    socket.to(room.code).emit('opponent_move', { r, c });
  });

  // Wall placed
  socket.on('place_wall', ({ r, c, dir }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    socket.to(room.code).emit('opponent_wall', { r, c, dir });
  });

  // Surrender
  socket.on('surrender', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    socket.to(room.code).emit('opponent_surrendered');
  });

  // Timer ran out
  socket.on('timeout', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    socket.to(room.code).emit('opponent_timeout');
  });

  // Chat message (bonus)
  socket.on('chat', ({ message }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    io.to(room.code).emit('chat_message', { username: player.username, message });
  });

  // Rematch request
  socket.on('rematch_request', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    socket.to(room.code).emit('rematch_requested');
  });

  socket.on('rematch_accept', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    room.players.forEach(p => p.ready = false);
    room.started = false;
    io.to(room.code).emit('rematch_start', {
      player0: room.players[0].username,
      player1: room.players[1].username,
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    socket.to(room.code).emit('opponent_disconnected');
    // Remove room after opponent disconnect
    delete rooms[socket.roomCode];
    console.log(`Socket ${socket.id} disconnected, room ${socket.roomCode} closed`);
  });
});

// Health check
app.get('/', (req, res) => res.send('Lomi Server OK'));

server.listen(PORT, () => console.log(`Lomi server running on port ${PORT}`));
