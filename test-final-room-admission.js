// Production room lifecycle, with controlled authorization and adapter scheduling.
const { createRoomLifecycle } = require('./src/socket/roomLifecycle');

let passed = 0, failed = 0;
function check(name, ok) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) passed++; else failed++;
}
function latch() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function bounded(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('admission test timed out')), 2000);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Original seven scenarios: authorization captures a snapshot, then eviction
// invalidates it before the query resolves. Room joins here stay synchronous.
async function run(lobby, revoked, action = 'evict') {
  const gate = latch(), reached = latch(), handlers = {}, rooms = new Map(), sockets = new Map();
  let active = true;
  const socket = {
    id: 's', connected: true, request: { user: { id: 'u', username: 'member' } },
    data: {}, rooms: new Set(['s']),
    on: (event, fn) => { handlers[event] = fn; },
    emit() {}, to: () => ({ emit() {} }),
    join(room) {
      this.rooms.add(room);
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(this.id);
    },
    leave(room) { this.rooms.delete(room); rooms.get(room)?.delete(this.id); },
  };
  sockets.set('s', socket);
  const io = { sockets: { sockets, adapter: { rooms } }, to: () => ({ emit() {} }) };
  async function snapshot(value) {
    const captured = value;
    reached.resolve();
    await gate.promise;
    return captured;
  }
  const knex = () => {
    const q = {
      join: () => q, where: () => q, andWhere: () => q, whereNull: () => q,
      select: () => snapshot(active ? [{ id: 'c' }] : []),
    };
    return q;
  };
  const api = createRoomLifecycle({ io, knex, isActiveMember: () => snapshot(active) });
  api.attach(socket, socket.request.user);
  let response;
  const work = handlers[lobby ? 'lobby:subscribe' : 'campaign:join'](
    { campaign_id: 'c' }, r => { response = r; },
  );
  await bounded(reached.promise);
  if (revoked) {
    active = false;
    if (action === 'delete') api.evictCampaign('c');
    else if (action === 'close') api.evictGamePlayers('c', 'gm');
    else api.evictUser('c', 'u');
  }
  gate.resolve();
  await bounded(work);
  const joined = socket.rooms.has((lobby ? 'lobby:' : 'campaign:') + 'c');
  check((lobby ? 'lobby' : 'game') + ' ' + action
    + (revoked ? ': pending join cannot undo eviction' : ': normal subscription works'),
  revoked ? !joined : joined && response?.ok === true);
}

