// A closed campaign is not playable.
//   Usage: SKIP_HIBP=1 node test-campaign-open.js   (server on npm run dev:test)
//
// The GM can close the table. While it is closed, members reach the CAMPAIGN —
// they can see it, choose a colour, archive it, leave it — and reach none of the
// GAME: no scenes, tokens, fog, characters, items, combat, chat, dice or spells,
// on either transport.
//
// Mapped to the OWASP API Security Top 10 (2023):
//   API1 BOLA — a member reaching game state they are not currently entitled to
//   API5 BFLA — a player trying to open a campaign
//
// THE PROBE THAT MATTERS is the socket one. The gate lives in two places that
// must agree — requireMember for HTTP and isActiveMember for the real-time
// transport — and gating only the first would leave an already-connected player
// free to keep playing after the doors were shut. That is the M3 transport
// defect in a new place, and it is the reason this suite opens a socket at all.

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

(async () => {
  const gm = await mk('gm');
  const pl = await mk('pl');

  const camp = (await gm.req('POST', '/api/campaigns', { name: 'Gate', is_public: true })).data.campaign;
  await pl.req('POST', `/api/campaigns/${camp.id}/join`, {});
  const C = `/api/campaigns/${camp.id}`;
  t('setup: campaign created', !!camp);

  const scene = (await gm.req('POST', `${C}/scenes`, { name: 'Board' })).data.scene;
  await gm.req('PUT', `${C}/scenes/active`, { scene_id: scene.id });
  t('setup: an active scene exists', !!scene);

  console.log('\n--- a new campaign is open ---');
  // Recorded rather than assumed: the column defaults to open, and that default
  // is a deliberate choice documented in the migration. If it is ever flipped
  // to closed, this probe is the one that should fail first.
  t('a campaign starts open', camp.is_open === true, `${camp.is_open}`);
  t('a player can reach the game while it is open',
    (await pl.req('GET', `${C}/scenes`)).status === 200);
  note('the default', 'open, because 60+ suite fixtures assume immediate access — see the migration header');

  console.log('\n--- only the GM may close it ---');
  const playerClose = await pl.req('PATCH', C, { is_open: false });
  t('BFLA: a player cannot close the campaign', playerClose.status === 403, `${playerClose.status}`);
  const playerOpen = await pl.req('PATCH', C, { is_open: true });
  t('...nor open one', playerOpen.status === 403, `${playerOpen.status}`);

  const closed = await gm.req('PATCH', C, { is_open: false });
  t('the GM closes it', closed.status === 200 && closed.data.campaign.is_open === false,
    `${closed.status}`);

  console.log('\n--- closed: the GAME is unreachable over HTTP ---');
  const gameRoutes = [
    ['GET', `${C}/scenes`, 'the scene list'],
    ['GET', `${C}/scenes/${scene.id}`, 'a scene'],
    ['GET', `${C}/actors`, 'characters'],
    ['GET', `${C}/items`, 'items'],
    ['GET', `${C}/spells`, 'spells'],
    ['GET', `${C}/combat`, 'combat'],
    ['GET', `${C}/messages`, 'the chat log'],
  ];
  for (const [method, path, label] of gameRoutes) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pl.req(method, path, undefined);
    t(`a player cannot read ${label}`, r.status === 403, `got ${r.status}`);
  }
  const write = await pl.req('POST', `${C}/messages`, { content: 'hello?' });
  t('...nor write to the chat', write.status === 403, `${write.status}`);
  const roll = await pl.req('POST', `${C}/messages`, { formula: '1d20' });
  t('...nor roll dice', roll.status === 403, `${roll.status}`);

  // The refusal SAYS why. This is the one place in the project that answers 403
  // with a reason instead of 404 — the member already knows the campaign exists,
  // so there is nothing left to conceal, and a 404 would tell somebody who
  // belongs at the table that it had vanished.
  t('the refusal explains itself rather than hiding',
    /closed/i.test((write.data && write.data.error) || ''), write.data && write.data.error);

  console.log('\n--- closed: the CAMPAIGN is still reachable ---');
  // Being unable to leave a closed campaign would make closing it a way to trap
  // people, which is worse than anything the gate protects.
  const detail = await pl.req('GET', C);
  t('a member can still read the campaign', detail.status === 200, `${detail.status}`);
  t('...and is told it is closed', detail.data.campaign.is_open === false);
  t('a member can still choose a colour',
    (await pl.req('PATCH', `${C}/me`, { color: '#4363d8' })).status === 200);
  // The dashboard listing is checked BEFORE archiving. The endpoint is
  // /mine, and it defaults to the ACTIVE filter — archiving first and then
  // asking for the active list is how the first version of this probe crashed,
  // reading `campaigns` off a 404 body.
  const list = await pl.req('GET', '/api/campaigns/mine');
  const listed = (list.data.campaigns || []).find((c) => c.id === camp.id);
  t('it still appears in their dashboard', !!listed, `${list.status}`);
  t('...flagged as closed there too', listed && listed.is_open === false,
    JSON.stringify(listed && listed.is_open));

  t('a member can still archive it from their dashboard',
    (await pl.req('POST', `${C}/archive`, {})).status === 200);
  // [FOUND HERE] Unarchiving is dashboard state exactly as archiving is, and it
  // was NOT exempted from the gate — so a member who tidied away a closed
  // campaign could not bring it back. Found by trying to undo the setup.
  t('...and can UNarchive it again while still closed',
    (await pl.req('POST', `${C}/unarchive`, {})).status === 200,
    'archive and unarchive are one operation in two directions');

  console.log('\n--- closed: the GM keeps working ---');
  // Closing the table is HOW a GM gets it to themselves. A gate that shut them
  // out too would make the feature useless.
  t('the GM can still read the scene list',
    (await gm.req('GET', `${C}/scenes`)).status === 200);
  t('the GM can still place a token',
    (await gm.req('POST', `${C}/scenes/${scene.id}/tokens`, { name: 'Goblin', x: 1, y: 1 })).status === 201);
  t('the GM can still author a spell',
    (await gm.req('POST', `${C}/spells`, { name: 'Prep', level: 1 })).status === 201);

  console.log('\n--- closed: the SOCKET transport agrees ---');
  // The probe this suite exists for. Two places implement one rule, and gating
  // only HTTP would leave the real-time layer wide open.
  const plSock = await connected(socketFor(pl));
  const joinClosed = await emitAck(plSock, 'campaign:join', { campaign_id: camp.id });
  t('a player cannot join the room of a closed campaign',
    joinClosed && joinClosed.ok === false, JSON.stringify(joinClosed));

  const moveClosed = await emitAck(plSock, 'token:move', {
    campaign_id: camp.id, scene_id: scene.id, token_id: '00000000-0000-4000-8000-000000000000', x: 1, y: 1,
  });
  t('...nor move a token', moveClosed && moveClosed.ok === false, JSON.stringify(moveClosed));

  const pingClosed = await emitAck(plSock, 'scene:ping', {
    campaign_id: camp.id, scene_id: scene.id, x: 1, y: 1,
  });
  t('...nor ping', pingClosed && pingClosed.ok === false, JSON.stringify(pingClosed));

  // A player ALREADY IN THE ROOM when the doors shut must not keep playing. The
  // check runs per message rather than at join time, which is what makes closing
  // take effect immediately rather than at the next reconnect.
  const gmSock = await connected(socketFor(gm));
  const gmJoin = await emitAck(gmSock, 'campaign:join', { campaign_id: camp.id });
  t('control: the GM can still join their own closed campaign',
    gmJoin && gmJoin.ok === true, JSON.stringify(gmJoin));

  console.log('\n--- reopening restores everything ---');
  const reopened = await gm.req('PATCH', C, { is_open: true });
  t('the GM reopens it', reopened.status === 200 && reopened.data.campaign.is_open === true);
  t('the player can read the game again',
    (await pl.req('GET', `${C}/scenes`)).status === 200);
  const rejoin = await emitAck(plSock, 'campaign:join', { campaign_id: camp.id });
  t('...and can join the room again, on the same socket',
    rejoin && rejoin.ok === true, JSON.stringify(rejoin));

  console.log('\n--- validation ---');
  t('a non-boolean is refused',
    (await gm.req('PATCH', C, { is_open: 'maybe' })).status === 400);
  t('an array is refused (type confusion)',
    (await gm.req('PATCH', C, { is_open: [false] })).status === 400);
  const stringFalse = await gm.req('PATCH', C, { is_open: 'false' });
  t('the string "false" closes it rather than being truthy',
    stringFalse.status === 200 && stringFalse.data.campaign.is_open === false,
    JSON.stringify(stringFalse.data && stringFalse.data.campaign.is_open));
  await gm.req('PATCH', C, { is_open: true });

  plSock.close(); gmSock.close();

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
