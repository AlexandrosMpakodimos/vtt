// Scene editing, grid alignment and image framing (M6).
//   Usage: SKIP_HIBP=1 node test-scene-grid.js   (server on npm run dev:test)
//
// Functional and adversarial in one file, on the same grounds as
// test-speaker-color.js: the features are small and their security surface is
// not a separate subject from their behaviour.
//
// Covers three things that did not exist before M6:
//   - PATCH /scenes/:sceneId, a recorded [TODO] since M3
//   - scenes.grid validated and accepted (it was JSONB with no validator, and
//     was not accepted on create at all)
//   - image framing on actors and tokens
//
// Mapped to the OWASP API Security Top 10 (2023):
//   API1 BOLA  — editing another campaign's scene
//   API3 BOPLA — forging id/campaign_id; unknown grid keys; framing tiers
//   API5 BFLA  — a player editing the board
//   API4 URC   — an unbounded grid blob

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
  return a;
}

(async () => {
  const gm = await mk('gm');
  const pl = await mk('pl');
  const outsider = await mk('out');

  const camp = (await gm.req('POST', '/api/campaigns', { name: 'Grid', is_public: true })).data.campaign;
  const other = (await outsider.req('POST', '/api/campaigns', { name: 'Other', is_public: true })).data.campaign;
  await pl.req('POST', `/api/campaigns/${camp.id}/join`, {});
  const S = `/api/campaigns/${camp.id}/scenes`;
  const A = `/api/campaigns/${camp.id}/actors`;
  t('setup: campaign created', !!camp);

  console.log('\n--- grid is accepted on create ---');
  const made = await gm.req('POST', S, {
    name: 'Bridge', width: 2000, height: 1500,
    grid: { size: 70, type: 'square', color: '#FFAA00', opacity: 0.4, offset_x: -12.5, offset_y: 8 },
  });
  t('a scene is created with a grid', made.status === 201, `${made.status}`);
  const scene = made.data.scene;
  t('grid.size stored', scene.grid.size === 70, JSON.stringify(scene.grid));
  t('grid.color normalised to lowercase', scene.grid.color === '#ffaa00');
  t('grid offsets stored, fractional allowed', scene.grid.offset_x === -12.5 && scene.grid.offset_y === 8);
  const bare = (await gm.req('POST', S, { name: 'Bare' })).data.scene;
  t('a scene with no grid gets an empty object, not null',
    bare.grid && typeof bare.grid === 'object' && Object.keys(bare.grid).length === 0,
    JSON.stringify(bare.grid));

  console.log('\n--- PATCH /:sceneId (did not exist before M6) ---');
  const P = `${S}/${scene.id}`;
  const ren = await gm.req('PATCH', P, { name: 'Bridge at dusk' });
  t('the GM renames a scene', ren.status === 200 && ren.data.scene.name === 'Bridge at dusk', `${ren.status}`);
  const img = await gm.req('PATCH', P, { img_url: 'https://example.com/map.png' });
  t('the map image can be set', img.status === 200 && img.data.scene.img_url === 'https://example.com/map.png');
  const dims = await gm.req('PATCH', P, { width: 2400, height: 1800 });
  t('dimensions can be changed', dims.status === 200 && dims.data.scene.width === 2400);
  t('an empty PATCH is refused', (await gm.req('PATCH', P, {})).status === 400);

  console.log('\n--- the grid MERGES rather than replaces ---');
  // An alignment tool nudges one offset at a time. A replace would silently
  // reset colour and opacity on every nudge.
  const nudge = await gm.req('PATCH', P, { grid: { offset_x: 4 } });
  t('a partial grid update is accepted', nudge.status === 200, `${nudge.status}`);
  t('...the touched key changed', nudge.data.scene.grid.offset_x === 4);
  t('...and the untouched keys SURVIVED',
    nudge.data.scene.grid.size === 70
      && nudge.data.scene.grid.color === '#ffaa00'
      && nudge.data.scene.grid.opacity === 0.4,
    JSON.stringify(nudge.data.scene.grid));

  console.log('\n--- the grid hazard is REPORTED, not silently compensated ---');
  await gm.req('PUT', `/api/campaigns/${camp.id}/scenes/active`, { scene_id: scene.id });
  const tok = (await gm.req('POST', `${P}/tokens`, { name: 'Goblin', x: 3, y: 4 })).data.token;
  t('setup: a token is on the scene', !!tok);
  const resize = await gm.req('PATCH', P, { grid: { size: 100 } });
  t('changing grid.size reports that the grid changed', resize.data.grid_changed === true);
  t('...and counts the tokens it will visually move',
    resize.data.affected_tokens === 1, `${resize.data.affected_tokens}`);
  const still = await knex('tokens').where({ id: tok.id }).first();
  t('...but does NOT rewrite any token coordinate',
    Number(still.x) === 3 && Number(still.y) === 4, `${still.x},${still.y}`);
  const rename2 = await gm.req('PATCH', P, { name: 'Bridge' });
  t('a non-grid edit does not claim the grid changed', rename2.data.grid_changed === false);
  note('why no rewrite', 'whether tokens keep their squares or their positions over the art is a GM decision');

  console.log('\n--- grid validation ---');
  const bad = [
    [{ size: 4 }, 'size below the bound'],
    [{ size: 501 }, 'size above the bound'],
    [{ type: 'octagon' }, 'unknown grid type'],
    [{ opacity: 2 }, 'opacity above 1'],
    [{ opacity: -1 }, 'opacity below 0'],
    [{ offset_x: 99999 }, 'offset past the bound'],
    [{ offset_x: 'abc' }, 'non-numeric offset'],
    [{ offset_x: [[5]] }, 'nested-array offset (type confusion)'],
    [{ color: 'red' }, 'non-hex grid colour'],
    [{ size: [70] }, 'array size'],
  ];
  for (const [grid, label] of bad) {
    // eslint-disable-next-line no-await-in-loop
    const r = await gm.req('PATCH', P, { grid });
    t(`grid: ${label} refused`, r.status === 400, `got ${r.status}`);
  }
  t('a non-object grid is refused', (await gm.req('PATCH', P, { grid: [1, 2] })).status === 400);
  t('a string grid is refused', (await gm.req('PATCH', P, { grid: 'square' })).status === 400);

  console.log('\n--- API4: two distinct defences against an inflated blob ---');
  // [PROBE CORRECTED] The first version sent ~100 KB and asserted a 200 with the
  // junk stripped. It got a 413 instead, because express.json() defaults to a
  // 100 KB body limit — the server defending correctly while the assertion was
  // wrong. Two defences exist and they are now probed separately, because a
  // probe that conflates them cannot tell which one is doing the work.

  // (a) UNDER the body limit: accepted, and the allow-list strips it.
  const junk = {};
  for (let i = 0; i < 300; i += 1) junk[`k${i}`] = 'x'.repeat(100);
  junk.size = 60;
  const fat = await gm.req('PATCH', P, { grid: junk });
  t('a ~30 KB grid blob is accepted', fat.status === 200, `${fat.status}`);
  t('...with every unknown key STRIPPED by the allow-list',
    fat.status === 200 && Object.keys(fat.data.scene.grid).every((k) => !/^k\d+$/.test(k)),
    JSON.stringify(fat.data.scene.grid).slice(0, 120));
  t('...and the legitimate key still landed',
    fat.status === 200 && fat.data.scene.grid.size === 60);
  const stored = await knex('scenes').where({ id: scene.id }).first();
  t('...so nothing oversized reached the database',
    JSON.stringify(stored.grid).length < 400, `${JSON.stringify(stored.grid).length} bytes`);

  // (b) OVER the body limit: refused by the parser before any route runs.
  const huge = {};
  for (let i = 0; i < 2000; i += 1) huge[`k${i}`] = 'x'.repeat(200);
  const tooBig = await gm.req('PATCH', P, { grid: huge });
  t('a ~400 KB body is refused outright (413), not parsed',
    tooBig.status === 413, `got ${tooBig.status}`);
  const afterHuge = await knex('scenes').where({ id: scene.id }).first();
  t('...and the refused request changed nothing',
    JSON.stringify(afterHuge.grid) === JSON.stringify(stored.grid));
  note('two defences', 'body limit stops the payload; the allow-list stops what gets stored');

  console.log('\n--- BFLA / BOLA on scene editing ---');
  t('a player cannot edit a scene', (await pl.req('PATCH', P, { name: 'mine' })).status === 403);
  t('a non-member gets 404, not 403 (no existence leak)',
    (await outsider.req('PATCH', P, { name: 'mine' })).status === 404);
  t('a GM cannot edit another campaign\'s scene through their own path',
    (await outsider.req('PATCH', `/api/campaigns/${other.id}/scenes/${scene.id}`, { name: 'x' })).status === 404);
  const untouched = await knex('scenes').where({ id: scene.id }).first();
  t('the scene survived every unauthorised attempt', untouched.name === 'Bridge', untouched.name);
  t('a malformed scene id -> 404, not 500',
    (await gm.req('PATCH', `${S}/not-a-uuid`, { name: 'x' })).status === 404);

  console.log('\n--- BOPLA: forged fields on PATCH ---');
  const forged = await gm.req('PATCH', P, {
    name: 'Forged', id: '00000000-0000-4000-8000-000000000000', campaign_id: other.id,
  });
  t('a forged id/campaign_id is ignored', forged.status === 200 && forged.data.scene.id === scene.id);
  const check = await knex('scenes').where({ id: scene.id }).first();
  t('...and the scene still belongs to its campaign', check.campaign_id === camp.id);

  console.log('\n--- image framing: actors ---');
  const mine = (await pl.req('POST', A, { name: 'Aria' })).data.actor;
  t('a new character starts with the identity transform',
    mine.img_offset_x === 0 && mine.img_offset_y === 0 && mine.img_scale === 1,
    JSON.stringify([mine.img_offset_x, mine.img_offset_y, mine.img_scale]));
  const framed = await pl.req('PATCH', `${A}/${mine.id}`, {
    img_offset_x: 0.25, img_offset_y: -0.1, img_scale: 1.4,
  });
  t('a player may frame their OWN portrait', framed.status === 200, `${framed.status}`);
  t('...and the values come back as NUMBERS, not strings',
    typeof framed.data.actor.img_offset_x === 'number' && framed.data.actor.img_scale === 1.4,
    JSON.stringify(framed.data.actor.img_offset_x));

  const npc = (await gm.req('POST', A, { name: 'Goblin', is_npc: true, hp_max: 7 })).data.actor;
  t('a player cannot frame the GM\'s NPC',
    (await pl.req('PATCH', `${A}/${npc.id}`, { img_scale: 2 })).status === 403);
  t('the GM may frame any character',
    (await gm.req('PATCH', `${A}/${npc.id}`, { img_scale: 2 })).status === 200);

  const badFrames = [
    ['img_scale', 0.01], ['img_scale', 99], ['img_scale', [[2]]],
    ['img_offset_x', 9], ['img_offset_x', 'abc'], ['img_offset_y', { x: 1 }],
  ];
  for (const [field, value] of badFrames) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pl.req('PATCH', `${A}/${mine.id}`, { [field]: value });
    t(`framing: ${field}=${JSON.stringify(value)} refused`, r.status === 400, `got ${r.status}`);
  }

  console.log('\n--- framing travels WITH the picture, including in the projection ---');
  // The projection already discloses img_url so a monster's token can render.
  // Withholding how that picture is framed would make the same token look
  // different on a player's screen than on the GM's, and would disclose nothing.
  const npcTok = (await gm.req('POST', `${P}/tokens`, {
    name: 'Goblin', actor_id: npc.id, x: 1, y: 1,
  })).data.token;
  t('setup: the NPC is on the board', !!npcTok);
  const plView = (await pl.req('GET', P)).data;
  const seen = (plView.actors || []).find((a) => a.id === npc.id);
  t('a player receives the projected NPC', !!seen);
  t('...with its framing', seen && seen.img_scale === 2, JSON.stringify(seen));
  t('...and still NO statistics', seen && seen.hp_max === undefined && seen.hp_current === undefined);

  console.log('\n--- image framing: tokens INHERIT it, LIVE ---');
  // [PROBES INVERTED 2026-08-10] These previously asserted copy-at-placement,
  // including one written specifically to record that re-framing a character
  // does NOT reach tokens already on the board. That behaviour was reported as
  // a bug and it was one: the copy made inheritance a one-time event, so a
  // linked token stopped being linked for display the moment it was created.
  //
  // NULL now means "ask the character". These probes assert the relationship
  // rather than the copy, and the one that recorded the old consequence is
  // inverted rather than deleted so the change is visible in the diff.
  t('a token placed from a character shows its framing',
    npcTok.img_scale === 2, `${npcTok.img_scale}`);

  const ownArt = (await gm.req('POST', `${P}/tokens`, {
    name: 'Custom', actor_id: npc.id, x: 4, y: 4,
    img_url: 'https://example.com/other.png',
  })).data.token;
  t('a token given its OWN picture starts at the identity transform',
    ownArt.img_scale === 1 && ownArt.img_offset_x === 0,
    JSON.stringify([ownArt.img_scale, ownArt.img_offset_x]));

  const unlinked = (await gm.req('POST', `${P}/tokens`, { name: 'Crate', x: 5, y: 5 })).data.token;
  t('an unlinked token has no picture to inherit',
    unlinked.img_url === null, `${unlinked.img_url}`);
  t('...and gets the identity transform, not an absent one',
    unlinked.img_offset_x === 0 && unlinked.img_scale === 1,
    JSON.stringify([unlinked.img_offset_x, unlinked.img_scale]));

  console.log('\n--- re-framing a character REACHES its tokens ---');
  await gm.req('PATCH', `${A}/${npc.id}`, { img_scale: 3, img_offset_x: 0.4 });
  const afterReframe = (await gm.req('GET', P)).data.tokens.find((x) => x.id === npcTok.id);
  t('a token that inherits follows the character',
    afterReframe.img_scale === 3 && afterReframe.img_offset_x === 0.4,
    JSON.stringify([afterReframe.img_scale, afterReframe.img_offset_x]));

  await gm.req('PATCH', `${A}/${npc.id}`, { img_url: 'https://example.com/newportrait.png' });
  const afterRepic = (await gm.req('GET', P)).data.tokens.find((x) => x.id === npcTok.id);
  t('...and so does its picture',
    afterRepic.img_url === 'https://example.com/newportrait.png', afterRepic.img_url);

  // The override must survive, or the fix would be the opposite bug: a
  // deliberate per-token picture silently reverting on every character edit.
  const overridden = (await gm.req('GET', P)).data.tokens.find((x) => x.id === ownArt.id);
  t('a token with its OWN picture is NOT overwritten',
    overridden.img_url === 'https://example.com/other.png', overridden.img_url);
  t('...nor is its own framing',
    overridden.img_scale === 1, `${overridden.img_scale}`);

  console.log('\n--- the payload SAYS whether it inherited ---');
  // Resolving on the server erases the distinction: an inherited picture and an
  // owned copy of the same URL look identical in the payload. A client that has
  // to repaint the first and leave the second alone therefore needs telling —
  // and the first version of the canvas handler tested the resolved value for
  // null, matched nothing, and left every token stale until a reload.
  const live = (await gm.req('GET', P)).data.tokens;
  const inheritTok = live.find((x) => x.id === npcTok.id);
  const ownTok = live.find((x) => x.id === ownArt.id);
  t('an inheriting token is flagged as inheriting its picture',
    inheritTok.img_inherited === true, `${inheritTok.img_inherited}`);
  t('...and its framing', inheritTok.frame_inherited === true);
  t('a token with its own picture is flagged as NOT inheriting',
    ownTok.img_inherited === false, `${ownTok.img_inherited}`);
  t('...nor its framing', ownTok.frame_inherited === false);
  const unlinkedTok = live.find((x) => x.id === unlinked.id);
  t('an unlinked token inherits nothing, having nothing to inherit from',
    unlinkedTok.img_inherited === false && unlinkedTok.frame_inherited === false);

  // The two are independent: re-framing a token that inherits its picture must
  // stop the framing following while the picture keeps following.
  await gm.req('PATCH', `${P}/tokens/${npcTok.id}`, { img_scale: 2.5 });
  const mixed = (await gm.req('GET', P)).data.tokens.find((x) => x.id === npcTok.id);
  t('a token can inherit the picture and own its framing',
    mixed.img_inherited === true && mixed.frame_inherited === false,
    JSON.stringify([mixed.img_inherited, mixed.frame_inherited]));
  t('...keeping the framing it was given', mixed.img_scale === 2.5, `${mixed.img_scale}`);

  const inheritRow = await knex('tokens').where({ id: npcTok.id }).first();
  t('the inheriting token stores NULL for the picture, not a copy',
    inheritRow.img_url === null, `${inheritRow.img_url}`);

  console.log('\n--- placing a token FOR a character: inheritance by absence ---');
  // The server fills a field from the character only when the body OMITS it.
  // Sending an empty name or a default size silently overwrites the character's
  // own values with blanks, which is what the placement form used to do.
  await gm.req('PATCH', `${A}/${npc.id}`, {
    img_url: 'https://example.com/goblin.png', size: 'Large',
    img_offset_x: 0.2, img_scale: 1.5,
  });
  const inherited = (await gm.req('POST', `${P}/tokens`, { actor_id: npc.id, x: 8, y: 8 })).data.token;
  t('an omitted name inherits the character\'s', inherited.name === 'Goblin', inherited.name);
  t('an omitted picture is inherited in the payload',
    inherited.img_url === 'https://example.com/goblin.png', inherited.img_url);
  t('...along with the framing',
    inherited.img_scale === 1.5 && inherited.img_offset_x === 0.2,
    JSON.stringify([inherited.img_scale, inherited.img_offset_x]));
  t('...while the ROW itself stores NULL, which is what keeps it live',
    (await knex('tokens').where({ id: inherited.id }).first()).img_url === null);
  t('an omitted size inherits the creature footprint (Large = 2x2)',
    inherited.width === 2 && inherited.height === 2,
    JSON.stringify([inherited.width, inherited.height]));

  const explicit = (await gm.req('POST', `${P}/tokens`, {
    actor_id: npc.id, x: 9, y: 9, name: 'Scout', width: 1, height: 1,
  })).data.token;
  t('an explicit name overrides inheritance', explicit.name === 'Scout');
  t('an explicit size overrides inheritance', explicit.width === 1);
  t('...while the picture still inherits, because it was omitted',
    explicit.img_url === 'https://example.com/goblin.png');
  const blanked = (await gm.req('POST', `${P}/tokens`, {
    actor_id: npc.id, x: 10, y: 10, name: '',
  })).data.token;
  t('an EMPTY name is a value, not an absence — it does not inherit',
    !blanked.name, JSON.stringify(blanked.name));

  console.log('\n--- the same rule on PASTE (fixed M6) ---');
  // This route resolved the actor and inherited nothing from it, while single
  // placement inherited everything. Two doors onto "create a token from a
  // character", the rule fitted to one — unnoticed because nothing sent
  // actor_id here until the placement bar gained a character picker.
  const pasted = (await gm.req('POST', `${P}/tokens/copy`, {
    tokens: [
      { actor_id: npc.id, x: 12, y: 12 },
      { actor_id: npc.id, x: 14, y: 12, name: 'Named One' },
    ],
  })).data.tokens;
  t('a pasted spec inherits the character\'s name', pasted[0].name === 'Goblin', pasted[0].name);
  t('...its picture', pasted[0].img_url === 'https://example.com/goblin.png');
  t('...its framing', pasted[0].img_scale === 1.5, `${pasted[0].img_scale}`);
  t('...and stores the picture as NULL, so it stays live',
    (await knex('tokens').where({ id: pasted[0].id }).first()).img_url === null);
  t('...and its footprint', pasted[0].width === 2, `${pasted[0].width}`);
  t('an explicit name in a spec still wins', pasted[1].name === 'Named One');
  t('...and that spec still inherits the picture it omitted',
    pasted[1].img_url === 'https://example.com/goblin.png');

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
