// Socket.io campaign rooms, and the authorisation that guards them.
//
// THE SOCKET-SESSION BRIDGE
// -------------------------
// An HTTP request carries a session cookie, express-session turns it into
// req.session, and passport turns that into req.user. A WebSocket has none of
// that machinery — but it *starts* life as an HTTP request (the "handshake"),
// and the browser sends the session cookie on that handshake like any other
// same-origin request. So the cookie is there; it just needs parsing.
//
// io.engine.use(middleware) runs Express-style middleware over that handshake
// request. Running sessionMiddleware -> passport.initialize() -> passport.session()
// over it does exactly what the HTTP pipeline does, leaving the result on
// socket.request.user. That wiring lives in server.js.
//
// The consequence worth internalising: socket.request is a SNAPSHOT of the
// handshake. It is not re-evaluated. A socket that connected while logged in
// stays "logged in" from its own point of view even after the session row is
// deleted — which is why authorisation is re-checked on every join below
// against the live database, never against a value cached at connect time.

const { isActiveMember } = require('./middleware/campaignAuth');

const roomName = (campaignId) => `campaign:${campaignId}`;

function initSockets(io) {
  // user_id -> Set of socket ids. Lets a kick/ban evict a live socket, and lets
  // a user hold several sockets (two tabs) without one closing the other.
  const socketsByUser = new Map();

  function track(userId, socketId) {
    if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
    socketsByUser.get(userId).add(socketId);
  }

  function untrack(userId, socketId) {
    const set = socketsByUser.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) socketsByUser.delete(userId);
  }

  // Called by the kick/ban routes. The DB write alone is not enough: a socket
  // already sitting in the room would keep receiving broadcasts.
  function evictUser(campaignId, userId, reason = 'removed') {
    const ids = socketsByUser.get(userId);
    if (!ids) return 0;
    let evicted = 0;
    for (const sid of ids) {
      const socket = io.sockets.sockets.get(sid);
      if (!socket || !socket.rooms.has(roomName(campaignId))) continue;
      socket.emit('campaign:evicted', { campaign_id: campaignId, reason });
      socket.leave(roomName(campaignId));
      evicted += 1;
    }
    return evicted;
  }

  io.on('connection', (socket) => {
    // Populated by the handshake middleware chain in server.js.
    const user = socket.request.user;

    // Reject an unauthenticated socket outright. Without this, an anonymous
    // socket sits connected and consumes a slot for no reason.
    if (!user) {
      socket.emit('unauthorized', { error: 'authentication required' });
      socket.disconnect(true);
      return;
    }

    track(user.id, socket.id);
    console.log(`Socket connected: ${socket.id} (user: ${user.username})`);

    // One bad connection must never take the process down with it.
    socket.on('error', (err) => console.error('Socket error:', socket.id, err && err.message));

    socket.on('ping', () => socket.emit('pong', { message: 'hello from server', timestamp: Date.now() }));

    // Join a campaign room. Authorisation is re-checked against the database on
    // every attempt (see the note about handshake snapshots above): a user
    // banned five seconds ago must not get in on a stale socket.
    socket.on('campaign:join', async (payload, ack) => {
      const respond = (result) => { if (typeof ack === 'function') ack(result); };
      try {
        const campaignId = payload && payload.campaign_id;
        if (!(await isActiveMember(campaignId, user.id))) {
          socket.emit('campaign:join:error', { error: 'not a member of that campaign' });
          return respond({ ok: false, error: 'not a member of that campaign' });
        }

        socket.join(roomName(campaignId));
        socket.to(roomName(campaignId)).emit('campaign:user-joined', {
          campaign_id: campaignId, user_id: user.id, username: user.username,
        });
        return respond({ ok: true, campaign_id: campaignId });
      } catch (err) {
        console.error('campaign:join failed:', err.message);
        return respond({ ok: false, error: 'join failed' });
      }
    });

    socket.on('campaign:leave', (payload, ack) => {
      const campaignId = payload && payload.campaign_id;
      if (campaignId) {
        socket.leave(roomName(campaignId));
        socket.to(roomName(campaignId)).emit('campaign:user-left', {
          campaign_id: campaignId, user_id: user.id, username: user.username,
        });
      }
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('disconnect', () => {
      // A disconnect is transient and says nothing about membership: the member
      // stays 'active' in the DB and walks straight back in on reconnect.
      // Only a deliberate leave/kick/ban changes status.
      untrack(user.id, socket.id);
      console.log('Client disconnected:', socket.id);
    });
  });

  return { evictUser, roomName, socketsByUser };
}

module.exports = { initSockets, roomName };
