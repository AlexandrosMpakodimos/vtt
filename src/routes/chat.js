// Chat (M5), mounted under /api/campaigns/:id/messages so that requireAuth /
// requireMember, req.campaign and req.isOwner apply exactly as they do
// everywhere else.
//
// Three things share this table because they are one thing — a line in the log:
// ordinary chat, dice results, and private messages. `type` distinguishes them
// for rendering; it does NOT control who receives them.
//
// ---------------------------------------------------------------------------
// WHISPERS — the confidentiality rule, and the door that is easy to miss
// ---------------------------------------------------------------------------
// whisper_to is the ONLY confidentiality mechanism on this table. NULL means
// everyone in the campaign; a non-empty array is the exact set of user ids who
// may receive the row. `type` is a rendering hint and nothing more: a row typed
// 'chat' with a populated whisper_to is private, and one typed 'whisper' with an
// empty array is public. The array is the authority, and only the array.
//
// THE DOOR. The obvious place to enforce this is the socket emit, and that is
// where it will get enforced first and where it is easiest to test. GET /
// (history) is the SIBLING ROUTE that reaches the same rows through a different
// door — and page back far enough and a player reads every private exchange at
// the table.
//
// That is precisely M4's V2: a rule enforced on list, detail and broadcast and
// missing from a sibling route reaching the same resource another way. ONE
// RESOURCE, SEVERAL DOORS, THE LOCK FITTED TO SOME OF THEM. Both doors are
// gated below, through the same predicate, so they cannot drift.
//
// POLICY, decided 2026-08-03: a whisper reaches exactly the ids in whisper_to
// plus its SENDER. The GM is included only when explicitly targeted. Silently
// copying the GM on every private message is surveillance, and M4 already chose
// prevention over surveillance when it took a restricted field allow-list
// instead of a change history. A GM who wants to see a message can be addressed
// in it.
//
// ---------------------------------------------------------------------------
// DICE
// ---------------------------------------------------------------------------
// The roll happens ON THE SERVER, in services/dice.js, and roll_data is written
// from what that returns. A results array in a request body is IGNORED, never
// merged: the one thing a player must not control is the outcome of their own
// roll. Dice roll and report — no damage is applied, no save resolved, nothing
// but this row is written.

const express = require('express');
const knex = require('../db');
const { requireMember } = require('../middleware/campaignAuth');
const { contentWriteLimiter } = require('../middleware/rateLimit');
const {
  validateMessageType, validateMessageContent, validateWhisperTo,
  validateInt,
} = require('../services/validators');
const { roll } = require('../services/dice');

const router = express.Router({ mergeParams: true });

router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return contentWriteLimiter(req, res, next);
});

// How many rows one history request may return. A bound on the PAGE, not on the
// table: there is deliberately no "no more than N messages" cap, because a cap
// that refuses new messages would make chat stop working at the ceiling, which
// is not what the standing atomic-cap constraint is for. Rate is bounded by
// contentWriteLimiter and each row is bounded by validateMessageContent.
//
// Unbounded history GROWTH is a real retention question and is flagged as future
// work rather than answered with a cap that breaks the feature.
const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;

function publicMessage(m) {
  if (!m) return null;
  return {
    id: m.id,
    campaign_id: m.campaign_id,
    user_id: m.user_id,
    speaker_name: m.speaker_name,
    content: m.content,
    type: m.type,
    roll_data: m.roll_data,
    whisper_to: m.whisper_to,
    created_at: m.created_at,
  };
}

// May this user receive this row? THE single definition, used by both doors —
// the history query below and the socket fan-out.
//
// Note the sender is always included: a whisper you sent must appear in your own
// log, or the conversation reads as one-sided to the person who started it.
function recipientsOf(message) {
  if (!message.whisper_to || !message.whisper_to.length) return null; // everyone
  const set = new Set(message.whisper_to);
  if (message.user_id) set.add(message.user_id);
  return [...set];
}

// GET /api/campaigns/:id/messages — history, newest last.
//
// Cursor by `before` (an ISO timestamp) rather than an offset: a log is appended
// to constantly, so an offset paginator re-reads and skips rows as new ones
// arrive. created_at is indexed with campaign_id for exactly this query.
router.get('/', requireMember, async (req, res, next) => {
  try {
    const limitRaw = req.query.limit === undefined ? DEFAULT_PAGE : req.query.limit;
    const limit = validateInt(limitRaw, { min: 1, max: MAX_PAGE, field: 'limit' });
    if (limit.error) return res.status(400).json({ error: limit.error });

    const q = knex('messages')
      .where({ campaign_id: req.campaign.id })
      .orderBy('created_at', 'desc')
      .limit(limit.value);

    if (req.query.before !== undefined) {
      const t = new Date(req.query.before);
      if (Number.isNaN(t.getTime())) {
        return res.status(400).json({ error: 'before must be a timestamp' });
      }
      q.andWhere('created_at', '<', t.toISOString());
    }

    // THE HISTORY DOOR. Enforced in SQL rather than by filtering after the fact,
    // so a private row is never even loaded into a response the code then has to
    // remember to strip. The containment operator does the work: a row is
    // readable when it has no recipient list, or when this user is in it, or
    // when this user wrote it.
    //
    // The GM is NOT exempt. A GM reading the table's private messages by virtue
    // of being the GM is the surveillance this project declined to build; if
    // they are meant to see it, they are in whisper_to.
    q.andWhere((b) => {
      b.whereNull('whisper_to')
        .orWhereRaw('cardinality(whisper_to) = 0')
        .orWhereRaw('whisper_to @> ARRAY[?]::uuid[]', [req.user.id])
        .orWhere('user_id', req.user.id);
    });

    const rows = await q;
    // Reverse so the client renders oldest-first without another sort.
    return res.json({ messages: rows.reverse().map(publicMessage) });
  } catch (err) {
    return next(err);
  }
});

