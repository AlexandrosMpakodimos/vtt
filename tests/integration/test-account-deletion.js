// Account deletion (Fix 4) — POST /api/auth/delete-account. Real Postgres and
// the isolated test server (memory object storage).
//
//   node scripts/test-local.js test-account-deletion.js
//
// Covers the plan "Account deletion: DECIDED 2026-10-05":
//   - refusals: not signed in, cross-origin, missing / non-string / wrong /
//     over-length password; the per-account rate limit
//   - the owner of a live campaign gets 409 with the list, and NOTHING changes
//   - success: the user, every session, the memberships and the e-mail and
//     reset tokens are gone; messages, actors, tokens and assets in other
//     people's campaigns are kept with the link set to NULL; chat lines keep
//     the old name
//   - the avatar and the soft-deleted campaign's image are queued in
//     storage_cleanup, their verified bytes move to cleanup debt, and the
//     cleanup worker then deletes the objects and releases the debt
//   - every open socket of the account is cut off; the GM's room is told
//   - no response carries password_hash
//   - the shared 40001 retry: two real serialization conflicts, in process
//     against the same database (a campaign transferred to the user while the
//     deletion runs, and a concurrent write to the ledger row)
//
// It saves the storage_budget row first and restores it at the end, and
// removes every row and object it created.

const crypto = require('node:crypto');
const { io } = require('socket.io-client');
const knex = require('../../src/db');
const budget = require('../../src/services/storageBudget');
const { deleteAccount, AVATAR_CLEANUP_REASON } = require('../../src/services/accountDeletion');

const BASE = process.env.BASE_URL;
const PASSWORD = 'correct-horse-battery-staple-9';
const RUN = 'acctdel-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
  'base64'
);

let passed = 0; let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sockets = [];
const createdUsers = new Set();
const createdCampaigns = new Set();
const responses = [];   // every raw body this suite received, for the leak check

function agent(initialCookie = '') {
  let cookie = initialCookie;
  async function send(method, path, { body, raw, origin = BASE, mime } = {}) {
    const headers = { ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) };
    let payload;
    if (raw) { headers['Content-Type'] = mime || 'application/octet-stream'; payload = raw; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    responses.push(text);
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: res.status, data, text, headers: res.headers };
  }
  return {
    get cookie() { return cookie; },
    req: (method, path, body, opts = {}) => send(method, path, { ...opts, body }),
    upload: (query, bytes) => send('POST', '/api/assets/upload?' + new URLSearchParams(query), { raw: bytes, mime: query.mime }),
  };
}

async function makeUser(tag) {
  const client = agent();
  const email = `${RUN}-${tag}@example.com`;
  const username = (tag + crypto.randomBytes(4).toString('hex')).slice(0, 30);
  const r = await client.req('POST', '/api/auth/register', { email, password: PASSWORD, username });
  if (r.status !== 201) throw new Error('register ' + tag + ': ' + r.status);
  const row = await knex('users').where({ email }).first('id');
  createdUsers.add(row.id);
  await knex('users').where({ id: row.id }).update({ email_verified_at: knex.fn.now() });
  const login = await client.req('POST', '/api/auth/login', { email, password: PASSWORD });
  if (login.status !== 200) throw new Error('login ' + tag + ': ' + login.status);
  return { id: row.id, email, username, client };
}
async function secondLogin(user) {
  const b = agent();
  const r = await b.req('POST', '/api/auth/login', { email: user.email, password: PASSWORD });
  if (r.status !== 200) throw new Error('second login: ' + r.status);
  return b;
}
async function createCampaign(user, name) {
  const r = await user.client.req('POST', '/api/campaigns', { name: RUN + ' ' + name, is_public: true });
  if (r.status !== 201) throw new Error('create campaign: ' + r.status + ' ' + r.text);
  createdCampaigns.add(r.data.campaign.id);
  return r.data.campaign;
}
const sessionCount = async (userId) => Number((await knex('session')
  .whereRaw("sess -> 'passport' ->> 'user' = ?", [userId]).count({ n: '*' }).first()).n);
