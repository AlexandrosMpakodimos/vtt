const express = require('express');
const knex = require('../db');
const { hashPassword, verifyPassword } = require('../services/password');
const { requireAuth } = require('../middleware/auth');
const { contentWriteLimiter } = require('../middleware/rateLimit');
const { requireMember, requireOwner, validCampaignId } = require('../middleware/campaignAuth');
const {
  validateCampaignName, validateCampaignDescription,
  validateImageUrl, validateCampaignPassword, validateColor,
} = require('../services/validators');

const { router: sceneRoutes } = require('./scenes');
const { router: actorRoutes } = require('./actors');
const { router: itemRoutes } = require('./items');
const { router: combatRoutes } = require('./combat');
const { router: chatRoutes } = require('./chat');
const { router: spellRoutes } = require('./spells');

const router = express.Router();

// Every campaign route requires a logged-in user; mounting the guard once here
// means a new route cannot be added without it by accident.
router.use(requireAuth);

// Scenes + tokens live under a specific campaign. Mounting here (rather than in
// server.js) means the scene routes inherit requireAuth above and receive :id
// as req.params.id via mergeParams, and the requireMember/requireOwner guards
// inside scenes.js resolve that campaign exactly as the campaign routes do.
router.use('/:id/scenes', sceneRoutes);

// Actors (characters) + inventory, and the item catalogue. Same reasoning as the
// scene mount above: they inherit requireAuth, receive :id via mergeParams, and
// resolve the campaign through the identical requireMember/requireOwner guards,
// so there is one definition of campaign membership across every game resource.
router.use('/:id/actors', actorRoutes);
router.use('/:id/items', itemRoutes);
// M5. Mounted through the campaign router like every other resource, so
// requireAuth / requireMember / requireOwner, req.campaign and req.isOwner apply
// unchanged and none of them has to be re-implemented.
router.use('/:id/combat', combatRoutes);
router.use('/:id/messages', chatRoutes);
router.use('/:id/spells', spellRoutes);

// Abuse-prevention caps, enforced in application logic (consistent with the
// attunement cap). NOT memory protection: campaigns are rows in Postgres, not
// objects in RAM — what consumes memory is live socket connections. These exist
// to stop spam (a script creating a million rows) and for product sanity.
const MAX_CAMPAIGNS_PER_USER = Number(process.env.MAX_CAMPAIGNS_PER_USER) || 20;
const MAX_PLAYERS_PER_CAMPAIGN = Number(process.env.MAX_PLAYERS_PER_CAMPAIGN) || 8; // includes the GM

// Soft-deleted campaigns are recoverable for this long, then hard-swept.
const SOFT_DELETE_DAYS = 30;

// Explicit allow-list. password_hash is absent by construction, so no response
// can leak it — the same discipline as SAFE_COLUMNS in routes/auth.js.
const SAFE_COLUMNS = [
  'id', 'owner_id', 'name', 'description', 'img_url',
  'is_public', 'active_scene_id', 'settings', 'created_at', 'updated_at',
];

// Shapes a campaign for the client. has_password is exposed as a BOOLEAN (never
// the hash) so the UI knows whether to prompt; is_gm is derived per-viewer.
function publicCampaign(c, viewerId) {
  if (!c) return null;
  return {
    id: c.id,
    owner_id: c.owner_id,
    name: c.name,
    description: c.description,
    img_url: c.img_url,
    is_public: c.is_public,
    has_password: !!c.password_hash,
    is_gm: viewerId != null && c.owner_id === viewerId,
    active_scene_id: c.active_scene_id,
    settings: c.settings,
    created_at: c.created_at,
    updated_at: c.updated_at,
    // archived is the VIEWER's own dashboard state (from their campaign_members
    // row), not a property of the campaign — two viewers can disagree on it.
    // Only present when this campaign was loaded with a membership row joined in.
    ...(c.archived_at !== undefined ? { archived: c.archived_at !== null } : {}),
    ...(c.deleted_at !== undefined && c.deleted_at !== null ? { deleted_at: c.deleted_at } : {}),
  };
}

