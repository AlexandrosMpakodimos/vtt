// Deliberately narrow production profile. Development and test use knexfile.js.
const path = require('node:path');
const SCHEMA_SQL = `SELECT current_schema() AS schema,
  current_schemas(false)::text[] AS schemas, current_setting('search_path') AS search_path`;
const messages = {
  DB_CONFIG_INVALID: 'Expected a supported Neon PostgreSQL URL and production environment.',
  DB_ENV_UNSUPPORTED: 'Remove unsupported PostgreSQL or TLS environment overrides.',
  DB_SCHEMA_INVALID: 'Configure the database role search_path to public before connecting.',
  DB_SCHEMA_CHECK_FAILED: 'Could not verify the connection schema.',
  DB_AUTH_FAILED: 'Database authentication failed.',
  DB_TLS_FAILED: 'Database certificate verification failed.',
  DB_CONNECT_TIMEOUT: 'Database connection or acquisition timed out.',
  MIGRATION_LOCKED: 'Migration lock unavailable; verify runner ownership. No automatic unlock.',
  MIGRATION_FAILED: 'Migration failed; review configuration and migration prerequisites.',
  SESSION_SCHEMA_INCOMPATIBLE: 'Session schema requires manual compatibility review.',
  SESSION_ROLLBACK_REFUSED: 'Session ownership rollback requires manual review.',
};
function failure(code) {
  const error = new Error(messages[code]);
  error.code = code;
  return error;
}
function diagnostic(error) {
  let code = Object.hasOwn(messages, error?.code) ? error.code : 'MIGRATION_FAILED';
  if (['28P01', '28000'].includes(error?.code)) code = 'DB_AUTH_FAILED';
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error?.code)) code = 'DB_TLS_FAILED';
  if (error?.code === 'ETIMEDOUT' || error?.name === 'KnexTimeoutError') code = 'DB_CONNECT_TIMEOUT';
  if (error?.name === 'MigrationLocked') code = 'MIGRATION_LOCKED';
  return `${code}: ${messages[code]}`;
}
function validateEnvironment(env) {
  if (env.NODE_ENV !== 'production') throw failure('DB_CONFIG_INVALID');
  if (Object.keys(env).some(key => /^PG[A-Z0-9_]*$/.test(key)) ||
      ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].some(key => env[key] !== undefined) ||
      (env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && env.NODE_TLS_REJECT_UNAUTHORIZED !== '1')) {
    throw failure('DB_ENV_UNSUPPORTED');
  }
}
function connection(env, direct = false) {
  validateEnvironment(env);
  try {
    const raw = env[direct ? 'DIRECT_DATABASE_URL' : 'DATABASE_URL'];
    if (typeof raw !== 'string' || /[\s\x00-\x1f\x7f]/.test(raw) || /%(?![a-f\d]{2})/i.test(raw)) throw 0;
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || raw.includes('#')) throw 0;
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!user || !password || !database || database.includes('/') ||
        [user, password, database].some(value => /[\x00-\x1f\x7f]/.test(value))) throw 0;
    // Routing shape only; these checks cannot establish project/branch identity.
    const pattern = direct ? /^ep-[a-z0-9-]+(?<!-pooler)\.[a-z0-9.-]+\.neon\.tech$/
      : /^ep-[a-z0-9-]+-pooler\.[a-z0-9.-]+\.neon\.tech$/;
    if (!pattern.test(url.hostname) || url.hostname.split('.').some(label =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || url.pathname.slice(1).includes('/')) throw 0;
    const params = [...url.searchParams];
    if (params.length > 1 || params.some(([key, value]) => key !== 'sslmode' || !['require', 'verify-full'].includes(value))) throw 0;
    const port = Number(url.port || 5432);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw 0;
    // Channel binding is used whenever the server offers SCRAM-SHA-256-PLUS.
    // pg cannot require it; if it is not offered, pg authenticates with plain
    // SCRAM and sends the 'y' flag, which a binding-capable server rejects.
    return { host: url.hostname, port, user, password, database,
      ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 10000, enableChannelBinding: true };
  } catch { throw failure('DB_CONFIG_INVALID'); }
}
async function assertPublic(client) {
  let result;
  try {
    // pg-pool clears its connection timer before onConnect; bound this query itself.
    result = await client.query({ text: SCHEMA_SQL, query_timeout: 10000 });
  } catch { throw failure('DB_SCHEMA_CHECK_FAILED'); }
  const row = result?.rows?.[0];
  if (row?.schema !== 'public' || !Array.isArray(row.schemas) ||
      row.schemas.length !== 1 || row.schemas[0] !== 'public' ||
      !['public', '"public"'].includes(row.search_path?.trim())) throw failure('DB_SCHEMA_INVALID');
}
function knexConfiguration(env, direct = false) {
  return {
    client: 'pg', connection: connection(env, direct),
    migrations: { directory: path.join(__dirname, '../db/migrations'), schemaName: 'public', tableName: 'knex_migrations' },
    acquireConnectionTimeout: 15000,
    pool: { min: 0, max: direct ? 2 : 5, idleTimeoutMillis: 30000, createTimeoutMillis: 10000,
      afterCreate(client, done) {
        assertPublic(client).then(() => done(null, client), async error => {
          // Knex 3.2.10 does not destroy a raw connection when afterCreate rejects.
          try { await client.end(); } catch { /* preserve the safe assertion error */ }
          done(error, client);
        });
      } },
    debug: false,
    // Knex sometimes supplies already-formatted raw error strings. Never forward them.
    log: { warn() { console.error('DB_DRIVER_WARNING: Database operation needs review.'); },
      error() { console.error('DB_DRIVER_ERROR: Database operation failed.'); }, debug() {}, deprecate() {} },
  };
}
function sessionConfiguration(env) {
  return { ...connection(env), min: 0, max: 2, idleTimeoutMillis: 30000, onConnect: assertPublic };
}
module.exports = { connection, knexConfiguration, sessionConfiguration, assertPublic, diagnostic, failure };