const ledger = async () => {
  const r = await knex('storage_budget').where({ id: true }).first();
  return { committed: Number(r.committed_bytes), reserved: Number(r.reserved_bytes), debt: Number(r.cleanup_debt_bytes) };
};
async function inventory() {
  const r = await fetch(BASE + '/__test/identity', { signal: AbortSignal.timeout(5000) });
  return (await r.json()).storageInventory;
}

async function connect(cookie) {
  const socket = io(BASE, { autoConnect: false, extraHeaders: { Cookie: cookie, Origin: BASE },
    transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 5000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
    socket.connect();
  });
  return socket;
}
function join(socket, campaignId) {
  return new Promise((resolve) => {
    socket.timeout(2500).emit('campaign:join', { campaign_id: campaignId }, (error, response) => {
      resolve(error ? { timeout: true } : response);
    });
  });
}
function disconnected(socket, ms) {
  return new Promise((resolve) => {
    if (!socket.connected) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), ms);
    socket.once('disconnect', () => { clearTimeout(timer); resolve(true); });
  });
}
async function reconnectRefused(cookie) {
  const socket = io(BASE, { autoConnect: false, extraHeaders: { Cookie: cookie, Origin: BASE },
    transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  return new Promise((resolve) => {
    let done = false;
    const finish = (refused) => { if (done) return; done = true; clearTimeout(timer); socket.close(); resolve(refused); };
    const timer = setTimeout(() => finish(false), 4000);
    socket.once('connect_error', () => finish(true));
    socket.once('disconnect', () => finish(true));
    socket.once('unauthorized', () => finish(true));
    socket.connect();
  });
}

// Wait until some backend of this database waits on a lock while running a
// statement that matches `pattern` (the deletion's own statement).
async function waitForLockWait(pattern) {
  for (let i = 0; i < 200; i++) {
    // eslint-disable-next-line no-await-in-loop
    const rows = (await knex.raw(
      `SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`
    )).rows;
    if (rows.some((r) => pattern.test(r.query))) return true;
    // eslint-disable-next-line no-await-in-loop
    await settle(25);
  }
  return false;
}

// Opens a transaction on its own connection and keeps it open until finish().
async function holdTransaction(work) {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const outcome = knex.transaction(async (trx) => {
    await work(trx);
    ready();
    await done;
  });
  await Promise.race([started, outcome]);
  return { commit: async () => { finish(); await outcome; } };
}

async function main() {
  if (process.env.NODE_ENV !== 'test' || BASE !== 'http://127.0.0.1:3001') {
    throw new Error('Use node scripts/test-local.js test-account-deletion.js');
  }
  const savedLedger = await knex('storage_budget').where({ id: true }).first();
  if (!savedLedger) throw new Error('Test budget row missing (run migrations)');
  await knex('storage_budget').where({ id: true }).update({
    committed_bytes: 0, reserved_bytes: 0, cleanup_debt_bytes: 0, class_a_used: 0, class_b_used: 0,
    period_start: knex.raw("now() - interval '1 day'"), period_end: knex.raw("now() + interval '1 day'"),
  });
  try {
    await scenarios();
  } finally {
    await teardown(savedLedger);
  }
}

async function scenarios() {
  // ── refusals before any work ───────────────────────────────────────────────
  console.log('\n--- refusals: auth, origin, password ---');
  const r = await makeUser('ref');
  check('not signed in: 401', (await agent().req('POST', '/api/auth/delete-account', { currentPassword: PASSWORD })).status === 401);
  const foreign = await r.client.req('POST', '/api/auth/delete-account', { currentPassword: PASSWORD }, { origin: 'https://evil.example' });
  check('a cross-origin request is blocked (verifyOrigin): 403', foreign.status === 403, String(foreign.status));
  const missing = await r.client.req('POST', '/api/auth/delete-account', {});
  check('a missing password: 400 currentPassword is required',
    missing.status === 400 && missing.data?.error === 'currentPassword is required', missing.text);
  const typed = await r.client.req('POST', '/api/auth/delete-account', { currentPassword: 12345678 });
  check('a non-string password: 400', typed.status === 400, typed.text);
  const wrong = await r.client.req('POST', '/api/auth/delete-account', { currentPassword: PASSWORD + 'x' });
  check('a wrong password: 400 current password is incorrect (as /change-password)',
    wrong.status === 400 && wrong.data?.error === 'current password is incorrect', wrong.text);
  check('after those refusals the account is intact',
    !!(await knex('users').where({ id: r.id }).first('id')) && (await r.client.req('GET', '/api/auth/me')).status === 200);

  // ── rate limit (per account, 5 per 15 minutes) ────────────────────────────
  console.log('\n--- rate limit ---');
  // r has used 3 of its 5 (missing, non-string, wrong; the 401 and the 403
  // never reach the limiter).
  const fourth = await r.client.req('POST', '/api/auth/delete-account', { currentPassword: 'x'.repeat(65) });
  check('the 4th attempt is answered (an over-length password: 400, no hashing)',
    fourth.status === 400 && fourth.data?.error === 'current password is incorrect', fourth.text);
  const fifth = await r.client.req('POST', '/api/auth/delete-account', { currentPassword: 'another-wrong-one' });
  check('the 5th attempt is still answered (400)', fifth.status === 400, fifth.text);
  const sixth = await r.client.req('POST', '/api/auth/delete-account', { currentPassword: PASSWORD });
  check('the 6th attempt in the window: 429, even with the right password', sixth.status === 429, sixth.text);
  check('...with Retry-After', Number(sixth.headers.get('retry-after')) > 0);
  check('...and the account still exists', !!(await knex('users').where({ id: r.id }).first('id')));
  const rb = await secondLogin(r);
  check('the limit is per account: another session of it is limited too',
    (await rb.req('POST', '/api/auth/delete-account', { currentPassword: PASSWORD })).status === 429);
  const other = await makeUser('oth');
  const otherTry = await other.client.req('POST', '/api/auth/delete-account', { currentPassword: 'wrong-password-1' });
  check('...while another account from the same address is not', otherTry.status === 400, otherTry.text);

  // ── the owner of a live campaign: 409 and nothing changes ─────────────────
  console.log('\n--- owner of a live campaign ---');
  const u = await makeUser('own');
  const gm = await makeUser('gm');
  const live = await createCampaign(u, 'live lair');
  const doomed = await createCampaign(u, 'old lair');
  // An image in the campaign that will be soft-deleted, and a link there too.
  const map = await u.client.upload({ kind: 'map', mime: 'image/png', campaign_id: doomed.id }, PNG);
  check('setup: map uploaded into the campaign to be soft-deleted', map.status === 201, map.text);
  const link = await u.client.req('POST', '/api/assets/external', { kind: 'map', campaign_id: doomed.id, url: 'https://elsewhere.example/map.png' });
  check('setup: external link recorded there', link.status === 201, link.text);
  const avatar = await u.client.upload({ kind: 'avatar', mime: 'image/png' }, PNG);
  check('setup: avatar uploaded', avatar.status === 201, avatar.text);
  const mapRow = await knex('assets').where({ id: map.data.asset.id }).first();
  const avatarRow = await knex('assets').where({ id: avatar.data.asset.id }).first();
  check('setup: both uploads are verified, committed bytes',
    mapRow.bytes_verified && avatarRow.bytes_verified && mapRow.bytes > 0 && avatarRow.bytes > 0);
  check('setup: soft-delete the second campaign', (await u.client.req('DELETE', '/api/campaigns/' + doomed.id)).status === 200);

  // The other GM's live campaign, where u plays.
  const table = await createCampaign(gm, 'their table');
  check('setup: u joins the other GM\'s table', (await u.client.req('POST', `/api/campaigns/${table.id}/join`, {})).status === 200);
  const said = await u.client.req('POST', `/api/campaigns/${table.id}/messages`, { content: 'hello from ' + RUN });
  check('setup: u speaks at that table', said.status === 201, said.text);
  const [actor] = await knex('actors').insert({ campaign_id: table.id, user_id: u.id, name: RUN + ' hero' }).returning('id');
  const scene = await gm.client.req('POST', `/api/campaigns/${table.id}/scenes`, { name: RUN + ' scene' });
  check('setup: a scene', scene.status === 201, scene.text);
  const [token] = await knex('tokens').insert({ scene_id: scene.data.scene.id, created_by: u.id, actor_id: actor.id || actor, name: 'hero' }).returning('id');
  const [theirAsset] = await knex('assets').insert({
    campaign_id: table.id, user_id: u.id, url: 'https://elsewhere.example/portrait.png', kind: 'portrait', status: 'ready',
  }).returning('id');
  await knex('email_verification_tokens').insert({ user_id: u.id, token_hash: crypto.randomBytes(32).toString('hex'),
    purpose: 'email_change', expires_at: knex.raw("now() + interval '1 hour'") });
  await knex('password_reset_tokens').insert({ user_id: u.id, token_hash: crypto.randomBytes(32).toString('hex'),
    expires_at: knex.raw("now() + interval '1 hour'") });

  const snapshot = async () => ({
    user: !!(await knex('users').where({ id: u.id }).first('id')),
    sessions: await sessionCount(u.id),
    members: Number((await knex('campaign_members').where({ user_id: u.id }).count({ n: '*' }).first()).n),
    campaigns: Number((await knex('campaigns').where({ owner_id: u.id }).count({ n: '*' }).first()).n),
    assets: Number((await knex('assets').where({ user_id: u.id }).count({ n: '*' }).first()).n),
    queued: Number((await knex('storage_cleanup').whereIn('storage_key', [mapRow.storage_key, avatarRow.storage_key]).count({ n: '*' }).first()).n),
    authTokens: Number((await knex('email_verification_tokens').where({ user_id: u.id }).count({ n: '*' }).first()).n)
      + Number((await knex('password_reset_tokens').where({ user_id: u.id }).count({ n: '*' }).first()).n),
    ledger: await ledger(),
  });
  const before = await snapshot();
  const refused = await u.client.req('POST', '/api/auth/delete-account', { currentPassword: PASSWORD });
  check('owner of a live campaign: 409', refused.status === 409, refused.text);
  check('...code owns_campaigns', refused.data?.code === 'owns_campaigns');
  check('...listing exactly the live campaign, as id and name only',
    Array.isArray(refused.data?.campaigns) && refused.data.campaigns.length === 1
    && refused.data.campaigns[0].id === live.id && refused.data.campaigns[0].name === live.name
    && Object.keys(refused.data.campaigns[0]).sort().join() === 'id,name', refused.text);
  const after = await snapshot();
  check('...and nothing changed (user, sessions, memberships, campaigns, assets, queue, auth tokens, ledger)',
    JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
  check('...the soft-deleted campaign is still restorable (row present)', !!(await knex('campaigns').where({ id: doomed.id }).first('id')));

  // ── success ───────────────────────────────────────────────────────────────
  console.log('\n--- success, after the live campaign is deleted ---');
  check('setup: delete the live campaign too (it becomes soft-deleted)',
    (await u.client.req('DELETE', '/api/campaigns/' + live.id)).status === 200);
  const second = await secondLogin(u);
  check('setup: two sessions of u', (await sessionCount(u.id)) === 2);
  const sockA = await connect(u.client.cookie);
  const sockB = await connect(second.cookie);
  const sockGm = await connect(gm.client.cookie);
  check('setup: u\'s second socket joins the table', (await join(sockB, table.id))?.ok === true);
  check('setup: the GM\'s socket joins the table', (await join(sockGm, table.id))?.ok === true);
  const memberEvents = [];
  sockGm.on('member:updated', (p) => memberEvents.push(p));
  const kicked = [];
  sockB.on('unauthorized', () => kicked.push('B'));
  sockA.on('unauthorized', () => kicked.push('A'));
  const ledgerBefore = await ledger();
  const inventoryBefore = await inventory();
  const oldName = u.username;

  const gone = await u.client.req('POST', '/api/auth/delete-account', { currentPassword: PASSWORD });
  check('success: 204', gone.status === 204, gone.status + ' ' + gone.text);
  check('...with an empty body', gone.text === '');
  check('...and the session cookie cleared', /connect\.sid=;/.test(gone.headers.get('set-cookie') || ''), gone.headers.get('set-cookie'));
  check('the users row is gone', !(await knex('users').where({ id: u.id }).first('id')));
  await settle(300);
  check('every session row of the account is gone', (await sessionCount(u.id)) === 0);
  check('the deleting session\'s cookie no longer signs in', (await agent(u.client.cookie).req('GET', '/api/auth/me')).status === 401);
  check('the other session\'s cookie no longer signs in', (await second.req('GET', '/api/auth/me')).status === 401);
  check('the second logged-in socket is cut off', await disconnected(sockB, 3000));
  check('...told it is unauthorized first', kicked.includes('B'), JSON.stringify(kicked));
  check('the deleting session\'s own socket is cut off too', await disconnected(sockA, 3000));
  check('...and the old cookie cannot open a new socket', await reconnectRefused(second.cookie));
  check('the GM\'s socket stays connected', sockGm.connected);
  await settle(300);
  check('the GM\'s room is told the roster changed (member:updated, ids only)',
    memberEvents.some((p) => p.campaign_id === table.id && p.user_id === u.id
      && Object.keys(p).sort().join() === 'campaign_id,user_id'), JSON.stringify(memberEvents));
  check('memberships are gone', Number((await knex('campaign_members').where({ user_id: u.id }).count({ n: '*' }).first()).n) === 0);
  check('the e-mail and reset tokens are gone',
    !(await knex('email_verification_tokens').where({ user_id: u.id }).first('id'))
    && !(await knex('password_reset_tokens').where({ user_id: u.id }).first('id')));
  check('the user\'s soft-deleted campaigns are gone', !(await knex('campaigns').whereIn('id', [live.id, doomed.id]).first('id')));
  check('...with their asset rows', !(await knex('assets').whereIn('campaign_id', [live.id, doomed.id]).first('id')));
  check('the avatar row is gone', !(await knex('assets').where({ id: avatarRow.id }).first('id')));

  const msg = await knex('messages').where({ campaign_id: table.id }).where('content', 'hello from ' + RUN).first();
  check('SET NULL: the chat line is kept, unlinked', msg && msg.user_id === null);
  check('...and keeps the old name', msg && msg.speaker_name === oldName, msg && msg.speaker_name);
  const log = await gm.client.req('GET', `/api/campaigns/${table.id}/messages`);
  check('...which the GM still sees in the log under that name',
    log.status === 200 && log.data.messages.some((m) => m.content === 'hello from ' + RUN && m.speaker_name === oldName));
  const a = await knex('actors').where({ id: actor.id || actor }).first();
  check('SET NULL: the character is kept, unassigned', a && a.user_id === null);
  const tk = await knex('tokens').where({ id: token.id || token }).first();
  check('SET NULL: the token is kept, created_by NULL, still linked to the character',
    tk && tk.created_by === null && tk.actor_id === (actor.id || actor));
  const ta = await knex('assets').where({ id: theirAsset.id || theirAsset }).first();
  check('SET NULL: the image in the other GM\'s campaign is kept, user_id NULL', ta && ta.user_id === null);
  check('the other GM\'s campaign is untouched', !!(await knex('campaigns').where({ id: table.id }).whereNull('deleted_at').first('id')));

  // Storage: both stored objects queued, bytes moved to debt, exactly once.
  const qMap = await knex('storage_cleanup').where({ storage_key: mapRow.storage_key });
  const qAvatar = await knex('storage_cleanup').where({ storage_key: avatarRow.storage_key });
  check('the soft-deleted campaign\'s image is queued once, reason campaign_purged, with its size',
    qMap.length === 1 && qMap[0].reason === 'campaign_purged' && Number(qMap[0].bytes) === mapRow.bytes, JSON.stringify(qMap));
  check(`the avatar is queued once, reason ${AVATAR_CLEANUP_REASON}, with its size`,
    qAvatar.length === 1 && qAvatar[0].reason === AVATAR_CLEANUP_REASON && Number(qAvatar[0].bytes) === avatarRow.bytes, JSON.stringify(qAvatar));
  check('the external link is not queued (nothing stored)',
    !(await knex('storage_cleanup').where('storage_key', 'like', '%elsewhere.example%').first('id')));
  const ledgerAfter = await ledger();
  const moved = mapRow.bytes + avatarRow.bytes;
  check('ledger: the verified bytes moved from committed to cleanup debt, reservations unchanged',
    ledgerAfter.committed === ledgerBefore.committed - moved && ledgerAfter.debt === ledgerBefore.debt + moved
    && ledgerAfter.reserved === ledgerBefore.reserved, JSON.stringify({ ledgerBefore, ledgerAfter, moved }));
  for (const row of [...qMap, ...qAvatar]) {
    // eslint-disable-next-line no-await-in-loop
    const done = await fetch(`${BASE}/__test/cleanup/${row.id}?repeat=1`, { method: 'POST', signal: AbortSignal.timeout(10000) });
    check('the cleanup worker processes the queued ' + row.reason + ' row', done.status === 200);
  }
  const ledgerDone = await ledger();
  check('after the worker: the debt is released exactly once',
    ledgerDone.debt === ledgerBefore.debt && ledgerDone.committed === ledgerAfter.committed, JSON.stringify(ledgerDone));
  const inventoryDone = await inventory();
  check('after the worker: both objects are gone from storage',
    inventoryDone.count === inventoryBefore.count - 2 && inventoryDone.bytes === inventoryBefore.bytes - moved,
    JSON.stringify({ inventoryBefore, inventoryDone }));
  check('after the worker: the queue rows are gone',
    !(await knex('storage_cleanup').whereIn('storage_key', [mapRow.storage_key, avatarRow.storage_key]).first('id')));

  const again = await agent(u.client.cookie).req('POST', '/api/auth/delete-account', { currentPassword: PASSWORD });
  check('a replay with the old cookie: 401', again.status === 401);

  // ── no response leaked the hash ───────────────────────────────────────────
  console.log('\n--- leak check ---');
  check('no response in this suite contains password_hash or an Argon2id hash',
    responses.every((t) => !/password_hash/.test(t) && !/\$argon2/.test(t)));

  // ── the shared 40001 retry, with real conflicts ────────────────────────────
  console.log('\n--- serialization retry (in process) ---');
  await retryTransferRace();
  await retryLedgerRace();

  console.log('\n--- other outcomes of the transaction (in process) ---');
  await otherOutcomes();
}

async function directUser(tag) {
  const [row] = await knex('users').insert({
    email: `${RUN}-${tag}@example.com`, username: (tag + crypto.randomBytes(5).toString('hex')).slice(0, 30), password_hash: 'x',
  }).returning('id');
  const id = row.id || row;
  createdUsers.add(id);
  return id;
}

// A campaign is transferred to the user by a transaction that commits while the
// deletion's first attempt is running. That attempt's snapshot predates the
// transfer, so its ownership check passes; the cascade from the users row then
// meets the transferred campaign and PostgreSQL aborts with 40001. The retry
// sees the campaign and refuses. Without the retry this would be a 500; with a
// weaker isolation level, the transferred game could be deleted by the cascade.
async function retryTransferRace() {
  const v = await directUser('vrace');
  const w = await directUser('wrace');
  const [k] = await knex('campaigns').insert({ owner_id: w, name: RUN + ' transferred' }).returning(['id', 'name']);
  createdCampaigns.add(k.id);
  let sessionsCalls = 0;
  const destroySessions = async () => { sessionsCalls += 1; return []; };

  const transfer = await holdTransaction(async (trx) => {
    await trx('campaigns').where({ id: k.id }).update({ owner_id: v });
  });
  const pending = deleteAccount({ userId: v, expectedHash: 'x', destroySessions });
  const blocked = await waitForLockWait(/from "users"[\s\S]*for update/i);
  check('retry (transfer): the deletion waits on the user row while the transfer is open', blocked);
  await transfer.commit();
  const result = await pending;
  check('retry (transfer): the first attempt ran to the users delete (sessions step reached once)', sessionsCalls === 1, String(sessionsCalls));
  check('retry (transfer): after the retry the deletion refuses: owns_campaigns with that campaign',
    result.outcome === 'owns_campaigns' && result.campaigns.length === 1 && result.campaigns[0].id === k.id, JSON.stringify(result));
  check('retry (transfer): the user and the transferred campaign both survive',
    !!(await knex('users').where({ id: v }).first('id'))
    && !!(await knex('campaigns').where({ id: k.id, owner_id: v }).whereNull('deleted_at').first('id')));
}

// A concurrent write to the single ledger row while the deletion moves the
// avatar's bytes: the deletion's UPDATE waits, then aborts with 40001 once the
// other transaction commits; the retry completes. The object is queued and the
// bytes moved exactly once.
async function retryLedgerRace() {
  const x = await directUser('xrace');
  const key = `avatars/${RUN}/race.png`;
  await knex('assets').insert({ user_id: x, campaign_id: null, kind: 'avatar', status: 'ready', url: 'https://storage.test.invalid/' + key,
    storage_key: key, mime: 'image/png', bytes: 1234, bytes_verified: true });
  await knex('storage_budget').where({ id: true }).update({ committed_bytes: knex.raw('committed_bytes + 1234') });
  const before = await ledger();
  let sessionsCalls = 0;
  const destroySessions = async () => { sessionsCalls += 1; return []; };

  // Observe each attempt's ledger move: how many ran, and what the failed ones threw.
  const realMove = budget.moveToCleanupDebtIn;
  const moves = [];
  budget.moveToCleanupDebtIn = async (trx, bytes) => {
    try { const r = await realMove(trx, bytes); moves.push('ok'); return r; }
    catch (err) { moves.push(err.code || err.message); throw err; }
  };
  let result;
  try {
    const writer = await holdTransaction(async (trx) => {
      await trx('storage_budget').where({ id: true }).update({ updated_at: trx.fn.now() });
    });
    const pending = deleteAccount({ userId: x, expectedHash: 'x', destroySessions });
    const blocked = await waitForLockWait(/update "storage_budget"/i);
    check('retry (ledger): the deletion waits on the ledger row while the other write is open', blocked);
    await writer.commit();
    result = await pending;
  } finally {
    budget.moveToCleanupDebtIn = realMove;
  }
  check('retry (ledger): the first attempt aborted with 40001 and a second attempt ran',
    moves.length === 2 && moves[0] === '40001' && moves[1] === 'ok', JSON.stringify(moves));
  check('retry (ledger): the deletion completes after the retry', result.outcome === 'deleted', JSON.stringify(result));
  check('retry (ledger): the aborted attempt never reached the sessions step; the retry did, once', sessionsCalls === 1, String(sessionsCalls));
  check('retry (ledger): the user is gone', !(await knex('users').where({ id: x }).first('id')));
  const q = await knex('storage_cleanup').where({ storage_key: key });
  check('retry (ledger): the avatar is queued exactly once, with its size', q.length === 1 && Number(q[0].bytes) === 1234, JSON.stringify(q));
  const after = await ledger();
  check('retry (ledger): its bytes moved to debt exactly once',
    after.committed === before.committed - 1234 && after.debt === before.debt + 1234, JSON.stringify({ before, after }));
  await knex('storage_cleanup').where({ storage_key: key }).del();
}

// The two remaining outcomes: an avatar upload still running, and a password
// that changed between the route's Argon2id check and the transaction.
async function otherOutcomes() {
  const y = await directUser('ypend');
  const destroySessions = async () => [];
  const fresh = `avatars/${RUN}/fresh.png`;
  const [row] = await knex('assets').insert({ user_id: y, campaign_id: null, kind: 'avatar', status: 'pending',
    url: 'https://storage.test.invalid/' + fresh, storage_key: fresh, reserved_bytes: 500 }).returning('id');
  await knex('storage_budget').where({ id: true }).update({ reserved_bytes: knex.raw('reserved_bytes + 500') });
  const before = await ledger();
  const busy = await deleteAccount({ userId: y, expectedHash: 'x', destroySessions });
  check('an avatar upload still in its request: upload_in_progress', busy.outcome === 'upload_in_progress', JSON.stringify(busy));
  check('...and nothing changed', !!(await knex('users').where({ id: y }).first('id'))
    && !!(await knex('assets').where({ id: row.id || row }).first('id'))
    && !(await knex('storage_cleanup').where({ storage_key: fresh }).first('id'))
    && JSON.stringify(await ledger()) === JSON.stringify(before));

  // The same row, older than the stale-sweep window: an upload that died.
  await knex('assets').where({ id: row.id || row }).update({ created_at: knex.raw("now() - interval '2 hours'") });
  const done = await deleteAccount({ userId: y, expectedHash: 'x', destroySessions });
  check('a dead upload (older than the sweep window) does not block', done.outcome === 'deleted', JSON.stringify(done));
  const q = await knex('storage_cleanup').where({ storage_key: fresh });
  check('...its object is queued with an unknown size', q.length === 1 && q[0].bytes === null, JSON.stringify(q));
  const after = await ledger();
  check('...and its reservation is released', after.reserved === before.reserved - 500, JSON.stringify({ before, after }));
  await knex('storage_cleanup').where({ storage_key: fresh }).del();

  const z = await directUser('zchg');
  let called = 0;
  const changed = await deleteAccount({ userId: z, expectedHash: 'not-the-hash', destroySessions: async () => { called += 1; return []; } });
  check('a password changed during the request: changed, nothing done',
    changed.outcome === 'changed' && called === 0 && !!(await knex('users').where({ id: z }).first('id')), JSON.stringify(changed));
}

async function teardown(savedLedger) {
  for (const s of sockets) s.close();
  try {
    const ids = [...createdCampaigns];
    if (ids.length) {
      await knex('storage_cleanup').whereIn('storage_key',
        knex('assets').whereIn('campaign_id', ids).whereNotNull('storage_key').select('storage_key')).del();
      await knex('campaigns').whereIn('id', ids).del();
    }
    await knex('campaigns').where('name', 'like', RUN + '%').del();
    const users = [...createdUsers];
    if (users.length) {
      await knex('campaigns').whereIn('owner_id', users).del();
      await knex('assets').whereIn('user_id', users).del();
      await knex('session').whereRaw("sess -> 'passport' ->> 'user' = ANY(?)", [users]).del();
      await knex('users').whereIn('id', users).del();
    }
    await knex('storage_cleanup').where('storage_key', 'like', `%${RUN}%`).del();
    const leftovers = Number((await knex('assets').whereNotNull('storage_key').count({ n: '*' }).first()).n)
      + Number((await knex('storage_cleanup').count({ n: '*' }).first()).n);
    check('teardown: no stored assets or cleanup rows are left behind', leftovers === 0, String(leftovers));
  } finally {
    await knex('storage_budget').where({ id: true }).update({
      committed_bytes: savedLedger.committed_bytes, reserved_bytes: savedLedger.reserved_bytes,
      cleanup_debt_bytes: savedLedger.cleanup_debt_bytes, class_a_used: savedLedger.class_a_used,
      class_b_used: savedLedger.class_b_used, period_start: savedLedger.period_start, period_end: savedLedger.period_end,
    });
  }
}

main()
  .then(async () => { console.log(`\n${passed} passed, ${failed} failed`); await knex.destroy(); process.exit(failed ? 1 : 0); })
  .catch(async (e) => {
    console.error('SUITE CRASHED:', e.message);
    console.log(`\n${passed} passed, ${failed + 1} failed`);
    await knex.destroy(); process.exit(1);
  });
