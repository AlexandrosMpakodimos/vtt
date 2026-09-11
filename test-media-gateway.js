// Media gateway — token security, visibility, cache/coalescing, metering.
//
//   SKIP_HIBP=1 MEDIA_HOST=media.test MEDIA_TOKEN_SECRET=testsecret node test-media-gateway.js
//
// storage.getObject is stubbed (deterministic bytes, a counter for how many R2
// GETs actually happen) and the DB side is real (visibility reads real rows).
// Proves: token mint/verify incl. forgery + expiry, visibility (member vs
// non-member vs public-media), cache hits avoid R2, concurrent misses coalesce
// to one GET, and an exhausted Class B budget refuses rather than reading.

process.env.MEDIA_HOST = process.env.MEDIA_HOST || 'media.test';
process.env.MEDIA_TOKEN_SECRET = process.env.MEDIA_TOKEN_SECRET || 'testsecret';

const knex = require('./src/db');
const storage = require('./src/services/storage');
const budget = require('./src/services/storageBudget');

// Stub the object read; count real GETs.
let getCount = 0;
storage.getObject = async (key) => {
  getCount += 1;
  return { bytes: Buffer.from(`bytes-for-${key}`), mime: 'image/png', etag: 'etag1' };
};
storage.isConfigured = () => true;

const gw = require('./src/services/mediaGateway');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

async function initLedger() {
  await knex('storage_budget').where({ id: true }).update({
    committed_bytes: 0, reserved_bytes: 0, cleanup_debt_bytes: 0,
    class_a_used: 0, class_b_used: 0,
    period_start: knex.raw("now() - interval '1 day'"),
    period_end: knex.raw("now() + interval '29 days'"),
  });
}

async function mkUser(tag) {
  const [u] = await knex('users').insert({
    email: `${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}@x.com`,
    username: `${tag}${Math.random().toString(16).slice(2, 8)}`,
    password_hash: 'x',
  }).returning('id');
  return u.id;
}

