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
  publicToken, shapeTokens, tokenMovePolicy, loadSceneInCampaign,
  validateGridCoord, validateTokenSize,
} = require('./routes/scenes');
// The active-scene rule, in one place. See services/sceneAccess.js for why it
// moved out of routes/scenes.js during M5.
// validUuid lives in the leaf module rather than being re-derived here, for the
// same reason mayUseScene was collapsed into it during M5: an input rule with
// two definitions is an input rule with two behaviours.
const { mayUseSceneFor, validUuid } = require('./services/sceneAccess');

const roomName = (campaignId) => `campaign:${campaignId}`;
// The lobby room is separate from the game room. A dashboard viewer joins
// lobby:<id> to receive presence/state for a campaign WITHOUT joining
// campaign:<id> (the game room), so they are never counted as "at the table".
const lobbyName = (campaignId) => `lobby:${campaignId}`;

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
      if (!socket) continue;
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

  // Tell everyone watching a campaign's lobby how many are now at the table.
  function pushPresence(campaignId) {
    io.to(lobbyName(campaignId)).emit('lobby:presence', {
      campaign_id: campaignId, online: onlineCount(campaignId),
    });
  }

  // Exported so HTTP routes can push a lobby event (PATCH /:id uses it for
  // campaign:state). Mirrors broadcastToken's shape, scoped to the lobby room.
  function broadcastLobby(campaignId, event, payload) {
    io.to(lobbyName(campaignId)).emit(event, payload);
  }


  // Push a token delta to everyone in a campaign room. Used by the HTTP token
  // routes (place / delete), which do the authoritative write and then hand the
  // shaped row here to fan out. Emitting to io.to(room) rather than a single
  // socket means the acting user's own other tabs get the update too.
  function broadcastToken(campaignId, event, payload) {
    io.to(roomName(campaignId)).emit(event, payload);
  }

  // Emit a SCENE-SCOPED event. The GM always receives it; players receive it only
  // when the scene is the campaign's ACTIVE scene.
  //
  // Without this, pinning players to the active scene would be enforced on the
  // HTTP layer and leak on the socket layer: every token the GM placed and every
  // fog region they drew while prepping an unopened map would still be pushed to
  // every player in the room. The client filters those by scene_id, but that is
  // client-side filtering of data the server should never have sent — precisely
  // the security theatre that cosmetic token-dimming was rejected as in M2.
  //
  // Built from the two helpers below rather than duplicating their logic, so
  // there is one definition of "the GM" (derived live from owner_id) everywhere.
  async function broadcastScene(campaignId, sceneId, event, payload) {
    const campaign = await knex('campaigns')
      .where({ id: campaignId }).whereNull('deleted_at').first();
    if (!campaign) return;
    if (campaign.active_scene_id === sceneId) {
      broadcastToken(campaignId, event, payload);
      return;
    }
    await broadcastToOwner(campaignId, event, payload);
  }

  // Players only, and only on the active scene. Used by the hide/show transition,
  // where the GM's copy is sent separately as a different event.
  async function broadcastScenePlayers(campaignId, sceneId, event, payload) {
    const campaign = await knex('campaigns')
      .where({ id: campaignId }).whereNull('deleted_at').first();
    if (!campaign || campaign.active_scene_id !== sceneId) return;
    await broadcastToPlayers(campaignId, event, payload);
  }

  // Emit only to the GM's sockets that are in the room. Used for HIDDEN tokens:
  // a hidden token's state may reach the owner but must never reach players.
  // The owner is derived from campaigns.owner_id (single source of truth), and
  // ownership can transfer, so it is looked up live rather than cached.
  async function broadcastToOwner(campaignId, event, payload) {
    const campaign = await knex('campaigns')
      .where({ id: campaignId }).whereNull('deleted_at').first();
    if (!campaign) return;
    const ids = socketsByUser.get(campaign.owner_id);
    if (!ids) return;
    for (const sid of ids) {
      const socket = io.sockets.sockets.get(sid);
      if (socket && socket.rooms.has(roomName(campaignId))) socket.emit(event, payload);
    }
  }

  // Emit to a SPECIFIC SET OF USERS' sockets in the room. M5 (whispers).
  //
  // PROJECT_STATE recorded, during M4, that per-recipient visibility finer than
  // GM/not-GM was "structurally impossible today — broadcastToPlayers targets
  // the room minus the GM, so GM/not-GM is the only distinction the socket layer
  // can express, and a finer rule would need new socket machinery, not a new
  // column." That note is wrong as written, and M5 depends on it being wrong:
  // broadcastToOwner directly above ALREADY does per-user targeting. It looks up
  // socketsByUser for one id and emits to that user's sockets in the room. It is
  // this function with a recipient set of size one.
  //
  // So this is a generalisation of an existing helper, not new machinery. The
  // room membership check is kept for the same reason broadcastToOwner keeps it:
  // socketsByUser is global, so without it a whisper would reach a recipient's
  // socket that is connected but sitting in a different campaign.
  //
  // Whisper policy, decided 2026-08-03: a private message reaches exactly the
  // ids in whisper_to plus its sender. The GM is included only when explicitly
  // targeted. Silently copying the GM on every private message is surveillance,
  // and this project already chose prevention over surveillance in M4 when it
  // took a restricted field allow-list over a change history.
  async function broadcastToUsers(campaignId, userIds, event, payload) {
    const campaign = await knex('campaigns')
      .where({ id: campaignId }).whereNull('deleted_at').first();
    if (!campaign) return;
    const room = roomName(campaignId);
    // A Set, so a duplicate id (sender also listed as a recipient) does not emit
    // the same message twice to the same socket.
    for (const userId of new Set(userIds || [])) {
      const ids = socketsByUser.get(userId);
      if (!ids) continue;
      for (const sid of ids) {
        const socket = io.sockets.sockets.get(sid);
        if (socket && socket.rooms.has(room)) socket.emit(event, payload);
      }
    }
  }

  // Emit to every socket in the room EXCEPT the GM's. Used when a token becomes
  // hidden (players are told to drop it) or a hidden token is created (players
  // must not receive it, but the "not owner" set is the safe target for the
  // player-facing half of a visibility change).
  async function broadcastToPlayers(campaignId, event, payload) {
    const campaign = await knex('campaigns')
      .where({ id: campaignId }).whereNull('deleted_at').first();
    if (!campaign) return;
    const ownerSockets = socketsByUser.get(campaign.owner_id) || new Set();
    const room = io.sockets.adapter.rooms.get(roomName(campaignId));
    if (!room) return;
    for (const sid of room) {
      if (ownerSockets.has(sid)) continue; // skip the GM
      io.sockets.sockets.get(sid)?.emit(event, payload);
    }
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
    // Presence counts DISTINCT users among a room's sockets, so each socket
    // carries its user id where onlineCount can read it (a GM with two tabs is
    // one person at the table).
    socket.data.userId = user.id;
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
        // Someone joined the game room: tell the campaign's lobby the new count.
        pushPresence(campaignId);
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
        const campaigns = [];
        for (const row of rows) {
          socket.join(lobbyName(row.id));
          campaigns.push({ campaign_id: row.id, online: onlineCount(row.id) });
        }
        return respond({ ok: true, campaigns });
      } catch (err) {
        console.error('lobby:subscribe failed:', err.message);
        return respond({ ok: false, error: 'subscribe failed' });
      }
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

        // [FIXED 2026-08-07] Shape-check the id before it reaches a query.
        //
        // Recorded as cosmetic in the M2 canvas audit and left through four
        // milestones, on the grounds that Postgres rejects a malformed uuid
        // anyway and the process survives. Both true. What made it worth fixing
        // is that it appeared in the server log of every full sweep since —
        // `invalid input syntax for type uuid: ""` — and a log that routinely
        // carries a harmless error trains its reader to skim past errors.
        //
        // Placed AFTER the membership and room checks, deliberately. Answering
        // "bad token id" to a caller who is not a member would order a
        // validation error ahead of an authorisation one, which is the shape of
        // an oracle even where — as here — the disclosed fact is about the
        // caller's own input. The HTTP routes resolve shape inside
        // loadSceneInCampaign, after their authorisation middleware; this
        // matches them.
        //
        // A non-string coerces to '' here, so the typeof test the batch handler
        // performs is necessary but not sufficient: 'not-a-uuid' is a string
        // and still reaches the database.
        if (!validUuid(tokenId)) {
          return respond({ ok: false, error: 'bad token id' });
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

        // Players are pinned to the active scene on the socket path too. Without
        // this, the HTTP gate would be bypassable: a player who had a token on a
        // scene before it was deactivated could keep moving it there unseen.
        //
        // M5: this was an INLINE COPY of routes/scenes.js's mayUseScene, which
        // was never exported. Two copies here plus the original made three, all
        // correct, none of them the single definition an authorisation rule
        // should have — and M3's V2 was exactly a boundary that held in one place
        // and leaked in another. Now one function in services/sceneAccess.js.
        if (!mayUseSceneFor({ isOwner: campaign.owner_id === user.id, campaign, scene })) {
          return respond({ ok: false, error: 'that scene is not active' });
        }

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

        // shapeTokens, not publicToken: a move broadcast must carry the same
        // resolved picture the scene load did, or a token whose art is
        // inherited would blank on every other client the moment it moved.
        const shaped = await shapeTokens(row);
        // Broadcast the authoritative position. A HIDDEN token must reach only
        // the GM — sending it to the room would leak the position of a token
        // players aren't meant to see. A visible token goes to the whole room
        // (mover included, so a server clamp self-corrects the mover's optimism).
        if (shaped.hidden) {
          await broadcastToOwner(campaignId, 'token:moved', shaped);
        } else {
          await broadcastScene(campaignId, scene.id, 'token:moved', shaped);
        }
        return respond({ ok: true, token: shaped });
      } catch (err) {
        console.error('token:move failed:', err.message);
        return respond({ ok: false, error: 'move failed' });
      }
    });

    // token:move-batch — group move (marquee drag) and keyboard nudge. Same
    // discipline as the single move, applied PER TOKEN: membership + room are
    // checked once, then each token is scope-checked, policy-checked, lock-checked
    // and coord-validated independently. A token the caller may not move (someone
    // else's, or locked) is SILENTLY DROPPED from the batch, not an error for the
    // whole set — grabbing a cluster and moving only your own is the intended feel.
    // Payload: { campaign_id, scene_id, moves: [{ token_id, x, y }, ...] }.
    // --- pings -------------------------------------------------------------
    //
    // A ping is a transient marker: somebody points at a spot on the map and
    // everyone sees a circle there for a couple of seconds. It is the one piece
    // of real-time state in this project that is DELIBERATELY NOT PERSISTED —
    // there is no table, no row, and nothing to load on a page refresh.
    //
    // That is not laziness. A ping means "look here NOW"; a ping that survived a
    // reload would be a ping that means something else, and storing it would
    // add a table, a cap, a sweep and a disclosure rule to a feature whose
    // entire lifetime is shorter than the request that would write it.
    //
    // AUTHORISATION IS THE SAME AS EVERYTHING ELSE ON THIS TRANSPORT, and that
    // is the point: an ephemeral event is still an event, and "it disappears in
    // two seconds" is not an argument for skipping the checks. Membership, room
    // membership, and the active-scene rule all apply — without the last one a
    // player could ping a map the GM has not revealed, and learn from the
    // absence of a refusal that it exists.
    //
    // FOCUS is GM-only. A normal ping draws a circle; a focus ping also moves
    // every player's view to it. Moving somebody's viewport is a stronger act
    // than drawing on it, so it takes the stronger permission — and the flag is
    // recomputed HERE from campaign ownership rather than trusted from the
    // payload, because a client that could set `focus` could seize the table's
    // attention at will.
    socket.on('scene:ping', async (payload, ack) => {
      const respond = (result) => { if (typeof ack === 'function') ack(result); };
      try {
        const p = payload || {};
        const campaignId = p.campaign_id;
        const sceneId = p.scene_id;

        if (!(await isActiveMember(campaignId, user.id))) {
          return respond({ ok: false, error: 'not a member of that campaign' });
        }
        if (!socket.rooms.has(roomName(campaignId))) {
          return respond({ ok: false, error: 'join the campaign room first' });
        }

        const scene = await loadSceneInCampaign(sceneId, campaignId);
        if (!scene) return respond({ ok: false, error: 'scene not found' });

        const campaign = await knex('campaigns')
          .where({ id: campaignId }).whereNull('deleted_at').first();
        if (!campaign) return respond({ ok: false, error: 'campaign not found' });

        const isOwner = campaign.owner_id === user.id;
        if (!mayUseSceneFor({ isOwner, campaign, scene })) {
          return respond({ ok: false, error: 'that scene is not active' });
        }

        // Grid coordinates, bounded to the scene. Unbounded values would let a
        // ping be placed far outside the map — harmless to the server, and a
        // way to scroll every other client's view to nowhere when combined with
        // focus.
        const x = Number(p.x);
        const y = Number(p.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return respond({ ok: false, error: 'x and y are required' });
        }
        const maxX = Math.max(1, Math.floor(scene.width / 50));
        const maxY = Math.max(1, Math.floor(scene.height / 50));
        if (x < -1 || y < -1 || x > maxX + 1 || y > maxY + 1) {
          return respond({ ok: false, error: 'ping is outside the scene' });
        }

        // Recomputed, never taken from the body.
        const focus = isOwner && p.focus === true;

        // The zoom a focus ping imposes on every other client.
        //
        // This is the only value in the project that a client supplies and that
        // then acts on OTHER PEOPLE'S SCREENS, so it is bounded here rather than
        // trusted and bounded on arrival. A client that could send an arbitrary
        // number would be able to zoom the whole table to 10000% — not a data
        // breach, but a way to make the application unusable for everyone else,
        // which is the same class of harm as an unbounded write.
        //
        // The bounds match the client's own, deliberately: two limits on one
        // quantity that disagree is how a value gets accepted here and refused
        // there. Carried only when focus is set, because it means nothing
        // otherwise and an ignored field invites somebody to rely on it.
        //
        // [FIXED before shipping, 2026-08-10] typeof BEFORE any coercion.
        // `Number.isFinite(Number(p.zoom))` accepts `[[2]]`, because
        // Number([[2]]) is 2 — the FIFTH appearance of this one trap in this
        // project, after Number([[5]]) in the M2 canvas validators,
        // String(['2d6']) in the dice bridge, String(['#ffffff']) in
        // validateColor, and an array used as an object key in formatFor.
        //
        // Caught here by running the clamp against a table of inputs rather
        // than by reading it. Every previous instance was found by a probe too;
        // none has ever been found by inspection, which is the more useful fact
        // about this class than the trap itself.
        //
        // A string is refused rather than coerced. This payload comes from our
        // own client, which sends a number, so accepting '3' would only widen
        // the surface for nothing.
        let zoom = null;
        if (focus && typeof p.zoom === 'number' && Number.isFinite(p.zoom)) {
          zoom = Math.max(0.25, Math.min(4, p.zoom));
        }

        // The colour is the member's own, read from the database rather than
        // sent. A client-supplied colour could impersonate another player at the
        // table, which is exactly what the colour exists to prevent.
        const member = await knex('campaign_members')
          .where({ campaign_id: campaignId, user_id: user.id }).first();

        const ping = {
          scene_id: scene.id,
          x,
          y,
          focus,
          zoom,
          user_id: user.id,
          color: (member && member.color) || null,
        };

        // Scene-scoped, so a player on another map hears nothing — the same
        // filter every token and fog broadcast uses. The GM gets it separately
        // because they may be looking at a different scene entirely.
        await broadcastScenePlayers(campaignId, scene.id, 'scene:ping', ping);
        await broadcastToOwner(campaignId, 'scene:ping', ping);
        return respond({ ok: true });
      } catch (err) {
        console.error('scene:ping failed:', err.message);
        return respond({ ok: false, error: 'ping failed' });
      }
    });


    socket.on('token:move-batch', async (payload, ack) => {
      const respond = (result) => { if (typeof ack === 'function') ack(result); };
      try {
        const p = payload || {};
        const campaignId = p.campaign_id;
        const sceneId = p.scene_id;
        const moves = Array.isArray(p.moves) ? p.moves : null;

        if (!moves || moves.length === 0) return respond({ ok: false, error: 'moves is empty' });
        if (moves.length > 500) return respond({ ok: false, error: 'too many moves' });

        if (!(await isActiveMember(campaignId, user.id))) {
          return respond({ ok: false, error: 'not a member of that campaign' });
        }
        if (!socket.rooms.has(roomName(campaignId))) {
          return respond({ ok: false, error: 'join the campaign room first' });
        }
        const scene = await loadSceneInCampaign(sceneId, campaignId);
        if (!scene) return respond({ ok: false, error: 'scene not found' });
        const campaign = await knex('campaigns')
          .where({ id: campaignId }).whereNull('deleted_at').first();
        if (!campaign) return respond({ ok: false, error: 'campaign not found' });
        // Same active-scene pin as the single move above, through the same
        // single definition.
        if (!mayUseSceneFor({ isOwner: campaign.owner_id === user.id, campaign, scene })) {
          return respond({ ok: false, error: 'that scene is not active' });
        }

        const applied = [];
        const rejected = [];
        // One transaction so the group move lands atomically — either the
        // authorised subset all commit, or (on an unexpected error) none do.
        await knex.transaction(async (trx) => {
          for (const m of moves) {
            const tokenId = m && m.token_id;
            // typeof alone lets 'not-a-uuid' through to the query; the shape
            // check is what actually keeps a malformed id out of Postgres.
            if (!validUuid(tokenId)) { rejected.push({ token_id: tokenId, error: 'bad id' }); continue; }
            const token = await trx('tokens').where({ id: tokenId, scene_id: scene.id }).first();
            if (!token) { rejected.push({ token_id: tokenId, error: 'not found' }); continue; }
            if (!tokenMovePolicy({ campaign, token, userId: user.id })) {
              rejected.push({ token_id: tokenId, error: 'not yours' }); continue;
            }
            if (token.locked) { rejected.push({ token_id: tokenId, error: 'locked' }); continue; }
            if (m.x === undefined || m.x === null || m.y === undefined || m.y === null) {
              rejected.push({ token_id: tokenId, error: 'x and y required' }); continue;
            }
            const x = validateGridCoord(m.x, 'x');
            const y = validateGridCoord(m.y, 'y');
            if (x.error || y.error) { rejected.push({ token_id: tokenId, error: x.error || y.error }); continue; }
            const [row] = await trx('tokens')
              .where({ id: token.id })
              .update({ x: x.value, y: y.value, updated_at: knex.fn.now() })
              .returning('*');
            // eslint-disable-next-line no-await-in-loop
            applied.push(await shapeTokens(row));
          }
        });

        // One broadcast for the whole authorised subset. Hidden tokens in the set
        // go only to the GM; visible ones to the room. (A player can only move
        // their own visible tokens anyway, so their batches are never hidden.)
        if (applied.length) {
          const visible = applied.filter((t) => !t.hidden);
          const hidden = applied.filter((t) => t.hidden);
          if (visible.length) await broadcastScene(campaignId, scene.id, 'token:moved-batch', { tokens: visible });
          if (hidden.length) await broadcastToOwner(campaignId, 'token:moved-batch', { tokens: hidden });
        }
        return respond({ ok: true, applied, rejected });
      } catch (err) {
        console.error('token:move-batch failed:', err.message);
        return respond({ ok: false, error: 'batch move failed' });
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
      // any game room it was in — tell each of those campaigns' lobbies.
      for (const campaignId of leavingGameRooms) pushPresence(campaignId);
      console.log('Client disconnected:', socket.id);
    });
  });

  return {
    evictUser, roomName, socketsByUser,
    broadcastToken, broadcastToOwner, broadcastToPlayers,
    broadcastScene, broadcastScenePlayers,
    // §7 lobby: the dashboard's presence/state channel. broadcastLobby is called
    // by PATCH /campaigns/:id to fan out campaign:state; lobbyName/onlineCount
    // are exported alongside so the lobby suite can assert the contract directly.
    broadcastLobby, lobbyName, onlineCount,
    // M5. The only addition to this file: one helper, no new event handler and
    // therefore no new authorisation surface. Fog cost this file one line and M4
    // cost it none, for the same reason — every combat and chat write is
    // structural and goes over HTTP.
    broadcastToUsers,
    // Same function as broadcastToken, exported under a neutral name. Fog
    // regions and the active-scene pointer are broadcast to the whole room too,
    // and routing them through a helper called "broadcastToken" would make the
    // call sites read like a lie. No behaviour change, no existing caller
    // touched — deliberately an alias rather than a rename, to avoid churn.
    broadcastRoom: broadcastToken,
  };
}

module.exports = { initSockets, roomName, lobbyName };
