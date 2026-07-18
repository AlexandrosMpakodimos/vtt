// Adversarial test suite for the campaign layer, run against a real PostgreSQL.
// Usage: SKIP_HIBP=1 node test-campaigns.js   (server must be running)
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { io } = require('socket.io-client');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}  ${detail}`); }
}

// A tiny cookie-jar client: each agent is one logged-in browser.
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
      try { data = await res.json(); } catch { /* html or empty */ }
      return { status: res.status, data };
    },
  };
}

const knex = require('./src/db');

async function makeUser(name) {
  const a = agent();
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const password = 'correct-horse-battery-staple-9';
  const r = await a.req('POST', '/api/auth/register', { email, username: `${name}${Math.random().toString(16).slice(2, 8)}`, password });
  if (r.status !== 201) throw new Error(`register failed for ${name}: ${JSON.stringify(r.data)}`);
  // Verify inline: the mail path is out of scope for this slice.
  await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  const l = await a.req('POST', '/api/auth/login', { email, password });
  if (l.status !== 200) throw new Error(`login failed for ${name}: ${JSON.stringify(l.data)}`);
  a.id = l.data.user.id;
  a.username = l.data.user.username;
  return a;
}

function socketFor(a) {
  return io(BASE, { extraHeaders: { Cookie: a.cookie }, transports: ['websocket'], forceNew: true });
}
const joinRoom = (s, campaign_id) =>
  new Promise((resolve) => {
    s.emit('campaign:join', { campaign_id }, resolve);
    setTimeout(() => resolve({ ok: false, error: 'timeout' }), 3000);
  });
const connected = (s) =>
  new Promise((resolve, reject) => {
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });

(async () => {
  const gm = await makeUser('gm');
  const player = await makeUser('player');
  const stranger = await makeUser('stranger');

  // ---------- create ----------
  let r = await gm.req('POST', '/api/campaigns', { name: 'Private Keep', is_public: false, password: 'dragons' });
  check('create private campaign -> 201', r.status === 201, JSON.stringify(r.data));
  const priv = r.data.campaign;
  check('response never contains password_hash', !('password_hash' in (priv || {})), JSON.stringify(priv));
  check('has_password is a boolean flag', priv && priv.has_password === true);
  check('creator sees is_gm true', priv && priv.is_gm === true);

  r = await gm.req('POST', '/api/campaigns', { name: 'Open Tavern', is_public: true });
  check('create public campaign -> 201', r.status === 201, JSON.stringify(r.data));
  const pub = r.data.campaign;
  check('public campaign has no password', pub && pub.has_password === false);

  r = await gm.req('POST', '/api/campaigns', { name: 'No Password', is_public: false });
  check('private campaign without password -> 400', r.status === 400, JSON.stringify(r.data));

  r = await gm.req('POST', '/api/campaigns', { name: 'Contradiction', is_public: true, password: 'x' });
  check('public campaign WITH password -> 400', r.status === 400, JSON.stringify(r.data));

  // ---------- mass assignment ----------
  r = await gm.req('POST', '/api/campaigns', {
    name: 'Injected', is_public: true,
    owner_id: stranger.id, password_hash: 'pwned', deleted_at: '2020-01-01', id: '00000000-0000-0000-0000-000000000000',
  });
  const injected = r.data.campaign;
  const injRow = await knex('campaigns').where({ id: injected.id }).first();
  check('mass assignment: owner_id not overridden', injRow.owner_id === gm.id);
  check('mass assignment: password_hash not injected', injRow.password_hash === null);
  check('mass assignment: deleted_at not injected', injRow.deleted_at === null);
  check('mass assignment: forged id ignored', injected.id !== '00000000-0000-0000-0000-000000000000');

  // ---------- img_url validation ----------
  r = await gm.req('POST', '/api/campaigns', { name: 'XSS', is_public: true, img_url: 'javascript:alert(1)' });
  check('img_url javascript: scheme -> 400', r.status === 400, JSON.stringify(r.data));
  r = await gm.req('POST', '/api/campaigns', { name: 'XSS2', is_public: true, img_url: 'https://x.test/a"><script>alert(1)</script>' });
  check('img_url normalised (quotes/brackets encoded)',
    r.status === 201 && !r.data.campaign.img_url.includes('<script>'), JSON.stringify(r.data.campaign && r.data.campaign.img_url));

  // ---------- search ----------
  r = await gm.req('GET', `/api/campaigns/search?q=Private+Keep`);
  check('search finds the campaign', r.data.campaigns.some((c) => c.id === priv.id));
  check('search never leaks password_hash', !r.data.campaigns.some((c) => 'password_hash' in c));
  r = await gm.req('GET', `/api/campaigns/search?q=%25`);
  check('search: bare % is escaped, not a wildcard', r.status === 200 && r.data.campaigns.length === 0, JSON.stringify(r.data.campaigns && r.data.campaigns.length));
  r = await gm.req('GET', `/api/campaigns/search?q=x'; DROP TABLE campaigns;--`);
  const stillThere = await knex.schema.hasTable('campaigns');
  check('search: SQL injection has no effect', r.status === 200 && stillThere);
  r = await gm.req('GET', `/api/campaigns/search?visibility=public`);
  check('search visibility=public excludes private', !r.data.campaigns.some((c) => c.id === priv.id));

  // ---------- join flow ----------
  r = await player.req('POST', `/api/campaigns/${priv.id}/join`, { password: 'wrong' });
  check('join private with wrong password -> 401', r.status === 401, JSON.stringify(r.data));
  r = await player.req('POST', `/api/campaigns/${priv.id}/join`, {});
  check('join private with no password -> 401', r.status === 401, JSON.stringify(r.data));
  r = await player.req('POST', `/api/campaigns/${priv.id}/join`, { password: 'dragons' });
  check('join private with correct password -> 200', r.status === 200, JSON.stringify(r.data));
  r = await player.req('POST', `/api/campaigns/${priv.id}/join`, {});
  check('re-join as active member needs NO password', r.status === 200, JSON.stringify(r.data));
  r = await stranger.req('POST', `/api/campaigns/${pub.id}/join`, {});
  check('join public campaign without password -> 200', r.status === 200, JSON.stringify(r.data));

  // ---------- authorisation ----------
  r = await stranger.req('GET', `/api/campaigns/${priv.id}`);
  check('non-member GET detail -> 404 (not 403: no existence leak)', r.status === 404, JSON.stringify(r.data));
  r = await player.req('PATCH', `/api/campaigns/${priv.id}`, { name: 'Hijacked' });
  check('member (non-owner) PATCH -> 403', r.status === 403, JSON.stringify(r.data));
  r = await stranger.req('PATCH', `/api/campaigns/${priv.id}`, { name: 'Hijacked' });
  check('non-member PATCH -> 404', r.status === 404, JSON.stringify(r.data));
  r = await player.req('DELETE', `/api/campaigns/${priv.id}`);
  check('member (non-owner) DELETE -> 403', r.status === 403, JSON.stringify(r.data));
  r = await player.req('POST', `/api/campaigns/${priv.id}/members/${gm.id}/ban`);
  check('member (non-owner) cannot ban the owner -> 403', r.status === 403, JSON.stringify(r.data));
  const noAuth = agent();
  r = await noAuth.req('GET', '/api/campaigns/mine');
  check('unauthenticated -> 401', r.status === 401, JSON.stringify(r.data));
  r = await gm.req('GET', '/api/campaigns/not-a-uuid');
  check('malformed uuid -> 404, not a 500', r.status === 404, JSON.stringify(r.data));

  // ---------- kick / ban / unban ----------
  r = await gm.req('POST', `/api/campaigns/${priv.id}/members/${player.id}/kick`);
  check('owner kicks member -> 200', r.status === 200, JSON.stringify(r.data));
  let row = await knex('campaign_members').where({ campaign_id: priv.id, user_id: player.id }).first();
  check('kick sets status=left (row NOT deleted)', row && row.status === 'left', JSON.stringify(row));
  r = await player.req('POST', `/api/campaigns/${priv.id}/join`, {});
  check("kicked member rejoining private w/o password -> 401", r.status === 401, JSON.stringify(r.data));
  r = await player.req('POST', `/api/campaigns/${priv.id}/join`, { password: 'dragons' });
  check('kicked member CAN rejoin with the password', r.status === 200, JSON.stringify(r.data));
  row = await knex('campaign_members').where({ campaign_id: priv.id, user_id: player.id }).first();
  check('rejoin UPDATEs the existing row (history preserved)', row && row.status === 'active');

  r = await gm.req('POST', `/api/campaigns/${priv.id}/members/${player.id}/ban`);
  check('owner bans member -> 200', r.status === 200, JSON.stringify(r.data));
  const tBan = Date.now();
  r = await player.req('POST', `/api/campaigns/${priv.id}/join`, { password: 'dragons' });
  const banMs = Date.now() - tBan;
  check('banned member join -> 403 with honest reason', r.status === 403 && /banned/i.test(r.data.error), JSON.stringify(r.data));
  check(`banned check precedes password verify (${banMs}ms < 100ms Argon2id)`, banMs < 100, `${banMs}ms`);
  r = await player.req('GET', `/api/campaigns/${priv.id}`);
  check('banned member cannot read detail -> 404', r.status === 404);
  r = await gm.req('POST', `/api/campaigns/${priv.id}/members/${player.id}/unban`);
  check('owner unbans -> 200 status becomes left', r.status === 200 && r.data.status === 'left', JSON.stringify(r.data));
  r = await player.req('POST', `/api/campaigns/${priv.id}/join`, { password: 'dragons' });
  check('unbanned member rejoins with password', r.status === 200, JSON.stringify(r.data));

  // ---------- manage-players view ----------
  r = await gm.req('GET', `/api/campaigns/${priv.id}/members`);
  check('owner manage-players lists members', r.status === 200 && r.data.members.length >= 2);
  check('members view marks the GM', r.data.members.some((m) => m.user_id === gm.id && m.is_gm === true));
  r = await player.req('GET', `/api/campaigns/${priv.id}/members`);
  check('non-owner cannot see manage-players -> 403', r.status === 403);

  // ---------- leave ----------
  r = await gm.req('POST', `/api/campaigns/${priv.id}/leave`);
  check('OWNER cannot leave -> 409 (no orphaned campaigns)', r.status === 409, JSON.stringify(r.data));
  r = await player.req('POST', `/api/campaigns/${priv.id}/leave`);
  check('member can leave -> 200', r.status === 200);
  row = await knex('campaign_members').where({ campaign_id: priv.id, user_id: player.id }).first();
  check('leave sets status=left, row preserved', row && row.status === 'left');
  r = await player.req('POST', `/api/campaigns/${priv.id}/join`, { password: 'dragons' });
  check('left member rejoins with password', r.status === 200);

  // ---------- soft delete ----------
  r = await gm.req('POST', '/api/campaigns', { name: 'Doomed Realm', is_public: true });
  const doomed = r.data.campaign;
  r = await gm.req('DELETE', `/api/campaigns/${doomed.id}`);
  check('owner soft-deletes -> 200', r.status === 200);
  row = await knex('campaigns').where({ id: doomed.id }).first();
  check('soft delete sets deleted_at, row still exists', row && row.deleted_at !== null);
  r = await gm.req('GET', `/api/campaigns/search?q=Doomed`);
  check('soft-deleted campaign is GONE from search', !r.data.campaigns.some((c) => c.id === doomed.id));
  r = await gm.req('GET', '/api/campaigns/mine');
  check('soft-deleted campaign is GONE from dashboard', !r.data.campaigns.some((c) => c.id === doomed.id));
  r = await gm.req('GET', `/api/campaigns/${doomed.id}`);
  check('soft-deleted campaign 404s even for the owner', r.status === 404);
  r = await stranger.req('POST', `/api/campaigns/${doomed.id}/join`, {});
  check('cannot join a soft-deleted campaign', r.status === 404);
  r = await gm.req('POST', `/api/campaigns/${doomed.id}/restore`);
  check('owner restores -> 200', r.status === 200, JSON.stringify(r.data));
  r = await gm.req('GET', `/api/campaigns/search?q=Doomed`);
  check('restored campaign is back in search', r.data.campaigns.some((c) => c.id === doomed.id));
  await gm.req('DELETE', `/api/campaigns/${doomed.id}`);
  r = await stranger.req('POST', `/api/campaigns/${doomed.id}/restore`);
  check('non-owner cannot restore -> 404', r.status === 404);
  await knex('campaigns').where({ id: doomed.id }).update({ deleted_at: knex.raw("now() - interval '31 days'") });
  r = await gm.req('POST', `/api/campaigns/${doomed.id}/restore`);
  check('restore after 30 days -> 410', r.status === 410, JSON.stringify(r.data));

  // ---------- visibility transitions ----------
  r = await gm.req('PATCH', `/api/campaigns/${pub.id}`, { is_public: false });
  check('public -> private without a password -> 400', r.status === 400, JSON.stringify(r.data));
  r = await gm.req('PATCH', `/api/campaigns/${pub.id}`, { is_public: false, password: 'secret9' });
  check('public -> private with a password -> 200', r.status === 200 && r.data.campaign.has_password === true);
  r = await gm.req('PATCH', `/api/campaigns/${pub.id}`, { is_public: true });
  check('private -> public drops the password', r.status === 200 && r.data.campaign.has_password === false);
  row = await knex('campaigns').where({ id: pub.id }).first();
  check('DB confirms password_hash nulled on going public', row.password_hash === null);

  // ---------- ownership transfer ----------
  r = await gm.req('POST', `/api/campaigns/${priv.id}/transfer`, { user_id: stranger.id });
  check('transfer to a non-member -> 409', r.status === 409, JSON.stringify(r.data));
  r = await gm.req('POST', `/api/campaigns/${priv.id}/transfer`, { user_id: player.id });
  check('transfer to an active member -> 200', r.status === 200, JSON.stringify(r.data));
  row = await knex('campaigns').where({ id: priv.id }).first();
  check('owner_id moved to the new owner', row.owner_id === player.id);
  r = await player.req('GET', `/api/campaigns/${priv.id}`);
  check('new owner sees is_gm true (GM-ness is derived)', r.data.campaign.is_gm === true);
  r = await gm.req('GET', `/api/campaigns/${priv.id}`);
  check('old owner sees is_gm false', r.data.campaign.is_gm === false);
  r = await gm.req('PATCH', `/api/campaigns/${priv.id}`, { name: 'Nope' });
  check('old owner lost owner powers -> 403', r.status === 403);
  r = await player.req('POST', `/api/campaigns/${priv.id}/leave`);
  check('NEW owner cannot leave -> 409', r.status === 409);
  r = await gm.req('POST', `/api/campaigns/${priv.id}/leave`);
  check('OLD owner is now an ordinary member and CAN leave', r.status === 200, JSON.stringify(r.data));
  // Transfer requires an ACTIVE member, and gm has just left — so gm must rejoin
  // before ownership can come back. (Asserted: an unchecked request here once
  // silently failed and cascaded into three bogus socket failures.)
  r = await player.req('POST', `/api/campaigns/${priv.id}/transfer`, { user_id: gm.id });
  check('transfer to a LEFT ex-member -> 409', r.status === 409, JSON.stringify(r.data));
  r = await gm.req('POST', `/api/campaigns/${priv.id}/join`, { password: 'dragons' });
  check('ex-owner rejoins with the password', r.status === 200, JSON.stringify(r.data));
  r = await player.req('POST', `/api/campaigns/${priv.id}/transfer`, { user_id: gm.id });
  check('ownership transfers back -> 200', r.status === 200, JSON.stringify(r.data));

  // ---------- caps ----------
  const capUser = await makeUser('capper');
  let created = 0;
  for (let i = 0; i < 21; i++) {
    const cr = await capUser.req('POST', '/api/campaigns', { name: `Cap ${i}`, is_public: true });
    if (cr.status === 201) created++;
    else { check('campaign cap enforced -> 409', cr.status === 409, JSON.stringify(cr.data)); break; }
  }
  check(`campaign cap stops at 20 (created ${created})`, created === 20, `created=${created}`);

  // ---------- tabs: role filter on /mine ----------
  // gm owns priv; make gm a PLAYER somewhere too. player2 owns a campaign gm joins.
  const player2 = await makeUser('owner2');
  r = await player2.req('POST', '/api/campaigns', { name: 'Others Realm', is_public: true });
  const others = r.data.campaign;
  await gm.req('POST', `/api/campaigns/${others.id}/join`, {});

  r = await gm.req('GET', '/api/campaigns/mine?role=owner');
  check('role=owner returns only campaigns I own', r.data.campaigns.every((c) => c.is_gm === true) && r.data.campaigns.some((c) => c.id === priv.id));
  check('role=owner excludes campaigns I only joined', !r.data.campaigns.some((c) => c.id === others.id));
  r = await gm.req('GET', '/api/campaigns/mine?role=player');
  check('role=player returns only campaigns I joined (not owned)', r.data.campaigns.every((c) => c.is_gm === false) && r.data.campaigns.some((c) => c.id === others.id));
  check('role=player excludes campaigns I own', !r.data.campaigns.some((c) => c.id === priv.id));
  r = await gm.req('GET', '/api/campaigns/mine?role=all');
  check('role=all returns both owned and joined', r.data.campaigns.some((c) => c.id === priv.id) && r.data.campaigns.some((c) => c.id === others.id));

  // ---------- archive: per-user, per-view ----------
  r = await gm.req('POST', `/api/campaigns/${others.id}/archive`);
  check('member can archive their own view -> 200', r.status === 200 && r.data.archived === true, JSON.stringify(r.data));
  r = await gm.req('GET', '/api/campaigns/mine?role=player&filter=active');
  check('archived campaign hidden from active dashboard', !r.data.campaigns.some((c) => c.id === others.id));
  r = await gm.req('GET', '/api/campaigns/mine?role=player&filter=archived');
  check('archived campaign shows under filter=archived', r.data.campaigns.some((c) => c.id === others.id && c.archived === true));
  r = await gm.req('GET', '/api/campaigns/mine?role=player&filter=all');
  check('filter=all shows archived + active together', r.data.campaigns.some((c) => c.id === others.id));

  // The crucial property: archive is MINE, not the campaign's. The OWNER's view is untouched.
  r = await player2.req('GET', '/api/campaigns/mine?role=owner&filter=active');
  check("one member's archive does NOT archive another member's view", r.data.campaigns.some((c) => c.id === others.id && !c.archived));

  r = await gm.req('POST', `/api/campaigns/${others.id}/unarchive`);
  check('unarchive -> 200', r.status === 200 && r.data.archived === false);
  r = await gm.req('GET', '/api/campaigns/mine?role=player&filter=active');
  check('unarchived campaign back in active dashboard', r.data.campaigns.some((c) => c.id === others.id));

  // a stranger (no membership row) cannot archive
  r = await stranger.req('POST', `/api/campaigns/${priv.id}/archive`);
  check('non-member cannot archive -> 404', r.status === 404, JSON.stringify(r.data));

  // ---------- status CHECK constraint (DB-level) ----------
  let checkRejected = false;
  try {
    await knex('campaign_members')
      .where({ campaign_id: priv.id, user_id: gm.id })
      .update({ status: 'actve' }); // deliberate typo
  } catch (e) { checkRejected = /check/i.test(e.message) || e.code === '23514'; }
  check('DB CHECK constraint rejects an invalid status', checkRejected);

  // ---------- 30-day hard-delete sweep ----------
  r = await gm.req('POST', '/api/campaigns', { name: 'Sweep Me', is_public: true });
  const sweepId = r.data.campaign.id;
  await gm.req('DELETE', `/api/campaigns/${sweepId}`);
  // Age it past the window, then run the same query the server's sweep runs.
  await knex('campaigns').where({ id: sweepId }).update({ deleted_at: knex.raw("now() - interval '31 days'") });
  const swept = await knex('campaigns')
    .whereNotNull('deleted_at')
    .whereRaw("deleted_at < now() - interval '30 days'")
    .del();
  check('sweep hard-deletes campaigns past 30 days', swept >= 1, `deleted ${swept}`);
  const gone = await knex('campaigns').where({ id: sweepId }).first();
  check('swept campaign row is physically gone', !gone);
  // a fresh soft-delete (within the window) must survive the same sweep
  r = await gm.req('POST', '/api/campaigns', { name: 'Keep Me', is_public: true });
  const keepId = r.data.campaign.id;
  await gm.req('DELETE', `/api/campaigns/${keepId}`);
  await knex('campaigns')
    .whereNotNull('deleted_at')
    .whereRaw("deleted_at < now() - interval '30 days'")
    .del();
  const kept = await knex('campaigns').where({ id: keepId }).first();
  check('recent soft-delete survives the sweep', !!kept && kept.deleted_at !== null);

  // ---------- SOCKETS ----------
  await gm.req('POST', `/api/campaigns/${priv.id}/join`, {});
  const sgm = await connected(socketFor(gm));
  check('socket-session bridge: authenticated socket connects', sgm.connected);

  let ack = await joinRoom(sgm, priv.id);
  check('owner socket joins campaign room', ack.ok === true, JSON.stringify(ack));

  const sStranger = await connected(socketFor(stranger));
  ack = await joinRoom(sStranger, priv.id);
  check('non-member socket REJECTED from room', ack.ok === false, JSON.stringify(ack));

  // an anonymous socket must be disconnected outright
  const anonSock = io(BASE, { transports: ['websocket'], forceNew: true });
  const anonDisconnected = await new Promise((resolve) => {
    anonSock.on('disconnect', () => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
  check('anonymous socket is disconnected', anonDisconnected === true);

  // ban must evict a LIVE socket, not just write a row
  await player.req('POST', `/api/campaigns/${priv.id}/join`, { password: 'dragons' });
  const sPlayer = await connected(socketFor(player));
  ack = await joinRoom(sPlayer, priv.id);
  check('member socket joins room', ack.ok === true, JSON.stringify(ack));

  const evicted = new Promise((resolve) => {
    sPlayer.on('campaign:evicted', (d) => resolve(d));
    setTimeout(() => resolve(null), 3000);
  });
  await gm.req('POST', `/api/campaigns/${priv.id}/members/${player.id}/ban`);
  const ev = await evicted;
  check('ban evicts the live socket from the room', ev && ev.campaign_id === priv.id, JSON.stringify(ev));
  ack = await joinRoom(sPlayer, priv.id);
  check('banned socket cannot rejoin the room', ack.ok === false, JSON.stringify(ack));

  for (const s of [sgm, sStranger, sPlayer, anonSock]) s.close();

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(results.join('\n'));
  console.error('\nSUITE ERROR:', e);
  await knex.destroy();
  process.exit(1);
});