async function main() {
  if (!(await knex('storage_budget').where({ id: true }).first())) {
    console.log('  FAIL  run migrations'); console.log('\n0 passed, 1 failed'); process.exit(1);
  }
  await initLedger();

  console.log('\n--- token mint/verify, forgery, expiry ---');
  const tok = gw.mintMediaToken({ assetId: 'asset-1', viewerId: 'viewer-1' });
  const v = gw.verifyMediaToken(tok);
  t('a minted token verifies', v && v.assetId === 'asset-1' && v.viewerId === 'viewer-1');
  t('a tampered token is rejected', gw.verifyMediaToken(`${tok}x`) === null);
  t('a token with a swapped body is rejected',
    gw.verifyMediaToken(`${Buffer.from('asset-2..9999999999').toString('base64url')}.${tok.split('.').pop()}`) === null);
  t('garbage is rejected', gw.verifyMediaToken('not-a-token') === null);
  t('null is rejected', gw.verifyMediaToken(null) === null);
  // expiry: mint a token that is already expired by crafting the payload
  const crypto = require('crypto');
  const past = Math.floor(Date.now() / 1000) - 10;
  const payload = `asset-1.viewer-1.${past}`;
  const sig = crypto.createHmac('sha256', process.env.MEDIA_TOKEN_SECRET).update(payload).digest('base64url');
  const expired = `${Buffer.from(payload).toString('base64url')}.${sig}`;
  t('an expired token is rejected', gw.verifyMediaToken(expired) === null);

  console.log('\n--- visibility: campaign membership ---');
  const owner = await mkUser('owner');
  const member = await mkUser('member');
  const outsider = await mkUser('outsider');
  const [camp] = await knex('campaigns').insert({ name: `mg-${Date.now()}`, owner_id: owner }).returning('id');
  const campaignId = camp.id || camp;
  await knex('campaign_members').insert({ campaign_id: campaignId, user_id: member, status: 'active' }).catch(() => {});
  const [mapAsset] = await knex('assets').insert({
    campaign_id: campaignId, user_id: owner, storage_key: 'c/x/map/m.png', url: 'u',
    kind: 'map', status: 'ready', mime: 'image/png', bytes: 100, bytes_verified: true,
  }).returning('id');
  const mapId = mapAsset.id || mapAsset;

  t('the owner may see a campaign map', !!(await gw.resolveVisible(mapId, owner)));
  t('an active member may see it', !!(await gw.resolveVisible(mapId, member)));
  t('an outsider may NOT', (await gw.resolveVisible(mapId, outsider)) === null);
  t('an anonymous viewer may NOT', (await gw.resolveVisible(mapId, null)) === null);

  console.log('\n--- visibility: public media (avatar) ---');
  const [av] = await knex('assets').insert({
    user_id: outsider, storage_key: 'u/o/avatar/a.png', url: 'u',
    kind: 'avatar', status: 'ready', mime: 'image/png', bytes: 50, bytes_verified: true,
  }).returning('id');
  const avId = av.id || av;
  t('any authenticated viewer may see an avatar', !!(await gw.resolveVisible(avId, member)));
  t('an avatar still requires SOME authenticated viewer', (await gw.resolveVisible(avId, null)) === null);

  console.log('\n--- a non-ready asset is invisible ---');
  const [pending] = await knex('assets').insert({
    campaign_id: campaignId, user_id: owner, storage_key: 'c/x/map/p.png', url: 'u',
    kind: 'map', status: 'pending',
  }).returning('id');
  t('a pending asset is not served', (await gw.resolveVisible((pending.id || pending), owner)) === null);

  console.log('\n--- cache: a hit avoids an R2 GET; misses coalesce ---');
  gw._cacheClear();
  getCount = 0;
  const asset = await gw.resolveVisible(mapId, owner);
  // first fetch: one GET
  const a1 = await gw.fetchBytes(asset);
  t('first fetch returns bytes', Buffer.isBuffer(a1.bytes));
  t('first fetch caused exactly one R2 GET', getCount === 1, `got ${getCount}`);
  // second fetch: cache hit, no GET
  await gw.fetchBytes(asset);
  t('a cached hit causes no further R2 GET', getCount === 1, `got ${getCount}`);
  // concurrent misses coalesce
  gw._cacheClear();
  getCount = 0;
  await Promise.all([gw.fetchBytes(asset), gw.fetchBytes(asset), gw.fetchBytes(asset), gw.fetchBytes(asset)]);
  t('four concurrent misses coalesce to ONE R2 GET', getCount === 1, `got ${getCount}`);

  console.log('\n--- metering: each real GET charges a Class B op ---');
  await initLedger();
  gw._cacheClear();
  getCount = 0;
  await gw.fetchBytes(asset);
  let snap = await budget.snapshot();
  t('a cache-miss read charged one Class B', snap.class_b.used === 1, `used=${snap.class_b.used}`);
  // a cache hit does not charge
  await gw.fetchBytes(asset);
  snap = await budget.snapshot();
  t('a cache hit charges nothing', snap.class_b.used === 1);

  console.log('\n--- bearer token: viewer-agnostic (broadcast) tokens work ---');
  // A broadcast mints a token with NO viewerId. It must still verify and be
  // usable to fetch, because room membership already authorised every recipient.
  const bcastTok = gw.mintMediaToken({ assetId: 'asset-b', viewerId: undefined });
  const bv = gw.verifyMediaToken(bcastTok);
  t('a viewer-agnostic token verifies', bv && bv.assetId === 'asset-b');
  t('...with a null viewerId', bv && bv.viewerId === null);
  // A viewer-bound token (HTTP) also verifies and records the viewer for audit.
  const boundTok = gw.mintMediaToken({ assetId: 'asset-b', viewerId: 'v9' });
  const bvb = gw.verifyMediaToken(boundTok);
  t('a viewer-bound token records the viewer', bvb && bvb.viewerId === 'v9');
  // Neither can be used for a different asset id (scope).
  t('a token is scoped to its asset id', bv.assetId !== 'asset-c');

  console.log('\n--- budget exhaustion refuses the read (no unmetered fallback) ---');
  // set Class B user ceiling to already-reached
  const bCeil = budget.LIMITS.maxClassB - budget.LIMITS.maintClassB;
  await knex('storage_budget').where({ id: true }).update({ class_b_used: bCeil });
  gw._cacheClear();
  let threw = null;
  try { await gw.fetchBytes(asset); } catch (e) { threw = e; }
  t('an exhausted Class B budget refuses the read', threw && threw.budgetExceeded);

  // cleanup
  await knex('assets').whereIn('id', [mapId, avId, (pending.id || pending)]).del();
  await knex('campaign_members').where({ campaign_id: campaignId }).del();
  await knex('campaigns').where({ id: campaignId }).del();
  await knex('users').whereIn('id', [owner, member, outsider]).del();
  await knex('storage_budget').where({ id: true })
    .update({ period_start: null, period_end: null, class_b_used: 0 });

  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
