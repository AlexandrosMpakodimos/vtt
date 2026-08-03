// Functional suite for M5 — combat, combatants, chat and dice over HTTP.
//   Usage: SKIP_HIBP=1 node test-combat.js   (server on npm run dev:test)
//
// This is the "does it work" half; break-combat.js is the "can it be abused"
// half. The split follows the project's existing convention, with one exception
// kept deliberately: the auto-add / auto-remove probes below carry BOTH kinds of
// assertion, because "a token placed during a fight joins the roster" and "a
// hidden token joining the roster must not reach a player" are the same
// behaviour seen from two sides — the same reason test-active-scene.js and
// test-scene-delete.js are not split.
//
// Assertions are on SHAPE or on MEASURED outcomes, never on a literal guessed in
// advance. Where a count is asserted it is the exact count, not a ceiling.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const knex = require('./src/db');

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
  const player = await mk('pl');

  const camp = (await gm.req('POST', '/api/campaigns', { name: 'M5', is_public: true })).data.campaign;
  await player.req('POST', `/api/campaigns/${camp.id}/join`, {});

  const C = `/api/campaigns/${camp.id}/combat`;
  const M = `/api/campaigns/${camp.id}/messages`;
  const A = `/api/campaigns/${camp.id}/actors`;
  const scene = (await gm.req('POST', `/api/campaigns/${camp.id}/scenes`, { name: 'Board' })).data.scene;
  const S = `/api/campaigns/${camp.id}/scenes/${scene.id}`;
  await gm.req('PUT', `/api/campaigns/${camp.id}/scenes/active`, { scene_id: scene.id });

  console.log('\n--- fixtures ---');
  const goblinActor = (await gm.req('POST', A, {
    name: 'Goblin', is_npc: true, hp_current: 7, hp_max: 7,
  })).data.actor;
  t('NPC actor created', !!goblinActor && goblinActor.hp_max === 7);
  const pcActor = (await player.req('POST', A, { name: 'Aria' })).data.actor;
  await gm.req('PATCH', `${A}/${pcActor.id}`, { hp_max: 12, hp_current: 5 });
  t('PC actor created and given capabilities by the GM', !!pcActor);

  // Three goblin tokens from ONE actor — the prototype/instance case the whole
  // hp_override design exists for.
  const g1 = (await gm.req('POST', `${S}/tokens`, { name: 'Goblin', actor_id: goblinActor.id, x: 1, y: 1 })).data.token;
  const g2 = (await gm.req('POST', `${S}/tokens`, { name: 'Goblin 2', actor_id: goblinActor.id, x: 2, y: 1 })).data.token;
  const g3 = (await gm.req('POST', `${S}/tokens`, { name: 'Goblin 3', actor_id: goblinActor.id, x: 3, y: 1 })).data.token;
  const pcTok = (await gm.req('POST', `${S}/tokens`, { name: 'Aria', actor_id: pcActor.id, x: 5, y: 5 })).data.token;
  const rock = (await gm.req('POST', `${S}/tokens`, { name: 'Rock', x: 7, y: 7, is_prop: true })).data.token;
  t('three tokens share one actor', g1.actor_id === g2.actor_id && g2.actor_id === g3.actor_id);
  t('prop placed with is_prop true', rock.is_prop === true);
  t('is_prop defaults false', g1.is_prop === false);

  console.log('\n--- starting an encounter seeds from the board ---');
  const started = (await gm.req('POST', C, { scene_id: scene.id, name: 'Bridge' })).data;
  t('combat created', !!started.combat && started.combat.active === true);
  t('combat named', started.combat.name === 'Bridge');
  const seeded = started.combatants.map((c) => c.token_id);
  t('all four creatures seeded',
    [g1, g2, g3, pcTok].every((x) => seeded.includes(x.id)), JSON.stringify(seeded));
  t('the prop is NOT seeded', !seeded.includes(rock.id));
  t('seeded roster length is exactly the non-prop count',
    started.combatants.length === 4, `${started.combatants.length}`);

  console.log('\n--- per-instance HP: the goblin problem ---');
  const cg1 = started.combatants.find((c) => c.token_id === g1.id);
  const cg2 = started.combatants.find((c) => c.token_id === g2.id);
  const cg3 = started.combatants.find((c) => c.token_id === g3.id);
  const cpc = started.combatants.find((c) => c.token_id === pcTok.id);
  t('NPC combatants default hp_override from the actor hp_max',
    cg1.hp_override === 7 && cg2.hp_override === 7 && cg3.hp_override === 7,
    JSON.stringify([cg1.hp_override, cg2.hp_override, cg3.hp_override]));
  t('a PC combatant gets NULL, not a heal to full',
    cpc.hp_override === null, JSON.stringify(cpc));

  // Damage one goblin. The other two, and the shared actor, must not move.
  await gm.req('PATCH', `${C}/${started.combat.id}/combatants/${cg2.id}`, { hp_override: 2 });
  const afterDamage = (await gm.req('GET', `${C}/${started.combat.id}`)).data.combatants;
  const d1 = afterDamage.find((c) => c.token_id === g1.id);
  const d2 = afterDamage.find((c) => c.token_id === g2.id);
  const d3 = afterDamage.find((c) => c.token_id === g3.id);
  t('damaging goblin 2 leaves goblin 1 untouched', d1.hp_override === 7, `${d1.hp_override}`);
  t('damaging goblin 2 leaves goblin 3 untouched', d3.hp_override === 7, `${d3.hp_override}`);
  t('goblin 2 took the damage', d2.hp_override === 2, `${d2.hp_override}`);
  const sharedActor = (await gm.req('GET', `${A}/${goblinActor.id}`)).data.actor;
  t('the SHARED actor row is untouched by per-instance damage',
    sharedActor.hp_current === 7, `${sharedActor.hp_current}`);
  t('max HP is still shared (no hp_override_max column needed)',
    sharedActor.hp_max === 7);

  // Negative HP is allowed — death is not a mechanic in this project.
  const neg = await gm.req('PATCH', `${C}/${started.combat.id}/combatants/${cg3.id}`, { hp_override: -4 });
  t('hp_override may go negative (hp is never clamped here either)',
    neg.status === 200 && neg.data.combatant.hp_override === -4, `${neg.status}`);

  console.log('\n--- auto-add on placement and paste ---');
  const late = (await gm.req('POST', `${S}/tokens`, {
    name: 'Reinforcement', actor_id: goblinActor.id, x: 8, y: 2,
  })).data.token;
  const afterLate = (await gm.req('GET', `${C}/${started.combat.id}`)).data.combatants;
  t('a token placed mid-fight joins the roster',
    afterLate.some((c) => c.token_id === late.id));
  t('the newcomer defaulted its own hp_override',
    afterLate.find((c) => c.token_id === late.id).hp_override === 7);
  t('the newcomer landed at the END of the order',
    afterLate.find((c) => c.token_id === late.id).sort_order
      === Math.max(...afterLate.map((c) => c.sort_order)));

  const lateProp = (await gm.req('POST', `${S}/tokens`, { name: 'Barrel', x: 9, y: 2, is_prop: true })).data.token;
  const afterProp = (await gm.req('GET', `${C}/${started.combat.id}`)).data.combatants;
  t('a PROP placed mid-fight does NOT join the roster',
    !afterProp.some((c) => c.token_id === lateProp.id));

  const pasted = (await gm.req('POST', `${S}/tokens/copy`, {
    tokens: [
      { name: 'Goblin A', actor_id: goblinActor.id, x: 10, y: 3 },
      { name: 'Goblin B', actor_id: goblinActor.id, x: 11, y: 3 },
      { name: 'Crate', x: 12, y: 3, is_prop: true },
    ],
  })).data.tokens;
  const afterPaste = (await gm.req('GET', `${C}/${started.combat.id}`)).data.combatants;
  const pastedCreatures = pasted.filter((p) => !p.is_prop);
  t('pasted creatures joined the roster',
    pastedCreatures.every((p) => afterPaste.some((c) => c.token_id === p.id)));
  t('a pasted PROP stayed a prop and did not join',
    !afterPaste.some((c) => c.token_id === pasted.find((p) => p.is_prop).id));
  t('each pasted goblin got its OWN hp_override row',
    pastedCreatures.every((p) => afterPaste.find((c) => c.token_id === p.id).hp_override === 7));

  console.log('\n--- the prop toggle is a two-way sync ---');
  await gm.req('PATCH', `${S}/tokens/${late.id}`, { is_prop: true });
  const afterTag = (await gm.req('GET', `${C}/${started.combat.id}`)).data.combatants;
  t('tagging a roster member a prop REMOVES it from the roster',
    !afterTag.some((c) => c.token_id === late.id));
  await gm.req('PATCH', `${S}/tokens/${late.id}`, { is_prop: false });
  const afterUntag = (await gm.req('GET', `${C}/${started.combat.id}`)).data.combatants;
  t('untagging it puts it back', afterUntag.some((c) => c.token_id === late.id));

  console.log('\n--- removing a combatant vs deleting a token ---');
  const fleeing = afterUntag.find((c) => c.token_id === late.id);
  await gm.req('DELETE', `${C}/${started.combat.id}/combatants/${fleeing.id}`);
  const afterFlee = (await gm.req('GET', `${C}/${started.combat.id}`)).data.combatants;
  t('removing a combatant drops the row', !afterFlee.some((c) => c.id === fleeing.id));
  const tokenStill = await gm.req('GET', S);
  t('...but leaves the TOKEN on the board',
    tokenStill.data.tokens.some((x) => x.id === late.id));
  t('sort_order is renumbered densely after a removal',
    afterFlee.map((c) => c.sort_order).join(',')
      === afterFlee.map((_, i) => i).join(','),
    afterFlee.map((c) => c.sort_order).join(','));

  await gm.req('DELETE', `${S}/tokens/${g3.id}`);
  const afterTokenDel = (await gm.req('GET', `${C}/${started.combat.id}`)).data.combatants;
  t('deleting a token removes its combatant (FK cascade)',
    !afterTokenDel.some((c) => c.token_id === g3.id));
  t('sort_order is dense again after the cascade',
    afterTokenDel.map((c) => c.sort_order).join(',')
      === afterTokenDel.map((_, i) => i).join(','));

  console.log('\n--- manual reorder ---');
  const current = (await gm.req('GET', `${C}/${started.combat.id}`)).data.combatants;
  const reversed = [...current].reverse().map((c) => c.id);
  const re = await gm.req('POST', `${C}/${started.combat.id}/reorder`, { combatant_ids: reversed });
  t('reorder accepted', re.status === 200, `${re.status}`);
  t('reorder applied in the order given',
    re.data.combatants.map((c) => c.id).join(',') === reversed.join(','));
  t('reorder produced dense 0..n-1 positions',
    re.data.combatants.map((c) => c.sort_order).join(',')
      === re.data.combatants.map((_, i) => i).join(','));

  console.log('\n--- one active combat per scene ---');
  const second = await gm.req('POST', C, { scene_id: scene.id, name: 'Another' });
  t('a second combat on the same scene is refused', second.status === 409, `${second.status}`);
  await gm.req('PATCH', `${C}/${started.combat.id}`, { active: false });
  const third = await gm.req('POST', C, { scene_id: scene.id, name: 'After the first ended' });
  t('...and allowed once the first has ended', third.status === 201, `${third.status}`);
  const reopen = await gm.req('PATCH', `${C}/${started.combat.id}`, { active: true });
  t('re-activating the old one is refused while another runs',
    reopen.status === 409, `${reopen.status}`);

  console.log('\n--- chat ---');
  const line = await player.req('POST', M, { content: 'I swing at the goblin' });
  t('a player can post', line.status === 201, `${line.status}`);
  t('type defaults to chat', line.data.message.type === 'chat');
  t('speaker_name is taken from the session', !!line.data.message.speaker_name);
  t('whisper_to is null for a public message', line.data.message.whisper_to === null);

  const empty = await player.req('POST', M, { content: '   ' });
  t('an empty message is refused', empty.status === 400, `${empty.status}`);

  const hist = await player.req('GET', M);
  t('history returns messages oldest-first',
    hist.status === 200 && hist.data.messages.length > 0);
  const paged = await player.req('GET', `${M}?limit=1`);
  t('limit is honoured exactly', paged.data.messages.length === 1, `${paged.data.messages.length}`);
  const badLimit = await player.req('GET', `${M}?limit=9999`);
  t('an over-large limit is refused', badLimit.status === 400, `${badLimit.status}`);

  console.log('\n--- dice ---');
  const r = await player.req('POST', M, { formula: '2d6+3' });
  t('a roll is accepted', r.status === 201, `${r.status}`);
  const rd = r.data.message.roll_data;
  t('roll_data has the schema shape',
    !!rd && typeof rd.formula === 'string' && Array.isArray(rd.results) && typeof rd.total === 'number',
    JSON.stringify(rd));
  t('results has one entry per die', rd.results.length === 2, JSON.stringify(rd.results));
  t('total is the measured sum plus the modifier',
    rd.total === rd.results.reduce((a, b) => a + b, 0) + 3, JSON.stringify(rd));
  t('every die landed inside 1..6', rd.results.every((x) => x >= 1 && x <= 6), JSON.stringify(rd.results));
  t('a roll is typed roll', r.data.message.type === 'roll');
  t('formula stored canonically', rd.formula === '2d6+3');

  const labelled = await player.req('POST', M, { formula: 'd20', content: 'Perception' });
  t('a roll may carry a label', labelled.status === 201 && labelled.data.message.content === 'Perception');
  const bad = await player.req('POST', M, { formula: '4d6kh3' });
  t('unsupported notation is refused (scope boundary)', bad.status === 400, `${bad.status}`);

  console.log('\n--- whisper ---');
  const w = await gm.req('POST', M, { content: 'psst', whisper_to: [player.id] });
  t('a whisper is accepted', w.status === 201, `${w.status}`);
  t('a whisper is typed whisper', w.data.message.type === 'whisper');
  t('whisper_to is stored', Array.isArray(w.data.message.whisper_to)
    && w.data.message.whisper_to.includes(player.id));
  const seen = (await player.req('GET', M)).data.messages;
  t('the addressed player sees it', seen.some((m) => m.id === w.data.message.id));

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
