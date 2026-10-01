// Live membership and card updates — nobody has to reload.
//   Usage: node scripts/test-local.js test-live-membership.js
//
// Found in the production QA pass (2026-09-30): a player who joined, left, was
// kicked, or changed their name or avatar stayed stale on every other open page
// until a manual reload, and a renamed game kept its old name on the players'
// dashboards. The server now announces those changes with id-only events:
//   member:updated   to the campaign's game room  -> the game page re-reads members
//   campaign:updated to the campaign's lobby room -> dashboards re-read their cards
// The payloads carry ids only; every page re-fetches through its own
// permission-checked endpoint, so the events disclose nothing new.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { io } = require('socket.io-client');
const knex = require('../../src/db');

let pass = 0; let fail = 0; const results = [];
function t(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(`  ok    ${name}`); } else {
    fail += 1; results.push(`  FAIL  ${name}  ${detail}`);
  }
}

function agent() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, path, body) {
      const headers = { Origin: BASE };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  await a.req('POST', '/api/auth/register', { email, username: `${name}${Math.random().toString(16).slice(2, 8)}`, password });
  await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  const l = await a.req('POST', '/api/auth/login', { email, password });
  a.id = l.data.user.id;
  return a;
}

const socketFor = (a) => io(BASE, { extraHeaders: { Cookie: a.cookie }, transports: ['websocket'], forceNew: true });
const connected = (s) => new Promise((resolve, reject) => {
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
  setTimeout(() => reject(new Error('connect timeout')), 3000);
});
const emitAck = (s, ev, p) => new Promise((resolve) => {
  s.emit(ev, p, resolve);
  setTimeout(() => resolve({ ok: false, error: 'timeout' }), 3000);
});
// The first payload of `ev` that satisfies `match`, or null on timeout.
const nextEvent = (s, ev, match = () => true, ms = 2000) => new Promise((resolve) => {
  const timer = setTimeout(() => { s.off(ev, h); resolve(null); }, ms);
  function h(p) { if (!match(p)) return; clearTimeout(timer); s.off(ev, h); resolve(p); }
  s.on(ev, h);
});
const idsOnly = (p, keys) => p && Object.keys(p).sort().join(',') === keys.slice().sort().join(',');

