// Campaign purge — a permanently deleted campaign's images reach the durable
// cleanup queue. Real Postgres, NO server.
//
//   node scripts/test-local.js test-campaign-purge.js
//
// Found in the production review (2026-10-01): the hourly purge of campaigns
// past their 30-day recovery window cascaded the asset ROWS away but never
// deleted the OBJECTS, which then stayed in the bucket, billed and invisible to
// the ledger. src/services/campaignPurge.js now queues every stored object in
// the same serialisable transaction that removes the rows. This suite checks:
//   - which rows are purged, and which are left alone (personal avatars, a
//     campaign still inside its window, a live campaign)
//   - one queue row per stored object, none for an external link
//   - the ledger: verified bytes move committed -> cleanup debt, a pending
//     upload's reservation is released, unknown sizes are queued as null
//   - the cleanup worker then deletes and releases exactly once
//   - a failure half-way rolls the whole run back
//   - with the ledger uninitialised, objects are still queued, sizes as null
//
// Like test-storage-cleanup.js it sets the shared storage_budget row to known
// values and returns it to "uninitialised" at the end. storage.remove is
// stubbed, so no bucket is involved.

const knex = require('../../src/db');
const { FIXTURE_CAMPAIGN_HASH } = require('../helpers/campaignFixture');
const storage = require('../../src/services/storage');
const budget = require('../../src/services/storageBudget');

storage.remove = async () => true;
storage.isConfigured = () => true;

const cleanup = require('../../src/services/storageCleanup');
const { purgeExpiredCampaigns } = require('../../src/services/campaignPurge');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${name}`); } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

const RUN = `purge-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
const key = (name) => `c/${RUN}/${name}.png`;

async function setLedger({ committed = 0, reserved = 0, debt = 0, initialised = true } = {}) {
  await knex('storage_budget').where({ id: true }).update({
    committed_bytes: committed, reserved_bytes: reserved, cleanup_debt_bytes: debt,
    class_a_used: 0, class_b_used: 0,
    period_start: initialised ? knex.raw("now() - interval '1 day'") : null,
    period_end: initialised ? knex.raw("now() + interval '29 days'") : null,
  });
}
const ledger = async () => {
  const r = await knex('storage_budget').where({ id: true }).first();
  return { committed: Number(r.committed_bytes), reserved: Number(r.reserved_bytes), debt: Number(r.cleanup_debt_bytes) };
};
const queued = async (k) => knex('storage_cleanup').where({ storage_key: k }).select('*');

async function makeUser(tag) {
  const [u] = await knex('users').insert({
    email: `${RUN}-${tag}@example.com`, username: `${tag}${Math.random().toString(16).slice(2, 10)}`, password_hash: 'x',
  }).returning('id');
  return u.id || u;
}
async function makeCampaign(owner, tag, deletedDaysAgo) {
  const [c] = await knex('campaigns').insert({
    name: `${RUN}-${tag}`, owner_id: owner, password_hash: FIXTURE_CAMPAIGN_HASH,
    deleted_at: deletedDaysAgo == null ? null : knex.raw(`now() - interval '${deletedDaysAgo} days'`),
  }).returning('id');
  return c.id || c;
}
async function makeAsset(fields) {
  const [a] = await knex('assets').insert(Object.assign({
    url: `https://objects.test/${fields.storage_key || 'external'}`, kind: 'map', status: 'ready', mime: 'image/png',
  }, fields)).returning('id');
  return a.id || a;
}

