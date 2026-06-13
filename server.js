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
  if (room.moderator) {
    const modSocket = io.sockets.sockets.get(room.moderator.id);
    if (modSocket) modSocket.emit('state', room.publicState(room.moderator.id));
  }
}

io.on('connection', socket => {
  let currentRoomId = null;

  // Room creator becomes the moderator (does not play)
  socket.on('create-room', ({ name }, cb) => {
    const roomId = getRoomId();
    const room = new GameRoom(roomId);
    rooms.set(roomId, room);
    const result = room.addModerator(socket.id, name);
    if (result.error) { cb({ error: result.error }); return; }
    currentRoomId = roomId;
    cb({ ok: true, roomId, isModerator: true });
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

  socket.on('reconnect-room', ({ roomId, name }, cb) => {
    const id = roomId?.toUpperCase();
    const room = rooms.get(id);
    if (!room) { cb({ error: 'room not found' }); return; }

    // Moderator reconnect (detected by name match + disconnected moderator)
    if (room.moderator && !room.moderator.connected && room.moderator.name === name) {
      const result = room.reconnectModerator(socket.id, name);
      if (result.error) { cb({ error: result.error }); return; }
      currentRoomId = id;
      cb({ ok: true, roomId: id, isModerator: true });
      broadcast(room);
      return;
    }

    if (room.phase === 'waiting') {
      const result = room.addPlayer(socket.id, name);
      if (result.error) { cb({ error: result.error }); return; }
      currentRoomId = id;
      cb({ ok: true, roomId: id });
      broadcast(room);
      return;
    }

    const result = room.reconnectPlayer(socket.id, name);
    if (result.error) { cb({ error: result.error }); return; }
    currentRoomId = id;
    cb({ ok: true, roomId: id });
    broadcast(room);
  });

  socket.on('start-game', (_, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room) { cb?.({ error: 'room not found' }); return; }
    if (room.moderator?.id !== socket.id) { cb?.({ error: 'only moderator can start' }); return; }
    const result = room.startGame();
    if (result.error) { cb?.({ error: result.error }); return; }
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('end-free-phase', (_, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.moderator?.id !== socket.id) { cb?.({ error: 'not allowed' }); return; }
    if (room.phase !== 'free') { cb?.({ error: 'wrong phase' }); return; }
    room.beginAction();
    cb?.({ ok: true });
    broadcast(room);
  });

  // Sub-phase 1: previous-round ±1 adjustment (or pass)
  socket.on('submit-adjust', (action, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room) { cb?.({ error: 'room not found' }); return; }
    const result = room.submitAdjust(socket.id, action);
    if (result.error) { cb?.({ error: result.error }); return; }
    cb?.({ ok: true });
    broadcast(room);
    if (room.allAdjusted()) {
      room.beginInvest();
      broadcast(room);
    }
  });

  // Sub-phase 2: current-round coin allocation
  socket.on('submit-invest', (action, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room) { cb?.({ error: 'room not found' }); return; }
    const result = room.submitInvest(socket.id, action);
    if (result.error) { cb?.({ error: result.error }); return; }
    cb?.({ ok: true });
    broadcast(room);
    if (room.allActed()) {
      try { room.beginGuess(); } catch (e) { console.error('[beginGuess]', e); }
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
      try { room.beginSettlement(); } catch (e) { console.error('[beginSettlement]', e); }
      broadcast(room);
    }
  });

  socket.on('next-round', (_, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.moderator?.id !== socket.id) { cb?.({ error: 'not allowed' }); return; }
    if (room.phase !== 'settlement') { cb?.({ error: 'wrong phase' }); return; }
    room.advanceRound();
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(currentRoomId);
    if (!room) return;

    // Moderator disconnect → pause game
    if (room.moderator?.id === socket.id) {
      room.moderator.connected = false;
      broadcast(room); // all clients receive paused:true
      if (room.allDisconnected) {
        const rid = currentRoomId;
        setTimeout(() => {
          const r = rooms.get(rid);
          if (r && r.allDisconnected) rooms.delete(rid);
        }, 5 * 60 * 1000);
      }
      return;
    }

    // Player disconnect
    room.removePlayer(socket.id);

    if (room.phase === 'waiting' && room.players.size === 0) {
      rooms.delete(currentRoomId);
      return;
    }

    // Disconnection may unblock a phase waiting on this player
    if (room.phase === 'action') {
      if (room.actionSubPhase === 'adjust' && room.allAdjusted()) {
        room.beginInvest();
        broadcast(room);
      } else if (room.actionSubPhase === 'invest' && room.allActed()) {
        room.beginGuess();
        broadcast(room);
        if (room.phase === 'settlement') broadcast(room);
      } else {
        broadcast(room);
      }
    } else if (room.phase === 'guess') {
      if (room.guessSubPhase === 'normal' && room.allNormalsGuessed()) {
        room.guessSubPhase = 'benjamin';
      }
      if (room.allGuessed()) {
        try { room.beginSettlement(); } catch (e) { console.error('[beginSettlement/dc]', e); }
        broadcast(room);
      } else {
        broadcast(room);
      }
    } else {
      broadcast(room);
    }

    if (room.allDisconnected) {
      const rid = currentRoomId;
      setTimeout(() => {
        const r = rooms.get(rid);
        if (r && r.allDisconnected) rooms.delete(rid);
      }, 5 * 60 * 1000);
    }
  });
});

const PORT = parseInt(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`The Tale of Benjamin running at http://localhost:${PORT}`);
  console.log(`LAN access: http://<your-ip>:${PORT}`);
});
