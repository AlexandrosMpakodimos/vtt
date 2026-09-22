// Synthetic schemas only, in the unchanged guarded local vtt_test database.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
if (process.env.NODE_ENV !== 'test') throw new Error('Session migration tests require NODE_ENV=test.');
const config = require('../../knexfile').test;
const makeKnex = require('knex');
const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(require('express-session'));
const migration = require('../../src/db/migrations/20260921000000_create_session_store');
const filename = '20260921000000_create_session_store.js';
const fs = require('node:fs');
const path = require('node:path');
const directory = path.resolve(__dirname, '../../src/db/migrations');
const historical = fs.readdirSync(directory).filter(n => n.endsWith('.js') && n !== filename).sort();
const admin = makeKnex(config);
const schemas = [], clients = [], stores = [], pools = [];
let passed = 0;
let stage = 'guarded connection';
async function check(fn) { await fn(); passed++; }
async function fixture() {
  const schema = `db_review_${randomBytes(8).toString('hex')}`;
  // Register before creation so a partially failed setup is still cleaned up.
  schemas.push(schema); await admin.raw('CREATE SCHEMA ??', [schema]);
  const local = {
    ...config, migrations: { ...config.migrations, schemaName: schema },
    pool: { ...config.pool, afterCreate(client, done) {
      config.pool.afterCreate(client, error => {
        if (error) return done(error, client);
        client.query(`SET search_path TO "${schema}"`, err => done(err, client));
      });
    } },
  };
  const db = makeKnex(local); clients.push(db);
  return { schema, db, local };
}
function call(store, method, ...args) {
  return new Promise((resolve, reject) => store[method](...args, (err, result) => err ? reject(err) : resolve(result)));
}
async function tests() {
  // This connection must pass the original role/database/privilege guard first.
  await admin.raw('SELECT 1');
  // Failure injection is available only after the unchanged real test DB guard.
  if (process.argv[2]?.startsWith('--inject=')) {
    const mode = process.argv[2].slice('--inject='.length);
    assert(['setup', 'cleanup', 'both', 'timeout', 'multiple'].includes(mode));
    await fixture();
    if (mode === 'setup') {
      const error = new Error('Injected partial setup failure'); error.code = 'INJECTED_SETUP'; throw error;
    }
    const pool = new Pool({ ...config.connection, onConnect: client => new Promise((resolve, reject) => config.pool.afterCreate(client, err => err ? reject(err) : resolve())) });
    pools.push(pool); await pool.query('SELECT 1');
    const store = new PgSession({ pool, pruneSessionInterval: false, createTableIfMissing: false });
    stores.push(store);
    if (mode === 'cleanup' || mode === 'both' || mode === 'multiple') store.close = () => { throw new Error('Injected cleanup failure'); };
    if (mode === 'multiple') pool.end = () => { throw new Error('Injected second cleanup failure'); };
    if (mode === 'timeout') store.close = () => new Promise(() => {});
    if (mode === 'setup' || mode === 'both') {
      const error = new Error('Injected partial setup failure'); error.code = 'INJECTED_SETUP'; throw error;
    }
    return;
  }
  for (const mode of ['setup', 'cleanup', 'both', 'timeout', 'multiple']) {
    const child = spawnSync(process.execPath, [__filename, `--inject=${mode}`], {
      env: process.env, encoding: 'utf8', timeout: 30000,
    });
    await check(() => assert.equal(child.error, undefined));
    await check(() => assert.equal(child.status, 1));
    await check(() => assert.equal(child.signal, null));
    await check(() => assert(!child.stdout.includes('passed, 0 failed')));
    await check(() => assert(!child.stderr.includes('UnhandledPromiseRejection')));
    const report = JSON.parse(child.stdout.trim());
    await check(() => assert.equal(report.primary, ['setup', 'both'].includes(mode) ? 'INJECTED_SETUP' : null));
    await check(() => assert.equal(report.cleanup.length, mode === 'setup' ? 0 : mode === 'multiple' ? 2 : 1));
    await check(() => assert.deepEqual(report.cleanup.map(f => f.step), mode === 'setup' ? [] : mode === 'multiple' ? ['store:0', 'pool:0'] : ['store:0']));
    if (mode === 'timeout') await check(() => assert.equal(report.cleanup[0].timeout, true));
    await check(() => assert.deepEqual(report.attempted, mode === 'setup' ? ['client:0', 'schema:0', 'admin'] : ['store:0', 'pool:0', 'client:0', 'schema:0', 'admin']));
    for (const schema of report.schemas) {
      await check(async () => assert.equal((await admin.raw('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=?', [schema])).rows[0].n, 0));
    }
  }
  stage = 'fresh schema and session operations';
  const fresh = await fixture();
  await fresh.db.migrate.latest();
  await check(async () => assert.equal(fs.readdirSync(directory).filter(n => n.endsWith('.js')).length, historical.length + 1));
  const names = await fresh.db('knex_migrations').orderBy('id').pluck('name');
  await check(async () => assert.deepEqual(names, [...historical, filename].sort()));
  await check(async () => assert.equal((await fresh.db.migrate.latest())[1].length, 0));
  const pool = new Pool({ ...config.connection, onConnect: client => new Promise((resolve, reject) => config.pool.afterCreate(client, err => err ? reject(err) : resolve())) });
  pools.push(pool);
  const store = new PgSession({ pool, schemaName: fresh.schema, createTableIfMissing: false, pruneSessionInterval: false }); stores.push(store);
  const sess = { cookie: { expires: new Date(Date.now() + 60000).toISOString() }, passport: { user: 'synthetic-user' } };
  await call(store, 'set', 'synthetic-session', sess);
  await check(async () => assert.equal((await call(store, 'get', 'synthetic-session')).passport.user, 'synthetic-user'));
  const oldExpiry = (await fresh.db('session').where({ sid: 'synthetic-session' }).first()).expire;
  await call(store, 'touch', 'synthetic-session', { ...sess, cookie: { expires: new Date(Date.now() + 3600000).toISOString() } });
  const newExpiry = (await fresh.db('session').where({ sid: 'synthetic-session' }).first()).expire;
  await check(() => assert(newExpiry.getTime() > oldExpiry.getTime() + 3000000));
  await check(async () => assert.equal((await fresh.db('session').where({ sid: 'synthetic-session' }).first()).sess.passport.user, 'synthetic-user'));
  await call(store, 'destroy', 'synthetic-session');
  await check(async () => assert.equal(await call(store, 'get', 'synthetic-session'), undefined));

  stage = 'populated adoption and migration history';
  const adopted = await fixture();
  await adopted.db.migrate.latest({ migrationSource: {
    getMigrations: () => historical,
    getMigrationName: name => name,
    getMigration: name => require(path.join(directory, name)),
  } });
  const beforeHistory = await adopted.db('knex_migrations').orderBy('id');
  await adopted.db.raw('CREATE TABLE session (sid varchar NOT NULL PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL)');
  await adopted.db('session').insert({ sid: 'preserved', sess: JSON.stringify(sess), expire: '2099-01-01 00:00:00.123456' });
  const snapshot = () => adopted.db.raw('SELECT sid, sess::text AS sess, expire::text AS expire FROM session ORDER BY sid');
  const before = (await snapshot()).rows;
  const other = makeKnex(adopted.local); clients.push(other);
  // New instances avoid cached custom migrationSource from the historical setup.
  const first = makeKnex(adopted.local); clients.push(first);
  const outcomes = await Promise.allSettled([first.migrate.latest(), other.migrate.latest()]);
  await check(async () => assert(outcomes.some(r => r.status === 'fulfilled')));
  for (const result of outcomes) if (result.status === 'rejected') await check(async () => assert.equal(result.reason.name, 'MigrationLocked'));
  await check(async () => assert.deepEqual((await snapshot()).rows, before));
  await check(async () => assert.deepEqual(await adopted.db('knex_migrations').whereIn('name', historical).orderBy('id'), beforeHistory));
  await check(async () => assert.equal((await adopted.db('knex_migrations').where({ name: filename })).length, 1));
  await check(async () => assert.equal((await first.migrate.latest())[1].length, 0));
  await assert.rejects(adopted.db.transaction(trx => migration.down(trx)), { code: 'SESSION_ROLLBACK_REFUSED' }); passed++;
  await check(async () => assert.deepEqual((await snapshot()).rows, before));

  const standard = 'CREATE TABLE session (sid varchar NOT NULL PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL)';
  const cases = [
    ['timezone', ['CREATE TABLE session (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamptz NOT NULL)']],
    ['bounded sid', ['CREATE TABLE session (sid varchar(20) PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL)']],
    ['extra column', ['CREATE TABLE session (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL, extra text)']],
    ['nullable', ['CREATE TABLE session (sid varchar PRIMARY KEY, sess json, expire timestamp(6) NOT NULL)']],
    ['missing primary key', ['CREATE TABLE session (sid varchar NOT NULL, sess json NOT NULL, expire timestamp(6) NOT NULL)']],
    ['wrong primary key', ['CREATE TABLE session (sid varchar NOT NULL, sess json NOT NULL, expire timestamp(6) PRIMARY KEY)']],
    ['composite primary key', ['CREATE TABLE session (sid varchar NOT NULL, sess json NOT NULL, expire timestamp(6) NOT NULL, PRIMARY KEY(sid, expire))']],
    ['deferrable primary key', ['CREATE TABLE session (sid varchar NOT NULL, sess json NOT NULL, expire timestamp(6) NOT NULL, PRIMARY KEY(sid) DEFERRABLE INITIALLY IMMEDIATE)']],
    ['check constraint', [standard, "ALTER TABLE session ADD CHECK (sid <> '')"]],
    ['unique constraint', [standard, 'ALTER TABLE session ADD UNIQUE(expire)']],
    ['unique index', [standard, 'CREATE UNIQUE INDEX extra_unique ON session(expire)']],
    ['user trigger', [standard,
      'CREATE FUNCTION unchanged_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
      'CREATE TRIGGER custom_session BEFORE INSERT OR UPDATE ON session FOR EACH ROW EXECUTE FUNCTION unchanged_session()']],
    ['RLS', [standard, 'ALTER TABLE session ENABLE ROW LEVEL SECURITY']],
    ['forced RLS', [standard, 'ALTER TABLE session ENABLE ROW LEVEL SECURITY',
      'CREATE POLICY fixture_access ON session USING (true) WITH CHECK (true)', 'ALTER TABLE session FORCE ROW LEVEL SECURITY']],
    ['inheritance parent', [standard, 'CREATE TABLE child_session () INHERITS (session)']],
    ['inheritance child', ['CREATE TABLE parent_session (sid varchar NOT NULL, sess json NOT NULL, expire timestamp(6) NOT NULL)',
      'CREATE TABLE session (PRIMARY KEY(sid)) INHERITS (parent_session)']],
    ['partitioned parent', [standard + ' PARTITION BY LIST(sid)', "CREATE TABLE session_part PARTITION OF session FOR VALUES IN ('preserved')"]],
    ['partition child', ['CREATE TABLE parent_session (sid varchar NOT NULL PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL) PARTITION BY LIST(sid)',
      "CREATE TABLE session PARTITION OF parent_session FOR VALUES IN ('preserved')"]],
    ['expiry name collision', [standard, 'CREATE INDEX "IDX_session_expire" ON session(sid)']],
  ];
  for (const [label, statements] of cases) {
    stage = label;
    const bad = await fixture();
    for (const sql of statements) await bad.db.raw(sql);
    await bad.db('session').insert({ sid: 'preserved', sess: JSON.stringify(sess), expire: '2099-01-01 00:00:00.123456' });
    const before = await catalogueSnapshot(bad);
    // Transaction-local marker proves rollback, not just absence of explicit row updates.
    await assert.rejects(bad.db.transaction(async trx => {
      await trx.raw('CREATE TABLE adoption_transaction_marker (id integer)');
      await migration.up(trx);
    }), { code: 'SESSION_SCHEMA_INCOMPATIBLE' }, label); passed++;
    await check(async () => assert.deepEqual(await catalogueSnapshot(bad), before, label));
  }
  // Equivalent index and text/jsonb compatibility are adopted without alteration.
  stage = 'equivalent index adoption';
  const equivalent = await fixture();
  await equivalent.db.raw('CREATE TABLE session (sid text PRIMARY KEY, sess jsonb NOT NULL, expire timestamp(6) NOT NULL)');
  await equivalent.db.raw('CREATE INDEX another_expiry_index ON session (expire)');
  await equivalent.db.transaction(trx => migration.up(trx));
  await check(async () => assert.equal((await equivalent.db.raw("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname=?", [equivalent.schema])).rows[0].n, 2));
}