async function main() {
  if (!(await knex('storage_budget').where({ id: true }).first())) {
    console.log('  FAIL  run migrations first'); console.log('\n0 passed, 1 failed'); process.exit(1);
  }
  const owner = await makeUser('gm');

  // ── an expired campaign with every kind of asset ─────────────────────────────
  console.log('\n--- an expired campaign: rows purged, objects queued, ledger moved ---');
  const expired = await makeCampaign(owner, 'expired', 31);
  const inWindow = await makeCampaign(owner, 'in-window', 10);
  const live = await makeCampaign(owner, 'live', null);
  await makeAsset({ campaign_id: expired, user_id: owner, storage_key: key('verified'), bytes: 3_000_000, bytes_verified: true });
  await makeAsset({ campaign_id: expired, user_id: owner, storage_key: key('unverified'), bytes: 500, bytes_verified: false });
  await makeAsset({ campaign_id: expired, user_id: owner, storage_key: key('pending'), status: 'pending', reserved_bytes: 2_000_000 });
  await makeAsset({ campaign_id: expired, user_id: owner, storage_key: null, url: 'https://elsewhere.example/a.png' });
  const avatar = await makeAsset({ campaign_id: null, user_id: owner, kind: 'avatar', storage_key: key('avatar'), bytes: 100, bytes_verified: true });
  const keepWindow = await makeAsset({ campaign_id: inWindow, user_id: owner, storage_key: key('in-window'), bytes: 100, bytes_verified: true });
  const keepLive = await makeAsset({ campaign_id: live, user_id: owner, storage_key: key('live'), bytes: 100, bytes_verified: true });
  await setLedger({ committed: 5_000_000, reserved: 2_000_000 });

  const r = await purgeExpiredCampaigns();
  t('the run reports at least this campaign and its four assets', r.campaigns >= 1 && r.assets >= 4 && r.queued >= 3, JSON.stringify(r));
  t('the expired campaign is gone', !(await knex('campaigns').where({ id: expired }).first()));
  t('its asset rows are gone', Number((await knex('assets').where({ campaign_id: expired }).count({ n: '*' }).first()).n) === 0);

  const qv = await queued(key('verified'));
  t('the verified upload is queued once, with its size', qv.length === 1 && Number(qv[0].bytes) === 3_000_000, JSON.stringify(qv));
  t('...under reason campaign_purged', qv[0] && qv[0].reason === 'campaign_purged');
  const qu = await queued(key('unverified'));
  t('an unverified size is queued as unknown (null)', qu.length === 1 && qu[0].bytes === null, JSON.stringify(qu));
  const qp = await queued(key('pending'));
  t('an unconfirmed upload\'s object is queued too, size unknown', qp.length === 1 && qp[0].bytes === null, JSON.stringify(qp));

  let l = await ledger();
  t('verified bytes moved from committed to cleanup debt', l.committed === 2_000_000 && l.debt === 3_000_000, JSON.stringify(l));
  t('the pending upload\'s reservation was released', l.reserved === 0, JSON.stringify(l));

  t('a personal avatar is untouched', !!(await knex('assets').where({ id: avatar }).first()) && (await queued(key('avatar'))).length === 0);
  t('a campaign still inside its 30 days is untouched',
    !!(await knex('campaigns').where({ id: inWindow }).first()) && !!(await knex('assets').where({ id: keepWindow }).first())
    && (await queued(key('in-window'))).length === 0);
  t('a live campaign is untouched',
    !!(await knex('campaigns').where({ id: live }).first()) && !!(await knex('assets').where({ id: keepLive }).first())
    && (await queued(key('live'))).length === 0);

  // ── the worker finishes the job, exactly once ────────────────────────────────
  console.log('\n--- the cleanup worker deletes the objects and releases the debt once ---');
  const mine = await knex('storage_cleanup').where('storage_key', 'like', `c/${RUN}/%`).select('*');
  for (const row of mine) await cleanup.processRow(row); // eslint-disable-line no-await-in-loop
  l = await ledger();
  t('the debt is released after deletion', l.debt === 0 && l.committed === 2_000_000, JSON.stringify(l));
  t('the queue rows are gone', (await knex('storage_cleanup').where('storage_key', 'like', `c/${RUN}/%`)).length === 0);
  for (const row of mine) await cleanup.processRow(row); // eslint-disable-line no-await-in-loop
  t('processing the same rows again releases nothing more', (await ledger()).debt === 0 && (await ledger()).committed === 2_000_000);
  await purgeExpiredCampaigns();
  t('a second purge queues nothing again for the same campaign', (await queued(key('verified'))).length === 0);

  // ── a failure part-way rolls everything back ─────────────────────────────────
  console.log('\n--- a failure half-way leaves no partial purge ---');
  const crash = await makeCampaign(owner, 'crash', 40);
  await makeAsset({ campaign_id: crash, user_id: owner, storage_key: key('crash-a'), bytes: 1_000, bytes_verified: true });
  await makeAsset({ campaign_id: crash, user_id: owner, storage_key: key('crash-b'), bytes: 2_000, bytes_verified: true });
  await setLedger({ committed: 10_000 });
  const realMove = budget.moveToCleanupDebtIn;
  let calls = 0;
  budget.moveToCleanupDebtIn = async (trx, bytes) => {
    calls += 1;
    if (calls === 2) throw new Error('simulated crash');
    return realMove(trx, bytes);
  };
  let threw = false;
  try { await purgeExpiredCampaigns(); } catch { threw = true; }
  budget.moveToCleanupDebtIn = realMove;
  t('the run reports the failure', threw);
  t('the campaign is still there', !!(await knex('campaigns').where({ id: crash }).first()));
  t('both asset rows are still there', Number((await knex('assets').where({ campaign_id: crash }).count({ n: '*' }).first()).n) === 2);
  t('nothing was queued', (await queued(key('crash-a'))).length === 0 && (await queued(key('crash-b'))).length === 0);
  l = await ledger();
  t('the ledger is unchanged', l.committed === 10_000 && l.debt === 0, JSON.stringify(l));
  const retry = await purgeExpiredCampaigns();
  t('the next run completes it', !(await knex('campaigns').where({ id: crash }).first()) && retry.queued >= 2, JSON.stringify(retry));
  l = await ledger();
  t('...moving both sizes into debt', l.committed === 7_000 && l.debt === 3_000, JSON.stringify(l));
  await knex('storage_cleanup').where('storage_key', 'like', `c/${RUN}/%`).del();

  // ── an uninitialised ledger still queues the objects ────────────────────────
  console.log('\n--- with the ledger uninitialised, objects are still queued ---');
  const noLedger = await makeCampaign(owner, 'no-ledger', 35);
  await makeAsset({ campaign_id: noLedger, user_id: owner, storage_key: key('no-ledger'), bytes: 4_000, bytes_verified: true });
  await setLedger({ committed: 9_000, initialised: false });
  await purgeExpiredCampaigns();
  const qn = await queued(key('no-ledger'));
  t('the object is queued', qn.length === 1, JSON.stringify(qn));
  t('...with an unknown size, so a later release takes nothing', qn[0] && qn[0].bytes === null);
  l = await ledger();
  t('the ledger was not touched', l.committed === 9_000 && l.debt === 0, JSON.stringify(l));

  // ── teardown ────────────────────────────────────────────────────────────────
  await knex('storage_cleanup').where('storage_key', 'like', `c/${RUN}/%`).del();
  await knex('assets').where('storage_key', 'like', `c/${RUN}/%`).del();
  await knex('campaigns').where('name', 'like', `${RUN}-%`).del();
  await knex('users').where({ id: owner }).del();
  await setLedger({ initialised: false });

  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error('SUITE CRASHED:', e); await knex.destroy(); process.exit(1); });
