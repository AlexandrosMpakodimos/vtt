require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// ── Express setup ──────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// Parse JSON request bodies
app.use(express.json());

// Serve static files from /public
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Socket.io setup ────────────────────────────────────────
const io = new Server(server);

io.on('connection', (socket) => {
  console.log(`[socket] client connected: ${socket.id}`);

  // Echo test: client sends 'ping', server responds 'pong'
  socket.on('ping', (data) => {
    console.log(`[socket] ping from ${socket.id}:`, data);
    socket.emit('pong', { message: 'hello from server', timestamp: Date.now() });
  });

  socket.on('disconnect', () => {
    console.log(`[socket] client disconnected: ${socket.id}`);
  });
});

// ── Start server ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] running at http://localhost:${PORT}`);
});