// Pause the adapter join itself, after authorization has succeeded. The room is
// added only after the latch opens, so eviction cannot rely on existing rooms.
function fixture({ lobby = false, delay = true, ids = ['c'], userId = 'u' } = {}) {
  const gate = latch(), reached = latch(), rooms = new Map(), sockets = new Map();
  const events = [], responses = [];
  const io = {
    sockets: { sockets, adapter: { rooms } },
    to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }),
  };
  const knex = () => {
    const q = {
      join: () => q, where: () => q, andWhere: () => q, whereNull: () => q,
      select: async () => ids.map(id => ({ id })),
    };
    return q;
  };
  const api = createRoomLifecycle({ io, knex, isActiveMember: async () => true });
  const delayedRoom = (lobby ? 'lobby:' : 'campaign:') + ids.at(-1);
  function add(id, uid = userId) {
    const handlers = {};
    const socket = {
      id, connected: true, data: {}, request: { user: { id: uid, username: uid } },
      rooms: new Set([id]),
      on: (event, fn) => { handlers[event] = fn; },
      emit: (event, payload) => events.push({ socket: id, event, payload }),
      to: room => ({ emit: (event, payload) => events.push({ from: id, room, event, payload }) }),
      async join(room) {
        if (delay && id === 's' && room === delayedRoom) {
          reached.resolve();
          await gate.promise;
        }
        this.rooms.add(room);
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(id);
      },
      leave(room) { this.rooms.delete(room); rooms.get(room)?.delete(id); },
      disconnect() {
        handlers.disconnecting();
        this.connected = false;
        for (const room of [...this.rooms]) this.leave(room);
        handlers.disconnect();
        sockets.delete(id);
      },
    };
    sockets.set(id, socket);
    api.attach(socket, socket.request.user);
    return { socket, handlers };
  }
  const primary = add('s');
  return {
    api, io, events, responses, gate, reached, add, ...primary,
    start: () => primary.handlers[lobby ? 'lobby:subscribe' : 'campaign:join'](
      { campaign_id: 'c' }, r => responses.push(r),
    ),
  };
}
async function delayedAdmission(lobby, action, ids = ['c']) {
  const f = fixture({ lobby, ids });
  const work = f.start();
  await bounded(f.reached.promise);
  const label = `delayed ${lobby ? 'lobby' : 'game'} join / ${action}`
    + (ids.length > 1 ? ' / partial subscription' : '');
  check(label + ': no acknowledgement before adapter completion', f.responses.length === 0);
  if (action === 'evict') f.api.evictUser('c', 'u');
  if (action === 'delete') f.api.evictCampaign('c');
  if (action === 'close') f.api.evictGamePlayers('c', 'gm');
  if (action === 'leave') f.handlers['campaign:leave']({ campaign_id: 'c' }, () => {});
  if (action === 'disconnect') f.socket.disconnect();
  // Ignore the eviction/leave's own presence update. A cancelled admission must
  // not emit a new joined/roster/presence success after its join resolves.
  const before = f.events.length;
  f.gate.resolve();
  await bounded(work);
  if (action === 'normal') {
    check(label + ': success acknowledgement', f.responses.length === 1 && f.responses[0].ok === true);
    check(label + ': joined intended room', f.socket.rooms.has((lobby ? 'lobby:' : 'campaign:') + 'c'));
    check(label + ': game only contributes to online count', f.api.onlineCount('c') === (lobby ? 0 : 1));
  } else {
    check(label + ': exact cancellation acknowledgement', f.responses.length === 1
      && f.responses[0].ok === false && f.responses[0].error === 'membership changed; retry');
    check(label + ': all rooms from this admission cleaned up', ids.every(id => {
      const room = (lobby ? 'lobby:' : 'campaign:') + id;
      return !f.socket.rooms.has(room) && !f.io.sockets.adapter.rooms.get(room)?.has('s');
    }));
    check(label + ': no success events after cancellation', f.events.length === before);
  }
}
async function presenceContracts() {
  const f = fixture({ delay: false });
  const second = f.add('second'), owner = f.add('owner', 'gm'), dashboard = f.add('dashboard', 'viewer');
  await f.start();
  await second.handlers['campaign:join']({ campaign_id: 'c' }, () => {});
  await owner.handlers['campaign:join']({ campaign_id: 'c' }, () => {});
  await dashboard.handlers['lobby:subscribe']({}, () => {});
  check('tracking: two tabs share one user entry', f.api.socketsByUser.get('u').size === 2);
  check('presence: distinct game users, excludes dashboard', f.api.onlineCount('c') === 2);
  const roster = f.events.findLast(e => e.socket === 'owner' && e.event === 'campaign:presence');
  check('presence: roster seeds distinct users',
    JSON.stringify(roster.payload.user_ids.sort()) === JSON.stringify(['gm', 'u']));
  f.events.length = 0;
  f.socket.disconnect();
  check('disconnect: retains other tab in tracking',
    f.api.socketsByUser.get('u').has('second') && !f.api.socketsByUser.get('u').has('s'));
  check('disconnect: no user-left while another tab remains', !f.events.some(e => e.event === 'campaign:user-left'));
  check('disconnect: lobby count remains two', f.events.some(e => e.event === 'lobby:presence' && e.payload.online === 2));
  f.events.length = 0;
  second.socket.disconnect();
  check('disconnect: final tab removes tracking entry', !f.api.socketsByUser.has('u'));
  check('disconnect: final tab announces departure', f.events.some(e => e.event === 'campaign:user-left' && e.payload.user_id === 'u'));
  check('disconnect: final tab refreshes lobby count', f.events.some(e => e.event === 'lobby:presence' && e.payload.online === 1));
  f.api.evictGamePlayers('c', 'gm');
  check('close: owner game room and dashboard lobby preserved',
    owner.socket.rooms.has('campaign:c') && dashboard.socket.rooms.has('lobby:c'));
  check('eviction return count excludes lobby-only sockets',
    f.api.evictUser('c', 'viewer') === 0 && !dashboard.socket.rooms.has('lobby:c'));
  await owner.handlers['lobby:subscribe']({}, () => {});
  check('eviction return count includes game socket', f.api.evictUser('c', 'gm') === 1
    && !owner.socket.rooms.has('campaign:c') && !owner.socket.rooms.has('lobby:c'));
  check('eviction preserves connected socket tracking', f.api.socketsByUser.get('gm').has('owner'));
}

(async () => {
  try {
    for (const lobby of [false, true]) {
      await run(lobby, false);
      await run(lobby, true);
      await run(lobby, true, 'delete');
    }
    await run(false, true, 'close');
    for (const lobby of [false, true]) {
      for (const action of ['normal', 'evict', 'delete', 'leave', 'disconnect']) {
        await delayedAdmission(lobby, action);
      }
    }
    await delayedAdmission(false, 'close');
    await delayedAdmission(true, 'delete', ['c', 'd']);
    await presenceContracts();
  } catch (err) {
    failed++;
    console.error('SUITE ERROR:', err);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