// Snapshot all fixture table rows plus logical schema metadata, not just counts.
async function catalogueSnapshot({ db, schema }) {
  const result = await db.raw(`SELECT c.relname, c.relkind, c.relrowsecurity,
    c.relforcerowsecurity, c.relispartition, c.relhassubclass, pg_get_expr(c.relpartbound,c.oid) AS bound
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=? ORDER BY c.relname`, [schema]);
  const columns = await db.raw(`SELECT table_name,column_name,data_type,udt_name,is_nullable,
    character_maximum_length,datetime_precision,column_default,is_identity,is_generated,generation_expression
    FROM information_schema.columns WHERE table_schema=? ORDER BY table_name,ordinal_position`, [schema]);
  const constraints = await db.raw(`SELECT c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=? ORDER BY c.relname,k.conname`, [schema]);
  const indexes = await db.raw('SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=? ORDER BY tablename,indexname', [schema]);
  const triggers = await db.raw(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=? AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [schema]);
  const policies = await db.raw('SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname=? ORDER BY tablename,policyname', [schema]);
  const inheritance = await db.raw(`SELECT c.relname AS child,p.relname AS parent FROM pg_inherits i
    JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=? ORDER BY c.relname,p.relname`, [schema]);
  const functions = await db.raw(`SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=? ORDER BY p.proname`, [schema]);
  const rows = {};
  for (const table of result.rows.filter(r => ['r','p'].includes(r.relkind))) {
    rows[table.relname] = (await db.raw('SELECT row_to_json(t)::text AS row FROM ONLY ??.?? t ORDER BY row_to_json(t)::text', [schema, table.relname])).rows;
  }
  return { relations: result.rows, columns: columns.rows, constraints: constraints.rows,
    indexes: indexes.rows, triggers: triggers.rows, policies: policies.rows,
    inheritance: inheritance.rows, functions: functions.rows, rows };
}

