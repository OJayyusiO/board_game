import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Game } from './game.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingInterval: 20000,
  pingTimeout: 25000,
});

app.use(express.static(join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

const rooms = new Map(); // code -> { game, players: Map<socketId, {playerId, name}>, createdAt, lastActivity }
const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // 6h idle cleanup

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

function broadcastState(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('state', room.game.snapshot());
  room.lastActivity = Date.now();
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}, 1000 * 60 * 10);

io.on('connection', (socket) => {
  let joinedRoom = null;
  let myPlayerId = null;

  socket.on('createRoom', ({ name, playerId }, cb) => {
    try {
      const code = makeRoomCode();
      const game = new Game();
      const pid = playerId || socket.id;
      game.addPlayer({ id: pid, name });
      const room = {
        game,
        sockets: new Map([[socket.id, pid]]),
        createdAt: Date.now(),
        lastActivity: Date.now(),
      };
      rooms.set(code, room);
      socket.join(code);
      joinedRoom = code;
      myPlayerId = pid;
      cb?.({ ok: true, code, playerId: pid });
      broadcastState(code);
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('joinRoom', ({ code, name, playerId }, cb) => {
    try {
      const room = getRoom(code);
      if (!room) throw new Error('Room not found');
      const upper = code.toUpperCase();

      // Reconnect path: existing playerId in this room
      if (playerId && room.game.players.some(p => p.id === playerId)) {
        room.game.reconnectPlayer(playerId);
        room.sockets.set(socket.id, playerId);
        socket.join(upper);
        joinedRoom = upper;
        myPlayerId = playerId;
        cb?.({ ok: true, code: upper, playerId });
        broadcastState(upper);
        return;
      }

      if (room.game.phase !== 'lobby') throw new Error('Game in progress');
      const pid = playerId || socket.id;
      room.game.addPlayer({ id: pid, name });
      room.sockets.set(socket.id, pid);
      socket.join(upper);
      joinedRoom = upper;
      myPlayerId = pid;
      cb?.({ ok: true, code: upper, playerId: pid });
      broadcastState(upper);
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('leaveRoom', () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (room && myPlayerId) {
      room.game.removePlayer(myPlayerId);
      room.sockets.delete(socket.id);
      if (room.game.players.length === 0) {
        rooms.delete(joinedRoom);
      } else {
        broadcastState(joinedRoom);
      }
    }
    socket.leave(joinedRoom);
    joinedRoom = null;
    myPlayerId = null;
  });

  function ensureRoom() {
    if (!joinedRoom) throw new Error('Not in room');
    const room = rooms.get(joinedRoom);
    if (!room) throw new Error('Room gone');
    return room;
  }

  socket.on('startGame', (_payload, cb) => {
    try {
      const room = ensureRoom();
      room.game.startGame(myPlayerId);
      broadcastState(joinedRoom);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message }); }
  });

  socket.on('hit', (_payload, cb) => {
    try {
      const room = ensureRoom();
      room.game.hit(myPlayerId);
      broadcastState(joinedRoom);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message }); }
  });

  socket.on('stay', (_payload, cb) => {
    try {
      const room = ensureRoom();
      room.game.stay(myPlayerId);
      broadcastState(joinedRoom);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message }); }
  });

  socket.on('chooseTarget', ({ targetId }, cb) => {
    try {
      const room = ensureRoom();
      room.game.chooseTarget(myPlayerId, targetId);
      broadcastState(joinedRoom);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message }); }
  });

  socket.on('nextRound', (_payload, cb) => {
    try {
      const room = ensureRoom();
      room.game.startNextRound(myPlayerId);
      broadcastState(joinedRoom);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message }); }
  });

  socket.on('newGame', (_payload, cb) => {
    try {
      const room = ensureRoom();
      room.game.newGame(myPlayerId);
      broadcastState(joinedRoom);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok: false, error: e.message }); }
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || !myPlayerId) return;
    room.sockets.delete(socket.id);
    // Don't immediately remove from game — allow reconnect within window
    if (room.game.phase === 'lobby') {
      room.game.removePlayer(myPlayerId);
      if (room.game.players.length === 0) {
        rooms.delete(joinedRoom);
        return;
      }
    } else {
      room.game.removePlayer(myPlayerId); // marks as disconnected
    }
    broadcastState(joinedRoom);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Flip 7 server listening on http://localhost:${PORT}`);
});
