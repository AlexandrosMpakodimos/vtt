// Strict-mode asset integration tests: real HTTP and DB, memory object storage.
// Usage: node scripts/test-local.js test-assets.js

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
    // Raw-body request for the controlled upload route: the body is the file
    // bytes, metadata is in the query string, and an idempotency key may be set.
    async reqRaw(method, path, bodyBuf, { mime, idem } = {}) {
      const headers = { Origin: BASE, 'Content-Type': mime || 'application/octet-stream' };
      if (cookie) headers.Cookie = cookie;
      if (idem) headers['Idempotency-Key'] = idem;
      const res = await fetch(BASE + path, { method, headers, body: bodyBuf });
      const setC = res.headers.get('set-cookie');
      if (setC) cookie = setC.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { /* empty */ }
      return { status: res.status, data };
    },
  };
}

// A minimal valid PNG (8-byte signature + IHDR start) — enough to pass the
// magic-number check. The controlled-upload probes that reach the write need a
// bucket; the ones that test validation/auth/idempotency-shape do not.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);

async function mk(name) {
  const a = agent();
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const password = 'correct-horse-battery-staple-9';
  await a.req('POST', '/api/auth/register', {
    email, username: `${name}${Math.random().toString(16).slice(2, 8)}`, password,
  });
  await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  const l = await a.req('POST', '/api/auth/login', { email, password });
  if (l.status !== 200 || !l.data?.user?.id) {
    throw new Error('Test user login failed');
  }
  a.id = l.data.user.id;
  createdUsers.push(a.id);
  return a;
}

// Every asset this suite creates, so the run can clean up after itself.
//
// A suite that leaves objects in a real bucket is a suite that costs money and
// grows a mess every time it runs — and the byte-verification probes cannot be
// faked, so it genuinely does upload. Recorded here and removed in the teardown
// below via the application's own DELETE route, which exercises deletion as a
// side effect of tidying up.
const created = [];
const createdUsers = [];
function track(res) {
  const id = res && res.data && res.data.asset && res.data.asset.id;
  if (id) created.push(id);
  return res;
}


const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
  'base64'
);

const NOT_AN_IMAGE = Buffer.from('<!DOCTYPE html><script>alert(1)</script>', 'ascii');

// Upload raw bytes to a presigned URL exactly as a browser would: the headers
// must match what was signed or R2 refuses before our code sees anything.
async function putToPresigned(upload, buf) {
  const res = await fetch(upload.url, {
    method: upload.method,
    headers: { 'Content-Type': upload.headers['Content-Type'] },
    body: buf,
  });
  return res.status;
}

// Remove everything this run created, through the application's own routes.
//
// Deliberately NOT `knex('assets').del()`: a direct delete would leave the
// objects in the bucket, which is the exact orphan this is meant to prevent.
// Going through DELETE /api/assets/:id removes both, and exercises that route
// on every run as a side effect.
async function teardown(gm, pl) {
  let cleaned = 0;
  for (const id of created) {
    for (const who of [gm, pl]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await who.req('DELETE', `/api/assets/${id}`);
      if (r.status === 200) { cleaned += 1; break; }
    }
  }
  return cleaned;
}


let gm;
let pl;

function expectStatus(name, response, expected) {
  t(name, response.status === expected, 'got ' + response.status);
  if (response.status !== expected) {
    throw new Error(name + ': expected ' + expected + ', got ' + response.status);
  }
  return response;
}

function upload(who, kind, campaignId, body = PNG, mime = 'image/png', idem) {
  const query = new URLSearchParams({ kind, mime });
  if (campaignId != null) query.set('campaign_id', campaignId);
  return who.reqRaw('POST', '/api/assets/upload?' + query, body, { mime, idem });
}

