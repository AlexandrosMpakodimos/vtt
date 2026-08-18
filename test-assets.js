// Assets: presigned uploads, verification, external links.
//   Usage: SKIP_HIBP=1 node test-assets.js   (server on npm run dev:test)
//
// Functional and adversarial in one file, as test-speaker-color.js and
// test-scene-grid.js are: the security surface here is not a separate subject
// from the behaviour. "A player may upload a portrait" and "a player may NOT
// upload a map" are one rule seen from two sides.
//
// Mapped to the OWASP API Security Top 10 (2023):
//   API1 BOLA   — presigning into a campaign you are not in; confirming
//                 somebody else's upload
//   API3 BOPLA  — forging the storage key, the status, the campaign
//   API4 URC    — the per-campaign and per-user quotas, under a race
//   API5 BFLA   — a player uploading a map
//
// ---------------------------------------------------------------------------
// WHAT THIS SUITE CAN AND CANNOT DO WITHOUT A BUCKET
// ---------------------------------------------------------------------------
// The routes that touch R2 answer 503 when no bucket is configured, so that the
// application runs — and every other suite passes — on a machine without the
// author's credentials. That is a deliberate property and this suite must not
// undermine it by requiring them.
//
// So the storage-dependent probes DETECT the 503 and assert the degraded
// behaviour instead, while every probe that does not need bytes — external
// links, quotas, permissions, refusal shapes — runs either way. A run without
// credentials therefore still proves most of the surface, and says which part
// it could not reach rather than silently passing.
//
// It does NOT skip silently: the header of the run states which mode it is in,
// and the storage-dependent count is reported separately.

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

