// Batched delivery authorization against a real PostgreSQL. No server.
//
//   node scripts/test-local.js test-delivery-batch-auth.js
//
// Production capacity test, 2026-10-01: checking each recipient of a realtime
// message in its own transaction cost ~55 ms per socket in series, so delivery
// time grew with every connection and join notices grew as N x N.
// src/coordination/authorization.js accessMany() now checks every recipient of
// one message in ONE transaction. This suite proves, with real row locks:
//   - the number of SQL statements does not grow with the number of recipients
//   - each recipient is still judged individually (banned, expired, revoked,
//     closed game, owner)
//   - the session and membership rows stay share-locked until the writes are
//     enqueued: a revocation issued during delivery waits for it
//   - a session row held by another transaction is skipped (no waiting, so no
//     deadlock against a multi-row session delete) and returned as `fallback`
//   - a session deleted before delivery is refused (through the fallback check)

const knex = require('../../src/db');
const { randomUUID } = require('node:crypto');
const { createAuthorization } = require('../../src/coordination/authorization');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${name}`); } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};
const RUN = `batch-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
const created = { users: [], sids: [], campaigns: [] };

async function user(tag) {
  const [u] = await knex('users').insert({
    email: `${RUN}-${tag}@example.com`, username: `${tag}${Math.random().toString(16).slice(2, 10)}`, password_hash: 'x',
  }).returning('id');
  const id = u.id || u; created.users.push(id); return id;
}
async function session(userId, { expiresInMs = 3600_000 } = {}) {
  const sid = `${RUN}-${randomUUID()}`;
  await knex('session').insert({ sid, sess: { cookie: {}, passport: { user: userId } }, expire: new Date(Date.now() + expiresInMs) });
  created.sids.push(sid); return sid;
}
const sock = (userId, sid) => ({ connected: true, data: { userId, authSessionId: sid } });

