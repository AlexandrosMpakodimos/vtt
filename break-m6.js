// Adversarial audit of the M6 surface.
//   Usage: SKIP_HIBP=1 node break-m6.js   (server on npm run dev:test)
//
// The existing adversarial suites predate five features and three migrations:
// chat speaker attribution, unique member colours, scene editing and grid
// alignment, image framing, and spells. This audits what those added, and — more
// usefully — what they added to code that already existed.
//
// Mapped to the OWASP API Security Top 10 (2023):
//   API1 BOLA   — cross-campaign reach through the new routes
//   API3 BOPLA  — forged attribution; the framing tiers
//   API4 URC    — an unlimited write that broadcasts room-wide
//   API5 BFLA   — player attempts at GM-only functions
//
// FOUR FINDINGS, all fixed, all probed below. Three of them are the same shape:
// a new thing changed the behaviour of an OLD thing whose author never saw it.
//
//   F1  A new UNIQUE index made an old route able to raise 23505, which it did
//       not handle — so joining with a taken colour was a 500, and the 500 was
//       an oracle for the palette of a campaign you were not yet in.
//   F2  PATCH /:id/me had no rate limiter and broadcasts room-wide, making it
//       the only unlimited amplifier in the project.
//   F3  inventory:changed and spellbook:changed went broadcastRoom while
//       actor:updated is gated by playersMayKnowActor — so the same actor's
//       updates were hidden while "somebody touched its bag" was announced to
//       everyone with its id attached.
//   F4  A comment insertion orphaned the leave route's documentation onto the
//       route above it. Cosmetic, and recorded because a wrong comment is worse
//       than none.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { io } = require('socket.io-client');
const knex = require('./src/db');

