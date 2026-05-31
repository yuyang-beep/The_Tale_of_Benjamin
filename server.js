const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const GameRoom = require('./lib/GameRoom');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket'],
});

app.use(express.static(path.join(__dirname)));

const rooms = new Map(); // roomId → GameRoom

function getRoomId() {
  // 4-letter uppercase code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function broadcast(room) {
  room.players.forEach((_, id) => {
    const socket = io.sockets.sockets.get(id);
    if (socket) socket.emit('state', room.publicState(id));
  });
}

io.on('connection', socket => {
  let currentRoomId = null;

  socket.on('create-room', ({ name }, cb) => {
    const roomId = getRoomId();
    const room = new GameRoom(roomId);
    rooms.set(roomId, room);
    const result = room.addPlayer(socket.id, name);
    if (result.error) { cb({ error: result.error }); return; }
    currentRoomId = roomId;
    cb({ ok: true, roomId });
    broadcast(room);
  });

  socket.on('join-room', ({ roomId, name }, cb) => {
    const room = rooms.get(roomId?.toUpperCase());
    if (!room) { cb({ error: 'room not found' }); return; }
    const result = room.addPlayer(socket.id, name);
    if (result.error) { cb({ error: result.error }); return; }
    currentRoomId = roomId.toUpperCase();
    cb({ ok: true, roomId: currentRoomId });
    broadcast(room);
  });

  socket.on('start-game', (_, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room) { cb?.({ error: 'room not found' }); return; }
    if (room.hostId !== socket.id) { cb?.({ error: 'only host can start' }); return; }
    const result = room.startGame();
    if (result.error) { cb?.({ error: result.error }); return; }
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('end-free-phase', (_, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) { cb?.({ error: 'not allowed' }); return; }
    if (room.phase !== 'free') { cb?.({ error: 'wrong phase' }); return; }
    room.beginAction();
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('submit-action', (action, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room) { cb?.({ error: 'room not found' }); return; }
    const result = room.submitAction(socket.id, action);
    if (result.error) { cb?.({ error: result.error }); return; }
    cb?.({ ok: true });
    broadcast(room);
    if (room.allActed()) {
      room.beginGuess();
      broadcast(room);
      if (room.phase === 'settlement') broadcast(room);
    }
  });

  socket.on('submit-guess', (guess, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room) { cb?.({ error: 'room not found' }); return; }
    const result = room.submitGuess(socket.id, guess);
    if (result.error) { cb?.({ error: result.error }); return; }
    cb?.({ ok: true });
    broadcast(room);
    if (room.allGuessed()) {
      room.beginSettlement();
      broadcast(room);
    }
  });

  socket.on('next-round', (_, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) { cb?.({ error: 'not allowed' }); return; }
    if (room.phase !== 'settlement') { cb?.({ error: 'wrong phase' }); return; }
    room.advanceRound();
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.removePlayer(socket.id);
    if (room.players.size === 0) { rooms.delete(currentRoomId); return; }
    broadcast(room);
  });
});

const PORT = parseInt(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`The Tale of Benjamin running at http://localhost:${PORT}`);
  console.log(`LAN access: http://<your-ip>:${PORT}`);
});