(async () => {
  const gm = await mk('gm');
  const pl = await mk('pl');
  const pl2 = await mk('pl2');
  const outsider = await mk('out');

  const camp = (await gm.req('POST', '/api/campaigns', { name: 'Live A', is_public: true })).data.campaign;
  const other = (await outsider.req('POST', '/api/campaigns', { name: 'Elsewhere', is_public: true })).data.campaign;
  await pl2.req('POST', `/api/campaigns/${camp.id}/join`, {});
  t('setup', !!camp && !!other);

  // The GM is at the table (game room) and on the dashboard (lobby).
  const gmGame = await connected(socketFor(gm));
  t('GM joins the game room', (await emitAck(gmGame, 'campaign:join', { campaign_id: camp.id })).ok === true);
  const gmLobby = await connected(socketFor(gm));
  await emitAck(gmLobby, 'lobby:subscribe', {});
  // pl2 watches their dashboard; the outsider watches theirs (not in this game).
  const pl2Lobby = await connected(socketFor(pl2));
  await emitAck(pl2Lobby, 'lobby:subscribe', {});
  const outLobby = await connected(socketFor(outsider));
  await emitAck(outLobby, 'lobby:subscribe', {});
  const outGame = await connected(socketFor(outsider));
  await emitAck(outGame, 'campaign:join', { campaign_id: camp.id });   // refused: not a member

  // ── a player joins ─────────────────────────────────────────────────────────
  let room = nextEvent(gmGame, 'member:updated', (p) => p && p.user_id === pl.id);
  let card = nextEvent(gmLobby, 'campaign:updated', (p) => p && p.campaign_id === camp.id);
  let leak = nextEvent(outLobby, 'campaign:updated', () => true, 1200);
  let leakGame = nextEvent(outGame, 'member:updated', () => true, 1200);
  await pl.req('POST', `/api/campaigns/${camp.id}/join`, {});
  let r = await room; let c = await card;
  t('join: the game room hears member:updated for the new player', r && r.campaign_id === camp.id, JSON.stringify(r));
  t('join: the payload carries ids only', idsOnly(r, ['campaign_id', 'user_id']), JSON.stringify(r));
  t('join: the GM dashboard hears campaign:updated', c && idsOnly(c, ['campaign_id']), JSON.stringify(c));
  t('join: a dashboard outside the campaign hears nothing', (await leak) === null);
  t('join: a socket refused from the room hears nothing', (await leakGame) === null);

  // ── a player changes name and avatar ───────────────────────────────────────
  room = nextEvent(gmGame, 'member:updated', (p) => p && p.user_id === pl.id);
  card = nextEvent(pl2Lobby, 'campaign:updated', (p) => p && p.campaign_id === camp.id);
  leak = nextEvent(outLobby, 'campaign:updated', () => true, 1200);
  const renamed = `ren${Math.random().toString(16).slice(2, 8)}`;
  const patched = await pl.req('PATCH', '/api/auth/me', { username: renamed, avatar_url: 'https://example.com/a.png' });
  r = await room; c = await card;
  t('profile: the change itself succeeds', patched.status === 200 && patched.data.user.username === renamed, JSON.stringify(patched));
  t('profile: every table the player sits at hears member:updated', r && r.campaign_id === camp.id, JSON.stringify(r));
  t('profile: other members’ dashboards hear campaign:updated', !!c, JSON.stringify(c));
  t('profile: a dashboard outside the player’s games hears nothing', (await leak) === null);
  const members = (await gm.req('GET', `/api/campaigns/${camp.id}`)).data.members || [];
  t('profile: the re-read the event triggers returns the new name',
    members.some((m) => m.user_id === pl.id && m.username === renamed), JSON.stringify(members.map((m) => m.username)));

  // ── the GM renames the game ────────────────────────────────────────────────
  card = nextEvent(pl2Lobby, 'campaign:updated', (p) => p && p.campaign_id === camp.id);
  await gm.req('PATCH', `/api/campaigns/${camp.id}`, { name: 'Live A renamed', description: 'new' });
  t('rename: players’ dashboards hear campaign:updated', !!(await card));
  card = nextEvent(pl2Lobby, 'campaign:updated', () => true, 1200);
  await gm.req('PATCH', `/api/campaigns/${camp.id}`, { is_open: false });
  t('closing the table alone sends no campaign:updated (campaign:state covers it)', (await card) === null);
  await gm.req('PATCH', `/api/campaigns/${camp.id}`, { is_open: true });

  // ── kick and leave ─────────────────────────────────────────────────────────
  room = nextEvent(gmGame, 'member:updated', (p) => p && p.user_id === pl2.id);
  await gm.req('POST', `/api/campaigns/${camp.id}/members/${pl2.id}/kick`);
  t('kick: the game room hears member:updated for the removed player', !!(await room));
  room = nextEvent(gmGame, 'member:updated', (p) => p && p.user_id === pl.id);
  card = nextEvent(gmLobby, 'campaign:updated', (p) => p && p.campaign_id === camp.id);
  await pl.req('POST', `/api/campaigns/${camp.id}/leave`);
  t('leave: the game room hears member:updated', !!(await room));
  t('leave: the GM dashboard hears campaign:updated', !!(await card));

  // ── teardown ───────────────────────────────────────────────────────────────
  for (const s of [gmGame, gmLobby, pl2Lobby, outLobby, outGame]) s.close();
  try { await knex('campaigns').whereIn('id', [camp.id, other.id]).del(); } catch { /* cascade */ }
  try { await knex('users').whereIn('id', [gm.id, pl.id, pl2.id, outsider.id]).del(); } catch { /* sessions may hold rows */ }

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