// POST /api/campaigns/:id/messages — say something, or roll something.
//
// Over HTTP rather than as a socket handler, deliberately and consistently with
// every structural write in this project. It reuses the CSRF middleware, the
// rate limiter and the validation path that already exist, and it means M5 adds
// NO new authorisation surface to socket.js — one broadcast helper and no event
// handler. Chat is not a per-frame delta; a round trip is not the bottleneck.
router.post('/', requireMember, async (req, res, next) => {
  try {
    const body = req.body || {};

    const type = validateMessageType(body.type);
    if (type.error) return res.status(400).json({ error: type.error });

    const whisper = validateWhisperTo(body.whisper_to);
    if (whisper.error) return res.status(400).json({ error: whisper.error });

    // Every recipient must be an ACTIVE MEMBER of this campaign. Shape alone is
    // not enough: whisper_to is a DISCLOSURE LIST, so a well-formed id belonging
    // to a stranger is a row deliberately emitted to a stranger. Same check
    // validateActorField already performs before assigning actors.user_id.
    if (whisper.value) {
      const members = await knex('campaign_members')
        .where({ campaign_id: req.campaign.id, status: 'active' })
        .whereIn('user_id', whisper.value)
        .select('user_id');
      const ok = new Set(members.map((m) => m.user_id));
      // The owner is the GM and is not necessarily a row in campaign_members.
      ok.add(req.campaign.owner_id);
      for (const id of whisper.value) {
        if (!ok.has(id)) {
          return res.status(400).json({ error: 'whisper_to must list active members of this campaign' });
        }
      }
    }

    // Dice. The formula is the ONLY thing taken from the caller; results and
    // total are computed here. A body-supplied roll_data is ignored entirely
    // rather than merged — there is no field of it a client may contribute.
    let rollData = null;
    let content = null;
    if (body.formula !== undefined && body.formula !== null && body.formula !== '') {
      const r = roll(body.formula);
      if (r.error) return res.status(400).json({ error: r.error });
      rollData = r;
      // A roll may carry an optional label ("Goblin attack"), but does not
      // require one — the formula and the result are the message.
      if (body.content !== undefined && body.content !== null && body.content !== '') {
        const c = validateMessageContent(body.content);
        if (c.error) return res.status(400).json({ error: c.error });
        content = c.value;
      }
    } else {
      const c = validateMessageContent(body.content);
      if (c.error) return res.status(400).json({ error: c.error });
      content = c.value;
    }

    // speaker_name is denormalized so rendering the log needs no join AND so the
    // log survives users.id being SET NULL by an account deletion. It is taken
    // from the authenticated user, never from the body: accepting it would let
    // anyone speak as anyone.
    const speakerName = req.user.username;

    // A roll is typed 'roll' unless the caller asked for something else; an
    // explicit whisper_to makes it 'whisper' for rendering. Neither affects who
    // receives it — recipientsOf reads whisper_to and nothing else.
    let finalType = type.value;
    if (rollData && finalType === 'chat') finalType = 'roll';
    if (whisper.value && finalType === 'chat') finalType = 'whisper';

    const [row] = await knex('messages').insert({
      campaign_id: req.campaign.id,
      user_id: req.user.id,
      speaker_name: speakerName,
      content,
      type: finalType,
      roll_data: rollData ? JSON.stringify(rollData) : null,
      whisper_to: whisper.value,
    }).returning('*');

    const shaped = publicMessage(row);
    const sockets = req.app.get('campaignSockets');
    if (sockets) {
      const to = recipientsOf(row);
      if (to === null) {
        // Public: the whole campaign room. Not scene-scoped — chat is a campaign
        // conversation, not a property of the map anyone happens to be looking
        // at, so a player on no scene at all still hears the table.
        sockets.broadcastRoom(req.campaign.id, 'message:created', shaped);
      } else {
        // Private: exactly the named users plus the sender. This is the socket
        // half of the same predicate the history query enforces in SQL.
        await sockets.broadcastToUsers(req.campaign.id, to, 'message:created', shaped);
      }
    }

    return res.status(201).json({ message: shaped });
  } catch (err) {
    return next(err);
  }
});

module.exports = {
  router,
  publicMessage,
  recipientsOf,
  MAX_PAGE,
};
