const express = require('express');
const knex = require('../db');
const gateway = require('../services/mediaGateway');
const { hashPassword, verifyPassword } = require('../services/password');
const { requireAuth } = require('../middleware/auth');
const { contentWriteLimiter } = require('../middleware/rateLimit');
const {
  requireMember, requireMemberAnyState, requireOwner, validCampaignId,
} = require('../middleware/campaignAuth');
const { validateColor } = require('../services/validators');
const { publicCampaign, publicMember, searchResult } = require('../services/campaigns/presentation');
const { createCampaignOperations } = require('../services/campaigns/operations');
const { createCampaignMutationHandlers } = require('./campaignMutations');
const { SOFT_DELETE_DAYS } = require('../services/campaigns/constants');

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

// Keep production dependencies explicit; tests import these same factories.
const operations = createCampaignOperations({
  knex, hashPassword, verifyPassword, validCampaignId,
  MAX_CAMPAIGNS_PER_USER, MAX_PLAYERS_PER_CAMPAIGN,
});
const mutations = createCampaignMutationHandlers({ operations, gateway });

const countActiveMembers = (campaignId) =>
  knex('campaign_members')
    .where({ campaign_id: campaignId, status: 'active' })
    .count({ n: '*' })
    .first()
    .then((r) => Number(r.n));

// POST /api/campaigns — create. Private campaigns require a password.
router.post('/', mutations.create);

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
      .join('users as owner', 'owner.id', 'c.owner_id')
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
      .select('c.*', 'm.archived_at', 'owner.username as owner_username'); // archived_at feeds the per-viewer `archived` flag; owner_username labels the card

    return gateway.sendJson(req, res, { campaigns: rows.map((c) => publicCampaign(c, req.user.id)) });
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

    return gateway.sendJson(req, res, { campaigns: rows.map((c) => publicCampaign(c, req.user.id)) });
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
    // Offset for "load more": non-negative, and capped so a huge value can't be
    // used to walk the whole table cheaply. Paired with the stable created_at
    // ordering below, successive pages don't overlap.
    const offset = Math.min(Math.max(Number(req.query.offset) || 0, 0), 10000);

    const query = knex('campaigns as c').whereNull('c.deleted_at');

    if (q) {
      // ILIKE with a knex binding: the term is a bound parameter, never
      // concatenated into SQL. Escape the LIKE metacharacters so a user
      // searching for "100%" or "a_b" gets a literal match rather than a wildcard.
      const term = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      // Match the campaign name, its description, OR the GM's username, so
      // "find games run by <person>" works. owner is joined below; knex assembles
      // the full statement before executing, so referencing owner.username here
      // is fine. The term stays a bound parameter (no SQL injection).
      query.where((b) => b
        .whereILike('c.name', term)
        .orWhereILike('c.description', term)
        .orWhereILike('owner.username', term));
    }
    if (visibility === 'public') query.where('c.is_public', true);
    if (visibility === 'private') query.where('c.is_public', false);

    const rows = await query
      .join('users as owner', 'owner.id', 'c.owner_id')
      .leftJoin('campaign_members as m', function () {
        this.on('m.campaign_id', '=', 'c.id').andOnVal('m.status', '=', 'active');
      })
      .groupBy('c.id', 'owner.username')
      .orderBy('c.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .select('c.*', 'owner.username as owner_username', knex.raw('count(m.user_id) as member_count'));

    return gateway.sendJson(req, res, { campaigns: rows.map(searchResult) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/campaigns/:id — detail, members only.
router.get('/:id', requireMemberAnyState, async (req, res, next) => {
  try {
    const members = await knex('campaign_members as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where('m.campaign_id', req.campaign.id)
      .where('m.status', 'active')
      .select('m.user_id', 'm.status', 'm.color', 'm.joined_at', 'u.username', 'u.avatar_url');

    return gateway.sendJson(req, res, {
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
router.post('/:id/join', mutations.join);

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
router.patch('/:id/me', requireMemberAnyState, contentWriteLimiter, async (req, res, next) => {
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

    return gateway.sendJson(req, res, { member: shaped });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/leave — status -> 'left'. The owner cannot leave.
router.post('/:id/leave', requireMemberAnyState, mutations.leave);

// POST /api/campaigns/:id/archive — hide this campaign from MY active dashboard.
// Per-user and purely visual: it sets my own membership's archived_at and touches
// no one else's view. Any active member (owner or player) may archive their view;
// it is not moderation and does not affect membership or access. requireMember
// guarantees the caller has a membership row to stamp.
router.post('/:id/archive', requireMemberAnyState, async (req, res, next) => {
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
// [FIXED 2026-08-14] requireMemberAnyState, not requireMember.
//
// Archiving is dashboard state and was correctly exempted from the open gate;
// UNarchiving is the same state and was not, so a member who tidied away a
// closed campaign could not bring it back. One operation, two directions, the
// exemption applied to one of them — the same shape as several findings already
// on record in this project, and found here by a probe that tried to undo its
// own setup.
router.post('/:id/unarchive', requireMemberAnyState, async (req, res, next) => {
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
router.patch('/:id', requireOwner, mutations.patch);

// DELETE /api/campaigns/:id — owner soft-deletes (recoverable for 30 days).
router.delete('/:id', requireOwner, mutations.remove);

// POST /api/campaigns/:id/restore — owner restores within the window.
// requireOwner is bypassed on purpose: it filters out deleted_at IS NOT NULL,
// which is exactly the row this route needs. Ownership is checked inside the operation.
router.post('/:id/restore', mutations.restore);

// GET /api/campaigns/:id/members — the owner's manage-players view: ALL statuses.
router.get('/:id/members', requireOwner, async (req, res, next) => {
  try {
    const members = await knex('campaign_members as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where('m.campaign_id', req.campaign.id)
      .orderBy('m.joined_at', 'asc')
      .select('m.user_id', 'm.status', 'm.color', 'm.joined_at', 'u.username', 'u.avatar_url');

    return gateway.sendJson(req, res, {
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
// POST /api/campaigns/:id/members/:userId/kick — status 'left'; they may rejoin.
router.post('/:id/members/:userId/kick', requireOwner, mutations.moderationRoute('left'));

// POST /api/campaigns/:id/members/:userId/ban — status 'banned'; owner-reversible only.
router.post('/:id/members/:userId/ban', requireOwner, mutations.moderationRoute('banned'));

// POST /api/campaigns/:id/members/:userId/unban — back to 'left', not 'active':
// un-banning restores the right to ask, not membership itself. They rejoin
// through the normal flow (and re-enter the password if the campaign is private).
router.post('/:id/members/:userId/unban', requireOwner, mutations.unban);

// POST /api/campaigns/:id/transfer — hand ownership to another ACTIVE member.
// GM-ness follows automatically because it is derived from owner_id.
router.post('/:id/transfer', requireOwner, mutations.transfer);

module.exports = { router, SOFT_DELETE_DAYS, MAX_CAMPAIGNS_PER_USER, MAX_PLAYERS_PER_CAMPAIGN };
