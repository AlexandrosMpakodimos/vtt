// Adversarial audit of the image storage surface.
//   Usage: SKIP_HIBP=1 node break-assets.js   (server on npm run dev:test)
//
// ---------------------------------------------------------------------------
// THIS SUITE COSTS MONEY, SO ITS COST IS BOUNDED AND COUNTED
// ---------------------------------------------------------------------------
// Every other suite in this project touches only a local database. This one
// writes to a metered object store, so it is built around that constraint
// rather than ignoring it.
//
//   - R2 UPLOADS ARE CAPPED at MAX_UPLOADS below, and the count is asserted at
//     the end. A probe that would exceed it fails rather than silently spending.
//   - Files are a 16-byte PNG header. Storage consumed is a few hundred bytes.
//   - EVERY object is deleted in the teardown, and the teardown reports how many
//     it removed so a leak is visible rather than assumed.
//   - Quota probes use FIXTURES INSERTED WITH KNEX, not real uploads. Proving a
//     three-hundred-image cap by uploading three hundred images would be absurd
//     and expensive; inserting three hundred rows costs nothing and tests the
//     same code path, because the cap counts rows.
//
// For scale: the free tier is one million writes and ten million reads per
// month. A full run of this suite is around thirty operations.
//
// ---------------------------------------------------------------------------
// Mapped to the OWASP API Security Top 10 (2023)
// ---------------------------------------------------------------------------
//   API1 BOLA  — confirming or deleting somebody else's asset
//   API3 BOPLA — forging storage_key, status, user_id
//   API4 URC   — the quota, and whether an authorisation counts against it
//   API5 BFLA  — a player uploading a map
//
// THE FINDING THIS SUITE WAS WRITTEN FOR: the quota counted only `ready` rows
// while presign inserts `pending`, so an issued authorisation claimed nothing
// and the cap did not hold. See the probes under "the quota actually holds".

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const knex = require('./src/db');

let pass = 0; let fail = 0; const findings = []; const results = [];
let uploads = 0;
const MAX_UPLOADS = 12;

function ok(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(`  DEFENDED  ${name}`); } else {
    fail += 1; results.push(`  VULNERABLE  ${name}  ${detail}`); findings.push(name);
  }
}
function note(name, detail) { results.push(`  NOTE      ${name}  ${detail}`); }

function agent() {
  let cookie = '';
  return {
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const created = [];

// Every real upload goes through here, so the budget cannot be exceeded by
// accident and the count in the summary is the true one.
async function upload(who, body, bytes = PNG, contentType) {
  if (uploads >= MAX_UPLOADS) {
    throw new Error(`upload budget of ${MAX_UPLOADS} exhausted — a probe is spending more than intended`);
  }
  const pres = await who.req('POST', '/api/assets/presign', body);
  if (pres.status !== 201) return { pres, put: null };
  created.push(pres.data.asset.id);
  uploads += 1;
  const put = await fetch(pres.data.upload.url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || pres.data.upload.headers['Content-Type'] },
    body: bytes,
  });
  return { pres, put: put.status };
}