let pass = 0; let fail = 0; const findings = []; const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(`  DEFENDED  ${name}`); } else {
    fail += 1; results.push(`  VULNERABLE  ${name}  ${detail}`); findings.push(name);
  }
}
function note(name, detail) { results.push(`  NOTE      ${name}  ${detail}`); }

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
function recorder(socket, events) {
  const seen = [];
  for (const ev of events) socket.on(ev, (d) => seen.push({ ev, d }));
  return seen;
}
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const gm = await mk('gm');
  const pl = await mk('pl');
  const outsider = await mk('out');

  const camp = (await gm.req('POST', '/api/campaigns', { name: 'M6 audit', is_public: true })).data.campaign;
  await pl.req('POST', `/api/campaigns/${camp.id}/join`, {});
  const C = `/api/campaigns/${camp.id}`;
  ok('setup: campaign created', !!camp);

  // =====================================================================
  // F1 — a new index made an old route crash, and the crash was an oracle
  // =====================================================================
  console.log('\n--- F1: joining with a colour somebody already holds ---');
  await gm.req('PATCH', `${C}/me`, { color: '#e6194b' });
  const taken = await mk('taken');
  const join = await taken.req('POST', `${C}/join`, { color: '#e6194b' });

  ok('F1: joining with a taken colour does NOT 500', join.status !== 500, `got ${join.status}`);
  ok('F1: ...the join SUCCEEDS anyway', join.status === 200, `got ${join.status}`);
  const row = await knex('campaign_members')
    .where({ campaign_id: camp.id, user_id: taken.id }).first();
  ok('F1: ...with the colour dropped rather than the join refused',
    !!row && row.color === null, `${row && row.color}`);
  ok('F1: ...and the original holder keeps it',
    (await knex('campaign_members').where({ campaign_id: camp.id, user_id: gm.id }).first()).color === '#e6194b');

  // The oracle: a refusal here would let a stranger read a campaign's palette
  // from outside by joining with each colour in turn.
  const free = await mk('free');
  const freeJoin = await free.req('POST', `${C}/join`, { color: '#3cb44b' });
  ok('F1: a FREE colour and a TAKEN colour are indistinguishable from outside',
    freeJoin.status === join.status,
    `free ${freeJoin.status} vs taken ${join.status} — a difference is a palette oracle`);
  note('why dropped, not refused', 'you cannot be barred from a game because somebody took blue');

  // Once inside, a conflict IS reported honestly — the palette is readable by then.
  const conflict = await taken.req('PATCH', `${C}/me`, { color: '#e6194b' });
  ok('F1: PATCH /me still answers 409 for a member (the palette is theirs to read)',
    conflict.status === 409, `${conflict.status}`);

  // =====================================================================
  // F2 — an unlimited write that fans out to every member
  // =====================================================================
  console.log('\n--- F2: the colour route is rate-limited like every other write ---');
  // dev:test sets RL_CONTENT_WRITE_MAX to 100000, so this cannot be measured by
  // exhausting it. Assert the MIDDLEWARE IS PRESENT instead — by its header,
  // which express-rate-limit emits and an unlimited route does not.
  const limited = await fetch(`${BASE}${C}/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: pl.cookie },
    body: JSON.stringify({ color: '#4363d8' }),
  });
  const hasLimit = limited.headers.get('ratelimit-limit')
    || limited.headers.get('x-ratelimit-limit');
  ok('F2: PATCH /:id/me carries rate-limit headers', !!hasLimit,
    'no limiter means one member can fan out unlimited broadcasts to the room');
  note('F2 rationale', 'every other resource router applies contentWriteLimiter; this route broadcasts room-wide');

  // =====================================================================
  // F3 — the socket layer: bag and spellbook events vs actor events
  // =====================================================================
  console.log('\n--- F3: does a bag or spellbook event announce an unseen NPC? ---');
  const board = (await gm.req('POST', `${C}/scenes`, { name: 'Board' })).data.scene;
  await gm.req('PUT', `${C}/scenes/active`, { scene_id: board.id });

  const lich = (await gm.req('POST', `${C}/actors`, { name: 'Lich', is_npc: true, hp_max: 80 })).data.actor;
  const aria = (await pl.req('POST', `${C}/actors`, { name: 'Aria' })).data.actor;
  const sword = (await gm.req('POST', `${C}/items`, { name: 'Sword', type: 'weapon' })).data.item;
  const bolt = (await gm.req('POST', `${C}/spells`, { name: 'Counterspell', level: 3 })).data.spell;
  ok('setup: an UNPLACED NPC, a PC, an item and a spell', !!lich && !!aria && !!sword && !!bolt);

  const gmSock = await connected(socketFor(gm));
  const plSock = await connected(socketFor(pl));
  await emitAck(gmSock, 'campaign:join', { campaign_id: camp.id });
  await emitAck(plSock, 'campaign:join', { campaign_id: camp.id });

  const EVENTS = ['inventory:changed', 'spellbook:changed', 'actor:updated'];

  let plSeen = recorder(plSock, EVENTS);
  let gmSeen = recorder(gmSock, EVENTS);
  await gm.req('POST', `${C}/actors/${lich.id}/inventory`, { item_id: sword.id });
  await gm.req('POST', `${C}/actors/${lich.id}/spells`, { spell_id: bolt.id });
  await settle();

  ok('F3: a player is NOT told the unseen NPC\'s bag changed',
    !plSeen.some((e) => e.ev === 'inventory:changed' && e.d.actor_id === lich.id),
    JSON.stringify(plSeen.map((e) => `${e.ev}:${e.d.actor_id}`)));
  ok('F3: nor its spellbook',
    !plSeen.some((e) => e.ev === 'spellbook:changed' && e.d.actor_id === lich.id),
    JSON.stringify(plSeen.map((e) => `${e.ev}:${e.d.actor_id}`)));
  ok('F3: ...so the NPC\'s id is never disclosed at all',
    !plSeen.some((e) => e.d && e.d.actor_id === lich.id));
  ok('F3 control: the GM DOES receive both (not fixed by muting everything)',
    gmSeen.some((e) => e.ev === 'inventory:changed' && e.d.actor_id === lich.id)
      && gmSeen.some((e) => e.ev === 'spellbook:changed' && e.d.actor_id === lich.id),
    JSON.stringify(gmSeen.map((e) => e.ev)));

  // The party must still hear about each other. If the fix over-applied, this
  // is where it shows.
  plSeen = recorder(plSock, EVENTS);
  await gm.req('POST', `${C}/actors/${aria.id}/inventory`, { item_id: sword.id });
  await gm.req('POST', `${C}/actors/${aria.id}/spells`, { spell_id: bolt.id });
  await settle();
  ok('F3 control: a PLAYER CHARACTER\'s bag change still reaches the table',
    plSeen.some((e) => e.ev === 'inventory:changed' && e.d.actor_id === aria.id),
    JSON.stringify(plSeen.map((e) => `${e.ev}:${e.d.actor_id}`)));
  ok('F3 control: and its spellbook',
    plSeen.some((e) => e.ev === 'spellbook:changed' && e.d.actor_id === aria.id));

  // Place the NPC visibly: the gate must be evaluated LIVE, not latched.
  plSeen = recorder(plSock, EVENTS);
  const lichTok = (await gm.req('POST', `${C}/scenes/${board.id}/tokens`, {
    actor_id: lich.id, x: 1, y: 1,
  })).data.token;
  await settle();
  plSeen = recorder(plSock, EVENTS);
  await gm.req('PATCH', `${C}/actors/${lich.id}/spells/${bolt.id}`, { prepared: true });
  await settle();
  ok('F3: once its token is VISIBLE, the player does hear about it (evaluated live)',
    plSeen.some((e) => e.ev === 'spellbook:changed' && e.d.actor_id === lich.id),
    JSON.stringify(plSeen.map((e) => `${e.ev}:${e.d.actor_id}`)));

  // ...and hiding it again withdraws that.
  await gm.req('PATCH', `${C}/scenes/${board.id}/tokens/${lichTok.id}`, { hidden: true });
  plSeen = recorder(plSock, EVENTS);
  await gm.req('PATCH', `${C}/actors/${lich.id}/spells/${bolt.id}`, { prepared: false });
  await settle();
  ok('F3: hiding the token withdraws it again (symmetric)',
    !plSeen.some((e) => e.ev === 'spellbook:changed' && e.d.actor_id === lich.id),
    JSON.stringify(plSeen.map((e) => `${e.ev}:${e.d.actor_id}`)));
  note('F3 why it mattered', 'the payload never carried data — it carried an EXISTENCE and a timing');

  // Reading is still refused, which is the control that makes the above coherent.
  ok('F3: the player still cannot read the NPC bag over HTTP',
    (await pl.req('GET', `${C}/actors/${lich.id}/inventory`)).status === 404);
  ok('F3: nor its spellbook',
    (await pl.req('GET', `${C}/actors/${lich.id}/spells`)).status === 404);

  gmSock.close(); plSock.close();

  // =====================================================================
  // scene editing: the new route on the old confidentiality rule
  // =====================================================================
  console.log('\n--- scene:updated respects the active-scene rule ---');
  const prep = (await gm.req('POST', `${C}/scenes`, { name: 'Prep' })).data.scene;
  const gm2 = await connected(socketFor(gm));
  const pl2 = await connected(socketFor(pl));
  await emitAck(gm2, 'campaign:join', { campaign_id: camp.id });
  await emitAck(pl2, 'campaign:join', { campaign_id: camp.id });

  const plScene = recorder(pl2, ['scene:updated']);
  const gmScene = recorder(gm2, ['scene:updated']);
  await gm.req('PATCH', `${C}/scenes/${prep.id}`, { name: 'Boss room', grid: { size: 64 } });
  await settle();
  ok('a player hears NOTHING about a prep-scene edit',
    plScene.length === 0, JSON.stringify(plScene.map((e) => e.d && e.d.name)));
  ok('control: the GM does hear it', gmScene.length > 0);

  const plActive = recorder(pl2, ['scene:updated']);
  await gm.req('PATCH', `${C}/scenes/${board.id}`, { grid: { size: 64 } });
  await settle();
  ok('control: a player DOES hear an edit to the ACTIVE scene', plActive.length > 0);
  ok('...and the name of the prep scene never reached them',
    !plScene.concat(plActive).some((e) => e.d && e.d.name === 'Boss room'));
  gm2.close(); pl2.close();

  // =====================================================================
  // BOLA / BFLA across the new routes
  // =====================================================================
  console.log('\n--- BOLA / BFLA on everything M6 added ---');
  const foreign = (await outsider.req('POST', '/api/campaigns', { name: 'Foreign', is_public: true })).data.campaign;
  const attempts = [
    ['PATCH', `${C}/me`, { color: '#f58231' }, 'set a colour in a campaign they are not in'],
    ['GET', `${C}/spells`, undefined, 'list spells'],
    ['POST', `${C}/spells`, { name: 'X', level: 1 }, 'author a spell'],
    ['PATCH', `${C}/scenes/${board.id}`, { name: 'x' }, 'edit a scene'],
    ['GET', `${C}/actors/${aria.id}/spells`, undefined, 'read a spellbook'],
  ];
  for (const [method, path, body, label] of attempts) {
    // eslint-disable-next-line no-await-in-loop
    const r = await outsider.req(method, path, body);
    ok(`BOLA: an outsider cannot ${label} -> 404`, r.status === 404, `got ${r.status}`);
  }
  const bfla = [
    ['POST', `${C}/spells`, { name: 'Wish', level: 9 }, 'author a spell'],
    ['PATCH', `${C}/scenes/${board.id}`, { grid: { size: 100 } }, 'realign the grid'],
    ['PATCH', `${C}/scenes/${board.id}/tokens/${lichTok.id}`, { img_scale: 2 }, 'frame a token'],
  ];
  for (const [method, path, body, label] of bfla) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pl.req(method, path, body);
    ok(`BFLA: a player cannot ${label}`, r.status === 403, `got ${r.status}`);
  }
  const crossCampaign = await gm.req('PATCH', `/api/campaigns/${foreign.id}/me`, { color: '#911eb4' });
  ok('BOLA: the GM of one campaign is a stranger to another -> 404',
    crossCampaign.status === 404, `${crossCampaign.status}`);

  // =====================================================================
  // BOPLA on the new columns
  // =====================================================================
  console.log('\n--- BOPLA: forging the M6 columns ---');
  const forged = await pl.req('POST', `${C}/messages`, {
    content: 'x', speaker_role: 'gm', speaker_as: 'Ancient Dragon', speaker_name: 'The GM',
  });
  const m = forged.data && forged.data.message;
  ok('speaker_role cannot be forged', m && m.speaker_role === 'player', m && m.speaker_role);
  ok('speaker_as cannot be forged', m && m.speaker_as === null, m && m.speaker_as);
  ok('speaker_name cannot be forged', m && m.speaker_name !== 'The GM');

  const framed = await pl.req('POST', `${C}/actors`, {
    name: 'Sneak', img_scale: 4, img_offset_x: 1.5,
  });
  ok('a player MAY set framing on their own new character (same tier as img_url)',
    framed.status === 201, `${framed.status}`);
  const npcFrame = await pl.req('PATCH', `${C}/actors/${lich.id}`, { img_scale: 3 });
  ok('...but not on the GM\'s NPC', npcFrame.status === 403, `${npcFrame.status}`);

  const gridForge = await gm.req('PATCH', `${C}/scenes/${board.id}`, {
    grid: { size: 64, __proto__: { polluted: true }, constructor: 'x' },
  });
  ok('a prototype-shaped grid key is stripped, not stored',
    gridForge.status === 200 && !('polluted' in gridForge.data.scene.grid),
    JSON.stringify(gridForge.data.scene.grid));
  ok('...and Object.prototype was not polluted',
    ({}).polluted === undefined);

  // =====================================================================
  // the spell catalogue as an enumeration surface
  // =====================================================================
  console.log('\n--- the spell catalogue discloses by design, and nothing more ---');
  const plSpells = await pl.req('GET', `${C}/spells`);
  ok('a player reads the catalogue in full', plSpells.status === 200);
  ok('...and it carries no per-character state',
    plSpells.data.spells.every((sp) => !('prepared' in sp) && !('actor_id' in sp)),
    JSON.stringify(plSpells.data.spells[0]));
  note('deliberate', 'a player must read what a spell does in order to cast it');

  console.log(results.join('\n'));
  console.log(`\n${pass} defended, ${fail} vulnerable`);
  if (findings.length) console.log('FINDINGS:\n' + findings.map((f) => `  - ${f}`).join('\n'));
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('SUITE CRASHED:', e);
  console.log(results.join('\n'));
  await knex.destroy();
  process.exit(1);
});
