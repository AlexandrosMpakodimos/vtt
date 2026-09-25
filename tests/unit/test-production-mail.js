// Production mail configuration and transport selection. No network, no SMTP:
// nodemailer is replaced in the require cache before the mailer is loaded.
const assert = require('node:assert/strict');
const path = require('node:path');
const { root } = require('../helpers/paths');
const { validate, diagnostic } = require(path.join(root, 'src/config/startup'));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (error) { failed++; console.error(`FAIL ${name}:`, error.message); }
}

const base = {
  TRUST_PROXY_HOPS: '1', NODE_ENV: 'production', COORDINATION_URL: 'rediss://default:fixture@host.invalid:6379',
  BASE_URL: 'https://fixture.invalid', SESSION_SECRET: 'fixture-only-not-a-real-secret-123456',
  DATABASE_URL: 'postgresql://fixture:fixture@ep-fixture-pooler.us.aws.neon.tech/fixture',
  SMTP_HOST: 'mail.fixture.invalid', SMTP_USER: 'no-reply@fixture.invalid',
  SMTP_PASS: 'smtp-pass-sentinel', MAIL_FROM: 'VTT <no-reply@fixture.invalid>',
};

function loadMailer(env) {
  const calls = { transports: [], messages: [], testAccounts: 0 };
  const fake = {
    createTransport(options) {
      calls.transports.push(options);
      return { sendMail: async message => { calls.messages.push(message); return { messageId: 'fixture' }; } };
    },
    createTestAccount: async () => { calls.testAccounts++; return { user: 'x', pass: 'y' }; },
    getTestMessageUrl: () => false,
  };
  const mailerPath = path.join(root, 'src/services/mailer.js');
  delete require.cache[mailerPath];
  require.cache[require.resolve('nodemailer', { paths: [root] })] = { exports: fake, loaded: true };
  const saved = { ...process.env };
  for (const key of ['NODE_ENV', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'MAIL_JSON']) delete process.env[key];
  Object.assign(process.env, env);
  const mailer = require(mailerPath);
  const restore = () => { process.env = saved; delete require.cache[mailerPath]; };
  return { mailer, calls, restore };
}

(async () => {
  await test('valid production mail configuration passes', () => {
    validate(base);
    validate({ ...base, MAIL_FROM: 'no-reply@fixture.invalid', SMTP_PORT: '465', SMTP_SECURE: 'true' });
    validate({ ...base, SMTP_PORT: '587', SMTP_SECURE: 'false' });
  });

  await test('missing or malformed production mail settings refuse startup by key only', () => {
    const cases = [
      ['SMTP_HOST', { SMTP_HOST: undefined }], ['SMTP_HOST', { SMTP_HOST: ' ' }], ['SMTP_HOST', { SMTP_HOST: 'host:25' }],
      ['SMTP_USER', { SMTP_USER: '' }], ['SMTP_PASS', { SMTP_PASS: undefined }], ['MAIL_FROM', { MAIL_FROM: undefined }],
      ['MAIL_FROM', { MAIL_FROM: 'VTT <no-reply@vtt.local' }], ['MAIL_FROM', { MAIL_FROM: 'VTT <a@b.invalid>\r\nBcc: x@y.invalid' }],
      ['MAIL_FROM', { MAIL_FROM: 'no-reply@localhost' }], ['SMTP_PORT', { SMTP_PORT: '0' }], ['SMTP_PORT', { SMTP_PORT: 'smtp' }],
      ['SMTP_SECURE', { SMTP_SECURE: 'yes' }], ['MAIL_JSON', { MAIL_JSON: '1' }], ['MAIL_JSON', { MAIL_JSON: '0' }],
    ];
    for (const [key, override] of cases) {
      let error;
      try { validate({ ...base, ...override }); } catch (e) { error = e; }
      assert.ok(error, `expected refusal for ${key}`);
      assert.equal(diagnostic(error), `STARTUP_FAILED: STARTUP_CONFIG_INVALID: ${key}`);
      assert.doesNotMatch(diagnostic(error), /sentinel|fixture\.invalid/);
    }
  });

  await test('development and test do not require mail settings', () => {
    validate({ NODE_ENV: 'development' }); validate({ NODE_ENV: 'test' }); validate({});
  });

  await test('production uses the configured sender and mandatory STARTTLS', async () => {
    const { mailer, calls, restore } = loadMailer({ ...base });
    try {
      await mailer.sendVerificationEmail('player@example.invalid', 'https://fixture.invalid/verify?t=x');
      assert.equal(calls.transports.length, 1);
      assert.equal(calls.transports[0].requireTLS, true);
      assert.equal(calls.transports[0].secure, false);
      assert.equal(calls.transports[0].port, 587);
      assert.equal(calls.transports[0].tls, undefined, 'certificate verification must not be relaxed');
      assert.equal(calls.messages[0].from, base.MAIL_FROM);
      await mailer.sendPasswordResetEmail('player@example.invalid', 'https://fixture.invalid/reset?t=x');
      await mailer.sendEmailChangeEmail('player@example.invalid', 'https://fixture.invalid/change?t=x');
      assert.deepEqual(calls.messages.map(m => m.from), [base.MAIL_FROM, base.MAIL_FROM, base.MAIL_FROM]);
      assert.equal(calls.testAccounts, 0);
    } finally { restore(); }
  });

  await test('production implicit TLS does not add STARTTLS requirement', async () => {
    const { mailer, calls, restore } = loadMailer({ ...base, SMTP_PORT: '465', SMTP_SECURE: 'true' });
    try {
      await mailer.sendVerificationEmail('player@example.invalid', 'https://fixture.invalid/verify?t=x');
      assert.equal(calls.transports[0].secure, true);
      assert.equal(calls.transports[0].port, 465);
      assert.equal(calls.transports[0].requireTLS, undefined);
    } finally { restore(); }
  });

  await test('production without SMTP never falls back to Ethereal or JSON', async () => {
    const { mailer, calls, restore } = loadMailer({ NODE_ENV: 'production', MAIL_FROM: base.MAIL_FROM, MAIL_JSON: '1' });
    const logged = []; const original = console.log; console.log = (...args) => logged.push(args.join(' '));
    try {
      await assert.rejects(mailer.sendVerificationEmail('player@example.invalid', 'https://fixture.invalid/verify?t=secret-link'),
        error => error.code === 'MAIL_TRANSPORT_UNCONFIGURED');
      assert.equal(calls.testAccounts, 0);
      assert.equal(calls.transports.length, 0);
      assert.equal(logged.some(line => /secret-link/.test(line)), false);
    } finally { console.log = original; restore(); }
  });

  await test('production without a sender refuses before any transport', async () => {
    const { mailer, calls, restore } = loadMailer({ ...base, MAIL_FROM: '' });
    try {
      await assert.rejects(mailer.sendVerificationEmail('player@example.invalid', 'https://fixture.invalid/v'),
        error => error.code === 'MAIL_SENDER_UNCONFIGURED');
      assert.equal(calls.transports.length, 0);
    } finally { restore(); }
  });

  await test('development keeps the local default sender', async () => {
    const { mailer, calls, restore } = loadMailer({ NODE_ENV: 'development', MAIL_JSON: '1' });
    const original = console.log; console.log = () => {};
    try {
      await mailer.sendVerificationEmail('player@example.invalid', 'http://localhost:3000/v');
      assert.equal(calls.messages[0].from, 'VTT <no-reply@vtt.local>');
      assert.equal(calls.transports[0].jsonTransport, true);
    } finally { console.log = original; restore(); }
  });

  console.log(`production mail: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
