// Additive ownership of connect-pg-simple 10.0.0's session table.
// Historical migration identities and populated compatible tables are preserved.
function incompatible() {
  const error = new Error('Session schema requires manual compatibility review.');
  error.code = 'SESSION_SCHEMA_INCOMPATIBLE';
  return error;
}
exports.up = async function up(knex) {
  const { rows: [context] } = await knex.raw('SELECT current_schema() AS schema');
  const schema = context.schema;
  if (!schema) throw incompatible();
  const relation = () => knex.raw(`SELECT c.oid, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
    c.relhassubclass, c.relispartition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=? AND c.relname='session'`, [schema]);
  let { rows: [table] } = await relation();
  if (!table) {
    await knex.raw('CREATE TABLE ??.?? (sid varchar NOT NULL PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL)', [schema, 'session']);
    ({ rows: [table] } = await relation());
  }
  if (table.relkind !== 'r' || table.relrowsecurity || table.relforcerowsecurity || table.relhassubclass || table.relispartition) throw incompatible();
  await knex.raw('LOCK TABLE ??.?? IN ACCESS EXCLUSIVE MODE', [schema, 'session']);
  // Recheck after obtaining the lock, before trusting metadata collected earlier.
  ({ rows: [table] } = await relation());
  if (table.relkind !== 'r' || table.relrowsecurity || table.relforcerowsecurity || table.relhassubclass || table.relispartition) throw incompatible();
  const { rows: columns } = await knex.raw(`SELECT attname, atttypid::regtype::text AS type,
    atttypmod, attnotnull, attgenerated, attidentity, attnum FROM pg_attribute
    WHERE attrelid=? AND attnum>0 AND NOT attisdropped ORDER BY attnum`, [table.oid]);
  const byName = Object.fromEntries(columns.map(c => [c.attname, c]));
  if (columns.length !== 3 || columns.some(c => !c.attnotnull || c.attgenerated || c.attidentity) ||
      !['character varying', 'text'].includes(byName.sid?.type) || byName.sid.atttypmod !== -1 ||
      !['json', 'jsonb'].includes(byName.sess?.type) ||
      byName.expire?.type !== 'timestamp without time zone' || ![-1, 6].includes(byName.expire.atttypmod)) throw incompatible();
  const { rows: constraints } = await knex.raw('SELECT contype, conkey, condeferrable, convalidated FROM pg_constraint WHERE conrelid=?', [table.oid]);
  const keys = constraints.filter(c => c.contype === 'p');
  if (keys.length !== 1 || keys[0].condeferrable || !keys[0].convalidated ||
      keys[0].conkey.length !== 1 || keys[0].conkey[0] !== byName.sid.attnum ||
      constraints.some(c => !['p', 'n'].includes(c.contype))) throw incompatible();
  const { rows: [unsafe] } = await knex.raw(`SELECT
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=? AND NOT tgisinternal) OR
    EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=?) OR
    EXISTS(SELECT 1 FROM pg_index WHERE indrelid=? AND indisunique AND NOT indisprimary) AS present`, [table.oid, table.oid, table.oid]);
  if (unsafe.present) throw incompatible();
  const { rows: [index] } = await knex.raw(`SELECT EXISTS(SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am a ON a.oid=c.relam
    WHERE i.indrelid=? AND i.indisvalid AND i.indisready AND NOT i.indisunique
      AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnatts=1
      AND i.indkey[0]=? AND a.amname='btree') AS present`, [table.oid, byName.expire.attnum]);
  if (!index.present) {
    const { rows: [collision] } = await knex.raw(`SELECT EXISTS(SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=? AND c.relname='IDX_session_expire') AS present`, [schema]);
    if (collision.present) throw incompatible();
    await knex.raw('CREATE INDEX ?? ON ??.?? (expire)', ['IDX_session_expire', schema, 'session']);
  }
};
exports.down = async function down() {
  const error = new Error('Session ownership rollback requires manual review.');
  error.code = 'SESSION_ROLLBACK_REFUSED';
  throw error;
};
