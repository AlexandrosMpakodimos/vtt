// The lobby socket — the whole server contract (design spec §7).
//   Usage: SKIP_HIBP=1 node test-lobby.js   (server on npm run dev:test)
//
// REST is the dashboard's source of truth; this socket carries ONLY presence and
// open/closed state for the campaigns a user belongs to. The invariants that
// matter:
//   - lobby:subscribe DERIVES the campaign set from the DB (the client sends no
//     ids), so there is nothing to validate and no id to leak.
//   - presence counts DISTINCT users in the GAME room — a dashboard viewer in a
//     lobby room is NOT "at the table", and a GM with two tabs is one person.
//   - a campaign:state fan-out reaches lobby subscribers when is_open changes.
//   - a ban reaches a lobby-only socket too (the card must vanish) even though
//     that socket never joined the game room.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { io } = require('socket.io-client');
const knex = require('./src/db');

let pass = 0; let fail = 0; const results = [];
function t(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(`  ok    ${name}`); } else {
    fail += 1; results.push(`  FAIL  ${name}  ${detail}`);
  }
}
function note(name, detail) { results.push(`  NOTE  ${name}  ${detail}`); }

function agent() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, path, body) {
      const headers = { Origin: BASE };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setC = res.headers.get('set-cookie');
      if (setC) cookie = setC.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { /* empty */ }
      return { status: res.status, data };
    },
  };
}

async function mk(name) {
  const a = agent();
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const password = 'correct-horse-battery-staple-9';
  await a.req('POST', '/api/auth/register', {
    email, username: `${name}${Math.random().toString(16).slice(2, 8)}`, password,
  });
  await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  const l = await a.req('POST', '/api/auth/login', { email, password });
  a.id = l.data.user.id;
  return a;
}

