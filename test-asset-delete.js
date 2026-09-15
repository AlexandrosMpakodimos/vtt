// Exercise the real DELETE handler with stubbed I/O: no server or database.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync('src/routes/assets.js', 'utf8');
const helperStart = source.indexOf('async function budgetActive()');
const helperEnd = source.indexOf('// UPLOAD_MODE', helperStart);
const routeStart = source.indexOf("router.delete('/:id',");
const routeEnd = source.indexOf('\nmodule.exports =', routeStart);
assert(helperStart >= 0 && helperEnd > helperStart && routeStart >= 0 && routeEnd > routeStart);

let passed = 0;
function check(condition, message) { assert(condition, message); passed++; }

async function run({ initialised = true, snapshotError = false, external = false, owner = true } = {}) {
  const events = [];
  let objectExists = !external, rowExists = true, status;
  const asset = { id: 'asset', user_id: 'owner', storage_key: external ? null : 'image', bytes: 100, bytes_verified: true };
  const ledger = { committed_bytes: 100 };
  let handler;
  function db(table) {
    return {
      where() { return this; },
      async first() { return asset; },
      async del() { events.push('delete row'); rowExists = false; },
      async update(update) { assert.equal(table, 'storage_budget'); Object.assign(ledger, update); events.push('release bytes'); },
    };
  }
  db.fn = { now: () => 'now' };
  const context = {
    router: { delete(path, fn) { handler = fn; } },
    knex: db, validUuid: () => true,
    storage: { async remove() { events.push('delete object'); objectExists = false; return true; } },
    budget: {
      async snapshot() { events.push('check ledger'); if (snapshotError) throw new Error('database unavailable'); return { initialised }; },
      async inSerializable(fn) { return fn(db); },
      async readRow() { return ledger; },
    },
  };
  vm.runInNewContext(source.slice(helperStart, helperEnd) + source.slice(routeStart, routeEnd), context);
  const response = { status(code) { status = code; return this; }, json() { status ??= 200; } };
  await handler({ params: { id: 'asset' }, user: { id: owner ? 'owner' : 'outsider' } }, response,
    error => { status = error.status || 500; });
  return { events, status, objectExists, rowExists, ledger };
}

(async () => {
  const refused = await run({ initialised: false });
  check(refused.status === 503, 'uninitialised accounting refuses deletion');
  check(refused.objectExists && refused.rowExists, 'refusal preserves both bytes and asset record');
  check(refused.events.join(',') === 'check ledger', 'refusal performs no storage write');
  const unavailable = await run({ snapshotError: true });
  check(unavailable.status === 500 && unavailable.objectExists && unavailable.rowExists,
    'an accounting read failure also preserves the image');
  const deleted = await run();
  check(deleted.status === 200 && !deleted.objectExists && !deleted.rowExists, 'normal deletion completes');
  check(deleted.ledger.committed_bytes === 0, 'normal deletion releases the committed bytes');
  check(deleted.events.join(',') === 'check ledger,delete object,release bytes,delete row',
    'accounting is checked before the destructive operation');
  const external = await run({ external: true, initialised: false });
  check(external.status === 200 && external.events.join(',') === 'delete row', 'external links need no storage accounting');
  const outsider = await run({ owner: false });
  check(outsider.status === 404 && outsider.objectExists && outsider.rowExists && !outsider.events.length,
    'unauthorised requests cannot probe accounting or delete bytes');
  console.log(`${passed} passed, 0 failed`);
})().catch(error => { console.error(error); console.log(`${passed} passed, 1 failed`); process.exitCode = 1; });
