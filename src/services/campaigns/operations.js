// Campaign mutations own their existing validation, transaction and retry units.
// Inputs carry caller IDs, never an authorized campaign snapshot. Expected
// refusals retain the existing status/error data; HTTP serialization and socket
// effects belong to routes/campaignMutations.js after these promises resolve.
const {
  validateCampaignName, validateCampaignDescription, validateImageUrl,
  validateCampaignPassword, validateColor, validateBool,
} = require('../validators');
const { SAFE_COLUMNS } = require('./presentation');
const { SOFT_DELETE_DAYS } = require('./constants');

function createCampaignOperations({
  knex, hashPassword, verifyPassword, validCampaignId,
  MAX_CAMPAIGNS_PER_USER, MAX_PLAYERS_PER_CAMPAIGN,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random, now = Date.now,
}) {
  async function create({ userId, body: input }) {
    const body = input || {};

    const n = validateCampaignName(body.name);
    if (n.error) return { status: 400, error: n.error };

    const d = validateCampaignDescription(body.description);
    if (d.error) return { status: 400, error: d.error };

    const img = validateImageUrl(body.img_url, 'img_url');
    if (img.error) return { status: 400, error: img.error };

    const isPublic = body.is_public === true || body.is_public === 'true';

    // public = listed, no password. private = listed, password required.
    let password_hash = null;
    if (!isPublic) {
      const p = validateCampaignPassword(body.password);
      if (p.error) return { status: 400, error: p.error };
      password_hash = await hashPassword(p.value);
    } else if (body.password) {
      return { status: 400, error: 'a public campaign cannot have a password' };
    }

    // Cap enforcement must be ATOMIC, not read-then-write: a plain
    // "count >= MAX ? reject : insert" is a TOCTOU race (OWASP A08:2025) —
    // N parallel creates all read the same count before any insert commits and
    // all overrun the cap. The fix is to do the count and the insert inside one
    // SERIALIZABLE transaction, so concurrent creators are serialised by the DB
    // and a loser is aborted (40001) rather than allowed through. We retry the
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
            .where({ owner_id: userId }).whereNull('deleted_at')
            .count({ n: '*' }).first();
          if (Number(owned.n) >= MAX_CAMPAIGNS_PER_USER) {
            const e = new Error('cap'); e.capExceeded = true; throw e;
          }

          const [row] = await trx('campaigns')
            .insert({
              owner_id: userId,
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
            user_id: userId,
            status: 'active',
          });

          return row;
        });
        break;
      } catch (err) {
        if (err.capExceeded) {
          return {
            status: 409,
            error: `you can own at most ${MAX_CAMPAIGNS_PER_USER} campaigns — delete one first`,
          };
        }
        // Retry the whole aborted transaction. Jitter separates competing
        // requests; the six-attempt bound prevents unbounded work under load.
        if (err.code === '40001') {
          if (attempt < 5) {
            const baseDelay = 10 * (2 ** attempt);
            const delay = baseDelay + Math.floor(random() * baseDelay);
            attempt += 1;
            await sleep(delay);
            continue;
          }
          // The last transaction rolled back. This is temporary contention,
          // not evidence that the user's campaign quota has been reached.
          return {
            status: 409,
            error: 'Campaign creation is busy. Please try again.',
            code: 'campaign_create_busy',
            retryable: true,
          };
        }
        throw err;
      }
    }

    return { row: campaign };
  }

  async function join({ campaignId, userId, body: input }) {
    const id = campaignId;
    if (!validCampaignId(id)) return { status: 404, error: 'campaign not found' };

    const campaign = await knex('campaigns').where({ id }).whereNull('deleted_at').first();
    if (!campaign) return { status: 404, error: 'campaign not found' };

    const existing = await knex('campaign_members')
      .where({ campaign_id: id, user_id: userId })
      .first();

    // 1. Banned — before any password work.
    if (existing && existing.status === 'banned') {
      return { status: 403, error: 'you are banned from this campaign' };
    }

    // 2. Already active (includes the owner) — no password, no write.
    if (campaign.owner_id === userId || (existing && existing.status === 'active')) {
      return { row: campaign };
    }

    // 3. 'left' or brand new — private campaigns verify the password here.
    if (!campaign.is_public) {
      const supplied = input && input.password;
      // Bound before hashing: mirrors the pre-hash guard in config/passport.js
      // so an oversized body can't force expensive Argon2id work.
      if (typeof supplied !== 'string' || supplied.length === 0 || supplied.length > 128) {
        return { status: 401, error: 'incorrect campaign password' };
      }
      const ok = campaign.password_hash && (await verifyPassword(campaign.password_hash, supplied));
      if (!ok) return { status: 401, error: 'incorrect campaign password' };
    }

    // The mutable color state also tracks whether a conflict already dropped it.
    const colour = validateColor(input && input.color);
    if (colour.error) return { status: 400, error: colour.error };
    const c = { value: colour.value, dropped: false };

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

          // Retry from the current membership, not the pre-password snapshot.
          // A concurrent join may already have succeeded, or a ban may have landed.
          const member = await trx('campaign_members')
            .where({ campaign_id: id, user_id: userId }).first();
          if (member && member.status === 'banned') {
            const e = new Error('banned'); e.memberBanned = true; throw e;
          }
          if (member && member.status === 'active') return;

          const cur = await trx('campaign_members')
            .where({ campaign_id: id, status: 'active' })
            .count({ n: '*' }).first();
          if (Number(cur.n) >= MAX_PLAYERS_PER_CAMPAIGN) {
            const e = new Error('full'); e.campaignFull = true; throw e;
          }

          // Rows are never deleted — a returning member is an UPDATE of the
          // existing row, so their history (and original joined_at) survives.
          if (member) {
            await trx('campaign_members')
              .where({ campaign_id: id, user_id: userId })
              .update({ status: 'active', ...(c.dropped ? { color: null } : c.value ? { color: c.value } : {}) });
          } else {
            await trx('campaign_members').insert({
              campaign_id: id,
              user_id: userId,
              status: 'active',
              color: c.value,
            });
          }
        });
        break;
      } catch (err) {
        if (err.campaignFull) return { status: 409, error: 'this campaign is full' };
        if (err.memberBanned) return { status: 403, error: 'you are banned from this campaign' };
        // Only these two known uniqueness conflicts are recoverable. A duplicate
        // membership retries the lookup; a color collision drops the color,
        // including a returning member's retained color, before retrying.
        const duplicateMember = err.code === '23505' && err.constraint === 'campaign_members_pkey';
        const duplicateColor = err.code === '23505'
          && err.constraint === 'campaign_members_campaign_color_unique' && !c.dropped;
        if (duplicateColor) { c.value = null; c.dropped = true; }
        if (err.code === '40001' || duplicateMember || duplicateColor) {
          if (attempt < 5) {
            const baseDelay = 10 * (2 ** attempt);
            const delay = baseDelay + Math.floor(random() * baseDelay);
            attempt += 1;
            await sleep(delay);
            continue;
          }
          return {
            status: 409,
            error: 'Campaign joining is busy. Please try again.',
            code: 'campaign_join_busy',
            retryable: true,
          };
        }
        throw err;
      }
    }

    return { row: campaign };
  }

  async function leave({ campaignId, userId }) {
    const result = await knex.transaction(async (trx) => {
      // Same lock order as transfer: campaign first, then membership.
      const campaign = await trx('campaigns').where({ id: campaignId }).forUpdate().first();
      if (!campaign || campaign.deleted_at) return { status: 404, error: 'campaign not found' };
      if (campaign.owner_id === userId) {
        return { status: 409, error: 'the owner cannot leave — transfer ownership or delete the campaign' };
      }
      const member = await trx('campaign_members')
        .where({ campaign_id: campaign.id, user_id: userId }).forUpdate().first();
      if (!member || member.status !== 'active') return { status: 404, error: 'campaign not found' };
      await trx('campaign_members').where({ campaign_id: campaign.id, user_id: userId })
        .update({ status: 'left' });
      return {};
    });
    return result;
  }

  async function patch({ campaignId, userId, body: input }) {
    const result = await knex.transaction(async (trx) => {
      const campaign = await trx('campaigns').where({ id: campaignId }).forUpdate().first();
      if (!campaign || campaign.deleted_at || campaign.owner_id !== userId) {
        return { status: 404, error: 'campaign not found' };
      }
      const body = input || {};
      const updates = {};

      if (body.name !== undefined) {
        const n = validateCampaignName(body.name);
        if (n.error) return { status: 400, error: n.error };
        updates.name = n.value;
      }

      if (body.is_open !== undefined) {
        // Open or close the table using the current owner checked under lock.
        //
        // The existing validator accepts booleans and explicit "true"/"false"
        // strings, never general truthiness (which would turn "false" into true).
        const b = validateBool(body.is_open, 'is_open');
        if (b.error) return { status: 400, error: b.error };
        updates.is_open = b.value;
      }

      if (body.description !== undefined) {
        const d = validateCampaignDescription(body.description);
        if (d.error) return { status: 400, error: d.error };
        updates.description = d.value;
      }

      if (body.img_url !== undefined) {
        const img = validateImageUrl(body.img_url, 'img_url');
        if (img.error) return { status: 400, error: img.error };
        updates.img_url = img.value;
      }

      // Visibility and password interact, so they are resolved together.
      const nextIsPublic = body.is_public === undefined
        ? campaign.is_public
        : (body.is_public === true || body.is_public === 'true');

      if (body.is_public !== undefined) updates.is_public = nextIsPublic;

      if (nextIsPublic) {
        // Going public drops the password: a public campaign has no secret to keep.
        if (body.password) {
          return { status: 400, error: 'a public campaign cannot have a password' };
        }
        if (!campaign.is_public) updates.password_hash = null;
      } else {
        if (body.password !== undefined) {
          const p = validateCampaignPassword(body.password);
          if (p.error) return { status: 400, error: p.error };
          updates.password_hash = await hashPassword(p.value);
        } else if (campaign.is_public && body.is_public !== undefined) {
          // Going private requires a password in the same request; otherwise the
          // campaign would sit private with a NULL hash and be unjoinable.
          return { status: 400, error: 'a password is required to make a campaign private' };
        }
      }

      if (Object.keys(updates).length === 0) {
        return { status: 400, error: 'nothing to update' };
      }

      updates.updated_at = trx.fn.now();

      const [row] = await trx('campaigns')
        .where({ id: campaign.id })
        .update(updates)
        .returning([...SAFE_COLUMNS, 'password_hash']);

      return { row, updates };
    });
    return result;
  }

  async function remove({ campaignId, userId }) {
    const changed = await knex('campaigns')
      .where({ id: campaignId, owner_id: userId }).whereNull('deleted_at')
      .update({ deleted_at: knex.fn.now(), updated_at: knex.fn.now() });

    if (!changed) return { status: 404, error: 'campaign not found' };

    return {};
  }

  // Restore and transfer retain their own six-attempt ownership policy.
  // No external effects inside the callback: it can run more than once.
  async function withOwnershipCapTransaction(work) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await knex.transaction(async (trx) => {
          await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
          return work(trx);
        });
      } catch (err) {
        if (err.code !== '40001') throw err;
        if (attempt === 5) {
          return { status: 409, error: 'Campaign ownership is busy. Please try again.',
            code: 'campaign_ownership_busy', retryable: true };
        }
        const baseDelay = 10 * (2 ** attempt);
        await sleep(baseDelay + Math.floor(random() * baseDelay));
      }
    }
  }

  async function restore({ campaignId, userId }) {
    const id = campaignId;
    if (!validCampaignId(id)) return { status: 404, error: 'campaign not found' };

    const result = await withOwnershipCapTransaction(async (trx) => {
      const campaign = await trx('campaigns').where({ id }).forUpdate().first();
      if (!campaign || !campaign.deleted_at || campaign.owner_id !== userId) {
        return { status: 404, error: 'no deleted campaign with that id' };
      }
      const expiry = new Date(campaign.deleted_at).getTime() + SOFT_DELETE_DAYS * 86400000;
      if (now() > expiry) {
        return { status: 410, error: 'the 30-day recovery window has passed' };
      }

      const owned = await trx('campaigns')
        .where({ owner_id: userId }).whereNull('deleted_at')
        .count({ n: '*' }).first();
      if (Number(owned.n) >= MAX_CAMPAIGNS_PER_USER) {
        return { status: 409,
          error: `you already own ${MAX_CAMPAIGNS_PER_USER} campaigns — delete one before restoring` };
      }
      const [row] = await trx('campaigns').where({ id })
        .update({ deleted_at: null, updated_at: trx.fn.now() })
        .returning([...SAFE_COLUMNS, 'password_hash']);
      return { row };
    });
    return result;
  }

  async function transfer({ campaignId, userId, body: input }) {
    const targetId = input && input.user_id;
    if (!validCampaignId(targetId)) return { status: 400, error: 'user_id is required' };
    if (targetId === userId) {
      return { status: 409, error: 'you already own this campaign' };
    }

    const result = await withOwnershipCapTransaction(async (trx) => {
      // Middleware checked an earlier snapshot. Recheck ownership on every
      // attempt and hold the campaign row until the transfer commits.
      const campaign = await trx('campaigns').where({ id: campaignId }).forUpdate().first();
      if (!campaign || campaign.deleted_at || campaign.owner_id !== userId) {
        return { status: 404, error: 'campaign not found' };
      }
      const member = await trx('campaign_members')
        .where({ campaign_id: campaign.id, user_id: targetId }).forUpdate().first();
      if (!member || member.status !== 'active') {
        return { status: 409, error: 'ownership can only be transferred to an active member' };
      }
      const owned = await trx('campaigns')
        .where({ owner_id: targetId }).whereNull('deleted_at')
        .count({ n: '*' }).first();
      if (Number(owned.n) >= MAX_CAMPAIGNS_PER_USER) {
        return { status: 409, error: `the recipient already owns ${MAX_CAMPAIGNS_PER_USER} campaigns` };
      }
      const [row] = await trx('campaigns').where({ id: campaign.id })
        .update({ owner_id: targetId, updated_at: trx.fn.now() })
        .returning([...SAFE_COLUMNS, 'password_hash']);
      return { row };
    });
    return result;
  }

  async function moderate({ campaignId, userId, targetId, nextStatus }) {
    if (!validCampaignId(targetId)) return { status: 404, error: 'member not found' };
    if (targetId === userId) {
      return { status: 409, error: `you cannot ${nextStatus === 'banned' ? 'ban' : 'kick'} yourself` };
    }

    const result = await knex.transaction(async (trx) => {
      // Middleware authorized a snapshot. Serialize with ownership transfer and
      // check the current owner before changing any membership.
      const campaign = await trx('campaigns').where({ id: campaignId }).forUpdate().first();
      if (!campaign || campaign.deleted_at) return { status: 404, error: 'campaign not found' };
      if (campaign.owner_id !== userId) {
        const caller = await trx('campaign_members')
          .where({ campaign_id: campaign.id, user_id: userId }).first();
        return caller && caller.status === 'active'
          ? { status: 403, error: 'only the campaign owner can do that' }
          : { status: 404, error: 'campaign not found' };
      }
      const member = await trx('campaign_members')
        .where({ campaign_id: campaign.id, user_id: targetId }).forUpdate().first();
      if (!member) return { status: 404, error: 'member not found' };
      await trx('campaign_members').where({ campaign_id: campaign.id, user_id: targetId })
        .update({ status: nextStatus });
      return {};
    });
    return result;
  }

  async function unban({ campaignId, userId, targetId }) {
    if (!validCampaignId(targetId)) return { status: 404, error: 'member not found' };

    const result = await knex.transaction(async (trx) => {
      const campaign = await trx('campaigns').where({ id: campaignId }).forUpdate().first();
      if (!campaign || campaign.deleted_at || campaign.owner_id !== userId) {
        return { status: 404, error: 'campaign not found' };
      }
      const member = await trx('campaign_members')
        .where({ campaign_id: campaignId, user_id: targetId })
        .first();
      if (!member) return { status: 404, error: 'member not found' };
      if (member.status !== 'banned') {
        return { status: 409, error: 'that member is not banned' };
      }

      await trx('campaign_members')
        .where({ campaign_id: campaignId, user_id: targetId })
        .update({ status: 'left' });

      return {};
    });
    return result;
  }

  return { create, join, leave, patch, remove, restore, transfer, moderate, unban };
}

module.exports = { createCampaignOperations };