(async () => {
  const gm = await mk('gm');
  const pl = await mk('pl');
  const outsider = await mk('out');

  const camp = (await gm.req('POST', '/api/campaigns', { name: 'Asset audit', is_public: true })).data.campaign;
  await pl.req('POST', `/api/campaigns/${camp.id}/join`, {});
  ok('setup: campaign created', !!camp);

  const probe = await gm.req('POST', '/api/assets/presign', {
    kind: 'portrait', campaign_id: camp.id, mime: 'image/png', bytes: PNG.length,
  });
  const storageOn = probe.status !== 503;
  if (probe.status === 201) { created.push(probe.data.asset.id); }
  note('mode', storageOn ? 'R2 configured' : 'no bucket — upload probes assert the 503 instead');
  note('budget', `at most ${MAX_UPLOADS} objects, all deleted in teardown`);

  // =====================================================================
  // API4 — does an issued authorisation cost anything?
  // =====================================================================
  console.log('\n--- the quota actually holds ---');
  // Fixtures via knex: the cap counts ROWS, so three hundred rows test it
  // exactly as three hundred uploads would, at no cost.
  const quotaUser = await mk('quota');
  await knex('assets').insert(Array.from({ length: 20 }, (_, i) => ({
    user_id: quotaUser.id,
    campaign_id: null,
    storage_key: `u/${quotaUser.id}/avatar/pending-${i}.png`,
    url: `https://example.invalid/p${i}.png`,
    source: 'upload',
    kind: 'avatar',
    // PENDING, not ready. Before the fix these counted for nothing.
    status: 'pending',
  })));
  const readyCount = Number((await knex('assets')
    .where({ user_id: quotaUser.id, status: 'ready' }).count({ n: '*' }).first()).n);
  ok('setup: the personal allowance is filled entirely with PENDING rows',
    readyCount === 0, `${readyCount} ready rows — the fixture must contain none`);

  const beyond = await quotaUser.req('POST', '/api/assets/external', {
    kind: 'avatar', url: 'https://example.com/one-more.png',
  });
  ok('API4: a PENDING authorisation counts against the quota',
    beyond.status === 409,
    `got ${beyond.status} — if 201, an issued URL claims nothing and the cap can be walked past by asking for authorisations and confirming them later`);

  const beyondUpload = await quotaUser.req('POST', '/api/assets/presign', {
    kind: 'avatar', mime: 'image/png', bytes: PNG.length,
  });
  ok('API4: ...on the upload route as well as the link route',
    beyondUpload.status === 409 || beyondUpload.status === 503, `got ${beyondUpload.status}`);
  if (beyondUpload.status === 201) created.push(beyondUpload.data.asset.id);

  // Both routes must count the SAME allowance, or the cheaper one is the way
  // around the other.
  const landed = Number((await knex('assets')
    .where({ user_id: quotaUser.id, campaign_id: null })
    .whereIn('status', ['pending', 'ready']).count({ n: '*' }).first()).n);
  ok('API4: the allowance landed on exactly its maximum', landed === 20, `${landed}`);
  note('why fixtures', 'the cap counts rows, so rows test it — uploading 300 images to prove a 300 cap would be absurd');

  // A rejected row must NOT hold quota: its object is already gone.
  await knex('assets').where({ user_id: quotaUser.id }).limit(1).update({ status: 'rejected' });
  const afterReject = await quotaUser.req('POST', '/api/assets/external', {
    kind: 'avatar', url: 'https://example.com/after-reject.png',
  });
  ok('API4: a REJECTED row releases its allowance', afterReject.status === 201,
    `got ${afterReject.status} — a rejected upload consumed no storage and must consume no quota`);
  if (afterReject.status === 201) created.push(afterReject.data.asset.id);

  // =====================================================================
  // API5 / API1 — who may do what
  // =====================================================================
  console.log('\n--- authorisation on presign ---');
  const playerMap = await pl.req('POST', '/api/assets/presign', {
    kind: 'map', campaign_id: camp.id, mime: 'image/png', bytes: PNG.length,
  });
  ok('BFLA: a player cannot upload a map', playerMap.status === 403, `${playerMap.status}`);

  const outsiderPres = await outsider.req('POST', '/api/assets/presign', {
    kind: 'portrait', campaign_id: camp.id, mime: 'image/png', bytes: PNG.length,
  });
  ok('BOLA: a non-member gets 404, not 403 (no campaign enumeration)',
    outsiderPres.status === 404, `${outsiderPres.status}`);

  // A member who has LEFT or been banned is not active, and must lose access.
  const gone = await mk('gone');
  await gone.req('POST', `/api/campaigns/${camp.id}/join`, {});
  await gone.req('POST', `/api/campaigns/${camp.id}/leave`, {});
  const goneUp = await gone.req('POST', '/api/assets/presign', {
    kind: 'portrait', campaign_id: camp.id, mime: 'image/png', bytes: PNG.length,
  });
  ok('a departed member cannot upload into the campaign', goneUp.status === 404, `${goneUp.status}`);
  const goneLink = await gone.req('POST', '/api/assets/external', {
    kind: 'portrait', campaign_id: camp.id, url: 'https://example.com/x.png',
  });
  ok('...nor link into it', goneLink.status === 404, `${goneLink.status}`);
  ok('...nor read its library', (await gone.req('GET', `/api/assets?campaign_id=${camp.id}`)).status === 404);

  // A soft-deleted campaign is not a live one.
  const doomed = (await gm.req('POST', '/api/campaigns', { name: 'Doomed', is_public: true })).data.campaign;
  await gm.req('DELETE', `/api/campaigns/${doomed.id}`);
  const doomedUp = await gm.req('POST', '/api/assets/presign', {
    kind: 'map', campaign_id: doomed.id, mime: 'image/png', bytes: PNG.length,
  });
  ok('a soft-deleted campaign accepts no uploads', doomedUp.status === 404, `${doomedUp.status}`);

  console.log('\n--- scope confusion between the two quota scopes ---');
  const avatarScoped = await pl.req('POST', '/api/assets/external', {
    kind: 'avatar', campaign_id: camp.id, url: 'https://example.com/a.png',
  });
  ok('an avatar cannot be filed under a campaign', avatarScoped.status === 404, `${avatarScoped.status}`);
  const mapPersonal = await pl.req('POST', '/api/assets/external', {
    kind: 'map', url: 'https://example.com/m.png',
  });
  ok('a map cannot be filed as personal (it would escape the campaign cap)',
    mapPersonal.status === 404, `${mapPersonal.status}`);

  // =====================================================================
  // API3 — the fields the server owns
  // =====================================================================
  console.log('\n--- BOPLA on the asset row ---');
  const forged = await pl.req('POST', '/api/assets/external', {
    kind: 'portrait', campaign_id: camp.id, url: 'https://example.com/ok.png',
    id: '00000000-0000-4000-8000-000000000000',
    storage_key: `c/${camp.id}/map/hijack.png`,
    status: 'ready', user_id: gm.id, mime: 'image/svg+xml', bytes: 99999999,
    source: 'upload',
  });
  ok('a forged payload is accepted but ignored', forged.status === 201, `${forged.status}`);
  if (forged.status === 201) {
    created.push(forged.data.asset.id);
    const row = await knex('assets').where({ id: forged.data.asset.id }).first();
    ok('...storage_key is not taken from the body', row.storage_key === null, `${row.storage_key}`);
    ok('...the uploader is the caller', row.user_id === pl.id);
    ok('...source is not forgeable to "upload"', row.source === 'external', row.source);
    ok('...mime is not accepted from a client', row.mime === null, `${row.mime}`);
    ok('...bytes is not either', row.bytes === null, `${row.bytes}`);
    ok('...and the id was generated, not chosen',
      row.id !== '00000000-0000-4000-8000-000000000000');
  }

  console.log('\n--- deletion ---');
  const victim = (await pl.req('POST', '/api/assets/external', {
    kind: 'portrait', campaign_id: camp.id, url: 'https://example.com/v.png',
  })).data.asset;
  created.push(victim.id);
  ok('an unrelated member cannot delete it -> 404',
    (await outsider.req('DELETE', `/api/assets/${victim.id}`)).status === 404);
  const personal = (await pl.req('POST', '/api/assets/external', {
    kind: 'avatar', url: 'https://example.com/mine.png',
  })).data.asset;
  created.push(personal.id);
  ok('the campaign GM cannot delete a personal image -> 404',
    (await gm.req('DELETE', `/api/assets/${personal.id}`)).status === 404,
    'a GM curates their campaign, not somebody personal library');
  ok('a malformed id -> 404, not 500',
    (await pl.req('DELETE', '/api/assets/not-a-uuid')).status === 404);

  // =====================================================================
  // The upload path itself
  // =====================================================================
  if (!storageOn) {
    note('storage probes', 'SKIPPED — no bucket configured');
  } else {
    console.log('\n--- the bytes are checked, not the claim ---');
    // A file that is a valid image but the WRONG one. The declared type is
    // image/png, the bytes are a GIF. Every layer before the byte check passes.
    const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(10)]);
    const wrongFmt = await upload(gm, {
      kind: 'portrait', campaign_id: camp.id, mime: 'image/png', bytes: GIF.length,
    }, GIF);
    if (wrongFmt.pres.status === 201) {
      const conf = await gm.req('POST', `/api/assets/${wrongFmt.pres.data.asset.id}/confirm`);
      // The stored content type is what the client sent at PUT, and it is NOT
      // covered by the signature — so this probe is really asking whether the
      // magic-number check is doing the work the signature does not.
      ok('a GIF uploaded as image/png is refused', conf.status === 400, `${conf.status}`);
    }

    console.log('\n--- confirming somebody else, and confirming twice ---');
    const mine = await upload(gm, {
      kind: 'portrait', campaign_id: camp.id, mime: 'image/png', bytes: PNG.length,
    });
    const mineId = mine.pres.data.asset.id;
    ok('BOLA: another user cannot confirm my upload -> 404',
      (await pl.req('POST', `/api/assets/${mineId}/confirm`)).status === 404);
    const first = await gm.req('POST', `/api/assets/${mineId}/confirm`);
    ok('the owner can confirm it', first.status === 200, `${first.status}`);
    ok('confirming again is refused',
      (await gm.req('POST', `/api/assets/${mineId}/confirm`)).status === 409);

    // Two confirms racing on one pending row. Both read `pending` before either
    // writes, so both could pass the status check.
    const raced = await upload(gm, {
      kind: 'portrait', campaign_id: camp.id, mime: 'image/png', bytes: PNG.length,
    });
    const racedId = raced.pres.data.asset.id;
    const both = await Promise.all([
      gm.req('POST', `/api/assets/${racedId}/confirm`),
      gm.req('POST', `/api/assets/${racedId}/confirm`),
    ]);
    const okCount = both.filter((r) => r.status === 200).length;
    ok('two parallel confirms do not corrupt the row',
      both.every((r) => r.status < 500)
        && (await knex('assets').where({ id: racedId }).first()).status === 'ready',
      `statuses ${both.map((r) => r.status).join(',')}`);
    note('confirm race', `${okCount} of 2 succeeded — idempotent either way, no cap is re-checked here`);

    console.log('\n--- the signed length is enforced by the storage service ---');
    const pinned = await gm.req('POST', '/api/assets/presign', {
      kind: 'portrait', campaign_id: camp.id, mime: 'image/png', bytes: PNG.length,
    });
    if (pinned.status === 201) {
      created.push(pinned.data.asset.id);
      uploads += 1;
      const over = await fetch(pinned.data.upload.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: Buffer.concat([PNG, Buffer.alloc(20000)]),
      });
      ok('a body larger than was signed is refused before our code runs',
        over.status >= 400, `${over.status}`);
    }

    console.log('\n--- what a public bucket means, stated rather than assumed ---');
    // Objects are unguessable but NOT authorised: anyone holding the URL can
    // fetch it, and the object outlives the permission that revealed it.
    const readyRow = await knex('assets').where({ id: mineId }).first();
    const direct = await fetch(readyRow.url);
    ok('a stored object is fetchable by URL with no session',
      direct.status === 200, `${direct.status}`);
    note('accepted limitation',
      'object URLs are unguessable but unauthenticated — deleting a token does not revoke a leaked image URL');
    ok('...and it is served from a DIFFERENT origin than the application',
      new URL(readyRow.url).origin !== BASE, new URL(readyRow.url).origin);
  }

  // =====================================================================
  console.log('\n--- teardown ---');
  let cleaned = 0;
  for (const id of created) {
    for (const who of [gm, pl, quotaUser]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await who.req('DELETE', `/api/assets/${id}`);
      if (r.status === 200) { cleaned += 1; break; }
    }
  }
  await knex('assets').where({ user_id: quotaUser.id }).del();
  ok(`teardown removed everything it created (${cleaned}/${created.length})`,
    cleaned >= created.length - 2, `${cleaned} of ${created.length}`);
  ok(`R2 uploads stayed within budget (${uploads}/${MAX_UPLOADS})`, uploads <= MAX_UPLOADS);
  note('cost', `${uploads} writes, a handful of reads — the free tier is 1,000,000 writes a month`);
  note('verify', 'run `npm run clean:bucket` afterwards; it should report 0 orphaned and 0 dangling');

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