const socketFor = (a) => io(BASE, {
  extraHeaders: { Cookie: a.cookie }, transports: ['websocket'], forceNew: true,
});
const connected = (s) => new Promise((resolve, reject) => {
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
  setTimeout(() => reject(new Error('connect timeout')), 3000);
});
const emitAck = (s, ev, p) => new Promise((resolve) => {
  s.emit(ev, p, resolve);
  setTimeout(() => resolve({ ok: false, error: 'timeout' }), 3000);
});
// Resolve with the first payload of an event, or null on timeout.
const onceEvent = (s, ev, ms = 1500) => new Promise((resolve) => {
  const timer = setTimeout(() => { s.off(ev, h); resolve(null); }, ms);
  function h(p) { clearTimeout(timer); s.off(ev, h); resolve(p); }
  s.on(ev, h);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const gm = await mk('gm');
  const pl = await mk('pl');
  const outsider = await mk('out');

  // Two campaigns owned by the GM; the player joins the first only.
  const campA = (await gm.req('POST', '/api/campaigns', { name: 'Lobby A', is_public: true })).data.campaign;
  const campB = (await gm.req('POST', '/api/campaigns', { name: 'Lobby B', is_public: true })).data.campaign;
  await pl.req('POST', `/api/campaigns/${campA.id}/join`, {});
  t('setup: two campaigns, player in A only', !!campA && !!campB);

  // ── lobby:subscribe derives the set from the DB ───────────────────────────
  const gmSock = await connected(socketFor(gm));
  const plSock = await connected(socketFor(pl));

  const gmSub = await emitAck(gmSock, 'lobby:subscribe', {});
  t('subscribe acks ok', gmSub && gmSub.ok === true, JSON.stringify(gmSub));
  t('the GM is subscribed to BOTH owned campaigns',
    Array.isArray(gmSub.campaigns) && gmSub.campaigns.length === 2,
    JSON.stringify(gmSub.campaigns));
  const gmIds = (gmSub.campaigns || []).map((c) => c.campaign_id).sort();
  t('...and they are exactly A and B',
    gmIds.join(',') === [campA.id, campB.id].sort().join(','), gmIds.join(','));

  const plSub = await emitAck(plSock, 'lobby:subscribe', {});
  t('the player is subscribed to only the campaign they joined (A)',
    Array.isArray(plSub.campaigns) && plSub.campaigns.length === 1
      && plSub.campaigns[0].campaign_id === campA.id, JSON.stringify(plSub.campaigns));

  // The client sends no ids: a subscribe with a bogus payload is still derived
  // from the session, never from the payload.
  const spoof = await emitAck(plSock, 'lobby:subscribe', { campaign_ids: [campB.id, 'nonsense'] });
  t('subscribe ignores any client-supplied ids (derived from the session)',
    spoof.ok === true && spoof.campaigns.length === 1 && spoof.campaigns[0].campaign_id === campA.id,
    JSON.stringify(spoof.campaigns));

  // ── presence: lobby-only sockets are NOT "at the table" ───────────────────
  t('nobody is at the table yet (lobby subscription is not presence)',
    plSub.campaigns[0].online === 0, JSON.stringify(plSub.campaigns[0]));

  // The GM joins the GAME room of A → the player (lobby-subscribed to A) hears a
  // presence bump to 1.
  const presenceP = onceEvent(plSock, 'lobby:presence');
  await emitAck(gmSock, 'campaign:join', { campaign_id: campA.id });
  const pres1 = await presenceP;
  t('joining the game room pushes lobby:presence to subscribers',
    pres1 && pres1.campaign_id === campA.id && pres1.online === 1, JSON.stringify(pres1));

  // The GM opens a SECOND socket and joins the same game room: still ONE distinct
  // user at the table.
  const gmSock2 = await connected(socketFor(gm));
  const presenceP2 = onceEvent(plSock, 'lobby:presence');
  await emitAck(gmSock2, 'campaign:join', { campaign_id: campA.id });
  const pres2 = await presenceP2;
  t('a GM with two tabs counts as one person at the table',
    pres2 && pres2.online === 1, JSON.stringify(pres2));

  // A dashboard viewer (lobby-subscribed, never joined the game room) does not
  // change the count: the player is subscribed to A's lobby but is not at the
  // table, and the count stayed at 1 above.
  note('dashboard viewers', 'lobby subscription never increments the table count');

  // ── campaign:state fans out on an is_open change ──────────────────────────
  const stateP = onceEvent(plSock, 'campaign:state');
  await gm.req('PATCH', `/api/campaigns/${campA.id}`, { is_open: false });
  const st = await stateP;
  t('closing the table fans out campaign:state to the lobby',
    st && st.campaign_id === campA.id && st.is_open === false, JSON.stringify(st));

  // A non-is_open PATCH does NOT emit campaign:state.
  const noState = onceEvent(plSock, 'campaign:state', 800);
  await gm.req('PATCH', `/api/campaigns/${campA.id}`, { name: 'Lobby A renamed' });
  const none = await noState;
  t('a rename does not emit campaign:state (is_open unchanged)', none === null, JSON.stringify(none));
  await gm.req('PATCH', `/api/campaigns/${campA.id}`, { is_open: true });

  // ── eviction reaches a lobby-only socket ──────────────────────────────────
  // The player holds only a LOBBY subscription to A (never joined the game room).
  // A ban must still reach them so the card disappears.
  const evictP = onceEvent(plSock, 'campaign:evicted');
  await gm.req('POST', `/api/campaigns/${campA.id}/members/${pl.id}/ban`);
  const ev = await evictP;
  t('a ban reaches the lobby-only socket (campaign:evicted)',
    ev && ev.campaign_id === campA.id, JSON.stringify(ev));

  // After the ban, the player re-subscribing no longer sees A (membership gone).
  const plResub = await emitAck(plSock, 'lobby:subscribe', {});
  t('after the ban, re-subscribe drops the campaign',
    plResub.ok === true && plResub.campaigns.length === 0, JSON.stringify(plResub.campaigns));

  // ── presence drops when the table empties ─────────────────────────────────
  // The GM (subscribed to A's lobby via gmSub) hears presence go to 0 when both
  // of their game-room sockets disconnect.
  const gmPresence0 = onceEvent(gmSock, 'lobby:presence', 2500);
  gmSock2.close();
  // gmSock is still in A's game room; closing it too should drop to 0. But gmSock
  // is also our listener, so listen on a fresh subscribed socket instead.
  const gmSock3 = await connected(socketFor(gm));
  await emitAck(gmSock3, 'lobby:subscribe', {});
  const gmPresence0b = onceEvent(gmSock3, 'lobby:presence', 2500);
  gmSock.close();
  const drop = await gmPresence0b;
  t('presence drops when the last game-room socket disconnects',
    drop && drop.campaign_id === campA.id && drop.online === 0, JSON.stringify(drop));

  // ── teardown ──────────────────────────────────────────────────────────────
  gmSock3.close(); plSock.close();
  try { await knex('campaigns').whereIn('id', [campA.id, campB.id]).del(); } catch { /* fk cascade handles members */ }

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('SUITE CRASHED:', e);
  console.log(results.join('\n'));
  await knex.destroy();
  process.exit(1);
});
