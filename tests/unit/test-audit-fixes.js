const { rootPath } = require('../helpers/paths');
// Small source-level guards for fixes made after the thesis audit (2026-10-01).
// Each one protects a property that is awkward to observe behaviourally.
const fs = require('fs');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${name}`); } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// C3: resend-verification must answer BEFORE it looks the account up or sends
// mail, as forgot-password does, or its response time reveals whether an
// unverified account exists for that address.
const auth = fs.readFileSync(rootPath('src/routes/auth.js'), 'utf8');
for (const route of ['resend-verification', 'forgot-password']) {
  const start = auth.indexOf(`router.post('/${route}'`);
  const end = auth.indexOf('router.', start + 10);
  const body = auth.slice(start, end);
  const reply = body.indexOf('res.json(generic)');
  const lookup = body.indexOf("knex('users')");
  t(`${route}: responds before the account lookup`, start >= 0 && reply >= 0 && lookup > reply,
    `reply at ${reply}, lookup at ${lookup}`);
}

// C4: the sign-up form must accept the usernames the server accepts. The
// server allows Unicode letters and digits; an ASCII-only pattern made the
// browser refuse Greek usernames before they reached it.
const html = fs.readFileSync(rootPath('client/index.html'), 'utf8');
const m = html.match(/id="suUsername"[^>]*pattern="([^"]+)"/);
t('sign-up username field has a pattern', !!m);
if (m) {
  // Browsers compile the pattern attribute with the v flag, anchored.
  const re = new RegExp(`^(?:${m[1]})$`, 'v');
  for (const ok of ['Αλέξανδρος', 'geek_one98', 'Zoë', 'Ηρώ_7']) t(`pattern accepts ${ok}`, re.test(ok));
  for (const bad of ['two words', 'semi;colon', 'dash-name']) t(`pattern refuses ${JSON.stringify(bad)}`, !re.test(bad));
}
const { validateUsername } = require('../../src/services/validators');
t('the server agrees on a Greek username', !validateUsername('Αλέξανδρος').error);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