(async () => {
  if (process.env.NODE_ENV !== 'test' || BASE !== 'http://127.0.0.1:3001') {
    throw new Error('Use node scripts/test-local.js test-assets.js');
  }

  const identityResponse = await fetch(BASE + '/__test/identity', {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const identity = await identityResponse.json();

  if (
    !identityResponse.ok ||
    identity.environment !== 'test' ||
    identity.database !== 'vtt_test' ||
    identity.role !== 'vtt_test_runner' ||
    identity.storageBackend !== 'memory' ||
    identity.storageConfigured !== true ||
    identity.uploadMode !== 'strict'
  ) throw new Error('Unexpected test server');

  const databaseIdentity = (await knex.raw(
    'SELECT current_database() AS database, current_user AS role'
  )).rows[0];

  if (
    databaseIdentity.database !== 'vtt_test' ||
    databaseIdentity.role !== 'vtt_test_runner'
  ) throw new Error('Unexpected test database');

  const keyed = await knex('assets')
    .whereNotNull('storage_key').count('* as n').first();
  const queued = await knex('storage_cleanup').count('* as n').first();

  if (Number(keyed.n) || Number(queued.n)) {
    throw new Error('Existing stored test assets or cleanup jobs need review before this run');
  }

  const updated = await knex('storage_budget').where({ id: true }).update({
    committed_bytes: 0,
    reserved_bytes: 0,
    cleanup_debt_bytes: 0,
    class_a_used: 0,
    class_b_used: 0,
    period_start: knex.raw("now() - interval '1 day'"),
    period_end: knex.raw("now() + interval '1 day'"),
  });
  if (updated !== 1) throw new Error('Test budget row missing');

  gm = await mk('gm');
  pl = await mk('pl');
  const outsider = await mk('out');

  const setup = expectStatus('campaign created',
    await gm.req('POST', '/api/campaigns', {
      name: 'Assets', is_public: true,
    }), 201);
  const camp = setup.data.campaign;

  const joined = await pl.req(
    'POST', '/api/campaigns/' + camp.id + '/join', {}
  );
  if (joined.status < 200 || joined.status >= 300) {
    throw new Error('Player join failed');
  }

  console.log('\n--- strict mode and controlled-upload validation ---');

  const probe = await gm.req('POST', '/api/assets/presign', {
    kind: 'map',
    campaign_id: camp.id,
    mime: 'image/png',
    bytes: PNG.length,
  });
  expectStatus('strict mode disables presigning', probe, 410);
  t('presign refusal identifies disabled route',
    probe.data?.error === 'presign_disabled');
  t('presign refusal supplies no upload grant', !probe.data?.upload);

  expectStatus('anonymous upload is refused',
    await upload(agent(), 'portrait', camp.id), 401);
  expectStatus('unknown kind is refused',
    await upload(pl, 'nonsense', camp.id), 400);
  expectStatus('SVG is refused',
    await upload(pl, 'portrait', camp.id, PNG, 'image/svg+xml'), 400);
  expectStatus('HTML MIME is refused',
    await upload(pl, 'portrait', camp.id, PNG, 'text/html'), 400);
  expectStatus('empty bytes are refused',
    await upload(pl, 'portrait', camp.id, Buffer.alloc(0)), 400);
  expectStatus('false PNG declaration is refused',
    await upload(pl, 'portrait', camp.id, NOT_AN_IMAGE), 400);
  expectStatus('player cannot upload a map',
    await upload(pl, 'map', camp.id), 403);
  expectStatus('outsider cannot upload into campaign',
    await upload(outsider, 'portrait', camp.id), 404);

  expectStatus('duplicate kind query is refused',
    await pl.reqRaw('POST',
      '/api/assets/upload?kind=portrait&kind=map&mime=image%2Fpng&campaign_id=' + camp.id,
      PNG, { mime: 'image/png' }), 400);

  const avatarLimit = require('./src/services/storage').limitFor('avatar');
  expectStatus('oversized avatar is refused',
    await upload(pl, 'avatar', null, Buffer.alloc(avatarLimit + 1)), 400);

  const badKindExt = await gm.req('POST', '/api/assets/external', {
    kind: 'nonsense',
    campaign_id: camp.id,
    url: 'https://example.com/x.png',
  });
  expectStatus('external unknown kind is refused', badKindExt, 400);
  t('kind allow-list includes cover',
    /cover/.test(badKindExt.data?.error || ''));

  console.log('\n--- external links need no bucket at all ---');
  const ext = track(await pl.req('POST', '/api/assets/external', {
    kind: 'portrait', campaign_id: camp.id, url: 'https://example.com/aria.png',
  }));
  t('a pasted link is recorded', ext.status === 201, `${ext.status}`);
  t('...marked as external', ext.data.asset.source === 'external');
  t('...ready immediately, since there is nothing of ours to verify',
    ext.data.asset.status === 'ready');
  t('...with the original address kept for provenance',
    ext.data.asset.source_url === 'https://example.com/aria.png');
  t('...and no storage key, because we host nothing',
    (await knex('assets').where({ id: ext.data.asset.id }).first()).storage_key === null);
  note('the trade-off', 'every player fetches this directly, disclosing their IP to that host');

  t('a javascript: url is refused',
    (await pl.req('POST', '/api/assets/external', {
      kind: 'portrait', campaign_id: camp.id, url: 'javascript:alert(1)',
    })).status === 400);
  t('a data: url is refused',
    (await pl.req('POST', '/api/assets/external', {
      kind: 'portrait', campaign_id: camp.id, url: 'data:text/html,<script>alert(1)</script>',
    })).status === 400);
  t('an array url is refused (type confusion)',
    (await pl.req('POST', '/api/assets/external', {
      kind: 'portrait', campaign_id: camp.id, url: ['https://example.com/x.png'],
    })).status === 400);
  t('a player still cannot set a map by link',
    (await pl.req('POST', '/api/assets/external', {
      kind: 'map', campaign_id: camp.id, url: 'https://example.com/map.png',
    })).status === 403);

  // A campaign cover is the GM's banner: same owner-only rule as the map, and
  // exercised through /external so it needs no bucket.
  const gmCover = track(await gm.req('POST', '/api/assets/external', {
    kind: 'cover', campaign_id: camp.id, url: 'https://example.com/cover.png',
  }));
  t('the GM may set a campaign cover by link', gmCover.status === 201, `${gmCover.status}`);
  t('...recorded against the campaign', gmCover.data.asset.campaign_id === camp.id);
  const plCover = await pl.req('POST', '/api/assets/external', {
    kind: 'cover', campaign_id: camp.id, url: 'https://example.com/cover2.png',
  });
  t('a player cannot set a campaign cover', plCover.status === 403, `${plCover.status}`);
  t('...and the refusal names the kind, not just "map"',
    typeof plCover.data.error === 'string' && /cover/.test(plCover.data.error), plCover.data.error);

  console.log('\n--- avatars are personal, not campaign-scoped ---');
  const avatar = track(await pl.req('POST', '/api/assets/external', {
    kind: 'avatar', url: 'https://example.com/me.png',
  }));
  t('an avatar needs no campaign', avatar.status === 201, `${avatar.status}`);
  t('...and is stored with none', avatar.data.asset.campaign_id === null);
  const avatarInCampaign = await pl.req('POST', '/api/assets/external', {
    kind: 'avatar', campaign_id: camp.id, url: 'https://example.com/me2.png',
  });
  t('an avatar WITH a campaign is refused — the scopes are exclusive',
    avatarInCampaign.status === 404, `${avatarInCampaign.status}`);

  console.log('\n--- the library ---');
  const lib = await pl.req('GET', `/api/assets?campaign_id=${camp.id}`);
  t('a member reads the campaign library', lib.status === 200 && lib.data.assets.length >= 1);
  t('a non-member cannot -> 404',
    (await outsider.req('GET', `/api/assets?campaign_id=${camp.id}`)).status === 404);
  const mine = await pl.req('GET', '/api/assets');
  t('personal images are listed separately from campaign ones',
    mine.data.assets.every((a) => a.campaign_id === null), JSON.stringify(mine.data.assets.map((a) => a.campaign_id)));
  t('a malformed campaign id -> 404, not 500',
    (await pl.req('GET', '/api/assets?campaign_id=nonsense')).status === 404);

  console.log('\n--- BOPLA: forging the fields the server owns ---');
  const forged = track(await pl.req('POST', '/api/assets/external', {
    kind: 'portrait',
    campaign_id: camp.id,
    url: 'https://example.com/ok.png',
    status: 'ready',
    storage_key: 'c/other/map/stolen.png',
    user_id: gm.id,
    bytes: 999999999,
    mime: 'image/svg+xml',
  }));
  t('a forged payload is accepted but ignored', forged.status === 201);
  const stored = await knex('assets').where({ id: forged.data.asset.id }).first();
  t('...the storage key is NOT taken from the body', stored.storage_key === null, `${stored.storage_key}`);
  t('...the uploader is the caller, not the claimed user', stored.user_id === pl.id);
  t('...the byte count is not accepted from a client', stored.bytes === null, `${stored.bytes}`);
  t('...and the mime is not either', stored.mime === null, `${stored.mime}`);

  console.log('\n--- deletion ---');
  const own = (await pl.req('POST', '/api/assets/external', {
    kind: 'portrait', campaign_id: camp.id, url: 'https://example.com/del.png',
  })).data.asset;
  t('another member cannot delete it -> 404',
    (await outsider.req('DELETE', `/api/assets/${own.id}`)).status === 404);
  t('the GM may curate the campaign library',
    (await gm.req('DELETE', `/api/assets/${own.id}`)).status === 200);
  t('...and the row is gone',
    (await knex('assets').where({ id: own.id }).first()) === undefined);
  const personal = (await pl.req('POST', '/api/assets/external', {
    kind: 'avatar', url: 'https://example.com/mine.png',
  })).data.asset;
  t('the GM cannot delete somebody personal image -> 404',
    (await gm.req('DELETE', `/api/assets/${personal.id}`)).status === 404);
  t('but its owner can',
    (await pl.req('DELETE', `/api/assets/${personal.id}`)).status === 200);
  t('a malformed asset id -> 404, not 500',
    (await pl.req('DELETE', '/api/assets/nonsense')).status === 404);

  console.log('\n--- API4: the per-user quota lands EXACTLY under a race ---');
  const racer = await mk('race');
  const MAX_USER = 20;
  // Fixtures via knex; only the racing writes go over HTTP.
  await knex('assets').insert(Array.from({ length: MAX_USER - 3 }, (_, i) => ({
    user_id: racer.id, campaign_id: null, url: `https://example.com/f${i}.png`,
    source: 'external', kind: 'avatar', status: 'ready',
  })));
  const preload = Number((await knex('assets')
    .where({ user_id: racer.id, campaign_id: null, status: 'ready' }).count({ n: '*' }).first()).n);
  t('setup: preloaded to exactly the cap minus three', preload === MAX_USER - 3, `${preload}`);

  const outcome = await Promise.all(Array.from({ length: 12 }, (_, i) => racer.req(
    'POST', '/api/assets/external', { kind: 'avatar', url: `https://example.com/r${i}.png` },
  )));
  const accepted = outcome.filter((r) => r.status === 201).length;
  const refused = outcome.filter((r) => r.status === 409).length;
  const landed = Number((await knex('assets')
    .where({ user_id: racer.id, campaign_id: null, status: 'ready' }).count({ n: '*' }).first()).n);
  t('the personal quota holds exactly under 12 parallel writes',
    landed === MAX_USER && accepted === 3 && refused === 9,
    `landed ${landed}, accepted ${accepted}, refused ${refused}`);
  t('nobody received a 500 from the race',
    outcome.every((r) => r.status < 500), outcome.map((r) => r.status).join(','));


  console.log('\n--- controlled upload, accounting and idempotency ---');

  const budget = require('./src/services/storageBudget');
  // An uninitialised ledger must refuse uploads before writing anything.
  const savedLedger = await knex('storage_budget').where({ id: true }).first();
  const rowsBefore = await knex('assets').count('* as n').first();
  try {
    await knex('storage_budget').where({ id: true }).update({
      period_start: null,
      period_end: null,
    });
    const refusedUpload = track(
      await upload(pl, 'portrait', camp.id)
    );
    expectStatus('uninitialised ledger refuses upload', refusedUpload, 503);

    const rowsAfter = await knex('assets').count('* as n').first();
    t('refused upload creates no asset row',
      Number(rowsAfter.n) === Number(rowsBefore.n));

    const unavailable = await budget.snapshot();
    t('refused upload commits no bytes',
      unavailable.bytes.committed === Number(savedLedger.committed_bytes));
    t('refused upload charges no PUT',
      unavailable.class_a.used === Number(savedLedger.class_a_used));
  } finally {
    await knex('storage_budget').where({ id: true }).update({
      period_start: savedLedger.period_start,
      period_end: savedLedger.period_end,
    });
  }

  const before = await budget.snapshot();
  const idem = 'asset-test-' + require('node:crypto').randomUUID();

  const first = track(
    await upload(pl, 'portrait', camp.id, PNG, 'image/png', idem)
  );
  expectStatus('player portrait upload succeeds', first, 201);

  const asset = first.data.asset;
  const storedUpload = await knex('assets').where({ id: asset.id }).first();

  t('uploaded asset is ready', storedUpload.status === 'ready');
  t('uploaded asset has a URL',
    typeof asset.url === 'string' && asset.url.length > 0);
  t('server assigned campaign storage key',
    storedUpload.storage_key.startsWith('c/' + camp.id + '/portrait/'));
  t('actual byte count recorded', Number(storedUpload.bytes) === PNG.length);
  t('bytes were accounted for', storedUpload.bytes_verified === true);
  t('one write attempt recorded', Number(storedUpload.upload_attempts) === 1);

  const after = await budget.snapshot();
  t('actual bytes committed',
    after.bytes.committed - before.bytes.committed === PNG.length);
  t('reservation consumed', after.bytes.reserved === before.bytes.reserved);
  t('one PUT charged', after.class_a.used - before.class_a.used === 1);
  t('one HEAD charged', after.class_b.used - before.class_b.used === 1);

  const repeated = await upload(pl, 'portrait', camp.id, PNG, 'image/png', idem);
  expectStatus('repeated idempotency key returns existing asset', repeated, 200);
  t('same asset returned', repeated.data.asset.id === asset.id);

  const duplicateCount = await knex('assets')
    .where({ user_id: pl.id, idempotency_key: idem })
    .count('* as n').first();
  t('only one row for idempotency key', Number(duplicateCount.n) === 1);

  const afterRepeat = await budget.snapshot();
  t('repeat commits no extra bytes',
    afterRepeat.bytes.committed === after.bytes.committed);
  t('repeat charges no extra PUT',
    afterRepeat.class_a.used === after.class_a.used);
  t('repeat charges no extra HEAD',
    afterRepeat.class_b.used === after.class_b.used);

  const map = track(await upload(gm, 'map', camp.id));
  expectStatus('GM can upload a map', map, 201);

  // A paused ledger must refuse deletion before the object is touched.
  const deletePeriod = await knex('storage_budget').where({ id: true })
    .select('period_start', 'period_end').first();
  const inventoryBeforeRefusal = await (await fetch(BASE + '/__test/identity')).json();
  try {
    await knex('storage_budget').where({ id: true }).update({ period_start: null, period_end: null });
    expectStatus('uninitialised accounting refuses deletion',
      await gm.req('DELETE', '/api/assets/' + map.data.asset.id), 503);
    const retained = await knex('assets').where({ id: map.data.asset.id }).first();
    t('refused deletion retains the ready asset', retained?.status === 'ready');
    const inventoryAfterRefusal = await (await fetch(BASE + '/__test/identity')).json();
    t('refused deletion preserves stored bytes and object count',
      inventoryAfterRefusal.storageInventory.bytes === inventoryBeforeRefusal.storageInventory.bytes &&
      inventoryAfterRefusal.storageInventory.count === inventoryBeforeRefusal.storageInventory.count);
  } finally {
    await knex('storage_budget').where({ id: true }).update(deletePeriod);
  }

  expectStatus('owner can delete uploaded portrait',
    await pl.req('DELETE', '/api/assets/' + asset.id), 200);

  const afterDelete = await budget.snapshot();
  t('deleted portrait bytes released while map remains',
    afterDelete.bytes.committed === before.bytes.committed + PNG.length);

  console.log('\n--- exhausted Class B does not issue a HEAD ---');
  const savedB = await budget.snapshot();
  const statsBefore = await (await fetch(BASE + '/__test/identity')).json();
  const bCeiling = budget.LIMITS.maxClassB - budget.LIMITS.maintClassB;
  let noHeadUpload;

  try {
    await knex('storage_budget').where({ id: true }).update({
      class_b_used: bCeiling,
    });

    noHeadUpload = track(await upload(gm, 'portrait', camp.id));
    expectStatus('upload succeeds using known body length', noHeadUpload, 201);

    const statsAfter = await (await fetch(BASE + '/__test/identity')).json();
    t('no HEAD call when its permit is refused',
      Number.isInteger(statsBefore.storageStats?.headCalls) &&
      statsAfter.storageStats?.headCalls === statsBefore.storageStats.headCalls);

    const capped = await budget.snapshot();
    t('Class B counter stays at its ceiling', capped.class_b.used === bCeiling);
    t('successful PUT is charged', capped.class_a.used === savedB.class_a.used + 1);
    t('body bytes are committed',
      capped.bytes.committed === savedB.bytes.committed + PNG.length);
    t('no reservation is left behind',
      capped.bytes.reserved === savedB.bytes.reserved);
  } finally {
    if (noHeadUpload?.data?.asset?.id) {
      expectStatus('fallback upload is cleaned up',
        await gm.req('DELETE', '/api/assets/' + noHeadUpload.data.asset.id), 200);
    }
    await knex('storage_budget').where({ id: true }).update({
      class_b_used: savedB.class_b.used,
    });
  }

  console.log('\n--- ambiguous PUT retains liability until cleanup ---');

  const failureBase = await budget.snapshot();
  const inventoryBefore = await (await fetch(BASE + '/__test/identity')).json();
  const faultBody = Buffer.concat([
    PNG, Buffer.from('\nVTT_TEST_AMBIGUOUS\n'),
  ]);
  const faultKey = 'ambiguous-' + require('node:crypto').randomUUID();
  const aCeiling = budget.LIMITS.maxClassA - budget.LIMITS.maintClassA;

  try {
    await knex('storage_budget').where({ id: true }).update({
      class_a_used: aCeiling - 1,
    });

    const failed = await upload(
      pl, 'portrait', camp.id, faultBody, 'image/png', faultKey
    );

    // Track the rejected row even though the error response contains no asset.
    const failedAsset = await knex('assets').where({
      user_id: pl.id, idempotency_key: faultKey,
    }).first();
    if (failedAsset) created.push(failedAsset.id);

    expectStatus('retry stops at the Class A ceiling', failed, 507);
    if (!failedAsset) throw new Error('Failed upload row was not recorded');

    const inventoryAfter = await (await fetch(BASE + '/__test/identity')).json();
    t('only one PUT was attempted',
      inventoryAfter.storageStats.putCalls === inventoryBefore.storageStats.putCalls + 1);
    t('object exists despite the failed response',
      inventoryAfter.storageInventory.bytes ===
        inventoryBefore.storageInventory.bytes + faultBody.length);

    const held = await budget.snapshot();
    t('ambiguous bytes remain in live liability',
      held.bytes.live === failureBase.bytes.live + faultBody.length);
    t('reservation transferred to cleanup debt',
      held.bytes.reserved === failureBase.bytes.reserved &&
      held.bytes.cleanup_debt === failureBase.bytes.cleanup_debt + faultBody.length);
    t('failed upload is rejected with no remaining row reservation',
      failedAsset.status === 'rejected' && failedAsset.reserved_bytes == null);
    t('Class A stops at its ceiling', held.class_a.used === aCeiling);

    const queued = await knex('storage_cleanup')
      .where({ storage_key: failedAsset.storage_key }).first();
    if (!queued) throw new Error('Failed upload was not queued');
    t('queue records the liable byte count', Number(queued.bytes) === faultBody.length);

    const cleanupPath = '/__test/cleanup/' + queued.id;
    const firstDelete = await gm.req('POST', cleanupPath);
    expectStatus('worker deletion attempt completes', firstDelete, 200);
    t('simulated deletion failure reaches the worker', firstDelete.data.first.ok === false);

    const retained = await budget.snapshot();
    t('failed deletion retains cleanup debt',
      retained.bytes.cleanup_debt === held.bytes.cleanup_debt);
    t('failed deletion retains queue row',
      Boolean(await knex('storage_cleanup').where({ id: queued.id }).first()));

    // Unrelated synthetic debt makes a duplicate release observable.
    await knex('storage_budget').where({ id: true }).update({
      cleanup_debt_bytes: retained.bytes.cleanup_debt + 37,
    });
    try {
      const removed = await gm.req('POST', cleanupPath + '?repeat=1');
      expectStatus('worker deletion and repeated callback complete', removed, 200);
      t('second deletion succeeds', removed.data.first.ok === true);

      const released = await budget.snapshot();
      t('duplicate cleanup does not release unrelated debt',
        released.bytes.cleanup_debt === failureBase.bytes.cleanup_debt + 37);
      t('cleanup removes queue row',
        !(await knex('storage_cleanup').where({ id: queued.id }).first()));

      const inventoryFinal = await (await fetch(BASE + '/__test/identity')).json();
      t('cleanup actually removes the stored bytes',
        inventoryFinal.storageInventory.bytes === inventoryBefore.storageInventory.bytes);
    } finally {
      await knex('storage_budget').where({ id: true }).update({
        cleanup_debt_bytes: knex.raw('cleanup_debt_bytes - LEAST(cleanup_debt_bytes, 37)'),
      });
    }
  } finally {
    await knex('storage_budget').where({ id: true }).update({
      class_a_used: failureBase.class_a.used,
    });
  }


  console.log('\n--- permanent image references survive delivery-token expiry ---');
  {
    let regressionActor = null;
    let regressionScene = null;

    function requireAssetResponse(response, label) {
      t(label, response.status === 201 && !!response.data?.asset?.id,
        'status=' + response.status);
      if (response.status !== 201 || !response.data?.asset?.id) {
        throw new Error(label + ' failed');
      }
      return response.data.asset;
    }

    function requireRecord(response, key, label) {
      t(label, response.status === 201 && !!response.data?.[key]?.id,
        'status=' + response.status);
      if (response.status !== 201 || !response.data?.[key]?.id) {
        throw new Error(label + ' failed');
      }
      return response.data[key];
    }

    function isGatewayUrl(value, assetId) {
      try {
        const url = new URL(value);
        return url.origin === 'http://media.test:3001' &&
          url.pathname === '/media/' + assetId &&
          !!url.searchParams.get('t');
      } catch {
        return false;
      }
    }

    try {
      const uploaded = track(await gm.reqRaw(
        'POST',
        '/api/assets/upload?kind=portrait&mime=image%2Fpng&campaign_id=' + camp.id,
        PNG,
        { mime: 'image/png', idem: 'reference-regression-' + Date.now() }
      ));
      const image = requireAssetResponse(uploaded, 'reference fixture upload succeeds');
      const storedAsset = await knex('assets').where({ id: image.id }).first();
      const canonical = storedAsset.url;
      t('fixture stores a permanent memory-storage URL',
        canonical === 'https://storage.test.invalid/' +
          storedAsset.storage_key.split('/').map(encodeURIComponent).join('/'));

      t('upload response supplies a gateway URL', isGatewayUrl(image.url, image.id));

      // Save an unusable delivery token. The current session must authorise
      // the asset reference independently; the old token is not a credential.
      const stale = new URL(image.url);
      stale.searchParams.set('t', 'expired-delivery-token');

      regressionActor = requireRecord(await gm.req(
        'POST', '/api/campaigns/' + camp.id + '/actors',
        { name: 'Reference regression actor', img_url: stale.href }
      ), 'actor', 'actor create accepts an authorised image reference');

      regressionScene = requireRecord(await gm.req(
        'POST', '/api/campaigns/' + camp.id + '/scenes',
        { name: 'Reference regression scene', img_url: stale.href }
      ), 'scene', 'scene create accepts an authorised image reference');

      const actorPath = '/api/campaigns/' + camp.id + '/actors/' + regressionActor.id;
      const scenePath = '/api/campaigns/' + camp.id + '/scenes/' + regressionScene.id;

      for (const [table, record] of [
        ['actors', regressionActor], ['scenes', regressionScene],
      ]) {
        const saved = await knex(table).where({ id: record.id }).first();
        t(table + ' create stores the permanent reference',
          saved.img_url === canonical);
      }

      for (const [table, record, route] of [
        ['actors', regressionActor, actorPath],
        ['scenes', regressionScene, scenePath],
      ]) {
        const patched = await gm.req('PATCH', route, { img_url: stale.href });
        t(table + ' patch accepts the authorised reference', patched.status === 200);
        const saved = await knex(table).where({ id: record.id }).first();
        t(table + ' patch stores no delivery token', saved.img_url === canonical);
      }

      const token = requireRecord(await gm.req(
        'POST', scenePath + '/tokens',
        { actor_id: regressionActor.id, x: 0, y: 0 }
      ), 'token', 'actor-linked token is placed');

      const opened = await gm.req('GET', scenePath);
      t('scene detail loads', opened.status === 200);
      t('scene detail rewrites the map URL',
        isGatewayUrl(opened.data?.scene?.img_url, image.id));
      t('scene detail rewrites inherited token art',
        isGatewayUrl(opened.data?.tokens?.find((r) => r.id === token.id)?.img_url, image.id));
      t('scene detail rewrites actor art',
        isGatewayUrl(opened.data?.actors?.find((r) => r.id === regressionActor.id)?.img_url, image.id));


      console.log('\n--- private images cannot cross campaign boundaries ---');
      let foreignCampaign = null;
      let foreignAsset = null;
      let unexpectedActor = null;
      try {
        const createdCampaign = await gm.req('POST', '/api/campaigns', {
          name: 'Private image boundary regression',
          password: 'boundary-test-only-password-9',
          is_public: false,
        });
        foreignCampaign = createdCampaign.data?.campaign;
        if (!foreignCampaign?.id) {
          throw new Error(
            'Could not create boundary-test campaign: status=' +
            createdCampaign.status + ', response=' +
            JSON.stringify(createdCampaign.data)
          );
        }

        const uploadedForeign = track(await gm.reqRaw(
          'POST',
          '/api/assets/upload?kind=portrait&mime=image%2Fpng&campaign_id=' +
            foreignCampaign.id,
          PNG,
          { mime: 'image/png', idem: 'foreign-reference-' + Date.now() }
        ));
        foreignAsset = requireAssetResponse(
          uploadedForeign, 'foreign campaign image uploaded'
        );
        const foreignStored = await knex('assets')
          .where({ id: foreignAsset.id }).first();

        // The GM owns both campaigns and can view the source image.
        // That must not permit sharing private art across their audiences.
        for (const reference of [foreignAsset.url, foreignStored.url]) {
          const form = reference === foreignStored.url ? 'permanent' : 'gateway';
          for (const [table, record, route] of [
            ['actors', regressionActor, actorPath],
            ['scenes', regressionScene, scenePath],
          ]) {
            const denied = await gm.req('PATCH', route, { img_url: reference });
            t(table + ' rejects a foreign private ' + form + ' reference',
              denied.status === 400, 'status=' + denied.status);
            const saved = await knex(table).where({ id: record.id }).first();
            t(table + ' keeps its original picture after foreign ' + form + ' refusal',
              saved.img_url === canonical);
          }
        }

        // The player belongs to the destination campaign but cannot view
        // the private source campaign. Possessing its URL grants no access.
        const deniedCreate = await pl.req(
          'POST', '/api/campaigns/' + camp.id + '/actors',
          {
            name: 'Foreign image must be refused',
            img_url: foreignAsset.url,
          }
        );
        unexpectedActor = deniedCreate.data?.actor || null;
        t('player cannot create an actor using an inaccessible image',
          deniedCreate.status === 400, 'status=' + deniedCreate.status);
        t('refused foreign-image create returns no actor', !unexpectedActor);
      } finally {
        if (unexpectedActor) {
          const removed = await gm.req(
            'DELETE', '/api/campaigns/' + camp.id + '/actors/' + unexpectedActor.id
          );
          t('unexpected boundary-test actor cleaned up', removed.status === 200);
        }

        let imageRemoved = !foreignAsset;
        if (foreignAsset) {
          const removed = await gm.req('DELETE', '/api/assets/' + foreignAsset.id);
          imageRemoved = removed.status === 200;
          t('foreign image fixture cleaned up', imageRemoved);
        }
        if (foreignCampaign && imageRemoved) {
          const removed = await gm.req(
            'DELETE', '/api/campaigns/' + foreignCampaign.id
          );
          t('foreign campaign fixture cleaned up', removed.status === 200);
        }
      }

      const missing = new URL(stale.href);
      missing.pathname = '/media/00000000-0000-4000-8000-000000000000';
      for (const [table, record, route] of [
        ['actors', regressionActor, actorPath],
        ['scenes', regressionScene, scenePath],
      ]) {
        const refused = await gm.req('PATCH', route, { img_url: missing.href });
        t(table + ' refuses a nonexistent media reference', refused.status === 400);
        const saved = await knex(table).where({ id: record.id }).first();
        t(table + ' refusal preserves the existing picture', saved.img_url === canonical);
      }
    } finally {
      if (regressionScene) {
        const removed = await gm.req(
          'DELETE', '/api/campaigns/' + camp.id + '/scenes/' + regressionScene.id
        );
        t('reference regression scene cleaned up', removed.status === 200);
      }
      if (regressionActor) {
        const removed = await gm.req(
          'DELETE', '/api/campaigns/' + camp.id + '/actors/' + regressionActor.id
        );
        t('reference regression actor cleaned up', removed.status === 200);
      }
    }
  }


  console.log('\n--- real upload route: all retries are charged ---');
  {
    const retryBytes = Buffer.concat([
      PNG, Buffer.from('\nVTT_TEST_RETRY_TWICE\n'),
    ]);
    const before = await budget.snapshot();
    const statsBefore = await (await fetch(BASE + '/__test/identity')).json();

    const result = track(await gm.reqRaw(
      'POST',
      '/api/assets/upload?kind=portrait&mime=image%2Fpng&campaign_id=' + camp.id,
      retryBytes,
      { mime: 'image/png', idem: 'retry-success-' + Date.now() }
    ));
    t('upload succeeds after two transient failures', result.status === 201,
      'status=' + result.status);
    if (!result.data?.asset?.id) throw new Error('Retry fixture upload failed');

    const row = await knex('assets').where({ id: result.data.asset.id }).first();
    const after = await budget.snapshot();
    const statsAfter = await (await fetch(BASE + '/__test/identity')).json();

    t('route records three write attempts', Number(row.upload_attempts) === 3);
    t('fixture received exactly three PUT calls',
      statsAfter.storageStats.putCalls - statsBefore.storageStats.putCalls === 3);
    t('three Class A permits were charged',
      after.class_a.used - before.class_a.used === 3);
    t('successful retry commits the body exactly once',
      after.bytes.committed - before.bytes.committed === retryBytes.length);
    t('successful retry consumes its reservation',
      after.bytes.reserved === before.bytes.reserved);
    t('successful retry adds no cleanup debt',
      after.bytes.cleanup_debt === before.bytes.cleanup_debt);
  }

  console.log('\n--- real upload route: three ambiguous failures retain liability ---');
  {
    const failedBytes = Buffer.concat([
      PNG, Buffer.from('\nVTT_TEST_AMBIGUOUS\n'),
    ]);
    const idem = 'all-attempts-fail-' + Date.now();
    const before = await budget.snapshot();
    const inventoryBefore = await (await fetch(BASE + '/__test/identity')).json();

    const result = await gm.reqRaw(
      'POST',
      '/api/assets/upload?kind=portrait&mime=image%2Fpng&campaign_id=' + camp.id,
      failedBytes,
      { mime: 'image/png', idem }
    );
    t('three ambiguous failures return 502', result.status === 502,
      'status=' + result.status);

    const row = await knex('assets')
      .where({ user_id: gm.id, idempotency_key: idem }).first();
    if (!row) throw new Error('Failed-upload asset row missing');
    track({ data: { asset: row } });

    const queued = await knex('storage_cleanup')
      .where({ storage_key: row.storage_key }).first();
    const after = await budget.snapshot();
    const inventoryAfter = await (await fetch(BASE + '/__test/identity')).json();

    t('failed route records all three attempts', Number(row.upload_attempts) === 3);
    t('failed route made exactly three PUT calls',
      inventoryAfter.storageStats.putCalls -
        inventoryBefore.storageStats.putCalls === 3);
    t('all failed PUT attempts are charged',
      after.class_a.used - before.class_a.used === 3);
    t('overwritten object occupies only one body worth of storage',
      inventoryAfter.storageInventory.bytes -
        inventoryBefore.storageInventory.bytes === failedBytes.length);
    t('failed upload adds no committed bytes',
      after.bytes.committed === before.bytes.committed);
    t('failed reservation transfers entirely into cleanup debt',
      after.bytes.reserved === before.bytes.reserved &&
      after.bytes.cleanup_debt === before.bytes.cleanup_debt + failedBytes.length);
    t('failed upload has a durable cleanup record',
      !!queued && Number(queued.bytes) === failedBytes.length);

    if (!queued) throw new Error('Failed-upload cleanup record missing');

    // The fixture refuses the first delete, then succeeds.
    const first = await gm.req('POST', '/__test/cleanup/' + queued.id, {});
    t('first cleanup request completes', first.status === 200);
    const held = await budget.snapshot();
    t('failed deletion preserves all liability',
      held.bytes.live === after.bytes.live);

    const second = await gm.req('POST', '/__test/cleanup/' + queued.id, {});
    t('second cleanup request completes', second.status === 200);
    const cleaned = await budget.snapshot();
    const inventoryFinal = await (await fetch(BASE + '/__test/identity')).json();
    t('successful cleanup restores the prior byte liability',
      cleaned.bytes.live === before.bytes.live);
    t('successful cleanup removes the object',
      inventoryFinal.storageInventory.bytes === inventoryBefore.storageInventory.bytes);
    t('successful cleanup removes the queue record',
      !(await knex('storage_cleanup').where({ id: queued.id }).first()));
  }

  note('scope',
    'Real HTTP routes and PostgreSQL; object storage is an in-memory fixture, not R2.');
})()
  .catch((error) => {
    t('suite completed without an exception', false, error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (gm && pl) await teardown(gm, pl);

      const remaining = created.length
        ? await knex('assets').whereIn('id', created).count('* as n').first()
        : { n: 0 };
      t('tracked assets cleaned up', Number(remaining.n) === 0);

      if (Number(remaining.n) === 0 && createdUsers.length) {
        await knex('users').whereIn('id', createdUsers).del();
      }
    } catch (error) {
      t('teardown completed', false, error.message);
    } finally {
      console.log(results.join('\n'));
      console.log('\n' + pass + ' passed, ' + fail + ' failed');
      if (fail) process.exitCode = 1;
      await knex.destroy();
    }
  });