async function teardown() {
  const failures = [], attempted = [];
  async function attempt(label, action) {
    attempted.push(label);
    let timer;
    try {
      // Race consumes late rejection too; no abandoned unhandled promise.
      await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Cleanup deadline exceeded'); error.code = 'CLEANUP_TIMEOUT'; reject(error);
        }, 3000);
      })]);
    } catch (error) { failures.push({ label, error }); } finally { clearTimeout(timer); }
  }
  for (const [i, store] of stores.entries()) await attempt(`store:${i}`, () => store.close());
  for (const [i, pool] of pools.entries()) await attempt(`pool:${i}`, () => pool.end());
  for (const [i, db] of clients.entries()) await attempt(`client:${i}`, () => db.destroy());
  for (const [i, schema] of schemas.entries()) await attempt(`schema:${i}`, () => admin.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]));
  await attempt('admin', () => admin.destroy());
  return { failures, attempted };
}
async function main() {
  let primary = null;
  try { await tests(); } catch (error) { primary = error; }
  const cleanup = await teardown();
  // Keep the original error object; cleanup failures never replace it.
  const failed = primary !== null || cleanup.failures.length !== 0;
  if (process.argv[2]?.startsWith('--inject=')) {
    console.log(JSON.stringify({ primary: primary?.code || (primary ? 'TEST_FAILURE' : null),
      cleanup: cleanup.failures.map(f => ({ step: f.label, timeout: f.error.code === 'CLEANUP_TIMEOUT' })), attempted: cleanup.attempted, schemas }));
  } else if (failed) {
    console.error(`Session migration validation failed: primary=${primary ? 'test/setup failure at ' + stage : 'none'}; cleanup=${cleanup.failures.map(f => f.label + (f.error.code === 'CLEANUP_TIMEOUT' ? ':timeout' : ':error')).join(',') || 'none'}`);
  } else {
    console.log(`${passed} passed, 0 failed`);
  }
  if (failed) {
    process.exitCode = 1;
    // Failed/timed-out teardown can leave a driver handle alive. Bound termination
    // after every cleanup step has been attempted, allowing diagnostic writes to flush.
    setTimeout(() => process.exit(1), 100).unref();
  }
}
main().catch(() => {
  console.error('Session migration test harness failed.'); process.exitCode = 1;
  setTimeout(() => process.exit(1), 100).unref();
});
