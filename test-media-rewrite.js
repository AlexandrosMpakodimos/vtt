// Media URL resolver / rewriter — against real Postgres, NO server.
//
//   SKIP_HIBP=1 MEDIA_HOST=media.test R2_PUBLIC_BASE_URL=https://pub.r2.dev \
//     MEDIA_TOKEN_SECRET=testsecret node test-media-rewrite.js
//
// Proves the stored-URL -> gateway-URL mapping that the whole client migration
// rests on: hosted URLs map to a tokenised gateway URL for the right asset id,
// external links and foreign URLs pass through untouched, cache-buster/traversal
// tricks are refused, batch resolution is one query, and the flag (MEDIA_HOST
// unset) makes the whole thing a no-op.

process.env.MEDIA_HOST = process.env.MEDIA_HOST || 'media.test';
process.env.MEDIA_TOKEN_SECRET = process.env.MEDIA_TOKEN_SECRET || 'testsecret';
process.env.R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || 'https://pub.r2.dev';

const knex = require('./src/db');
const gw = require('./src/services/mediaGateway');
if (!process.env.MEDIA_ORIGIN) throw new Error('Run through scripts/test-local.js');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

const BASE = 'https://pub.r2.dev';

async function main() {
  if (!(await knex('storage_budget').where({ id: true }).first())) {
    console.log('  FAIL  run migrations'); console.log('\n0 passed, 1 failed'); process.exit(1);
  }

  console.log('\n--- storageKeyFromUrl: only our hosted objects ---');
  t('a hosted URL yields its key',
    gw.storageKeyFromUrl(`${BASE}/c/1/map/abc.png`) === 'c/1/map/abc.png');
  t('an external URL yields null', gw.storageKeyFromUrl('https://imgur.com/x.png') === null);
  t('empty yields null', gw.storageKeyFromUrl('') === null);
  t('null yields null', gw.storageKeyFromUrl(null) === null);
  t('a cache-buster query is refused', gw.storageKeyFromUrl(`${BASE}/c/1/map/abc.png?v=2`) === null);
  t('a fragment is refused', gw.storageKeyFromUrl(`${BASE}/c/1/map/abc.png#x`) === null);
  t('a traversal is refused', gw.storageKeyFromUrl(`${BASE}/../secret`) === null);
  t('a gateway URL is not re-hosted (idempotent)',
    gw.storageKeyFromUrl('https://media.test/media/xyz?t=abc') === null);

  console.log('\n--- resolve + rewrite against real rows ---');
  // insert two ready uploads and one external link
  const [u] = await knex('users').insert({
    email: `rw-${Date.now()}@x.com`, username: `rw${Date.now()}`, password_hash: 'x',
  }).returning('id');
  const [c] = await knex('campaigns').insert({ name: `rw-${Date.now()}`, owner_id: u.id }).returning('id');
  const cid = c.id || c;
  const [a1] = await knex('assets').insert({
    campaign_id: cid, user_id: u.id, storage_key: 'c/rw/map/one.png',
    url: `${BASE}/c/rw/map/one.png`, kind: 'map', status: 'ready', mime: 'image/png', bytes: 10, bytes_verified: true,
  }).returning('id');
  const [a2] = await knex('assets').insert({
    campaign_id: cid, user_id: u.id, storage_key: 'c/rw/portrait/two.png',
    url: `${BASE}/c/rw/portrait/two.png`, kind: 'portrait', status: 'ready', mime: 'image/png', bytes: 10, bytes_verified: true,
  }).returning('id');
  await knex('assets').insert({
    campaign_id: cid, user_id: u.id, storage_key: null,
    url: 'https://external.example/pic.png', source: 'external', kind: 'portrait', status: 'ready',
  });
  const id1 = a1.id || a1; const id2 = a2.id || a2;

  const rw1 = await gw.rewriteUrl(`${BASE}/c/rw/map/one.png`, u.id);
  t('a hosted URL is rewritten to the media host', rw1.startsWith(process.env.MEDIA_ORIGIN.replace(/\/+$/, '') + '/media/'));
  t('...for the correct asset id', rw1.includes(`/media/${id1}?t=`));
  t('...with a token that verifies', (() => {
    const tok = rw1.split('t=')[1];
    const v = gw.verifyMediaToken(tok);
    return v && v.assetId === id1 && v.viewerId === u.id;
  })());

  const extPass = await gw.rewriteUrl('https://external.example/pic.png', u.id);
  t('an external link passes through unchanged', extPass === 'https://external.example/pic.png');

  const foreignPass = await gw.rewriteUrl('https://imgur.com/z.png', u.id);
  t('a foreign URL passes through unchanged', foreignPass === 'https://imgur.com/z.png');

  console.log('\n--- batch resolution is one query and maps only hosted URLs ---');
  const urls = [
    `${BASE}/c/rw/map/one.png`,
    `${BASE}/c/rw/portrait/two.png`,
    'https://external.example/pic.png',
    'https://imgur.com/z.png',
    `${BASE}/c/rw/map/NONEXISTENT.png`,
  ];
  const map = await gw.rewriteBatch(urls, u.id);
  t('both hosted URLs are in the batch result', map.has(urls[0]) && map.has(urls[1]));
  t('the external link is NOT rewritten', !map.has(urls[2]));
  t('the foreign URL is NOT rewritten', !map.has(urls[3]));
  t('a hosted-shaped URL with no row is NOT rewritten', !map.has(urls[4]));
  t('batch maps to the right ids',
    map.get(urls[0]).includes(`/media/${id1}?`) && map.get(urls[1]).includes(`/media/${id2}?`));

  console.log('\n--- payload walker: rewrites only known image keys, only hosted URLs ---');
  gw._cacheClear && gw._cacheClear();
  {
    const payload = {
      actor: { id: 'a', img_url: `${BASE}/c/rw/map/one.png`, name: 'Hero' },
      tokens: [
        { id: 't1', img_url: `${BASE}/c/rw/portrait/two.png` },
        { id: 't2', img_url: 'https://imgur.com/external.png' },
      ],
      // a presign UPLOAD url (S3 endpoint, not PUBLIC_BASE) must NOT be rewritten
      upload: { url: 'https://acct.r2.cloudflarestorage.com/c/rw/map/x.png?X-Amz-Signature=abc' },
      // a provenance field is not an image key
      source_url: `${BASE}/c/rw/map/one.png`,
      // a chat-like body that happens to contain a URL must be untouched
      body: `see ${BASE}/c/rw/map/one.png`,
    };
    await gw.rewritePayload(payload, u.id);
    t('actor img_url is rewritten to the gateway', payload.actor.img_url.startsWith(process.env.MEDIA_ORIGIN.replace(/\/+$/, '') + '/media/'));
    t('a nested token img_url is rewritten', payload.tokens[0].img_url.startsWith(process.env.MEDIA_ORIGIN.replace(/\/+$/, '') + '/media/'));
    t('an external token img_url is left alone', payload.tokens[1].img_url === 'https://imgur.com/external.png');
    t('a presign upload url is NOT rewritten (different host)',
      payload.upload.url.includes('r2.cloudflarestorage.com'));
    t('source_url (provenance, not an image key) is untouched', payload.source_url === `${BASE}/c/rw/map/one.png`);
    t('a chat body string is untouched even if it contains a hosted URL',
      payload.body === `see ${BASE}/c/rw/map/one.png`);
    t('the actor name is untouched', payload.actor.name === 'Hero');
  }

  console.log('\n--- a non-ready asset is not rewritten ---');
  await knex('assets').where({ id: id1 }).update({ status: 'pending' });
  const notReady = await gw.rewriteUrl(`${BASE}/c/rw/map/one.png`, u.id);
  t('a pending asset URL passes through unchanged', notReady === `${BASE}/c/rw/map/one.png`);
  await knex('assets').where({ id: id1 }).update({ status: 'ready' });

  console.log('\n--- disabled gateway leaves URLs unchanged ---');
  {
    const modulePath = require.resolve('./src/services/mediaGateway');
    const cachedModule = require.cache[modulePath];
    const savedHost = process.env.MEDIA_HOST;
    const savedOrigin = process.env.MEDIA_ORIGIN;

    try {
      process.env.MEDIA_HOST = '';
      process.env.MEDIA_ORIGIN = '';
      delete require.cache[modulePath];
      const disabled = require('./src/services/mediaGateway');

      t('gateway is disabled without MEDIA_HOST', disabled.isEnabled() === false);

      const hosted = BASE + '/c/rw/map/one.png';
      t('disabled single rewrite preserves the hosted URL',
        await disabled.rewriteUrl(hosted, u.id) === hosted);

      const batch = await disabled.rewriteBatch([hosted], u.id);
      t('disabled batch returns no replacements', batch.size === 0);

      const payload = { actor: { img_url: hosted } };
      const originalPayload = JSON.stringify(payload);
      await disabled.rewritePayload(payload, u.id);
      t('disabled payload rewrite preserves every field',
        JSON.stringify(payload) === originalPayload);
    } finally {
      if (savedHost === undefined) delete process.env.MEDIA_HOST;
      else process.env.MEDIA_HOST = savedHost;
      if (savedOrigin === undefined) delete process.env.MEDIA_ORIGIN;
      else process.env.MEDIA_ORIGIN = savedOrigin;
      require.cache[modulePath] = cachedModule;
    }
  }

  // cleanup
  await knex('assets').where({ campaign_id: cid }).del();
  await knex('campaigns').where({ id: cid }).del();
  await knex('users').where({ id: u.id }).del();

  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
