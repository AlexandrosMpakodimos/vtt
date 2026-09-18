// One owner for room admission generations, eviction, tracking and presence.
// Session enforcement stays in socketSessions and runs before attach().
// Callers use the same map for existing per-user broadcasts; no second registry.
const roomName = (campaignId) => `campaign:${campaignId}`;
// The lobby room is separate from the game room. A dashboard viewer joins
// lobby:<id> to receive presence/state for a campaign WITHOUT joining
// campaign:<id> (the game room), so they are never counted as "at the table".
const lobbyName = (campaignId) => `lobby:${campaignId}`;

function createRoomLifecycle({ io, knex, isActiveMember }) {
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

  // Per-socket generations invalidate authorization reads already in flight.
  // They need no persistent map and are discarded with the socket.
  const generation = socket => socket.data.admissionGeneration || 0;
  const invalidateAdmission = socket => { socket.data.admissionGeneration = generation(socket) + 1; };
  const admissionCurrent = (socket, version) => socket.connected && generation(socket) === version;

  // Closing preserves dashboard subscriptions but removes non-owner game access.
  function evictGamePlayers(campaignId, ownerId) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.userId === ownerId) continue;
      invalidateAdmission(socket);
      if (!socket.rooms.has(roomName(campaignId))) continue;
      socket.leave(roomName(campaignId));
      socket.emit('campaign:evicted', { campaign_id: campaignId, reason: 'closed' });
    }
    pushPresence(campaignId);
  }

  // Called by the kick/ban routes. The DB write alone is not enough: a socket
  // already sitting in the room would keep receiving broadcasts.
  function evictUser(campaignId, userId, reason = 'removed') {
    const ids = socketsByUser.get(userId);
    if (!ids) return 0;
    let evicted = 0;
    for (const sid of ids) {
      const socket = io.sockets.sockets.get(sid);
      if (!socket) continue;
      invalidateAdmission(socket);
      // Remove the target from the LOBBY room too, and tell them there: a
      // dashboard viewer who was kicked should see the card vanish even though
      // they never joined the game room. The returned count still reflects only
      // game-room evictions, so existing callers are unchanged.
      if (socket.rooms.has(lobbyName(campaignId))) {
        socket.emit('campaign:evicted', { campaign_id: campaignId, reason });
        socket.leave(lobbyName(campaignId));
      }
      if (!socket.rooms.has(roomName(campaignId))) continue;
      socket.emit('campaign:evicted', { campaign_id: campaignId, reason });
      socket.leave(roomName(campaignId));
      evicted += 1;
    }
    // Presence in this campaign's lobby has dropped by the evicted user.
    pushPresence(campaignId);
    return evicted;
  }

  // Remove game and dashboard subscriptions when the campaign is deleted.
  // Snapshot the union: leave() mutates the adapter's room sets.
  function evictCampaign(campaignId) {
    // Pending subscribers may not yet appear in either room.
    for (const socket of io.sockets.sockets.values()) invalidateAdmission(socket);
    const game = roomName(campaignId), lobby = lobbyName(campaignId);
    const ids = new Set([
      ...(io.sockets.adapter.rooms.get(game) || []),
      ...(io.sockets.adapter.rooms.get(lobby) || []),
    ]);
    for (const sid of ids) {
      const socket = io.sockets.sockets.get(sid);
      if (!socket) continue;
      socket.leave(game);
      socket.leave(lobby);
      socket.emit('campaign:evicted', { campaign_id: campaignId, reason: 'deleted' });
    }
  }

  // How many DISTINCT users have a socket in the campaign's GAME room. "At the
  // table" means the game page, not the dashboard — lobby-only sockets are not
  // counted. Reads socket.data.userId set at connection.
  function onlineCount(campaignId) {
    const room = io.sockets.adapter.rooms.get(roomName(campaignId));
    if (!room) return 0;
    const users = new Set();
    for (const sid of room) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data && s.data.userId != null) users.add(s.data.userId);
    }
    return users.size;
  }

  // The DISTINCT user ids currently at the table (game room). Same enumeration as
  // onlineCount, but returns the set — the game room's presence roster needs to
  // know WHO is online, not just how many. Used to seed a joining socket with the
  // people already present (join/leave deltas alone would miss them).
  function onlineUserIds(campaignId) {
    const room = io.sockets.adapter.rooms.get(roomName(campaignId));
    if (!room) return [];
    const users = new Set();
    for (const sid of room) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data && s.data.userId != null) users.add(s.data.userId);
    }
    return [...users];
  }

  // Tell everyone watching a campaign's lobby how many are now at the table.
  function pushPresence(campaignId) {
    io.to(lobbyName(campaignId)).emit('lobby:presence', {
      campaign_id: campaignId, online: onlineCount(campaignId),
    });
  }

  // Called once per authenticated connection, after session enforcement attaches.
  function attach(socket, user) {
    track(user.id, socket.id);
    // Presence counts DISTINCT users among a room's sockets, so each socket
    // carries its user id where onlineCount can read it (a GM with two tabs is
    // one person at the table).
    socket.data.userId = user.id;
    console.log(`Socket connected: ${socket.id} (user: ${user.username})`);

    // Join a campaign room. Authorisation is re-checked against the database on
    // every attempt (see the note about handshake snapshots above): a user
    // banned five seconds ago must not get in on a stale socket.
    socket.on('campaign:join', async (payload, ack) => {
      const respond = (result) => { if (typeof ack === 'function') ack(result); };
      try {
        const version = generation(socket);
        const campaignId = payload && payload.campaign_id;
        if (!(await isActiveMember(campaignId, user.id))) {
          socket.emit('campaign:join:error', { error: 'not a member of that campaign' });
          return respond({ ok: false, error: 'not a member of that campaign' });
        }

        if (!admissionCurrent(socket, version)) return respond({ ok: false, error: 'membership changed; retry' });
        await socket.join(roomName(campaignId));
        if (!admissionCurrent(socket, version)) {
          socket.leave(roomName(campaignId));
          return respond({ ok: false, error: 'membership changed; retry' });
        }
        socket.to(roomName(campaignId)).emit('campaign:user-joined', {
          campaign_id: campaignId, user_id: user.id, username: user.username,
        });
        // Seed THIS socket with everyone already at the table (join/leave deltas
        // alone would miss people who were here before it connected). Sent only
        // to the joiner, after it has joined so it includes itself.
        socket.emit('campaign:presence', {
          campaign_id: campaignId, user_ids: onlineUserIds(campaignId),
        });
        // Someone joined the game room: tell the campaign's lobby the new count.
        pushPresence(campaignId);
        return respond({ ok: true, campaign_id: campaignId });
      } catch (err) {
        console.error('campaign:join failed:', err.message);
        return respond({ ok: false, error: 'join failed' });
      }
    });

    socket.on('campaign:leave', (payload, ack) => {
      invalidateAdmission(socket);
      const campaignId = payload && payload.campaign_id;
      if (campaignId) {
        socket.leave(roomName(campaignId));
        socket.to(roomName(campaignId)).emit('campaign:user-left', {
          campaign_id: campaignId, user_id: user.id, username: user.username,
        });
        // The leaver is gone from the table; refresh the lobby's count.
        pushPresence(campaignId);
      }
      if (typeof ack === 'function') ack({ ok: true });
    });

    // Subscribe this socket to the lobby of every campaign the user belongs to.
    // The server DERIVES the set from the database — the client supplies no ids,
    // so there is nothing to validate and no id to leak. Idempotent: it first
    // leaves any lobby rooms it is already in, so a re-subscribe after a list
    // change simply reconciles to the current membership.
    socket.on('lobby:subscribe', async (payload, ack) => {
      const respond = (result) => { if (typeof ack === 'function') ack(result); };
      try {
        const version = generation(socket);
        // Leave every lobby room this socket currently sits in.
        for (const r of Array.from(socket.rooms)) {
          if (typeof r === 'string' && r.indexOf('lobby:') === 0) socket.leave(r);
        }
        // The user's active memberships in campaigns that still exist.
        const rows = await knex('campaign_members as m')
          .join('campaigns as c', 'c.id', 'm.campaign_id')
          .where('m.user_id', user.id)
          .andWhere('m.status', 'active')
          .whereNull('c.deleted_at')
          .select('c.id');
        if (!admissionCurrent(socket, version)) return respond({ ok: false, error: 'membership changed; retry' });
        const campaigns = [];
        for (const row of rows) {
          await socket.join(lobbyName(row.id));
          if (!admissionCurrent(socket, version)) {
            socket.leave(lobbyName(row.id));
            for (const joined of campaigns) socket.leave(lobbyName(joined.campaign_id));
            return respond({ ok: false, error: 'membership changed; retry' });
          }
          campaigns.push({ campaign_id: row.id, online: onlineCount(row.id) });
        }
        return respond({ ok: true, campaigns });
      } catch (err) {
        console.error('lobby:subscribe failed:', err.message);
        return respond({ ok: false, error: 'subscribe failed' });
      }
    });

    // `disconnecting` fires while socket.rooms STILL lists the rooms; capture the
    // game rooms this socket is in so `disconnect` (after it has left them) can
    // recompute and push presence for each. Lobby rooms need no push — a viewer
    // leaving the lobby does not change who is at the table.
    let leavingGameRooms = [];
    socket.on('disconnecting', () => {
      leavingGameRooms = [];
      for (const r of socket.rooms) {
        if (typeof r === 'string' && r.indexOf('campaign:') === 0) {
          leavingGameRooms.push(r.slice('campaign:'.length));
        }
      }
    });

    socket.on('disconnect', () => {
      // A disconnect is transient and says nothing about membership: the member
      // stays 'active' in the DB and walks straight back in on reconnect.
      // Only a deliberate leave/kick/ban changes status.
      untrack(user.id, socket.id);
      // Now that this socket has left its rooms, the table count has dropped for
      // any game room it was in — tell each of those campaigns' lobbies, and the
      // game room itself IF this was the user's last socket there (another open
      // tab means they are still present, so no user-left in that case). Without
      // this, a browser close/refresh would never clear the presence indicator —
      // only an explicit campaign:leave did, which a tab-close never sends.
      for (const campaignId of leavingGameRooms) {
        pushPresence(campaignId);
        if (!onlineUserIds(campaignId).includes(user.id)) {
          io.to(roomName(campaignId)).emit('campaign:user-left', {
            campaign_id: campaignId, user_id: user.id, username: user.username,
          });
        }
      }
      console.log('Client disconnected:', socket.id);
    });
  }

  return {
    attach, evictUser, evictCampaign, evictGamePlayers,
    socketsByUser, onlineCount,
  };
}

module.exports = { createRoomLifecycle, roomName, lobbyName };
