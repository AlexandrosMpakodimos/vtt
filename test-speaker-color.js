// Chat speaker attribution + unique member colours.
//   Usage: SKIP_HIBP=1 node test-speaker-color.js   (server on npm run dev:test)
//
// Functional and adversarial probes in ONE file. The project's convention is to
// split them, and the two exceptions on record (test-active-scene.js,
// test-scene-delete.js) earned it the same way this does: the features are
// small, and their security surface is not a separate subject from their
// behaviour. "A player may speak as their own character" and "a player may NOT
// speak as the GM's NPC" are one rule seen from two sides, and separating them
// would put the control and its refusal in different files.
//
// Mapped to the OWASP API Security Top 10 (2023):
//   API1 BOLA  — speaking as somebody else's character; setting somebody
//                else's colour
//   API3 BOPLA — forging speaker_name, speaker_role or speaker_as
//   API4 URC   — the colour uniqueness race
//
// Cap-style probes assert the EXACT landing state and the accept/refuse split,
// never a ceiling. Fixtures go in through knex; only the behaviour under test
// goes over HTTP.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
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
  a.username = l.data.user.username;
  return a;
}

(async () => {
  const gm = await mk('gm');
  const pl = await mk('pl');
  const pl2 = await mk('pl2');
  const outsider = await mk('out');

  const camp = (await gm.req('POST', '/api/campaigns', { name: 'Speaker', is_public: true })).data.campaign;
  await pl.req('POST', `/api/campaigns/${camp.id}/join`, {});
  await pl2.req('POST', `/api/campaigns/${camp.id}/join`, {});
  const C = `/api/campaigns/${camp.id}`;
  const M = `${C}/messages`;
  const A = `${C}/actors`;
  t('setup: campaign created', !!camp);

  const aria = (await pl.req('POST', A, { name: 'Aria' })).data.actor;
  const goblin = (await gm.req('POST', A, { name: 'Goblin', is_npc: true })).data.actor;
  const other = (await pl2.req('POST', A, { name: 'Borin' })).data.actor;
  t('setup: three characters created', !!aria && !!goblin && !!other);

  console.log('\n--- the role is stamped, not derived ---');
  const gmLine = (await gm.req('POST', M, { content: 'the door creaks' })).data.message;
  const plLine = (await pl.req('POST', M, { content: 'I listen' })).data.message;
  t('the GM\'s line records role gm', gmLine.speaker_role === 'gm', gmLine.speaker_role);
  t('a player\'s line records role player', plLine.speaker_role === 'player', plLine.speaker_role);
  t('speaker_name is still the username', plLine.speaker_name === pl.username);
  t('speaking as nobody leaves speaker_as null', plLine.speaker_as === null, `${plLine.speaker_as}`);

  console.log('\n--- speaking as a character ---');
  const asAria = (await pl.req('POST', M, { content: 'well met', actor_id: aria.id })).data.message;
  t('a player may speak as their own character', asAria.speaker_as === 'Aria', asAria.speaker_as);
  t('...and speaker_name is UNCHANGED, so the human is still identifiable',
    asAria.speaker_name === pl.username, asAria.speaker_name);
  const asGoblin = (await gm.req('POST', M, { content: 'you dare?', actor_id: goblin.id })).data.message;
  t('the GM may speak as an NPC', asGoblin.speaker_as === 'Goblin', asGoblin.speaker_as);
  const roll = (await pl.req('POST', M, { formula: '1d20', actor_id: aria.id })).data.message;
  t('a ROLL also carries the speaker', roll.speaker_as === 'Aria' && !!roll.roll_data);

  console.log('\n--- BOLA: speaking as somebody you do not control ---');
  const stolen = await pl.req('POST', M, { content: 'I am the goblin', actor_id: goblin.id });
  t('a player cannot speak as the GM\'s NPC', stolen.status === 404, `${stolen.status}`);
  t('...and the refusal is 404, not 403 (no NPC enumeration oracle)',
    stolen.status === 404 && !(stolen.data && /forbidden/i.test(stolen.data.error || '')));
  const stolen2 = await pl.req('POST', M, { content: 'hi', actor_id: other.id });
  t('a player cannot speak as another PLAYER\'s character', stolen2.status === 404, `${stolen2.status}`);
  const foreign = await pl.req('POST', M, { content: 'hi', actor_id: '00000000-0000-4000-8000-000000000000' });
  t('an unknown character id -> 404', foreign.status === 404, `${foreign.status}`);
  t('a malformed character id -> 404, not 500',
    (await pl.req('POST', M, { content: 'hi', actor_id: 'not-a-uuid' })).status === 404);
  const none = await knex('messages')
    .where({ campaign_id: camp.id })
    .andWhere('content', 'I am the goblin').first();
  t('the refused message was not written at all', !none);

  console.log('\n--- BOPLA: the attribution fields cannot be forged ---');
  const forged = (await pl.req('POST', M, {
    content: 'trust me',
    speaker_name: 'The GM', speaker_role: 'gm', speaker_as: 'Ancient Dragon',
  })).data.message;
  t('speaker_name cannot be forged', forged.speaker_name === pl.username, forged.speaker_name);
  t('speaker_role cannot be forged', forged.speaker_role === 'player', forged.speaker_role);
  t('speaker_as cannot be forged without a character', forged.speaker_as === null, `${forged.speaker_as}`);

  console.log('\n--- history and the socket carry the same attribution ---');
  const hist = (await pl.req('GET', `${M}?limit=50`)).data.messages;
  const histAria = hist.find((m) => m.id === asAria.id);
  t('history carries speaker_as', histAria && histAria.speaker_as === 'Aria');
  t('history carries speaker_role', histAria && histAria.speaker_role === 'player');

  console.log('\n--- the name is COPIED, so the log survives its character ---');
  await gm.req('DELETE', `${A}/${goblin.id}`);
  const afterDelete = (await gm.req('GET', `${M}?limit=50`)).data.messages
    .find((m) => m.id === asGoblin.id);
  t('deleting the character leaves the line intact',
    afterDelete && afterDelete.speaker_as === 'Goblin', JSON.stringify(afterDelete));
  note('why no actor_id column', 'a FK here would be a new door onto actors from a table every member reads');

  console.log('\n--- colours: self-service ---');
  const set1 = await pl.req('PATCH', `${C}/me`, { color: '#e6194b' });
  t('a member sets their own colour', set1.status === 200, `${set1.status}`);
  t('...and it comes back on the member', set1.data.member.color === '#e6194b');
  const seen = (await pl2.req('GET', C)).data.members.find((m) => m.user_id === pl.id);
  t('every member can see it', seen && seen.color === '#e6194b', JSON.stringify(seen));
  const gmSet = await gm.req('PATCH', `${C}/me`, { color: '#3cb44b' });
  t('the GM has a membership row and can set a colour too', gmSet.status === 200, `${gmSet.status}`);

  console.log('\n--- colours: uniqueness ---');
  const clash = await pl2.req('PATCH', `${C}/me`, { color: '#e6194b' });
  t('a colour already claimed is refused with 409', clash.status === 409, `${clash.status}`);
  const stillMine = (await pl.req('GET', C)).data.members.find((m) => m.user_id === pl.id);
  t('...and the original holder keeps it', stillMine.color === '#e6194b');
  const free = await pl2.req('PATCH', `${C}/me`, { color: '#4363d8' });
  t('a free colour is accepted', free.status === 200, `${free.status}`);
  const rechoose = await pl.req('PATCH', `${C}/me`, { color: '#e6194b' });
  t('re-choosing your OWN colour is not a conflict', rechoose.status === 200, `${rechoose.status}`);
  const clear = await pl.req('PATCH', `${C}/me`, { color: null });
  t('a colour can be cleared', clear.status === 200 && clear.data.member.color === null);
  const reclaim = await pl2.req('PATCH', `${C}/me`, { color: '#e6194b' });
  t('...and the freed colour becomes available', reclaim.status === 200, `${reclaim.status}`);

  console.log('\n--- colours: the same colour in a DIFFERENT campaign is fine ---');
  const camp2 = (await gm.req('POST', '/api/campaigns', { name: 'Other', is_public: true })).data.campaign;
  await pl.req('POST', `/api/campaigns/${camp2.id}/join`, {});
  const elsewhere = await pl.req('PATCH', `/api/campaigns/${camp2.id}/me`, { color: '#e6194b' });
  t('uniqueness is scoped to the campaign', elsewhere.status === 200, `${elsewhere.status}`);

  console.log('\n--- colours: validation and authorisation ---');
  t('a non-hex colour is refused',
    (await pl.req('PATCH', `${C}/me`, { color: 'red' })).status === 400);
  t('a short hex is refused',
    (await pl.req('PATCH', `${C}/me`, { color: '#fff' })).status === 400);
  t('an array is refused (type confusion)',
    (await pl.req('PATCH', `${C}/me`, { color: ['#ffffff'] })).status === 400);
  t('an empty body is refused',
    (await pl.req('PATCH', `${C}/me`, {})).status === 400);
  t('a non-member cannot set a colour -> 404 (no existence leak)',
    (await outsider.req('PATCH', `${C}/me`, { color: '#f58231' })).status === 404);
  const forgedTarget = await pl.req('PATCH', `${C}/me`, { color: '#f58231', user_id: gm.id });
  t('a forged user_id in the body is ignored — the route updates the CALLER',
    forgedTarget.status === 200);
  const gmColor = (await gm.req('GET', C)).data.members.find((m) => m.user_id === gm.id);
  t('...and the GM\'s colour was untouched', gmColor.color === '#3cb44b', gmColor.color);

  console.log('\n--- API4: the uniqueness race lands on EXACTLY one winner ---');
  // Six members racing for one colour. Fixtures via knex; only the racing writes
  // go over HTTP. The database index is the enforcement, so this measures the
  // index rather than an application check.
  const racers = [];
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const a = await mk(`race${i}`);
    // eslint-disable-next-line no-await-in-loop
    await a.req('POST', `/api/campaigns/${camp2.id}/join`, {});
    racers.push(a);
  }
  const target = '#911eb4';
  const outcome = await Promise.all(racers.map((a) => a.req('PATCH', `/api/campaigns/${camp2.id}/me`, { color: target })));
  const accepted = outcome.filter((r) => r.status === 200).length;
  const refused = outcome.filter((r) => r.status === 409).length;
  const holders = Number((await knex('campaign_members')
    .where({ campaign_id: camp2.id, color: target }).count({ n: '*' }).first()).n);
  t('exactly ONE member holds the colour after 6 parallel claims',
    holders === 1 && accepted === 1 && refused === 5,
    `holders ${holders}, accepted ${accepted}, refused ${refused}`);
  t('nobody received a 500 from the race',
    outcome.every((r) => r.status < 500), outcome.map((r) => r.status).join(','));

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