async function main() {
  const auth = createAuthorization(knex);
  const owner = await user('gm');
  const [c] = await knex('campaigns').insert({ name: `${RUN}-game`, owner_id: owner }).returning('id');
  const cid = c.id || c; created.campaigns.push(cid);
  // The owner needs no membership row: owner_id alone authorizes them.
  async function player(tag, status = 'active') {
    const id = await user(tag);
    await knex('campaign_members').insert({ campaign_id: cid, user_id: id, status });
    return id;
  }

  // ── statement count is constant ──────────────────────────────────────────────
  console.log('\n--- one transaction, constant statements, whatever the number of recipients ---');
  const players = [];
  for (let i = 0; i < 8; i += 1) players.push(await player(`p${i}`)); // eslint-disable-line no-await-in-loop
  const sockets = [sock(owner, await session(owner))];
  for (const p of players) sockets.push(sock(p, await session(p))); // eslint-disable-line no-await-in-loop
  const count = async (list) => {
    let n = 0; const on = () => { n += 1; };
    knex.on('query', on);
    try { await auth.accessMany(list, cid, false, () => {}); } finally { knex.removeListener('query', on); }
    return n;
  };
  const small = await count(sockets.slice(0, 2));
  const large = await count(sockets);
  t('2 recipients and 9 recipients run the same number of statements', small === large && small > 0, `2 -> ${small}, 9 -> ${large}`);
  let delivered = [];
  const r = await auth.accessMany(sockets, cid, false, (campaign, list) => { delivered = list; });
  t('all 9 active recipients are allowed and delivered', r.allowed.length === 9 && delivered.length === 9, JSON.stringify({ a: r.allowed.length, d: r.denied.length, f: r.fallback.length }));

  // ── individual judgement ────────────────────────────────────────────────────
  console.log('\n--- each recipient judged on its own ---');
  const banned = await player('banned', 'banned');
  const expired = await player('expired');
  const bannedSock = sock(banned, await session(banned));
  const expiredSock = sock(expired, await session(expired, { expiresInMs: -1000 }));
  const thief = sock(players[0], sockets[2].data.authSessionId);   // another user's session id
  const mixed = [sockets[0], sockets[1], bannedSock, expiredSock, thief];
  const m = await auth.accessMany(mixed, cid, false, () => {});
  t('the owner and an active player are allowed', m.allowed.includes(sockets[0]) && m.allowed.includes(sockets[1]) && m.allowed.length === 2,
    JSON.stringify(m.allowed.map((s) => s.data.userId)));
  t('a banned member, an expired session and a borrowed session id are refused',
    [bannedSock, expiredSock, thief].every((s) => m.denied.includes(s)));
  await knex('campaigns').where({ id: cid }).update({ is_open: false });
  const closed = await auth.accessMany([sockets[0], sockets[1]], cid, false, () => {});
  t('a closed game: the owner is allowed, a player is refused', closed.allowed.length === 1 && closed.allowed[0] === sockets[0] && closed.denied[0] === sockets[1]);
  const lobby = await auth.accessMany([sockets[1]], cid, true, () => {});
  t('...but the player\'s dashboard (lobby) still is', lobby.allowed.length === 1);
  await knex('campaigns').where({ id: cid }).update({ is_open: true });

  // ── locks held through the enqueue ───────────────────────────────────────────
  console.log('\n--- a revocation during delivery waits for it ---');
  // The final statement before the synchronous enqueue reads the database
  // clock. A wrapped transaction pauses there, issues a session DELETE from
  // another connection, and checks in pg_stat_activity that the DELETE is
  // waiting on a lock: the share lock the batch holds while it enqueues.
  const victim = sockets[3];
  let blockedSeen = false; let revoke; let revokeDoneAt = 0;
  const wrapped = {
    transaction: (fn) => knex.transaction((trx) => {
      const w = (...args) => trx(...args);
      w.raw = async (sql, ...rest) => {
        if (String(sql).includes('clock_timestamp') && !revoke) {
          revoke = knex('session').where({ sid: victim.data.authSessionId }).del().then(() => { revokeDoneAt = Date.now(); });
          const until = Date.now() + 3000;
          while (Date.now() < until && !blockedSeen) {
            // eslint-disable-next-line no-await-in-loop
            const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND query ILIKE 'delete from "session"%'`);
            blockedSeen = rows[0].n > 0;
            if (!blockedSeen) await new Promise((r2) => setTimeout(r2, 50)); // eslint-disable-line no-await-in-loop
          }
        }
        return trx.raw(sql, ...rest);
      };
      return fn(w);
    }),
  };
  let deliveredTo = 0;
  await createAuthorization(wrapped).accessMany(sockets, cid, false, (campaign, list) => { deliveredTo = list.length; });
  const committedAt = Date.now();
  await revoke;
  t('a session DELETE issued during the batch waits on its lock', blockedSeen);
  t('...the delivery still reaches every recipient, including that one', deliveredTo === 9, String(deliveredTo));
  t('...and the DELETE completes only after the batch commits', revokeDoneAt >= committedAt - 5, `${revokeDoneAt} vs ${committedAt}`);
  const after = await auth.accessMany([victim], cid, false, () => {});
  t('the revoked socket then goes back for the single check', after.fallback.length === 1 && after.allowed.length === 0);
  t('...which refuses it', (await auth.access(victim, cid, false, () => {})) === false);

  // ── a busy session row is skipped, not waited on ─────────────────────────────
  console.log('\n--- a session row held by another transaction is skipped ---');
  const busy = sockets[4];
  let releaseHolder; const held = new Promise((r2) => { releaseHolder = r2; });
  let holderReady; const ready = new Promise((r2) => { holderReady = r2; });
  const holder = knex.transaction(async (trx) => {
    await trx('session').where({ sid: busy.data.authSessionId }).forUpdate().first();
    holderReady(); await held;
  });
  await ready;
  const started = Date.now();
  const s = await auth.accessMany(sockets.filter((x) => x !== victim), cid, false, () => {});
  const took = Date.now() - started;
  releaseHolder(); await holder;
  t('the batch did not wait for the held row', took < 1000, `${took} ms`);
  t('the held socket is handed back as fallback; the rest are allowed', s.fallback.length === 1 && s.fallback[0] === busy && s.allowed.length === 7,
    JSON.stringify({ a: s.allowed.length, f: s.fallback.length, d: s.denied.length }));
  t('once the row is free, the single check allows it', (await auth.access(busy, cid, false, () => {})) === true);

  // ── teardown ────────────────────────────────────────────────────────────────
  await knex('session').whereIn('sid', created.sids).del();
  await knex('campaigns').whereIn('id', created.campaigns).del();
  await knex('users').whereIn('id', created.users).del();
  console.log(`\n${pass} passed, ${fail} failed`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error('SUITE CRASHED:', e); await knex.destroy(); process.exit(1); });