// Every asset this suite creates, so the run can clean up after itself.
//
// A suite that leaves objects in a real bucket is a suite that costs money and
// grows a mess every time it runs — and the byte-verification probes cannot be
// faked, so it genuinely does upload. Recorded here and removed in the teardown
// below via the application's own DELETE route, which exercises deletion as a
// side effect of tidying up.
const created = [];
function track(res) {
  const id = res && res.data && res.data.asset && res.data.asset.id;
  if (id) created.push(id);
  return res;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
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

(async () => {
  const gm = await mk('gm');
  const pl = await mk('pl');
  const outsider = await mk('out');

  const camp = (await gm.req('POST', '/api/campaigns', { name: 'Assets', is_public: true })).data.campaign;
  await pl.req('POST', `/api/campaigns/${camp.id}/join`, {});
  t('setup: campaign created', !!camp);

  // Establish which mode this run is in, from the server's own answer.
  const probe = await gm.req('POST', '/api/assets/presign', {
    kind: 'map', campaign_id: camp.id, mime: 'image/png', bytes: 1024,
  });
  const storageOn = probe.status !== 503;
  note('mode', storageOn
    ? 'R2 configured — the full upload path is exercised'
    : 'no bucket configured — upload probes assert the 503 degradation instead');

  console.log('\n--- validation, which needs no bucket ---');
  const bad = [
    [{ kind: 'nonsense', campaign_id: camp.id, mime: 'image/png', bytes: 10 }, 'an unknown kind'],
    [{ kind: 'map', campaign_id: camp.id, mime: 'image/svg+xml', bytes: 10 }, 'SVG'],
    [{ kind: 'map', campaign_id: camp.id, mime: 'text/html', bytes: 10 }, 'HTML'],
    [{ kind: 'map', campaign_id: camp.id, mime: 'image/png', bytes: 0 }, 'zero bytes'],
    [{ kind: 'map', campaign_id: camp.id, mime: 'image/png', bytes: -5 }, 'negative bytes'],
    [{ kind: 'map', campaign_id: camp.id, mime: 'image/png', bytes: 999999999 }, 'a file past the size limit'],
    [{ kind: 'map', campaign_id: camp.id, mime: 'image/png', bytes: [[10]] }, 'nested-array bytes'],
    [{ kind: ['map'], campaign_id: camp.id, mime: 'image/png', bytes: 10 }, 'an array kind'],
    [{ kind: 'map', campaign_id: camp.id, mime: ['image/png'], bytes: 10 }, 'an array mime'],
  ];
  for (const [body, label] of bad) {
    // eslint-disable-next-line no-await-in-loop
    const r = await gm.req('POST', '/api/assets/presign', body);
    t(`presign refuses ${label}`, r.status === 400 || r.status === 503, `got ${r.status}`);
  }
  note('SVG', 'refused at the allow-list — R2 serves raw bytes, so a scriptable image would be stored XSS');

  // The kind allow-list is shared by both routes; /external runs it without a
  // bucket, so we can assert deterministically that `cover` is now a valid kind
  // and that the rejection message enumerates it.
  const badKindExt = await gm.req('POST', '/api/assets/external', {
    kind: 'nonsense', campaign_id: camp.id, url: 'https://example.com/x.png',
  });
  t('external refuses an unknown kind (400)', badKindExt.status === 400, `${badKindExt.status}`);
  t('...and the allow-list now includes cover',
    typeof badKindExt.data.error === 'string' && /cover/.test(badKindExt.data.error), badKindExt.data.error);

  console.log('\n--- who may upload what ---');
  const playerMap = await pl.req('POST', '/api/assets/presign', {
    kind: 'map', campaign_id: camp.id, mime: 'image/png', bytes: 1024,
  });
  t('BFLA: a player cannot upload a map',
    playerMap.status === 403 || playerMap.status === 503, `got ${playerMap.status}`);
  const playerPortrait = await pl.req('POST', '/api/assets/presign', {
    kind: 'portrait', campaign_id: camp.id, mime: 'image/png', bytes: 1024,
  });
  t('...but may upload a portrait',
    playerPortrait.status === 201 || playerPortrait.status === 503, `got ${playerPortrait.status}`);
  const outsiderUp = await outsider.req('POST', '/api/assets/presign', {
    kind: 'portrait', campaign_id: camp.id, mime: 'image/png', bytes: 1024,
  });
  t('BOLA: a non-member gets 404, not 403 (no campaign enumeration)',
    outsiderUp.status === 404 || outsiderUp.status === 503, `got ${outsiderUp.status}`);
  const anon = agent();
  t('an unauthenticated caller is refused',
    (await anon.req('POST', '/api/assets/presign', { kind: 'avatar', mime: 'image/png', bytes: 10 })).status === 401);

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

  // ===================================================================
  // Everything below needs a real bucket.
  // ===================================================================
  if (!storageOn) {
    note('storage probes', 'SKIPPED — no bucket configured. Set R2_* to exercise the upload path.');
    note('teardown', `${await teardown(gm, pl)} asset(s) removed`);
    console.log(results.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed  (storage path not exercised)`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  }

  console.log('\n--- the presigned url itself ---');
  // [ADDED 2026-08-09] Two defects found by the first BROWSER upload, neither
  // of which the Node probes could see:
  //
  //   - the SDK baked a CRC32 of an EMPTY body into the signature, so real
  //     bytes never matched it. Node uploads happened to work because the
  //     suite's PUT went through a path that recomputed it; a browser's did not.
  //   - the signed header list is `content-length;host`. The content TYPE is
  //     NOT pinned by the signature, contradicting a comment that said it was.
  //
  // Both are properties of the URL, so they are asserted on the URL.
  const shape = await gm.req('POST', '/api/assets/presign', {
    kind: 'portrait', campaign_id: camp.id, mime: 'image/png', bytes: PNG.length,
  });
  const signed = new URL(shape.data.upload.url);
  t('the presigned url carries NO precomputed checksum',
    !signed.searchParams.get('x-amz-checksum-crc32'),
    'a checksum computed at signing time is the checksum of an empty body');
  t('the length IS signed', /content-length/.test(signed.searchParams.get('X-Amz-SignedHeaders') || ''),
    signed.searchParams.get('X-Amz-SignedHeaders'));
  t('the client is told to send Content-Type and nothing else',
    Object.keys(shape.data.upload.headers).join(',') === 'Content-Type',
    Object.keys(shape.data.upload.headers).join(','));
  t('Content-Length is NOT handed to the client (fetch forbids setting it)',
    !('Content-Length' in shape.data.upload.headers));
  t('the url expires quickly', Number(signed.searchParams.get('X-Amz-Expires')) <= 900,
    signed.searchParams.get('X-Amz-Expires'));
  track(shape);

  // [ADDED 2026-08-09] The presigned URL and the Content-Security-Policy are
  // two independent parts of this system that MUST agree, and nothing checked
  // that they did. They disagreed twice in a row for different reasons: first
  // connect-src was absent entirely, then it named the wrong addressing style —
  // the SDK uses virtual-hosted URLs (`bucket.account.r2...`) and the policy
  // listed only the account host.
  //
  // Both failures were invisible to every Node probe, because CSP is enforced
  // by a browser against a document and a test client has neither. Asserting
  // the agreement here is the cheapest available substitute for a real browser.
  const page = await fetch(`${BASE}/actors.html`);
  const csp = page.headers.get('content-security-policy') || '';
  const connectSrc = (csp.split(';').find((d) => d.trim().startsWith('connect-src')) || '');
  t('the page sends a connect-src directive', !!connectSrc,
    'without it the fallback is default-src, which refuses the upload origin');
  t('...and it permits the origin the presigned url actually uses',
    connectSrc.includes(signed.origin), `${signed.origin} not in "${connectSrc.trim()}"`);
  t('...while still permitting the websocket transport',
    /ws:|wss:|'self'/.test(connectSrc), connectSrc.trim());

  console.log('\n--- the full upload path ---');
  const pres = track(await gm.req('POST', '/api/assets/presign', {
    kind: 'map', campaign_id: camp.id, mime: 'image/png', bytes: PNG.length,
  }));
  t('the GM is authorised for one upload', pres.status === 201, `${pres.status}`);
  t('...the asset starts pending', pres.data.asset.status === 'pending');
  t('...and the key was chosen by the SERVER, under the campaign',
    (await knex('assets').where({ id: pres.data.asset.id }).first())
      .storage_key.startsWith(`c/${camp.id}/map/`));

  const putStatus = await putToPresigned(pres.data.upload, PNG);
  t('the bytes go straight to R2, never through this server',
    putStatus >= 200 && putStatus < 300, `PUT returned ${putStatus}`);

  const confirmed = await gm.req('POST', `/api/assets/${pres.data.asset.id}/confirm`);
  t('confirming verifies the bytes and marks it ready',
    confirmed.status === 200 && confirmed.data.asset.status === 'ready', `${confirmed.status}`);
  t('...recording the type established by INSPECTION', confirmed.data.asset.mime === 'image/png');
  t('...and its real size', confirmed.data.asset.bytes === PNG.length);
  t('confirming twice is refused',
    (await gm.req('POST', `/api/assets/${pres.data.asset.id}/confirm`)).status === 409);

  console.log('\n--- THE PROBE THAT MATTERS: bytes that lie about their type ---');
  // R2 stores and serves exactly what it is given, unlike an image CDN that
  // transcodes. The declared type is a claim; the bytes are the evidence.
  const evil = track(await gm.req('POST', '/api/assets/presign', {
    kind: 'map', campaign_id: camp.id, mime: 'image/png', bytes: NOT_AN_IMAGE.length,
  }));
  await putToPresigned(evil.data.upload, NOT_AN_IMAGE);
  const rejected = await gm.req('POST', `/api/assets/${evil.data.asset.id}/confirm`);
  t('HTML uploaded as image/png is REFUSED at confirm',
    rejected.status === 400, `${rejected.status}`);
  const evilRow = await knex('assets').where({ id: evil.data.asset.id }).first();
  t('...the row is marked rejected, never ready', evilRow.status === 'rejected', evilRow.status);
  t('...and it never becomes visible in the library',
    !(await gm.req('GET', `/api/assets?campaign_id=${camp.id}`))
      .data.assets.some((a) => a.id === evil.data.asset.id));

  console.log('\n--- BOLA on confirm ---');
  const victim = track(await gm.req('POST', '/api/assets/presign', {
    kind: 'map', campaign_id: camp.id, mime: 'image/png', bytes: PNG.length,
  }));
  t('a different user cannot confirm somebody else upload -> 404',
    (await pl.req('POST', `/api/assets/${victim.data.asset.id}/confirm`)).status === 404);
  t('confirming an upload that never happened -> 409',
    (await gm.req('POST', `/api/assets/${victim.data.asset.id}/confirm`)).status === 409);

  console.log('\n--- the signature pins the size ---');
  const small = track(await gm.req('POST', '/api/assets/presign', {
    kind: 'portrait', campaign_id: camp.id, mime: 'image/png', bytes: PNG.length,
  }));
  const oversize = await fetch(small.data.upload.url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: Buffer.concat([PNG, Buffer.alloc(50000)]),
  });
  t('R2 refuses a body larger than was signed, before our code runs',
    oversize.status >= 400, `${oversize.status} — the length is part of the signature`);

  note('teardown', `${await teardown(gm, pl)} asset(s) removed from the bucket and the database`);

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
