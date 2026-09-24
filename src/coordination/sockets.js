const { createHash } = require('node:crypto');
const { createAuthorization } = require('./authorization');
const digest = sid => createHash('sha256').update(sid).digest('hex');
const game = id => `campaign:${id}`, lobby = id => `lobby:${id}`;
function createCoordinatedSockets({ io, knex, bus, workLifecycle, rewritePayload }) {
  const authorize = createAuthorization(knex);
  const socketsByUser = new Map();
  const lastPresence = new Map();
  let stopping = false;
  const valid = () => bus.ready && !stopping && (!workLifecycle || workLifecycle.state === 'ready');
  const generation = socket => socket.data.admissionGeneration || 0;
  function invalidate(socket) { socket.data.admissionGeneration = generation(socket) + 1; }
  // Consume every promise immediately, including callers intentionally not awaiting.
  function run(promise) {
    workLifecycle?.track(promise);
    promise.catch(() => bus.fail());
    return promise;
  }
  function snapshot() {
    const rooms = {};
    for (const socket of io.sockets.sockets.values()) {
      if (!socket.connected || !socket.data.userId) continue;
      for (const room of socket.rooms) if (room.startsWith('campaign:')) {
        (rooms[room.slice(9)] ||= []).push(socket.data.userId);
      }
    }
    return Object.fromEntries(Object.entries(rooms).map(([id, users]) => [id, [...new Set(users)].sort()]));
  }
  function roster(id) {
    return [...new Set(bus.nodes.flatMap(node => node[id] || []))].sort();
  }
  function onlineCount(id) { return roster(id).length; }
  async function announce(campaignId) {
    if (!valid()) return;
    await bus.refresh();
    await bus.publish({ type: 'presence-refresh', campaignId });
  }
  function controlLocal(message) {
    for (const socket of io.sockets.sockets.values()) {
      if (message.action === 'sessions') {
        if (socket.data.authSessionId && message.sessions.includes(digest(socket.data.authSessionId))) {
          invalidate(socket); socket.emit('unauthorized', { error: 'authentication required' }); socket.disconnect(true);
        }
        continue;
      }
      if (message.action === 'user' && socket.data.userId !== message.userId) continue;
      if (message.action === 'players' && socket.data.userId === message.ownerId) continue;
      invalidate(socket); // Pending joins may not yet be in a room.
      const rooms = message.action === 'players' ? [game(message.campaignId)] : [game(message.campaignId), lobby(message.campaignId)];
      let removed = false;
      for (const room of rooms) if (socket.rooms.has(room)) { socket.leave(room); removed = true; }
      if (removed) socket.emit('campaign:evicted', { campaign_id: message.campaignId, reason: message.reason });
    }
  }
  function control(message) {
    controlLocal(message);
    return run((async () => { await bus.publish(message); await announce(); })());
  }
  function evictUser(campaignId, userId, reason = 'removed') { return control({ type: 'control', action: 'user', campaignId, userId, reason }); }
  function evictCampaign(campaignId) { return control({ type: 'control', action: 'campaign', campaignId, reason: 'deleted' }); }
  function evictGamePlayers(campaignId, ownerId) { return control({ type: 'control', action: 'players', campaignId, ownerId, reason: 'closed' }); }
  function disconnectSessions(sids) { return control({ type: 'control', action: 'sessions', sessions: sids.map(digest) }); }
  function broadcast(campaignId, mode, event, payload, extra = {}) {
    return run((async () => {
      await rewritePayload(payload);
      await bus.publish({ type: 'event', campaignId, mode, event, payload, ...extra });
    })());
  }
  function broadcastBatch(campaignId, mode, event, payloads, extra = {}) {
    return run((async () => {
      if (!Array.isArray(payloads) || payloads.length > 500) throw new Error('COORDINATION_BATCH_LIMIT');
      if (!payloads.length) return;
      for (const payload of payloads) await rewritePayload(payload);
      await bus.publish({ type: 'event-batch', campaignId, mode, event, payloads, ...extra });
    })());
  }
  async function deliver(message, onlySocket) {
    if (!['lobby', 'room', 'owner', 'players', 'users', 'scene', 'scenePlayers'].includes(message.mode)) throw new Error('COORDINATION_PROTOCOL');
    if (message.type === 'event-batch' && (!Array.isArray(message.payloads) || message.payloads.length > 500)) throw new Error('COORDINATION_PROTOCOL');
    const room = message.mode === 'lobby' ? lobby(message.campaignId) : game(message.campaignId);
    for (const socket of onlySocket ? [onlySocket] : [...io.sockets.sockets.values()]) {
      if (!valid() || !socket.connected || !socket.rooms.has(room)) continue;
      const version = generation(socket);
      const allowed = await authorize.access(socket, message.campaignId, message.mode === 'lobby', campaign => {
        if (!valid() || !socket.connected || generation(socket) !== version || !socket.rooms.has(room)) return;
        const owner = campaign.owner_id === socket.data.userId;
        if (message.mode === 'owner' && !owner) return;
        if (message.mode === 'players' && owner) return;
        if (message.mode === 'users' && !message.userIds.includes(socket.data.userId)) return;
        if (message.mode === 'scene' && !owner && campaign.active_scene_id !== message.sceneId) return;
        if (message.mode === 'scenePlayers' && (owner || campaign.active_scene_id !== message.sceneId)) return;
        // Keep authorization locks through the synchronous batch enqueue.
        if (message.type === 'event-batch') {
          for (const payload of message.payloads) socket.emit(message.event, payload);
        } else socket.emit(message.event, message.payload);
      });
      if (!allowed) {
        invalidate(socket); socket.leave(room);
        socket.emit('campaign:evicted', { campaign_id: message.campaignId, reason: 'access changed' });
      }
    }
  }
  async function presence(forceCampaignId) {
    await bus.refresh();
    const local = new Set(lastPresence.keys());
    for (const socket of io.sockets.sockets.values()) for (const room of socket.rooms) {
      if (room.startsWith('campaign:')) local.add(room.slice(9));
      if (room.startsWith('lobby:')) local.add(room.slice(6));
    }
    for (const id of local) {
      const users = roster(id), text = JSON.stringify(users);
      // Explicit room joins/leaves retain the existing presence notification contract.
      // Heartbeats still suppress unchanged rosters.
      if (lastPresence.get(id) === text && id !== forceCampaignId) continue;
      lastPresence.set(id, text);
      await deliver({ campaignId: id, mode: 'room', event: 'campaign:presence', payload: { campaign_id: id, user_ids: users } });
      await deliver({ campaignId: id, mode: 'lobby', event: 'lobby:presence', payload: { campaign_id: id, online: users.length } });
    }
    // Avoid retaining every campaign ever visited in a long-lived process.
    const subscribed = new Set();
    for (const socket of io.sockets.sockets.values()) for (const room of socket.rooms) {
      if (room.startsWith('campaign:')) subscribed.add(room.slice(9));
      if (room.startsWith('lobby:')) subscribed.add(room.slice(6));
    }
    for (const id of lastPresence.keys()) if (!subscribed.has(id)) lastPresence.delete(id);
  }
  async function receive(message) {
    if (message.type === 'control') { controlLocal(message); await announce(); }
    else if (message.type === 'event' || message.type === 'event-batch') await deliver(message);
    else if (message.type === 'presence-refresh') await presence(message.campaignId);
    else throw new Error('COORDINATION_PROTOCOL');
  }
  function attach(socket, user) {
    socket.data.userId = user.id;
    if (!socketsByUser.has(user.id)) socketsByUser.set(user.id, new Set());
    socketsByUser.get(user.id).add(socket.id);
    socket.on('campaign:join', (payload, ack) => run((async () => {
      const respond = value => { if (typeof ack === 'function') ack(value); };
      const campaignId = payload?.campaign_id, version = generation(socket);
      let joined = false;
      const allowed = await authorize.access(socket, campaignId, false, () => {
        if (!valid() || generation(socket) !== version) return;
        socket.join(game(campaignId)); joined = true;
      });
      if (!allowed || !joined) return respond({ ok: false, error: 'join refused' });
      await announce(campaignId);
      if (!valid() || !socket.connected || generation(socket) !== version) return respond({ ok: false, error: 'membership changed; retry' });
      await deliver({ campaignId, mode: 'room', event: 'campaign:presence', payload: { campaign_id: campaignId, user_ids: roster(campaignId) } }, socket);
      if (!socket.rooms.has(game(campaignId))) return respond({ ok: false, error: 'join refused' });
      respond({ ok: true, campaign_id: campaignId });
    })()));
    socket.on('campaign:leave', (payload, ack) => {
      invalidate(socket); socket.leave(game(payload?.campaign_id));
      run(announce(payload?.campaign_id));
      if (typeof ack === 'function') ack({ ok: true });
    });
    socket.on('lobby:subscribe', (payload, ack) => run((async () => {
      const version = generation(socket);
      for (const room of [...socket.rooms]) if (room.startsWith('lobby:')) socket.leave(room);
      const rows = await knex('campaign_members as m').join('campaigns as c', 'c.id', 'm.campaign_id')
        .where('m.user_id', user.id).andWhere('m.status', 'active').whereNull('c.deleted_at').select('c.id');
      const campaigns = [];
      for (const row of rows) await authorize.access(socket, row.id, true, () => {
        if (valid() && generation(socket) === version) {
          socket.join(lobby(row.id)); campaigns.push({ campaign_id: row.id, online: onlineCount(row.id) });
        }
      });
      if (typeof ack === 'function') ack(valid() && generation(socket) === version
        ? { ok: true, campaigns } : { ok: false, error: 'membership changed; retry' });
    })()));
    socket.on('disconnect', () => {
      invalidate(socket);
      const ids = socketsByUser.get(user.id); ids?.delete(socket.id);
      if (!ids?.size) socketsByUser.delete(user.id);
      if (valid()) run(announce());
    });
  }
  return { attach, socketsByUser, evictUser, evictCampaign, evictGamePlayers, disconnectSessions, onlineCount,
    broadcast, broadcastBatch, start: () => bus.start(receive, snapshot), stop() { stopping = true; return bus.close(); },
    get ready() { return bus.ready; } };
}
module.exports = { createCoordinatedSockets };
