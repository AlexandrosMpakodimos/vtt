// Dev helper: fill a campaign to its player cap (MAX_PLAYERS_PER_CAMPAIGN,
// default 8, INCLUDING the GM). Registers throwaway users, verifies them
// straight in the DB (no email round-trip), logs each in, and joins them.
//
//   node scripts/fill-campaign.js "Test_Game"                 # public campaign
//   node scripts/fill-campaign.js "Test_Game" --password pw   # private campaign
//   node scripts/fill-campaign.js --id <uuid> --password pw   # by id instead of name
//
// Requires the server running (e.g. `SKIP_HIBP=1 MAIL_JSON=1 npm run dev:test`)
// and DATABASE_URL reachable. Talks to BASE_URL (default http://localhost:3000).
//
// SAFETY: this creates real accounts + membership rows in whatever database
// DATABASE_URL points at. Intended for a LOCAL DEV database only. Every user it
// makes is tagged with email `fill+<campaign>-<n>-<rand>@example.test` so you
// can find and delete them later:
//   DELETE FROM users WHERE email LIKE 'fill+%@example.test';
// (campaign_members rows cascade on user delete.)

const knex = require('../src/db');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PASSWORD = 'correct-horse-battery-staple-9'; // account password (not the campaign one)

// --- tiny arg parse -------------------------------------------------------
const args = process.argv.slice(2);
let name = null; let id = null; let campaignPassword = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--id') { id = args[i + 1]; i += 1; }
  else if (args[i] === '--password') { campaignPassword = args[i + 1]; i += 1; }
  else if (!args[i].startsWith('--')) { name = args[i]; }
}

function agent() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, path, body) {
      const headers = { Origin: BASE };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setC = res.headers.get('set-cookie');
      if (setC) cookie = setC.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { /* empty */ }
      return { status: res.status, data };
    },
  };
}

async function makeVerifiedUser(tag, n) {
  const a = agent();
  // The server normalizes emails to lowercase (validators.normalizeEmail), so
  // the stored row is lowercase. Build the email lowercase here too, or the
  // verify-update below would target 0 rows and the user would stay unverified.
  const email = `fill+${tag}-${n}-${Math.random().toString(16).slice(2, 8)}@example.test`.toLowerCase();
  const username = `fill_${tag}_${n}_${Math.random().toString(16).slice(2, 6)}`.slice(0, 30);
  const reg = await a.req('POST', '/api/auth/register', { email, username, password: PASSWORD });
  if (reg.status !== 201) throw new Error(`register failed (${reg.status}): ${JSON.stringify(reg.data)}`);
  // Verify directly in the DB so we skip the email link. Match on the normalized
  // email and assert exactly one row changed, so a silent 0-row update can't
  // slip through and surface as a confusing 403 at login.
  const updated = await knex('users').where({ email }).update({ email_verified_at: knex.fn.now() });
  if (updated !== 1) throw new Error(`verify-update touched ${updated} rows for ${email} (email normalization mismatch?)`);
  const login = await a.req('POST', '/api/auth/login', { email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed (${login.status}): ${JSON.stringify(login.data)}`);
  return { agent: a, email, username };
}

(async () => {
  try {
    // Resolve the campaign.
    let campaign;
    if (id) {
      campaign = await knex('campaigns').where({ id }).whereNull('deleted_at').first();
    } else if (name) {
      const matches = await knex('campaigns').where({ name }).whereNull('deleted_at');
      if (matches.length > 1) {
        console.error(`More than one campaign named "${name}". Re-run with --id <uuid>. Candidates:`);
        matches.forEach((c) => console.error(`  ${c.id}  (owner ${c.owner_id}, ${c.is_public ? 'public' : 'private'})`));
        process.exit(1);
      }
      campaign = matches[0];
    } else {
      console.error('Usage: node scripts/fill-campaign.js "<name>" [--password <pw>]  |  --id <uuid> [--password <pw>]');
      process.exit(1);
    }
    if (!campaign) { console.error(`No campaign found for ${id ? `id ${id}` : `name "${name}"`}.`); process.exit(1); }

    const tag = (campaign.name || 'game').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'game';
    const MAX = Number(process.env.MAX_PLAYERS_PER_CAMPAIGN) || 8;

    // How many active members already? (GM counts.)
    const cur = await knex('campaign_members')
      .where({ campaign_id: campaign.id, status: 'active' }).count({ n: '*' }).first();
    const already = Number(cur.n);
    const need = MAX - already;

    console.log(`Campaign: ${campaign.name}  (${campaign.id})`);
    console.log(`Visibility: ${campaign.is_public ? 'public' : 'private'}${campaign.is_public ? '' : (campaignPassword ? ' — password supplied' : ' — NO --password given!')}`);
    console.log(`Cap: ${MAX} (incl. GM).  Active now: ${already}.  Adding: ${need > 0 ? need : 0}.`);

    if (!campaign.is_public && !campaignPassword) {
      console.error('\nThis campaign is PRIVATE. Re-run with --password "<the campaign password>".');
      process.exit(1);
    }
    if (need <= 0) { console.log('\nAlready at (or over) cap — nothing to do.'); await knex.destroy(); process.exit(0); }

    let added = 0;
    for (let i = 0; i < need; i += 1) {
      const u = await makeVerifiedUser(tag, already + i + 1);
      const body = campaign.is_public ? {} : { password: campaignPassword };
      const j = await u.agent.req('POST', `/api/campaigns/${campaign.id}/join`, body);
      if (j.status === 200 || j.status === 201) {
        added += 1;
        console.log(`  [${added}/${need}] joined as ${u.username}`);
      } else if (j.data && j.data.error === 'full') {
        console.log(`  cap reached mid-run (someone else joined?) — stopping.`);
        break;
      } else {
        console.error(`  join failed for ${u.username} (${j.status}): ${JSON.stringify(j.data)}`);
        console.error('  (If this says "incorrect campaign password", check --password. If the table is closed, joins may be blocked.)');
        break;
      }
    }

    const after = await knex('campaign_members')
      .where({ campaign_id: campaign.id, status: 'active' }).count({ n: '*' }).first();
    console.log(`\nDone. Active members now: ${Number(after.n)}/${MAX}.`);
    console.log(`Clean up later with:  DELETE FROM users WHERE email LIKE 'fill+%@example.test';`);
    await knex.destroy();
    process.exit(0);
  } catch (e) {
    console.error('\nfill-campaign failed:', e.message);
    try { await knex.destroy(); } catch { /* ignore */ }
    process.exit(1);
  }
})();
