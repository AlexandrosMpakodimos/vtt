// M5: messages — chat, dice rolls, system notices and whispers.
//
// Separate from the combat migration deliberately. Combat and chat are two
// independent features that happen to share a milestone, and a rollback of one
// should not drop the other. (M4 put actors, items and inventory in ONE
// migration because those three tables are one feature cluster — an inventory
// row is meaningless without both of its parents. A chat log is perfectly
// meaningful with no combat table in the database.)
//
// Columns follow SCHEMA_REFERENCE.md with ONE deviation and two notes.
//
//   1. DEVIATION — no updated_at. Every other mutable table in this schema got
//      one, and the reasoning behind those additions is the reason this table
//      does NOT get one: a message is IMMUTABLE. There is no edit endpoint and
//      no delete endpoint in M5. A chat log whose rows can be rewritten after
//      the fact is a different feature with different questions attached (who
//      may edit, is the original kept, does an edit re-broadcast to the people
//      who already read it) and none of them are in scope. created_at alone is
//      correct here, and SCHEMA_REFERENCE already lists exactly that.
//
//   2. whisper_to is a NATIVE POSTGRES ARRAY (uuid[]), the first in this schema
//      — everything variable-shape so far has been JSONB. It is not the JSONB
//      case: the contents are fixed-shape (a list of user ids, nothing else),
//      homogeneous, and queryable with the containment operator. JSONB would buy
//      nothing and would lose element-level typing.
//
//      NULL / empty means "everyone in the campaign". A non-empty array is the
//      exact set of user ids who may receive the row, and it is the ONLY
//      confidentiality mechanism on this table.
//
//      Every element is validated on the way in as a uuid AND as an active
//      member of the campaign — the same check validateActorField already
//      performs for actors.user_id. An unvalidated element is not a cosmetic
//      problem: whisper_to is a DISCLOSURE LIST, so a stranger's id in it is a
//      row deliberately emitted to a stranger.
//
//   3. `type` is an app-level allow-list ('chat' | 'roll' | 'system' |
//      'whisper') with NO DB CHECK constraint, consistent with fog_of_war.type
//      and items.type. The one CHECK exception in this project
//      (campaign_members.status) earned it by driving authorisation. This does
//      not: the confidentiality gate is whisper_to being non-empty, never the
//      string. A row typed 'chat' with a populated whisper_to is still private,
//      and a row typed 'whisper' with an empty one is still public — the array
//      is the authority, and only the array.
//
//   4. roll_data holds the server's own dice output ({formula, results, total}),
//      written ONLY by the server from src/services/dice.js and never taken from
//      a request body. A client-supplied results array is a cheat vector: the
//      one thing a player must not control is the outcome of their own roll.
//
// FOREIGN KEYS
//   campaign_id CASCADE  — a chat log without its campaign is orphaned, and
//     campaigns already carry a 30-day soft delete plus an hourly hard-delete
//     sweep, so the cascade only fires when the campaign is genuinely gone.
//   user_id     SET NULL — a deleted account must not vaporise the table's
//     history mid-campaign. speaker_name is denormalized precisely so the log
//     still renders after the FK has fired, matching tokens.created_by and
//     actors.user_id.

exports.up = async function up(knex) {
  await knex.schema.createTable('messages', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('campaign_id').notNullable()
      .references('id').inTable('campaigns').onDelete('CASCADE');
    t.uuid('user_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    // Denormalized display name (character name or username) so rendering the
    // log needs no join, and so it survives the SET NULL above.
    t.string('speaker_name', 100);
    t.text('content');
    t.string('type', 20).notNullable().defaultTo('chat');
    t.jsonb('roll_data');
    t.specificType('whisper_to', 'uuid[]');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

    // SCHEMA_REFERENCE's index list names this one: chat pagination.
    t.index(['campaign_id', 'created_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('messages');
};
