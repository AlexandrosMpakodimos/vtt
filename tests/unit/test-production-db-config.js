const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const policy = require('../../src/config/database');
const pooled = 'postgresql://runner:s%40fe@ep-example-pooler.eu-central-1.aws.neon.tech/vtt?sslmode=require';
const env = { NODE_ENV: 'production', DATABASE_URL: pooled };
let passed = 0;
function check(fn) { fn(); passed++; }
(async () => {
  const config = policy.knexConfiguration(env);
  check(() => assert.deepEqual(config.connection, {
    host: 'ep-example-pooler.eu-central-1.aws.neon.tech', port: 5432, user: 'runner', password: 's@fe', database: 'vtt', ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 10000,
  }));
  check(() => assert.equal(config.pool.max, 5));
  check(() => assert.equal(config.pool.min, 0));
  check(() => assert.equal(config.acquireConnectionTimeout, 15000));
  check(() => assert.equal(policy.sessionConfiguration(env).max, 2));
  check(() => assert.equal(config.migrations.schemaName, 'public'));
  for (const option of ['ssl=false', 'sslmode=disable', 'sslmode=verify-ca', 'sslmode=no-verify', 'sslmode=prefer', 'sslmode=require&sslmode=require', 'channel_binding=require', 'channel_binding=prefer', 'sslrootcert=/private', 'options=-csearch_path=evil', 'host=evil', 'uselibpqcompat=true', 'connect_timeout=0', 'unknown=secret']) {
    check(() => assert.throws(() => policy.connection({ ...env, DATABASE_URL: pooled.split('?')[0] + '?' + option }), { code: 'DB_CONFIG_INVALID' }));
  }
  for (const key of ['PGHOST', 'PGPASSWORD', 'PGOPTIONS', 'PGSSLMODE', 'PGAPPNAME', 'PGCONNECT_TIMEOUT', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    check(() => assert.throws(() => policy.connection({ ...env, [key]: '' }), { code: 'DB_ENV_UNSUPPORTED' }));
  }
  check(() => assert.throws(() => policy.connection({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' })));
  for (const value of ['', 'not-a-url', pooled.replace('s%40fe', '%GG'), pooled + '#secret', pooled.replace('/vtt?', '/a/b?'), pooled.replace('-pooler', ''), pooled.replace('ep-example-pooler.eu-central-1.aws.neon.tech', 'localhost')]) {
    check(() => assert.throws(() => policy.connection({ ...env, DATABASE_URL: value })));
  }
  check(() => assert.equal(policy.connection({ ...env, DATABASE_URL: pooled.split('?')[0] }).ssl.rejectUnauthorized, true));
  check(() => assert.throws(() => policy.connection({ NODE_ENV: 'production', DATABASE_URL: pooled }, true)));
  // Inspect real locked driver object without opening a connection.
  const pg = require('pg');
  const client = new pg.Client(config.connection);
  check(() => assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true));
  check(() => assert.equal(client.host, config.connection.host));
  // Real pg-pool onConnect must hold acquisition and destroy rejected clients.
  let finish, used = false, ended = false;
  class FakeClient extends EventEmitter {
    connect(cb) { cb(null); }
    query() { return new Promise(resolve => { finish = resolve; }); }
    end(cb) { ended = true; if (cb) cb(); return Promise.resolve(); }
    isConnected() { return true; }
  }
  const Pool = require('pg-pool');
  const pool = new Pool({ ...policy.sessionConfiguration(env), Client: FakeClient });
  const acquiring = pool.connect().then(c => { used = true; return c; });
  await new Promise(resolve => setImmediate(resolve));
  check(() => assert.equal(used, false));
  finish({ rows: [{ schema: 'evil', schemas: ['evil', 'public'] }] });
  await assert.rejects(acquiring, { code: 'DB_SCHEMA_INVALID' }); passed++;
  check(() => assert.equal(used, false)); check(() => assert.equal(ended, true));
  await pool.end();
  // Real Knex/Tarn acquisition also awaits afterCreate, closes a rejected raw client.
  const db = require('knex')(config);
  let releaseSchema;
  let rawEnded = false;
  db.client.acquireRawConnection = async () => ({ query: () => new Promise(resolve => { releaseSchema = resolve; }), end: async () => { rawEnded = true; } });
  const acquiringKnex = db.client.acquireConnection();
  await new Promise(resolve => setImmediate(resolve));
  releaseSchema({ rows: [{ schema: 'public', schemas: ['evil', 'public'] }] });
  await assert.rejects(acquiringKnex, { code: 'DB_SCHEMA_INVALID' }); passed++;
  check(() => assert.equal(rawEnded, true));
  await db.destroy();
  // Success remains pending until the actual awaited hooks complete.
  let complete;
  let available = false;
  const goodPool = new Pool({ ...policy.sessionConfiguration(env), Client: class extends FakeClient {
    query() { return new Promise(resolve => { complete = resolve; }); }
  } });
  const goodAcquisition = goodPool.connect().then(c => { available = true; return c; });
  await new Promise(resolve => setImmediate(resolve));
  check(() => assert.equal(available, false));
  complete({ rows: [{ schema: 'public', schemas: ['public'], search_path: 'public' }] });
  const goodClient = await goodAcquisition;
  check(() => assert.equal(available, true));
  goodClient.release(); await goodPool.end();
  const goodKnex = require('knex')(config);
  let completeKnex;
  let knexAvailable = false;
  goodKnex.client.acquireRawConnection = async () => ({
    query: () => new Promise(resolve => { completeKnex = resolve; }), end: cb => { if (cb) { cb(); return; } return Promise.resolve(); },
  });
  const goodKnexAcquisition = goodKnex.client.acquireConnection().then(c => { knexAvailable = true; return c; });
  await new Promise(resolve => setImmediate(resolve));
  check(() => assert.equal(knexAvailable, false));
  completeKnex({ rows: [{ schema: 'public', schemas: ['public'], search_path: 'public' }] });
  const goodKnexClient = await goodKnexAcquisition;
  check(() => assert.equal(knexAvailable, true));
  await goodKnex.client.releaseConnection(goodKnexClient); await goodKnex.destroy();
  await assert.rejects(policy.assertPublic({ query: async () => { throw new Error('sentinel-secret'); } }), error => error.code === 'DB_SCHEMA_CHECK_FAILED' && !error.message.includes('sentinel')); passed++;
  await assert.rejects(policy.assertPublic({ query: async () => ({ rows: [{ schema: 'public', schemas: ['public'], search_path: '\"$user\", public' }] }) }), { code: 'DB_SCHEMA_INVALID' }); passed++;
  const logged = [];
  const oldError = console.error;
  console.error = text => logged.push(text);
  try { config.log.warn('sentinel-secret'); config.log.error(new Error('sentinel-secret')); } finally { console.error = oldError; }
  check(() => assert(!logged.join(' ').includes('sentinel-secret')));
  // Isolated test branch ignores malicious production environment/URLs.
  const root = path.resolve(__dirname, '../..');
  const testEnv = { ...process.env, NODE_ENV: 'test', TEST_DATABASE_URL: 'postgresql://vtt_test_runner:fixture@127.0.0.1/vtt_test', DATABASE_URL: 'bad', DIRECT_DATABASE_URL: 'bad', PGSSLMODE: 'no-verify' };
  const result = spawnSync(process.execPath, ['-e', "const c=require('./knexfile').test; if(c.connection.database!=='vtt_test'||!c.pool.afterCreate) process.exit(2)"], { cwd: root, env: testEnv });
  check(() => assert.equal(result.status, 0));
  const rejected = spawnSync(process.execPath, ['-e', "require('./knexfile')"], { cwd: root, env: { ...testEnv, TEST_DATABASE_URL: 'postgresql://wrong:fixture@127.0.0.1/vtt_test' } });
  check(() => assert.notEqual(rejected.status, 0));
  check(() => assert.equal(policy.diagnostic(new Error('sentinel-secret')), 'MIGRATION_FAILED: Migration failed; review configuration and migration prerequisites.'));
  console.log(`${passed} passed, 0 failed`);
})().catch(() => { console.error('Production DB configuration tests failed'); process.exitCode = 1; });
