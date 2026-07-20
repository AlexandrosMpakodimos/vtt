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

const knex = require('./db');
const { isActiveMember } = require('./middleware/campaignAuth');
const {
  publicToken, tokenMovePolicy, loadSceneInCampaign,
  validateGridCoord, validateTokenSize,
} = require('./routes/scenes');

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

  // Push a token delta to everyone in a campaign room. Used by the HTTP token
  // routes (place / delete), which do the authoritative write and then hand the
  // shaped row here to fan out. Emitting to io.to(room) rather than a single
  // socket means the acting user's own other tabs get the update too.
  function broadcastToken(campaignId, event, payload) {
    io.to(roomName(campaignId)).emit(event, payload);
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

    // token:move — the one high-frequency delta, sent ONCE on drop (not streamed
    // during the drag; live-drag streaming is a deliberate later optimisation).
    //
    // Server-authoritative, and every check is redone here against the live DB:
    // socket.request is a handshake snapshot (see the header note), so nothing
    // established at connect time may be trusted for a write.
    //   1. Re-verify active membership of the campaign — a member banned since
    //      connecting must not move tokens on a stale socket.
    //   2. Re-verify the socket is actually in the room (it can only be there if
    //      a prior campaign:join authorised it).
    //   3. Scope the scene to the campaign (no cross-campaign token by id).
    //   4. Apply the move policy (GM moves any token; a player only their own).
    //   5. Validate coordinates BEFORE persisting; then write, then broadcast.
    // Only after the write succeeds is the delta broadcast — a rejected or
    // clamped move never reaches other clients.
    socket.on('token:move', async (payload, ack) => {
      const respond = (result) => { if (typeof ack === 'function') ack(result); };
      try {
        const p = payload || {};
        const campaignId = p.campaign_id;
        const sceneId = p.scene_id;
        const tokenId = p.token_id;

        if (!(await isActiveMember(campaignId, user.id))) {
          return respond({ ok: false, error: 'not a member of that campaign' });
        }
        // Must have joined the room first. Guards against a socket that never
        // ran campaign:join trying to write straight into a room.
        if (!socket.rooms.has(roomName(campaignId))) {
          return respond({ ok: false, error: 'join the campaign room first' });
        }

        const scene = await loadSceneInCampaign(sceneId, campaignId);
        if (!scene) return respond({ ok: false, error: 'scene not found' });

        const token = await knex('tokens')
          .where({ id: typeof tokenId === 'string' ? tokenId : '', scene_id: scene.id })
          .first();
        if (!token) return respond({ ok: false, error: 'token not found' });

        // Load the campaign to get owner_id for the policy check. (isActiveMember
        // already proved access; this is only to distinguish GM from player.)
        const campaign = await knex('campaigns')
          .where({ id: campaignId }).whereNull('deleted_at').first();
        if (!campaign) return respond({ ok: false, error: 'campaign not found' });

        if (!tokenMovePolicy({ campaign, token, userId: user.id })) {
          return respond({ ok: false, error: 'you can only move tokens you placed' });
        }

        if (token.locked) return respond({ ok: false, error: 'token is locked' });

        // A move MUST carry both coordinates. Unlike placement (where an absent
        // coord legitimately defaults to origin), a move with a missing x/y is
        // malformed. This guard also closes a coercion hole: JSON serialises
        // Infinity/NaN as null, and Number(null) === 0 would otherwise slip a
        // bogus "move" through as a move-to-origin.
        if (p.x === undefined || p.x === null || p.y === undefined || p.y === null) {
          return respond({ ok: false, error: 'x and y are required' });
        }
        const x = validateGridCoord(p.x, 'x');
        if (x.error) return respond({ ok: false, error: x.error });
        const y = validateGridCoord(p.y, 'y');
        if (y.error) return respond({ ok: false, error: y.error });

        // Optional resize on the same event; ignored unless both provided.
        const updates = { x: x.value, y: y.value, updated_at: knex.fn.now() };
        if (p.width !== undefined) {
          const w = validateTokenSize(p.width, 'width');
          if (w.error) return respond({ ok: false, error: w.error });
          updates.width = w.value;
        }
        if (p.height !== undefined) {
          const h = validateTokenSize(p.height, 'height');
          if (h.error) return respond({ ok: false, error: h.error });
          updates.height = h.value;
        }

        const [row] = await knex('tokens')
          .where({ id: token.id }).update(updates).returning('*');

        const shaped = publicToken(row);
        // Broadcast the authoritative position to the WHOLE room, mover included:
        // if the server clamped or adjusted anything, the mover's optimistic
        // local state is corrected by the same message everyone else receives.
        io.to(roomName(campaignId)).emit('token:moved', shaped);
        return respond({ ok: true, token: shaped });
      } catch (err) {
        console.error('token:move failed:', err.message);
        return respond({ ok: false, error: 'move failed' });
      }
    });

    socket.on('disconnect', () => {
      // A disconnect is transient and says nothing about membership: the member
      // stays 'active' in the DB and walks straight back in on reconnect.
      // Only a deliberate leave/kick/ban changes status.
      untrack(user.id, socket.id);
      console.log('Client disconnected:', socket.id);
    });
  });

  return { evictUser, roomName, socketsByUser, broadcastToken };
}

module.exports = { initSockets, roomName };
