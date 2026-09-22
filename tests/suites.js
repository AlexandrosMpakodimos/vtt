// Authoritative registered suite lists and execution order.
// Importing this file performs no I/O, configuration loading or test execution.

// No external server or database. Some suites start their own loopback server.
const UNIT = [
  'test-production-db-config.js', 'test-production-migrate-command.js',
  'test-campaign-mutation-contracts.js',
  'test-final-owner-boundaries.js', 'test-final-room-admission.js',
  'test-campaign-permission-races.js',
  'test-login-session-races.js',
  'test-email-recovery-transactions.js',
  'test-auth-session-revocation.js', 'test-socket-sessions.js',
  'test-campaign-ownership.js',
  'test-campaign-join-retry.js',
  'test-shortcuts.js', 'test-bulk-place.js', 'test-marquee.js',
  'test-fog-ui.js', 'test-fog-validators.js', 'test-sheet-ui.js',
  'test-dice.js', 'test-dice3d.js',
  'test-combat-ui.js', 'test-align-ui.js', 'test-landing-ui.js', 'test-dashboard-ui.js', 'test-actors-ui.js', 'test-game-ui.js',
  'test-storage.js', 'test-asset-delete.js', 'test-campaign-create-retry.js', 'test-imagepicker.js', 'test-events.js', 'test-closednotice.js', 'test-frametool.js',
];

// Functional. Real Postgres, server on npm run dev:test.
const DB = [
  'test-session-store-migration.js',
  'test-final-closed-broadcasts.js',
  'test-campaign-permission-races-db.js',
  'test-login-session-races-db.js',
  'test-campaign-access-transitions.js',
  'test-account-recovery.js',
  'test-session-invalidation.js',
  'test-campaign-ownership-races.js',
  'test-campaigns.js', 'test-scenes.js', 'test-token-ops.js', 'test-fog.js',
  'test-active-scene.js', 'test-scene-delete.js', 'test-actors.js',
  'test-items-inventory.js', 'test-combat.js', 'test-speaker-color.js',
  'test-scene-grid.js', 'test-spells.js', 'test-assets.js', 'test-landing-server.js',
  'test-campaign-open.js', 'test-lobby.js',
  // Storage budget ledger + durable cleanup. DB-backed (real Postgres) but NOT
  // server-backed: they exercise the serialisable accounting directly, which is
  // where the money-safety property lives. Use the isolated wrapper for these
  // suites too; the DB group also contains tests that require the test server.
  'test-upload-controlled.js', 'test-storage-budget.js', 'test-budget-lifecycle.js', 'test-storage-cleanup.js',
  'test-storage-reconcile.js', 'test-media-gateway.js', 'test-media-rewrite.js',
  // Route-level media gate in host and proxy modes. Real Postgres; it starts its
  // own loopback listener and does not use the isolated test server.
  'test-media-proxy-gate.js',
];

// Adversarial security regressions.
const SEC = [
  'break-campaigns.js', 'break-canvas.js', 'break-fog.js',
  'break-active-scene.js', 'break-actors.js', 'break-combat.js',
  'break-dice.js', 'break-m6.js', 'break-assets.js',
];

// This diagnostic is selectable explicitly, but never part of a registered run.
const manual = ['test-media-integration.js'];

// test-stale-asset-atomicity.js is intentionally NOT registered or mapped here.
// It invokes the unfiltered production stale-asset sweep and therefore requires
// exclusive vtt_test ownership with the shared dev:test server/background
// maintenance stopped. Run it directly using the guarded command in its header.

const byName = new Map();
for (const [group, directory, files, registered] of [
  ['unit', 'unit', UNIT, true],
  ['db', 'integration', DB, true],
  ['sec', 'security', SEC, true],
  ['manual', 'integration', manual, false],
]) {
  for (const name of files) {
    byName.set(name, { file: `tests/${directory}/${name}`, group, registered });
  }
}

// Exact basenames only: no filesystem discovery, traversal or prototype lookup.
const resolveSuite = name => byName.get(name);

module.exports = { UNIT, DB, SEC, resolveSuite };