function publicMember(m) {
  return {
    user_id: m.user_id,
    username: m.username,
    avatar_url: m.avatar_url,
    status: m.status,
    color: m.color,
    joined_at: m.joined_at,
    is_gm: m.is_gm === true,
  };
}

// Search results are seen by non-members, so they get a narrower shape: enough
// to decide whether to join, nothing about who is inside.
function searchResult(c) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    img_url: c.img_url,
    is_public: c.is_public,
    has_password: !!c.password_hash,
    member_count: Number(c.member_count) || 0,
    created_at: c.created_at,
  };
}

const countActiveMembers = (campaignId) =>
  knex('campaign_members')
    .where({ campaign_id: campaignId, status: 'active' })
    .count({ n: '*' })
    .first()
    .then((r) => Number(r.n));

// POST /api/campaigns — create. Private campaigns require a password.
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};

    const n = validateCampaignName(body.name);
    if (n.error) return res.status(400).json({ error: n.error });

    const d = validateCampaignDescription(body.description);
    if (d.error) return res.status(400).json({ error: d.error });

    const img = validateImageUrl(body.img_url, 'img_url');
    if (img.error) return res.status(400).json({ error: img.error });

    const isPublic = body.is_public === true || body.is_public === 'true';

    // public = listed, no password. private = listed, password required.
    let password_hash = null;
    if (!isPublic) {
      const p = validateCampaignPassword(body.password);
      if (p.error) return res.status(400).json({ error: p.error });
      password_hash = await hashPassword(p.value);
    } else if (body.password) {
      return res.status(400).json({ error: 'a public campaign cannot have a password' });
    }

    // Cap enforcement must be ATOMIC, not read-then-write: a plain
    // "count >= MAX ? reject : insert" is a TOCTOU race (OWASP A08:2025) —
    // N parallel creates all read the same count before any insert commits and
    // all overrun the cap. The fix is to do the count and the insert inside one
    // SERIALIZABLE transaction, so concurrent creators are serialised by the DB
    // and a loser is aborted (40011) rather than allowed through. We retry the
    // aborted transaction a bounded number of times.
    //
    // Columns are hand-listed, never spread from the body: this is what makes
    // the write structurally immune to mass assignment.
    let campaign;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        campaign = await knex.transaction(async (trx) => {
          await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

          const owned = await trx('campaigns')
            .where({ owner_id: req.user.id }).whereNull('deleted_at')
            .count({ n: '*' }).first();
          if (Number(owned.n) >= MAX_CAMPAIGNS_PER_USER) {
            const e = new Error('cap'); e.capExceeded = true; throw e;
          }

          const [row] = await trx('campaigns')
            .insert({
              owner_id: req.user.id,
              name: n.value,
              description: d.value,
              img_url: img.value,
              is_public: isPublic,
              password_hash,
            })
            .returning([...SAFE_COLUMNS, 'password_hash']);

          // The owner gets a membership row at creation. Access is still derived
          // from owner_id (see campaignAuth), but the row keeps the member list
          // complete and survives an ownership transfer.
          await trx('campaign_members').insert({
            campaign_id: row.id,
            user_id: req.user.id,
            status: 'active',
          });

          return row;
        });
        break;
      } catch (err) {
        if (err.capExceeded) {
          return res.status(409).json({
            error: `you can own at most ${MAX_CAMPAIGNS_PER_USER} campaigns — delete one first`,
          });
        }
        // 40001 = serialization_failure: a concurrent create won the race and
        // this one was aborted to preserve the cap. Retry a few times.
        if (err.code === '40001' && attempt < 5) { attempt += 1; continue; }
        throw err;
      }
    }

    return res.status(201).json({ campaign: publicCampaign(campaign, req.user.id) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/mine?role=all|owner|player&filter=active|archived|all
// The dashboard: campaigns I'm an active member of (owned or joined).
// Declared before /:id so "mine" is never parsed as a campaign id.
//
//   role   — 'owner' (I'm the GM), 'player' (active member, not GM), 'all' (both).
//            Drives the Owned vs. Joined tabs; defaults to 'all'.
//   filter — 'active' (not archived), 'archived', or 'all'. Archive is per-user
//            (campaign_members.archived_at), so this filters MY view, not the
//            campaign globally; defaults to 'active' so archived rows are hidden
//            from the normal dashboard until asked for.
router.get('/mine', async (req, res, next) => {
  try {
    const role = ['all', 'owner', 'player'].includes(req.query.role) ? req.query.role : 'all';
    const filter = ['active', 'archived', 'all'].includes(req.query.filter) ? req.query.filter : 'active';

    const query = knex('campaigns as c')
      .join('campaign_members as m', 'm.campaign_id', 'c.id')
      .where('m.user_id', req.user.id)
      .where('m.status', 'active')
      .whereNull('c.deleted_at');

    // GM is derived from ownership, so the tabs split on owner_id, not a role column.
    if (role === 'owner') query.where('c.owner_id', req.user.id);
    if (role === 'player') query.whereNot('c.owner_id', req.user.id);

    if (filter === 'active') query.whereNull('m.archived_at');
    if (filter === 'archived') query.whereNotNull('m.archived_at');

    const rows = await query
      .orderBy('c.updated_at', 'desc')
      .select('c.*', 'm.archived_at'); // archived_at feeds the per-viewer `archived` flag

    return res.json({ campaigns: rows.map((c) => publicCampaign(c, req.user.id)) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/deleted — the owner's 30-day recycle bin.
router.get('/deleted', async (req, res, next) => {
  try {
    const rows = await knex('campaigns')
      .where({ owner_id: req.user.id })
      .whereNotNull('deleted_at')
      .whereRaw(`deleted_at > now() - interval '${SOFT_DELETE_DAYS} days'`)
      .orderBy('deleted_at', 'desc');

    return res.json({ campaigns: rows.map((c) => publicCampaign(c, req.user.id)) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/search?q=&visibility=all|public|private
// Rate-limited in server.js. Excludes soft-deleted rows.
router.get('/search', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > 100) return res.status(400).json({ error: 'search term is too long' });

    const visibility = ['all', 'public', 'private'].includes(req.query.visibility)
      ? req.query.visibility
      : 'all';

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

    const query = knex('campaigns as c').whereNull('c.deleted_at');

    if (q) {
      // ILIKE with a knex binding: the term is a bound parameter, never
      // concatenated into SQL. Escape the LIKE metacharacters so a user
      // searching for "100%" or "a_b" gets a literal match rather than a wildcard.
      const term = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      query.where((b) => b.whereILike('c.name', term).orWhereILike('c.description', term));
    }
    if (visibility === 'public') query.where('c.is_public', true);
    if (visibility === 'private') query.where('c.is_public', false);

    const rows = await query
      .leftJoin('campaign_members as m', function () {
        this.on('m.campaign_id', '=', 'c.id').andOnVal('m.status', '=', 'active');
      })
      .groupBy('c.id')
      .orderBy('c.created_at', 'desc')
      .limit(limit)
      .select('c.*', knex.raw('count(m.user_id) as member_count'));

    return res.json({ campaigns: rows.map(searchResult) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id — detail, members only.
router.get('/:id', requireMember, async (req, res, next) => {
  try {
    const members = await knex('campaign_members as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where('m.campaign_id', req.campaign.id)
      .where('m.status', 'active')
      .select('m.user_id', 'm.status', 'm.color', 'm.joined_at', 'u.username', 'u.avatar_url');

    return res.json({
      campaign: publicCampaign(req.campaign, req.user.id),
      members: members
        .map((m) => ({ ...m, is_gm: m.user_id === req.campaign.owner_id }))
        .map(publicMember),
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/join — rate-limited in server.js.
//
// Order is deliberate: banned -> active -> password.
//   1. A banned user is told plainly they are banned, and no ~150ms Argon2id
//      verify is spent on someone who can never get in.
//   2. An already-active member walks straight back in, which is what makes a
//      reconnect free (disconnect != leave).
//   3. A 'left' member and a brand-new user take the SAME path: a returning
//      member is not privileged over a newcomer.
router.post('/:id/join', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!validCampaignId(id)) return res.status(404).json({ error: 'campaign not found' });

    const campaign = await knex('campaigns').where({ id }).whereNull('deleted_at').first();
    if (!campaign) return res.status(404).json({ error: 'campaign not found' });

    const existing = await knex('campaign_members')
      .where({ campaign_id: id, user_id: req.user.id })
      .first();

    // 1. Banned — before any password work.
    if (existing && existing.status === 'banned') {
      return res.status(403).json({ error: 'you are banned from this campaign' });
    }

    // 2. Already active (includes the owner) — no password, no write.
    if (campaign.owner_id === req.user.id || (existing && existing.status === 'active')) {
      return res.json({ campaign: publicCampaign(campaign, req.user.id), status: 'active' });
    }

    // 3. 'left' or brand new — private campaigns verify the password here.
    if (!campaign.is_public) {
      const supplied = req.body && req.body.password;
      // Bound before hashing: mirrors the pre-hash guard in config/passport.js
      // so an oversized body can't force expensive Argon2id work.
      if (typeof supplied !== 'string' || supplied.length === 0 || supplied.length > 128) {
        return res.status(401).json({ error: 'incorrect campaign password' });
      }
      const ok = campaign.password_hash && (await verifyPassword(campaign.password_hash, supplied));
      if (!ok) return res.status(401).json({ error: 'incorrect campaign password' });
    }

    // `let`, not `const`: the retry below clears it if the colour is taken.
    const colour = validateColor(req.body && req.body.color);
    if (colour.error) return res.status(400).json({ error: colour.error });
    const c = { value: colour.value };

    // Cap + membership write, made ATOMIC to close the same TOCTOU race as
    // create (OWASP A08:2025): without this, N parallel joiners all read
    // "count < MAX" before any insert commits and overrun the player cap.
    // SERIALIZABLE serialises concurrent joiners; a loser aborts (40001) and
    // retries, re-reading a now-accurate count. The cap is still checked AFTER
    // the password (above) so it can't probe how full a private campaign is.
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await knex.transaction(async (trx) => {
          await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

          const cur = await trx('campaign_members')
            .where({ campaign_id: id, status: 'active' })
            .count({ n: '*' }).first();
          if (Number(cur.n) >= MAX_PLAYERS_PER_CAMPAIGN) {
            const e = new Error('full'); e.campaignFull = true; throw e;
          }

          // Rows are never deleted — a returning member is an UPDATE of the
          // existing row, so their history (and original joined_at) survives.
          if (existing) {
            await trx('campaign_members')
              .where({ campaign_id: id, user_id: req.user.id })
              .update({ status: 'active', ...(c.value ? { color: c.value } : {}) });
          } else {
            await trx('campaign_members').insert({
              campaign_id: id,
              user_id: req.user.id,
              status: 'active',
              color: c.value,
            });
          }
        });
        break;
      } catch (err) {
        if (err.campaignFull) return res.status(409).json({ error: 'this campaign is full' });
        if (err.code === '40001' && attempt < 5) { attempt += 1; continue; }
        // [FINDING, fixed 2026-08-04] The M6 partial unique index on
        // (campaign_id, color) made this route able to raise 23505, which it did
        // not handle — so joining a campaign where somebody already held your
        // colour returned a 500.
        //
        // Worse than the crash: the 500 was an ORACLE. A stranger could probe a
        // public campaign's palette from outside by joining with each colour in
        // turn and watching which ones failed.
        //
        // The colour is DROPPED rather than the join refused. Refusing would be
        // absurd — you cannot enter a game because somebody took blue — and a
        // 409 would leak the same information the 500 did. Joining succeeds
        // colourless; PATCH /:id/me is where a colour is chosen, and that route
        // answers 409 honestly because by then the caller is already a member
        // and the palette is data they can already read.
        if (err.code === '23505' && c.value && attempt < 5) {
          c.value = null;
          attempt += 1;
          continue;
        }
        throw err;
      }
    }

    return res.json({ campaign: publicCampaign(campaign, req.user.id), status: 'active' });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/campaigns/:id/me — a member sets their own display colour.
//
// SELF-SERVICE by design. The colour identifies you at the table, so it is yours
// to choose; requireMember rather than requireOwner, and the row updated is
// always the CALLER's — there is no user id in the path, so this route cannot be
// pointed at somebody else no matter what the body says.
//
// The owner is covered by the same route because campaign creation inserts a
// membership row for them, and an ownership transfer targets an existing active
// member, so every participant has a row to update.
//
// UNIQUENESS IS ENFORCED BY THE DATABASE, not by checking first. A partial
// unique index on (campaign_id, color) means two members clicking the same
// swatch simultaneously race at the index and exactly one wins — there is no
// read-then-write for a TOCTOU to live in, which is the standing atomic-cap
// constraint satisfied natively rather than through withAtomicCap. The 23505
// below is that race being lost, and it is a 409 rather than a 500 because
// losing it is an ordinary outcome, not an error.
// [FINDING, fixed 2026-08-04] This route had NO rate limiter, and it is the only
// write in the project that both persists and broadcasts ROOM-WIDE without one.
// Every other resource router — actors, scenes, items, chat, combat, spells —
// applies contentWriteLimiter; campaigns.js never needed one because its writes
// are rare (create, join, transfer) and each has its own limiter in server.js.
// This route broke that pattern: one request fans out to every connected member,
// so an unlimited caller is an amplifier, not merely a busy writer.
//
// Applied to this route ALONE rather than to the router, because mounting it on
// campaigns.js would silently change the limits on join, search and create,
// which have their own tuned limiters and their own suites.
router.patch('/:id/me', requireMember, contentWriteLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.color === undefined) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    const c = validateColor(body.color);
    if (c.error) return res.status(400).json({ error: c.error });

    let row;
    try {
      // Explicit column list, and the WHERE names the caller: an update that
      // could be aimed elsewhere is the shape of every BOLA defect in this
      // project's audits.
      [row] = await knex('campaign_members')
        .where({ campaign_id: req.campaign.id, user_id: req.user.id })
        .update({ color: c.value })
        .returning(['user_id', 'status', 'color', 'joined_at']);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'somebody at this table already has that colour' });
      }
      throw err;
    }
    if (!row) return res.status(404).json({ error: 'membership not found' });

    const user = await knex('users').where({ id: req.user.id }).first();
    const shaped = publicMember({
      ...row,
      username: user && user.username,
      avatar_url: user && user.avatar_url,
      is_gm: req.user.id === req.campaign.owner_id,
    });

    // Everyone at the table needs to know, or the legend disagrees between
    // browsers. Room-wide because a colour is not scene-scoped and discloses
    // nothing — every member can already read the member list.
    req.app.get('campaignSockets')?.broadcastRoom(req.campaign.id, 'member:updated', shaped);

    return res.json({ member: shaped });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/leave — status -> 'left'. The owner cannot leave.
router.post('/:id/leave', requireMember, async (req, res, next) => {
  try {
    // Deliberate: this kills the orphaned-campaign bug at the source.
    if (req.isOwner) {
      return res.status(409).json({
        error: 'the owner cannot leave — transfer ownership or delete the campaign',
      });
    }

    await knex('campaign_members')
      .where({ campaign_id: req.campaign.id, user_id: req.user.id })
      .update({ status: 'left' });

    return res.json({ ok: true, status: 'left' });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/archive — hide this campaign from MY active dashboard.
// Per-user and purely visual: it sets my own membership's archived_at and touches
// no one else's view. Any active member (owner or player) may archive their view;
// it is not moderation and does not affect membership or access. requireMember
// guarantees the caller has a membership row to stamp.
router.post('/:id/archive', requireMember, async (req, res, next) => {
  try {
    await knex('campaign_members')
      .where({ campaign_id: req.campaign.id, user_id: req.user.id })
      .update({ archived_at: knex.fn.now() });
    return res.json({ ok: true, archived: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/unarchive — bring it back into my active dashboard.
router.post('/:id/unarchive', requireMember, async (req, res, next) => {
  try {
    await knex('campaign_members')
      .where({ campaign_id: req.campaign.id, user_id: req.user.id })
      .update({ archived_at: null });
    return res.json({ ok: true, archived: false });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/campaigns/:id — owner edits.
router.patch('/:id', requireOwner, async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) {
      const n = validateCampaignName(body.name);
      if (n.error) return res.status(400).json({ error: n.error });
      updates.name = n.value;
    }

    if (body.description !== undefined) {
      const d = validateCampaignDescription(body.description);
      if (d.error) return res.status(400).json({ error: d.error });
      updates.description = d.value;
    }

    if (body.img_url !== undefined) {
      const img = validateImageUrl(body.img_url, 'img_url');
      if (img.error) return res.status(400).json({ error: img.error });
      updates.img_url = img.value;
    }

    // Visibility and password interact, so they are resolved together.
    const nextIsPublic = body.is_public === undefined
      ? req.campaign.is_public
      : (body.is_public === true || body.is_public === 'true');

    if (body.is_public !== undefined) updates.is_public = nextIsPublic;

    if (nextIsPublic) {
      // Going public drops the password: a public campaign has no secret to keep.
      if (body.password) {
        return res.status(400).json({ error: 'a public campaign cannot have a password' });
      }
      if (!req.campaign.is_public) updates.password_hash = null;
    } else {
      if (body.password !== undefined) {
        const p = validateCampaignPassword(body.password);
        if (p.error) return res.status(400).json({ error: p.error });
        updates.password_hash = await hashPassword(p.value);
      } else if (req.campaign.is_public && body.is_public !== undefined) {
        // Going private requires a password in the same request; otherwise the
        // campaign would sit private with a NULL hash and be unjoinable.
        return res.status(400).json({ error: 'a password is required to make a campaign private' });
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }

    updates.updated_at = knex.fn.now();

    const [row] = await knex('campaigns')
      .where({ id: req.campaign.id })
      .update(updates)
      .returning([...SAFE_COLUMNS, 'password_hash']);

    return res.json({ campaign: publicCampaign(row, req.user.id) });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/campaigns/:id — owner soft-deletes (recoverable for 30 days).
router.delete('/:id', requireOwner, async (req, res, next) => {
  try {
    await knex('campaigns')
      .where({ id: req.campaign.id })
      .update({ deleted_at: knex.fn.now(), updated_at: knex.fn.now() });

    return res.json({
      ok: true,
      message: `campaign deleted — recoverable for ${SOFT_DELETE_DAYS} days`,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/restore — owner restores within the window.
// requireOwner is bypassed on purpose: it filters out deleted_at IS NOT NULL,
// which is exactly the row this route needs. Ownership is checked inline.
router.post('/:id/restore', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!validCampaignId(id)) return res.status(404).json({ error: 'campaign not found' });

    const campaign = await knex('campaigns').where({ id }).first();
    if (!campaign || !campaign.deleted_at) {
      return res.status(404).json({ error: 'no deleted campaign with that id' });
    }
    if (campaign.owner_id !== req.user.id) {
      return res.status(404).json({ error: 'no deleted campaign with that id' });
    }

    const expiry = new Date(campaign.deleted_at).getTime() + SOFT_DELETE_DAYS * 86400000;
    if (Date.now() > expiry) {
      return res.status(410).json({ error: 'the 30-day recovery window has passed' });
    }

    // Restoring must respect the cap, or delete/create/restore would be a way
    // around it.
    const owned = await knex('campaigns')
      .where({ owner_id: req.user.id }).whereNull('deleted_at')
      .count({ n: '*' }).first();
    if (Number(owned.n) >= MAX_CAMPAIGNS_PER_USER) {
      return res.status(409).json({
        error: `you already own ${MAX_CAMPAIGNS_PER_USER} campaigns — delete one before restoring`,
      });
    }

    const [row] = await knex('campaigns')
      .where({ id })
      .update({ deleted_at: null, updated_at: knex.fn.now() })
      .returning([...SAFE_COLUMNS, 'password_hash']);

    return res.json({ campaign: publicCampaign(row, req.user.id) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id/members — the owner's manage-players view: ALL statuses.
router.get('/:id/members', requireOwner, async (req, res, next) => {
  try {
    const members = await knex('campaign_members as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where('m.campaign_id', req.campaign.id)
      .orderBy('m.joined_at', 'asc')
      .select('m.user_id', 'm.status', 'm.color', 'm.joined_at', 'u.username', 'u.avatar_url');

    return res.json({
      members: members
        .map((m) => ({ ...m, is_gm: m.user_id === req.campaign.owner_id }))
        .map(publicMember),
    });
  } catch (err) {
    return next(err);
  }
});

// Kick and ban differ only in the resulting status and reversibility, so they
// share a helper. Both disconnect the target's sockets — enforcement lives in
// the socket layer (see socket.js); the DB write alone would leave an already
// connected socket sitting in the room.
function moderationRoute(nextStatus) {
  return async (req, res, next) => {
    try {
      const targetId = req.params.userId;
      if (!validCampaignId(targetId)) return res.status(404).json({ error: 'member not found' });
      if (targetId === req.user.id) {
        return res.status(409).json({ error: `you cannot ${nextStatus === 'banned' ? 'ban' : 'kick'} yourself` });
      }

      const member = await knex('campaign_members')
        .where({ campaign_id: req.campaign.id, user_id: targetId })
        .first();
      if (!member) return res.status(404).json({ error: 'member not found' });

      await knex('campaign_members')
        .where({ campaign_id: req.campaign.id, user_id: targetId })
        .update({ status: nextStatus });

      req.app.get('campaignSockets')?.evictUser(req.campaign.id, targetId);

      return res.json({ ok: true, user_id: targetId, status: nextStatus });
    } catch (err) {
      return next(err);
    }
  };
}

// POST /api/campaigns/:id/members/:userId/kick — status 'left'; they may rejoin.
router.post('/:id/members/:userId/kick', requireOwner, moderationRoute('left'));

// POST /api/campaigns/:id/members/:userId/ban — status 'banned'; owner-reversible only.
router.post('/:id/members/:userId/ban', requireOwner, moderationRoute('banned'));

// POST /api/campaigns/:id/members/:userId/unban — back to 'left', not 'active':
// un-banning restores the right to ask, not membership itself. They rejoin
// through the normal flow (and re-enter the password if the campaign is private).
router.post('/:id/members/:userId/unban', requireOwner, async (req, res, next) => {
  try {
    const targetId = req.params.userId;
    if (!validCampaignId(targetId)) return res.status(404).json({ error: 'member not found' });

    const member = await knex('campaign_members')
      .where({ campaign_id: req.campaign.id, user_id: targetId })
      .first();
    if (!member) return res.status(404).json({ error: 'member not found' });
    if (member.status !== 'banned') {
      return res.status(409).json({ error: 'that member is not banned' });
    }

    await knex('campaign_members')
      .where({ campaign_id: req.campaign.id, user_id: targetId })
      .update({ status: 'left' });

    return res.json({ ok: true, user_id: targetId, status: 'left' });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/transfer — hand ownership to another ACTIVE member.
// GM-ness follows automatically because it is derived from owner_id.
router.post('/:id/transfer', requireOwner, async (req, res, next) => {
  try {
    const targetId = req.body && req.body.user_id;
    if (!validCampaignId(targetId)) return res.status(400).json({ error: 'user_id is required' });
    if (targetId === req.user.id) {
      return res.status(409).json({ error: 'you already own this campaign' });
    }

    const member = await knex('campaign_members')
      .where({ campaign_id: req.campaign.id, user_id: targetId })
      .first();
    if (!member || member.status !== 'active') {
      return res.status(409).json({ error: 'ownership can only be transferred to an active member' });
    }

    const [row] = await knex('campaigns')
      .where({ id: req.campaign.id })
      .update({ owner_id: targetId, updated_at: knex.fn.now() })
      .returning([...SAFE_COLUMNS, 'password_hash']);

    // The old owner keeps their (already existing) membership row and stays an
    // active member — now an ordinary player.
    return res.json({ campaign: publicCampaign(row, req.user.id) });
  } catch (err) {
    return next(err);
  }
});

module.exports = { router, SOFT_DELETE_DAYS, MAX_CAMPAIGNS_PER_USER, MAX_PLAYERS_PER_CAMPAIGN };
