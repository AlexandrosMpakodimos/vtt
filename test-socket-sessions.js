const assert = require('node:assert/strict');
const { createSocketSessions } = require('./src/services/socketSessions');
let passed = 0;
function check(value, message) { assert(value, message); passed++; }
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const connected = new Map(), sessions = new Map(), pending = [];
  let delayed = false, storeError = null;
  const store = { get(id, callback) {
    if (delayed) pending.push({ id, callback });
    else callback(storeError, sessions.get(id));
  } };
  const guard = createSocketSessions({ sockets: { sockets: connected } });
  let serial = 0;
  function socket(sid, user = 'user') {
    const s = { id: ++serial, connected: true, data: {}, events: [],
      request: { sessionID: sid, user: { id: user }, sessionStore: store },
      emit(...args) { s.events.push(args); },
      disconnect() { s.connected = false; connected.delete(s.id); },
      use(fn) { s.middleware = fn; },
    };
    connected.set(s.id, s);
    return s;
  }
  return { guard, socket, sessions, pending, setDelayed(v) { delayed=v; }, setError(v) { storeError=v; } };
}
(async () => {
  let env = setup();
  env.sessions.set('a', { passport: { user: 'user' } });
  env.sessions.set('b', { passport: { user: 'user' } });
  env.sessions.set('gm', { passport: { user: 'gm' } });
  const a = env.socket('a'), aTab = env.socket('a'), b = env.socket('b'), gm = env.socket('gm','gm');
  for (const s of [a,aTab,b,gm]) check(env.guard.attach(s), 'valid socket attaches');
  await flush();
  check([a,aTab,b,gm].every(s => s.connected), 'valid sockets stay connected');
  let result;
  a.middleware(['campaign:join', {}], err => { result = err || 'allowed'; });
  await flush();
  check(result === 'allowed', 'valid session may send packets');
  env.guard.disconnectSessions(['a']);
  check(!a.connected && !aTab.connected, 'all tabs sharing revoked SID disconnect');
  check(b.connected && gm.connected, 'other session and other user remain connected');
  env.guard.disconnectSessions(['missing']);
  check(b.connected && gm.connected, 'unknown SID has no effect');
  env.sessions.delete('b');
  result = null;
  b.middleware(['campaign:join', {}], err => { result = err; });
  await flush();
  check(!b.connected && result instanceof Error, 'deleted session cannot send packet');
  check(gm.connected, 'invalid packet does not disconnect another user');

  env = setup();
  const stale = env.socket('deleted');
  env.guard.attach(stale); await flush();
  check(!stale.connected, 'handshake snapshot without stored session rejected');
  env.sessions.set('wrong', { passport: { user: 'other' } });
  const wrong = env.socket('wrong'); env.guard.attach(wrong); await flush();
  check(!wrong.connected, 'stored session must match handshake user');
  env.sessions.set('anonymous', { passport: {} });
  const anonymous = env.socket('anonymous'); env.guard.attach(anonymous); await flush();
  check(!anonymous.connected, 'session without login identity rejected');
  const noStore = env.socket('a'); delete noStore.request.sessionStore;
  check(!env.guard.attach(noStore) && !noStore.connected, 'missing session store fails closed');
  env.setError(new Error('database offline'));
  const outage = env.socket('gm'); env.guard.attach(outage); await flush();
  check(!outage.connected, 'store read errors fail closed');

  env = setup(); env.setDelayed(true);
  const racing = env.socket('a'); env.guard.attach(racing);
  check(racing.data.authSessionId === 'a', 'pending validation registers SID immediately');
  env.guard.disconnectSessions(['a']);
  env.pending.shift().callback(null, { passport: { user: 'user' } });
  await flush();
  check(!racing.connected, 'late successful validation cannot revive revoked socket');

  env = setup(); env.sessions.set('a', { passport: { user: 'user' } });
  const packetRace = env.socket('a'); env.guard.attach(packetRace); await flush();
  env.setDelayed(true); result = null;
  packetRace.middleware(['campaign:join', {}], err => { result = err || 'allowed'; });
  env.guard.disconnectSessions(['a']);
  env.pending.shift().callback(null, { passport: { user: 'user' } });
  await flush();
  check(!packetRace.connected && result instanceof Error, 'pending packet validation cannot pass after revocation');
  console.log(`${passed} passed, 0 failed`);
})().catch(err => { console.error(err); console.log(`${passed} passed, 1 failed`); process.exitCode=1; });
