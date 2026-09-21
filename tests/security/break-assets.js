// Strict-mode asset security tests.
// Usage: node scripts/test-local.js break-assets.js
// Real HTTP/PostgreSQL; memory storage only.
if (process.env.NODE_ENV !== 'test' ||
    process.env.BASE_URL !== 'http://127.0.0.1:3001') {
  throw new Error('Use the isolated test launcher.');
}

const knex = require('../../src/db');
const BASE = process.env.BASE_URL;
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
const users = [];
const campaigns = [];
const assets = new Set();
let savedPeriod = null;
let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log('  DEFENDED  ' + name);
  } else {
    fail++;
    console.log('  VULNERABLE  ' + name + ' ' + detail);
  }
}
function expect(name, response, status) {
  check(name, response.status === status, 'status=' + response.status);
}
function agent() {
  let cookie = '';
  return {
    async req(method, route, body, raw = false) {
      const headers = { Origin: BASE };
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) {
        headers['Content-Type'] = raw ? 'image/png' : 'application/json';
      }
      const response = await fetch(BASE + route, {
        method, headers,
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
      const nextCookie = response.headers.get('set-cookie');
      if (nextCookie) cookie = nextCookie.split(';')[0];
      const data = await response.json().catch(() => null);
      if (data?.asset?.id) assets.add(data.asset.id);
      return { status: response.status, data };
    },
    upload(metadata, bytes = PNG) {
      return this.req('POST',
        '/api/assets/upload?' + new URLSearchParams(metadata), bytes, true);
    },
  };
}
async function makeUser(label) {
  const who = agent();
  const suffix = Date.now() + '-' + Math.random().toString(16).slice(2, 8);
  const email = label + '-' + suffix + '@example.com';
  const password = 'correct-horse-battery-staple-9';
  const registered = await who.req('POST', '/api/auth/register', {
    email, username: label + suffix.replace(/[^a-z0-9]/gi, '').slice(-10), password,
  });
  const row = await knex('users').where({ email }).first();
  if (!row) throw new Error(
    'User setup failed: ' + registered.status + ' ' +
    JSON.stringify(registered.data?.error)
  );
  who.id = row.id;
  users.push(who);
  await knex('users').where({ id: row.id }).update({
    email_verified_at: knex.fn.now(),
  });
  const login = await who.req('POST', '/api/auth/login', { email, password });
  if (login.status !== 200) throw new Error('Login setup failed');
  return who;
}
async function makeCampaign(gm, name) {
  const result = await gm.req('POST', '/api/campaigns', {
    name, is_public: true,
  });
  if (!result.data?.campaign?.id) {
    throw new Error('Campaign setup failed: ' + result.status);
  }
  const campaign = result.data.campaign;
  campaigns.push({ gm, id: campaign.id });
  return campaign;
}

(async () => {
  try {
    const identityResponse = await fetch(BASE + '/__test/identity');
    const identity = await identityResponse.json();
    if (!identityResponse.ok || identity.storageBackend !== 'memory' ||
        identity.uploadMode !== 'strict') {
      throw new Error('Requires the strict memory test server');
    }
    const dbIdentity = (await knex.raw(
      'SELECT current_database() AS database, current_user AS role'
    )).rows[0];
    if (dbIdentity.database !== 'vtt_test' ||
        dbIdentity.role !== 'vtt_test_runner') {
      throw new Error('Unexpected database identity');
    }

    // Establish a test period without resetting byte or operation counters.
    const ledger = await knex('storage_budget').where({ id: true }).first();
    if (!ledger) throw new Error('Test ledger missing');
    if (!ledger.period_start || !ledger.period_end) {
      savedPeriod = {
        period_start: ledger.period_start,
        period_end: ledger.period_end,
      };
      await knex('storage_budget').where({ id: true }).update({
        period_start: knex.raw("now() - interval '1 day'"),
        period_end: knex.raw("now() + interval '1 day'"),
      });
    }

    const gm = await makeUser('assetgm');
    const player = await makeUser('assetpl');
    const outsider = await makeUser('assetout');
    const quotaUser = await makeUser('assetquota');
    const camp = await makeCampaign(gm, 'Strict asset audit');
    expect('player joins', await player.req(
      'POST', '/api/campaigns/' + camp.id + '/join', {}), 200);

    const portrait = {
      kind: 'portrait', campaign_id: camp.id, mime: 'image/png',
    };
    const map = { ...portrait, kind: 'map' };

    const disabled = await gm.req('POST', '/api/assets/presign', {
      ...map, bytes: PNG.length,
    });
    expect('legacy presign is disabled', disabled, 410);
    check('disabled presign supplies no grant', !disabled.data?.upload);

    expect('anonymous upload is refused', await agent().upload(map), 401);
    expect('player cannot upload a map', await player.upload(map), 403);
    expect('outsider cannot upload into the campaign',
      await outsider.upload(portrait), 404);

    const gone = await makeUser('assetgone');
    expect('departing member joins', await gone.req(
      'POST', '/api/campaigns/' + camp.id + '/join', {}), 200);
    expect('member leaves', await gone.req(
      'POST', '/api/campaigns/' + camp.id + '/leave', {}), 200);
    expect('departed member cannot upload', await gone.upload(portrait), 404);
    expect('departed member cannot add links', await gone.req(
      'POST', '/api/assets/external',
      { kind: 'portrait', campaign_id: camp.id, url: 'https://example.com/x.png' }
    ), 404);
    expect('departed member cannot read the library', await gone.req(
      'GET', '/api/assets?campaign_id=' + camp.id), 404);

    const doomed = await makeCampaign(gm, 'Deleted asset audit');
    expect('campaign deletion succeeds', await gm.req(
      'DELETE', '/api/campaigns/' + doomed.id), 200);
    expect('deleted campaign refuses uploads',
      await gm.upload({ ...map, campaign_id: doomed.id }), 404);

    // Synthetic rows test the count cap. They have no storage keys or objects.
    const pending = await knex('assets').insert(
      Array.from({ length: 20 }, (_, i) => ({
        user_id: quotaUser.id, campaign_id: null,
        storage_key: null, source: 'external', kind: 'avatar',
        status: 'pending', url: 'https://example.invalid/p' + i + '.png',
      }))
    ).returning('id');
    pending.forEach((row) => assets.add(row.id));

    expect('pending rows fill the external-link quota', await quotaUser.req(
      'POST', '/api/assets/external',
      { kind: 'avatar', url: 'https://example.com/extra.png' }), 409);
    expect('pending rows also fill the controlled-upload quota',
      await quotaUser.upload({ kind: 'avatar', mime: 'image/png' }), 409);

    const count = await knex('assets')
      .where({ user_id: quotaUser.id, campaign_id: null })
      .whereIn('status', ['pending', 'ready']).count('* as n').first();
    check('quota remains exactly twenty', Number(count.n) === 20);

    await knex('assets').where({ id: pending[0].id }).update({ status: 'rejected' });
    expect('rejected row frees one count slot', await quotaUser.req(
      'POST', '/api/assets/external',
      { kind: 'avatar', url: 'https://example.com/available.png' }), 201);

    expect('avatar cannot use campaign scope', await player.req(
      'POST', '/api/assets/external',
      { kind: 'avatar', campaign_id: camp.id, url: 'https://example.com/a.png' }
    ), 404);
    expect('map cannot use personal scope', await player.req(
      'POST', '/api/assets/external',
      { kind: 'map', url: 'https://example.com/m.png' }), 404);

    const forged = await player.req('POST', '/api/assets/external', {
      kind: 'portrait', campaign_id: camp.id, url: 'https://example.com/ok.png',
      id: '00000000-0000-4000-8000-000000000000',
      storage_key: 'forged/key.png', user_id: gm.id,
      source: 'upload', mime: 'image/svg+xml', bytes: 99999999,
    });
    expect('external link accepts only writable fields', forged, 201);
    if (!forged.data?.asset?.id) throw new Error('External fixture failed');
    const row = await knex('assets').where({ id: forged.data.asset.id }).first();
    check('storage key cannot be forged', row.storage_key === null);
    check('uploader cannot be forged', row.user_id === player.id);
    check('source cannot be forged', row.source === 'external');
    check('MIME cannot be forged', row.mime === null);
    check('byte count cannot be forged', row.bytes === null);
    check('asset ID is server assigned',
      row.id !== '00000000-0000-4000-8000-000000000000');
    expect('outsider cannot delete the image', await outsider.req(
      'DELETE', '/api/assets/' + row.id), 404);

    const personal = await player.req('POST', '/api/assets/external', {
      kind: 'avatar', url: 'https://example.com/avatar.png',
    });
    if (!personal.data?.asset?.id) throw new Error('Personal fixture failed');
    expect('campaign GM cannot delete another user personal image', await gm.req(
      'DELETE', '/api/assets/' + personal.data.asset.id), 404);
    expect('malformed deletion ID is refused', await player.req(
      'DELETE', '/api/assets/not-a-uuid'), 404);

    const statsBefore = await (await fetch(BASE + '/__test/identity')).json();
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)]);
    expect('GIF bytes claiming PNG are refused', await gm.upload(portrait, gif), 400);
    expect('SVG MIME is refused',
      await gm.upload({ ...portrait, mime: 'image/svg+xml' }), 400);
    expect('empty image is refused', await gm.upload(portrait, Buffer.alloc(0)), 400);
    const statsAfter = await (await fetch(BASE + '/__test/identity')).json();
    check('invalid images trigger no storage writes',
      statsBefore.storageStats.putCalls === statsAfter.storageStats.putCalls);

    console.log('NOTE: successful uploads, retries, idempotency and cleanup are covered by test-assets.js.');
  } catch (error) {
    check('suite completes without an exception', false, error.message);
  } finally {
    try {
      for (const id of assets) {
        if (!(await knex('assets').where({ id }).first())) continue;
        for (const who of users) {
          const result = await who.req('DELETE', '/api/assets/' + id);
          if (result.status === 200) break;
        }
      }
      const remaining = assets.size
        ? await knex('assets').whereIn('id', [...assets]).count('* as n').first()
        : { n: 0 };
      check('all recorded asset fixtures are removed', Number(remaining.n) === 0);

      if (Number(remaining.n) === 0) {
        for (const campaign of campaigns) {
          await campaign.gm.req('DELETE', '/api/campaigns/' + campaign.id);
        }
        if (users.length) {
          await knex('users').whereIn('id', users.map((who) => who.id)).del();
        }
      }
    } catch (error) {
      check('fixture cleanup succeeds', false, error.message);
    } finally {
      try {
        if (savedPeriod) {
          await knex('storage_budget').where({ id: true }).update(savedPeriod);
        }
      } catch (error) {
        check('test period restored', false, error.message);
      }
      console.log('\n' + pass + ' defended, ' + fail + ' vulnerable');
      if (fail) process.exitCode = 1;
      await knex.destroy();
    }
  }
})();
