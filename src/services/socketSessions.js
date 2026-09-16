// Session revocation for this server's sockets. The shared session store remains
// authoritative; neither a handshake snapshot nor campaign membership is a login.
function createSocketSessions(io) {
  function reject(socket) {
    if (!socket.connected) return;
    socket.emit('unauthorized', { error: 'authentication required' });
    socket.disconnect(true);
  }

  function attach(socket) {
    const sessionId = socket.request.sessionID;
    const userId = socket.request.user && socket.request.user.id;
    const store = socket.request.sessionStore;
    if (!sessionId || !userId || !store || typeof store.get !== 'function') {
      reject(socket);
      return false;
    }
    // Register synchronously, BEFORE reading the store. Revocation can then find
    // sockets whose initial session validation is still pending.
    socket.data.authSessionId = sessionId;
    const valid = () => new Promise(resolve => {
      try {
        store.get(sessionId, (err, session) => resolve(!err && socket.connected
          && session && session.passport && session.passport.user === userId));
      } catch { resolve(false); }
    });
    socket.use((packet, next) => {
      valid().then(ok => {
        if (ok) return next();
        reject(socket);
        return next(new Error('authentication required'));
      });
    });
    // This also catches handshakes that loaded a session before its deletion,
    // but reached the connection handler after the revocation sweep.
    valid().then(ok => { if (!ok) reject(socket); });
    return true;
  }

  function disconnectSessions(sessionIds) {
    const revoked = new Set(sessionIds);
    if (!revoked.size) return;
    for (const socket of Array.from(io.sockets.sockets.values())) {
      if (revoked.has(socket.data.authSessionId)) reject(socket);
    }
  }

  return { attach, disconnectSessions };
}
module.exports = { createSocketSessions };
