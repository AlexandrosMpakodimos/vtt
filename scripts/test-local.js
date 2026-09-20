const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { root, rootPath } = require('../tests/helpers/paths');
const { resolveSuite } = require('../tests/suites');
const command = process.argv[2];
const suite = resolveSuite(command);
const commands = new Set(['server', 'check', 'unit', 'db', 'sec', 'all']);

// Refuse arbitrary paths and inherited object-property names before configuration.
if (!commands.has(command) && !suite) {
  console.error('Usage: node scripts/test-local.js server|check|unit|db|sec|all|test-FILE.js (exact mapped basename)');
  process.exit(1);
}
process.chdir(root);
process.env.NODE_ENV = 'test';

// Validate the dedicated database configuration before launching anything.
require('../knexfile');

const base = 'http://127.0.0.1:3001';
const env = {};

// Pass operating-system settings, not application credentials.
for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']) {
  if (process.env[key]) env[key] = process.env[key];
}
if (process.env.TEST_DATABASE_URL) {
  env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
}

Object.assign(env, {
  NODE_ENV: 'test',
  PORT: '3001',
  BASE_URL: base,
  SESSION_SECRET: 'local-isolated-test-session-secret',
  MEDIA_TOKEN_SECRET: 'local-isolated-test-media-secret',
  MEDIA_HOST: 'media.test',
  MEDIA_ORIGIN: 'http://media.test:3001',
  MAIL_JSON: '1',
  SKIP_HIBP: '1',
  UPLOAD_MODE: 'strict',
});

for (const name of [
  'LOGIN', 'REGISTER', 'RESEND', 'FORGOT', 'RESET', 'CHANGE_EMAIL',
  'CAMPAIGN_JOIN', 'CAMPAIGN_SEARCH', 'CAMPAIGN_CREATE', 'CONTENT_WRITE',
]) {
  env[`RL_${name}_MAX`] = '100000';
}

async function verifyServer() {
  const response = await fetch(`${base}/__test/identity`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) throw new Error('Test server identity check failed.');
  const identity = await response.json();

  if (
    identity.environment !== 'test' ||
    identity.database !== 'vtt_test' ||
    identity.role !== 'vtt_test_runner' ||
    identity.storageConfigured !== true ||
    identity.storageBackend !== 'memory' ||
    identity.uploadMode !== 'strict'
  ) {
    throw new Error('Refusing to run tests against an unexpected server.');
  }
  console.log('Verified isolated test server:', base);
}

function launch(args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: 'inherit',
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', () => {
    console.error('Could not start the test process.');
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code === null ? 1 : code;
  });
}

(async () => {
  if (command === 'server') {
    launch([rootPath('scripts/test-memory-server.js')]);
  } else if (command === 'check') {
    await verifyServer();
  } else if (['unit', 'db', 'sec', 'all'].includes(command)) {
    if (command !== 'unit') await verifyServer();
    launch([rootPath('run-tests.js'), command]);
  } else if (suite) {
    if (!fs.existsSync(rootPath(suite.file))) throw new Error('Mapped suite file is missing.');
    await verifyServer();
    if (!suite.registered) console.log('Manual-only diagnostic (not in registered groups):', command);
    launch([rootPath(suite.file)]);
  } else {
    throw new Error(
      'Usage: node scripts/test-local.js server|check|unit|db|sec|all|test-FILE.js'
    );
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
