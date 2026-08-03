// Atomic caps: the single implementation of every "no more than N of X" rule in
// this project.
//
// It lives in services/ rather than in routes/scenes.js, where it was written
// during the M2 canvas audit, because M4 gave it a third and fourth consumer
// (actors, items, inventory attunement). Leaving it in the scene router would
// have meant routes/actors.js requiring routes/scenes.js while routes/scenes.js
// requires routes/actors.js for the actor projection — a genuine require cycle,
// which in CommonJS resolves to one of the two modules receiving a
// half-populated exports object at load time. Moving the primitive to a leaf
// module breaks the cycle without any lazy-require trickery, and it is where a
// shared primitive with no route knowledge belongs anyway.
//
// The behaviour is unchanged from the version audited on 2026-07-23 and
// 2026-07-29; the M4 additions (`update`, `extraCaps`) are documented below and
// are opt-in, so every pre-M4 call site behaves exactly as before.
//
// Background: the 2026-07-18 campaign audit found both caps implemented as
// read-count-then-write across an `await`. 40 parallel creates made 30 campaigns
// against a cap of 20. The fix — and the standing constraint since — is that the
// count and the write happen inside ONE serialisable transaction, with bounded
// retry on serialization_failure (40001). An app-level mutex was rejected (it
// does not survive multiple processes) and SELECT ... FOR UPDATE was rejected
// (there is no single row to lock: a cap counts a SET).

const knex = require('../db');

// Run a count-then-write as one serialisable transaction with bounded retry, so
// N concurrent requests cannot all read "count < MAX" before any of them commits.
// `capError` is thrown (and surfaced as 409) when the cap is already reached.
// M4 extended this in two backwards-compatible ways. Every pre-M4 call site
// passes { table, where, max, capMessage, insert } and behaves exactly as before.
//
//   `update: { where, patch }` — cap an UPDATE instead of an INSERT.
//     Every cap before M4 was a CREATION cap (one more scene, one more token,
//     one more fog region), so ending the transaction in an insert was enough.
//     Attunement is not: the inventory row already exists and the operation
//     flips `attuned` false -> true on it. The race is identical to the one the
//     2026-07-18 audit found in the campaign caps — two parallel PATCHes both
//     count 2 attuned items against a cap of 3, both see room, both write, and
//     the actor ends with 4 — so it needs the same serialisable count+write.
//
//     A subtlety that is a silent bug if missed: an UPDATE only enters the
//     capped set if the row is not ALREADY in it. Re-sending attuned:true for an
//     already-attuned item must not be counted as a new member, or a no-op would
//     be refused at exactly the cap. `adding` is therefore 0 in that case, and
//     an operation adding 0 rows cannot breach any cap, so the counts are
//     skipped entirely. (Attuning DOWN is never capped and does not come
//     through here at all — the caller does a plain update for that.)
//
//   `conflict: { columns, match, merge }` — cap an UPSERT. Added 2026-08-02 to
//     close the last non-atomic cap in the project: the inventory row cap was
//     a count() followed by an insert outside any transaction, justified at the
//     time by "the overshoot is bounded by another cap anyway". That reasoning
//     is the same species as the one that produced V1 — locally true, and not
//     the rule the project actually committed to. Every "no more than N of X"
//     rule is atomic, with no carve-outs.
//
//   `extraCaps: [{ where, max, capMessage }]` — additional caps checked inside
//     the SAME transaction. Actor creation by a player must satisfy two rules at
//     once (at most N per player AND at most M in the campaign); checking the
//     second one outside the transaction would reintroduce the very race the
//     first one closes.
async function withAtomicCap({ table, where, max, capMessage, insert, update, extraCaps, conflict }) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await knex.transaction(async (trx) => {
        await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

        // How many rows this operation adds to the capped set.
        let adding;
        if (update) {
          const target = await trx(table).where(update.where).first();
          if (!target) {
            const e = new Error('row not found'); e.rowMissing = true; throw e;
          }
          // Already a member of the capped set? Then this write adds nothing.
          const already = await trx(table).where(update.where).andWhere(where).first();
          adding = already ? 0 : 1;
        } else if (conflict) {
          // An UPSERT adds a row only when there is no conflicting row to merge
          // into. Counting it as +1 unconditionally would refuse a legitimate
          // "add three more arrows to a full bag", which changes no row count.
          const existing = await trx(table).where(conflict.match).first();
          adding = existing ? 0 : 1;
        } else {
          adding = Array.isArray(insert) ? insert.length : 1;
        }

        if (adding > 0) {
          for (const c of [{ where, max, capMessage }, ...(extraCaps || [])]) {
            const cur = await trx(table).where(c.where).count({ n: '*' }).first();
            const have = Number(cur.n);
            if (have + adding > c.max) {
              const e = new Error(c.capMessage); e.capExceeded = true; e.have = have; throw e;
            }
          }
        }

        if (update) {
          return await trx(table).where(update.where).update(update.patch).returning('*');
        }
        if (conflict) {
          return await trx(table)
            .insert(insert)
            .onConflict(conflict.columns)
            .merge(conflict.merge)
            .returning('*');
        }
        return await trx(table).insert(insert).returning('*');
      });
    } catch (err) {
      if (err.capExceeded || err.rowMissing) throw err;
      if (err.code === '40001' && attempt < 5) { attempt += 1; continue; }
      throw err;
    }
  }
}

module.exports = { withAtomicCap };
