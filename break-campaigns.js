// BREAK-IT suite: adversarial audit of the campaign layer.
// Targets research-backed classes: TOCTOU races (OWASP A08:2025), BOLA/IDOR
// (OWASP API #1), input/type confusion, and info leaks.
// Usage: SKIP_HIBP=1 node break-campaigns.js   (server must be running)
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const knex = require('./src/db');

let findings = [];
function vuln(name, detail) { findings.push({ sev: 'VULN', name, detail }); console.log(`  \x1b[31mVULN\x1b[0m  ${name} — ${detail}`); }
function ok(name, detail = '') { findings.push({ sev: 'OK', name, detail }); console.log(`  \x1b[32mOK\x1b[0m    ${name}${detail ? ' — ' + detail : ''}`); }
function info(name, detail = '') { console.log(`  ----  ${name}${detail ? ' — ' + detail : ''}`); }

function agent() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, path, body, extraHeaders = {}) {
      const headers = { Origin: BASE, ...extraHeaders };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
      const setC = res.headers.get('set-cookie');
      if (setC) cookie = setC.split(';')[0];
      let data = null; try { data = await res.json(); } catch { /**/ }
      return { status: res.status, data };
    },
  };
}
async function makeUser(name) {
  const a = agent();
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const password = 'correct-horse-battery-staple-9';
  await a.req('POST', '/api/auth/register', { email, username: `${name}${Math.random().toString(16).slice(2, 8)}`, password });
  await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  const l = await a.req('POST', '/api/auth/login', { email, password });
  a.id = l.data.user.id;
  return a;
}

(async () => {
  const gm = await makeUser('gm');
  const attacker = await makeUser('attacker');
  const victim = await makeUser('victim');

  // ============================================================
  // H1a — TOCTOU: per-user campaign cap overrun via parallel create
  // ============================================================
  info('H1a', 'firing 40 parallel creates against a 20-cap (TOCTOU race)');
  const raceUser = await makeUser('racer');
  const creates = Array.from({ length: 40 }, (_, i) =>
    raceUser.req('POST', '/api/campaigns', { name: `Race ${i}`, is_public: true }));
  const createRes = await Promise.all(creates);
  const created = createRes.filter((r) => r.status === 201).length;
  const liveCount = Number((await knex('campaigns').where({ owner_id: raceUser.id }).whereNull('deleted_at').count({ n: '*' }).first()).n);
  if (liveCount > 20) vuln('campaign cap TOCTOU', `cap is 20 but ${liveCount} rows exist (${created} creates returned 201) — read-count-then-insert race`);
  else ok('campaign cap holds under parallel load', `${liveCount} rows, ${created} succeeded`);

  // ============================================================
  // H1b — TOCTOU: per-campaign member cap overrun via parallel join
  // ============================================================
  info('H1b', 'firing 30 parallel joins against an 8-player cap (TOCTOU race)');
  const capGmRes = await gm.req('POST', '/api/campaigns', { name: 'CapRace', is_public: true });
  const capCampaign = capGmRes.data.campaign;
  const joiners = await Promise.all(Array.from({ length: 30 }, () => makeUser('j')));
  const joinRes = await Promise.all(joiners.map((j) => j.req('POST', `/api/campaigns/${capCampaign.id}/join`, {})));
  const joined200 = joinRes.filter((r) => r.status === 200).length;
  const activeCount = Number((await knex('campaign_members').where({ campaign_id: capCampaign.id, status: 'active' }).count({ n: '*' }).first()).n);
  // 8 includes the GM, so at most 8 active total.
  if (activeCount > 8) vuln('member cap TOCTOU', `cap is 8 but ${activeCount} active members (${joined200} joins returned 200) — read-count-then-insert race`);
  else ok('member cap holds under parallel load', `${activeCount} active, ${joined200} joins succeeded`);

  // ============================================================
  // H2 — BOLA/IDOR: horizontal access to another user's campaign
  // ============================================================
  const vCampRes = await victim.req('POST', '/api/campaigns', { name: 'Victim Private', is_public: false, password: 'sekret123' });
  const vCamp = vCampRes.data.campaign;

  let r = await attacker.req('GET', `/api/campaigns/${vCamp.id}`);
  if (r.status === 200) vuln('BOLA: read detail', `attacker read a private campaign they are not a member of`);
  else ok('BOLA read blocked', `GET detail as non-member -> ${r.status}`);

  r = await attacker.req('PATCH', `/api/campaigns/${vCamp.id}`, { name: 'Pwned' });
  const afterPatch = await knex('campaigns').where({ id: vCamp.id }).first();
  if (afterPatch.name === 'Pwned') vuln('BOLA: edit', 'attacker renamed a campaign they do not own');
  else ok('BOLA edit blocked', `PATCH as non-owner -> ${r.status}`);

  r = await attacker.req('DELETE', `/api/campaigns/${vCamp.id}`);
  const afterDel = await knex('campaigns').where({ id: vCamp.id }).first();
  if (afterDel.deleted_at !== null) vuln('BOLA: delete', 'attacker soft-deleted a campaign they do not own');
  else ok('BOLA delete blocked', `DELETE as non-owner -> ${r.status}`);

  r = await attacker.req('POST', `/api/campaigns/${vCamp.id}/transfer`, { user_id: attacker.id });
  const afterXfer = await knex('campaigns').where({ id: vCamp.id }).first();
  if (afterXfer.owner_id === attacker.id) vuln('BOLA: steal ownership', 'attacker transferred ownership to themselves');
  else ok('BOLA transfer blocked', `transfer as non-owner -> ${r.status}`);

  // ============================================================
  // H2b — BFLA: moderation actions by a non-owner member
  // ============================================================
  await attacker.req('POST', `/api/campaigns/${vCamp.id}/join`, { password: 'sekret123' }); // now an active member
  r = await attacker.req('POST', `/api/campaigns/${vCamp.id}/members/${victim.id}/ban`);
  const victimRow = await knex('campaign_members').where({ campaign_id: vCamp.id, user_id: victim.id }).first();
  if (victimRow && victimRow.status === 'banned') vuln('BFLA: member bans owner', 'a plain member banned the owner');
  else ok('BFLA moderation blocked', `member ban attempt -> ${r.status}`);

  // ============================================================
  // H2c — can a member escalate by transferring? (they are not owner)
  // ============================================================
  r = await attacker.req('POST', `/api/campaigns/${vCamp.id}/transfer`, { user_id: attacker.id });
  const afterXfer2 = await knex('campaigns').where({ id: vCamp.id }).first();
  if (afterXfer2.owner_id === attacker.id) vuln('privilege escalation', 'active member transferred ownership to self');
  else ok('member cannot transfer', `-> ${r.status}`);

  // ============================================================
  // H3 — is_public type confusion
  // ============================================================
  // is_public omitted/garbage should default to PRIVATE and thus require a password.
  r = await gm.req('POST', '/api/campaigns', { name: 'TypeConfuse', is_public: 1 });
  if (r.status === 201 && r.data.campaign.is_public === true) vuln('type confusion is_public=1', 'numeric 1 treated as public');
  else if (r.status === 201 && r.data.campaign.is_public === false && !r.data.campaign.has_password) vuln('private without password', 'is_public=1 fell through to private with NO password → unjoinable/ghost');
  else ok('is_public=1 handled', `status ${r.status}, is_public=${r.data.campaign && r.data.campaign.is_public}`);

  r = await gm.req('POST', '/api/campaigns', { name: 'TypeConfuse2', is_public: ['true'] });
  if (r.status === 201 && r.data.campaign.is_public === true) vuln('type confusion is_public=[array]', 'array coerced to public');
  else ok('is_public=[array] handled', `status ${r.status}`);

  // ============================================================
  // H4 — mass assignment via settings / owner_id on create + patch
  // ============================================================
  r = await gm.req('POST', '/api/campaigns', {
    name: 'MassAssign', is_public: true,
    settings: { isAdmin: true }, created_at: '1999-01-01', updated_at: '1999-01-01',
  });
  const maRow = await knex('campaigns').where({ id: r.data.campaign.id }).first();
  // settings IS a legit column, so injecting it is allowed by design — but created_at should not be overridable.
  if (new Date(maRow.created_at).getFullYear() === 1999) vuln('mass assignment: created_at', 'client set created_at');
  else ok('created_at not client-settable', `stored ${new Date(maRow.created_at).getFullYear()}`);
  info('settings note', `settings is a real column; client-supplied settings=${JSON.stringify(maRow.settings)} is by-design, confirm that is intended`);

  // patch injecting owner_id / password_hash directly
  const ownCamp = (await gm.req('POST', '/api/campaigns', { name: 'PatchTarget', is_public: true })).data.campaign;
  r = await gm.req('PATCH', `/api/campaigns/${ownCamp.id}`, { owner_id: attacker.id, password_hash: 'injected', deleted_at: '2000-01-01' });
  const patched = await knex('campaigns').where({ id: ownCamp.id }).first();
  if (patched.owner_id === attacker.id) vuln('mass assignment PATCH owner_id', 'owner_id overwritten via patch body');
  else if (patched.password_hash === 'injected') vuln('mass assignment PATCH password_hash', 'raw hash injected via patch body');
  else if (patched.deleted_at !== null) vuln('mass assignment PATCH deleted_at', 'deleted_at injected via patch body');
  else ok('PATCH ignores non-allowlisted fields', 'owner_id/password_hash/deleted_at all unchanged');

  // ============================================================
  // H5 — search: does it leak private-campaign existence / soft-deleted rows / injection
  // ============================================================
  r = await attacker.req('GET', `/api/campaigns/search?q=Victim+Private`);
  const foundPrivate = r.data.campaigns.find((c) => c.id === vCamp.id);
  if (foundPrivate && ('password_hash' in foundPrivate)) vuln('search leaks password_hash', JSON.stringify(foundPrivate));
  else info('search lists private campaigns by design', foundPrivate ? 'private campaign appears in search (listed, password-gated) — intended per spec' : 'not found');

  // ILIKE injection: underscore is a single-char wildcard if unescaped
  const uniqueName = `Zx_${Date.now()}`;
  await gm.req('POST', '/api/campaigns', { name: uniqueName.replace('_', 'Q'), is_public: true }); // ZxQ...
  r = await gm.req('GET', `/api/campaigns/search?q=${encodeURIComponent(uniqueName)}`); // Zx_... underscore
  if (r.data.campaigns.some((c) => c.name && c.name.startsWith('ZxQ'))) vuln('LIKE wildcard injection', 'unescaped _ matched an arbitrary char');
  else ok('LIKE metacharacters escaped', 'underscore treated literally');

  // ============================================================
  // H6 — join password: is the pre-hash length guard real? timing on banned
  // ============================================================
  // Oversized password must be rejected BEFORE argon2 (cheap), not hashed.
  // Use a FRESH non-member (attacker is already a member by now → would 200).
  const h6user = await makeUser('h6');
  const big = 'x'.repeat(200);
  const t0 = Date.now();
  r = await h6user.req('POST', `/api/campaigns/${vCamp.id}/join`, { password: big });
  const oversizeMs = Date.now() - t0;
  if (r.status === 401 && oversizeMs < 100) ok('oversized join password rejected pre-hash', `${oversizeMs}ms`);
  else if (oversizeMs >= 100) vuln('hashing-exhaustion via join', `oversized password took ${oversizeMs}ms — likely hashed`);
  else info('oversized join', `status ${r.status}, ${oversizeMs}ms`);

  // ============================================================
  // H7 — archive endpoint IDOR: archive someone else's view?
  // ============================================================
  // attacker archives — can they pass a target? (endpoint has no target param, but confirm it only hits caller's row)
  await attacker.req('POST', `/api/campaigns/${vCamp.id}/archive`);
  const victimMember = await knex('campaign_members').where({ campaign_id: vCamp.id, user_id: victim.id }).first();
  if (victimMember && victimMember.archived_at !== null) vuln('archive affects other users', "attacker's archive set victim's archived_at");
  else ok('archive is caller-scoped', "attacker archive left victim's row untouched");

  // ============================================================
  // H8 — malformed/oversized body & content-type confusion
  // ============================================================
  r = await gm.req('POST', '/api/campaigns', '{"name":', { 'Content-Type': 'application/json' });
  if (r.status >= 500) vuln('malformed JSON -> 5xx', `broken JSON crashed with ${r.status}`);
  else ok('malformed JSON handled', `-> ${r.status}`);

  r = await gm.req('POST', '/api/campaigns', { name: 'x'.repeat(5000), is_public: true });
  if (r.status === 201) vuln('name length not enforced', '5000-char name accepted');
  else ok('over-long name rejected', `-> ${r.status}`);

  // ============================================================
  // H9 — leave-then-transfer orphan; owner self-ban lock
  // ============================================================
  // Can the owner get themselves banned to orphan the campaign?
  const orphanCamp = (await gm.req('POST', '/api/campaigns', { name: 'Orphan', is_public: true })).data.campaign;
  r = await gm.req('POST', `/api/campaigns/${orphanCamp.id}/members/${gm.id}/ban`);
  if (r.status === 200) vuln('owner self-ban', 'owner banned themselves → orphaned campaign');
  else ok('owner cannot self-ban', `-> ${r.status}`);

  console.log(`\n${'='.repeat(60)}`);
  const vulns = findings.filter((f) => f.sev === 'VULN');
  console.log(`${findings.filter((f) => f.sev === 'OK').length} defended, ${vulns.length} VULNERABILITIES`);
  if (vulns.length) { console.log('\nFINDINGS:'); vulns.forEach((v) => console.log(`  • ${v.name}: ${v.detail}`)); }
  await knex.destroy();
  process.exit(0);
})().catch(async (e) => { console.error('SUITE ERROR:', e); await knex.destroy(); process.exit(1); });
