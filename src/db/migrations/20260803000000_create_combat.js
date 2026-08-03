// M5: combat + combatants.
//
// This is the milestone where actors stop being sheets and start taking part in
// a fight. A combat is a per-scene overlay on the tokens already standing on
// that scene; a combatant is one token's place in that overlay, carrying the
// per-instance hit points a shared actor row cannot express.
//
// The problem this table exists to solve, stated plainly because it drove every
// column below: tokens.actor_id is MANY-TO-ONE. Five goblin tokens link to one
// Goblin actor and therefore share one actors.hp_current. That is correct for a
// player character (one individual, one sheet, authoritative across sessions)
// and wrong for a monster, where the actor is a TEMPLATE and each token is an
// INSTANCE that takes its own damage. combatants.hp_override is the per-instance
// current HP; actors.hp_max stays shared, because every goblin of that type
// really does have the same maximum. That split is why no hp_override_max column
// is needed.
//
// Columns follow SCHEMA_REFERENCE.md with SIX deliberate, documented deviations,
// recorded here and reconciled into SCHEMA_REFERENCE at session end. The house
// rule established by tokens.created_by (M2), fog_of_war.updated_at (M3) and the
// five M4 deviations is that a deviation is DECLARED in the migration header,
// never added quietly.
//
//   1. combat.updated_at — SCHEMA_REFERENCE gives combat only created_at, but
//      `name` and `active` are both mutable, so the row is mutable. An updatable
//      row with no updated_at contradicts this schema's own "timestamps on every
//      table" principle. Third instance of this exact case after
//      fog_of_war.updated_at and items.updated_at; the precedent is settled.
//
//   2. combatants.created_at / updated_at — SCHEMA_REFERENCE gives the table no
//      timestamps at all, but sort_order, hp_override and hp_visible are all
//      mutable. Same reasoning as (1), and the same case as the M4
//      inventory.created_at / updated_at deviation.
//
//   3. UNIQUE (combat_id, token_id) — NOT in SCHEMA_REFERENCE. One token twice
//      in the same fight has no defined meaning: which row's hp_override is the
//      creature's hit points? Without the constraint, "add this token to the
//      fight" is inherently read-then-write (look for an existing row, then
//      insert), which is a TOCTOU by construction and which the standing atomic
//      cap constraint forbids. With it the add is a single INSERT ... ON
//      CONFLICT DO NOTHING and the race cannot happen. This is exactly the
//      argument that earned inventory its UNIQUE (actor_id, item_id) in M4.
//
//   4. combatants.hp_visible (BOOLEAN NOT NULL DEFAULT false) — NOT in
//      SCHEMA_REFERENCE. The GM decides, per combatant, whether players may see
//      that creature's hp_override. It is a REAL COLUMN rather than a key in a
//      client-writable JSONB blob for the same reason items.identified and
//      actors.is_npc are: it gates DISCLOSURE, and the standing rule from the
//      campaign audit is that authority is never re-derived from client-writable
//      JSONB (campaigns.settings).
//
//      It DEFAULTS FALSE, i.e. secret — satisfying both this schema's
//      booleans-default-false convention and secure-by-default: a GM who forgets
//      the flag gets the non-disclosing outcome, exactly as items.identified
//      does. It governs hp_override ONLY and never the linked actor's own HP,
//      which remains shapeActorFor's sole business. A per-combatant switch can
//      only coherently govern a per-combatant value: five goblin tokens share
//      one actors.hp_current, so a toggle on one of them could not disclose that
//      number without disclosing it for all five.
//
//   5. tokens.is_prop (BOOLEAN NOT NULL DEFAULT false) — NOT in
//      SCHEMA_REFERENCE, and a column added to an M2 table. Required by
//      auto-add: placing a token on a scene with a running combat enrols it as a
//      combatant, which would otherwise sweep in trees, doors and barricades.
//
//      It is a real column and NOT derived from `actor_id IS NULL`, deliberately.
//      "Unlinked means scenery" is true for the common case and false for the
//      ordinary one where a GM drops an unlinked square called "Ogre" because
//      they never made it a sheet — which is precisely the shape of the M4 V1
//      defect (reasoning drawn from the common case, shipping the exception). It
//      is also not a key in tokens.conditions, which SCHEMA_REFERENCE documents
//      as a visual icon array only.
//
//      DEFAULT false means a token is a CREATURE unless the GM says otherwise,
//      which is the right way round: most things on a battle map fight. Existing
//      rows backfill to false accordingly.
//
//   6. combat.round and combat.turn_index are NOT CREATED, and
//      combatants.initiative is NOT CREATED. All three are in SCHEMA_REFERENCE.
//      Turn sequencing was cut from M5 scope by explicit decision: the order is
//      a visual aid the GM arranges by hand, not a pointer the server advances.
//      sort_order survives and does the whole job — SCHEMA_REFERENCE already
//      described it as "explicit position in initiative order", so with the
//      number gone it stops being redundant with a value nothing sorted by.
//      Recorded as a scope amendment, not an omission.
//
// FOREIGN KEYS
//
//   combat.campaign_id  CASCADE — denormalized per SCHEMA_REFERENCE (socket room
//     management needs it directly rather than through a join). App logic loads
//     the scene THROUGH the campaign on create, so the two can never disagree.
//   combat.scene_id     CASCADE — a fight on a deleted map is meaningless. Note
//     this widens DELETE /:sceneId's blast radius, so that route now counts and
//     reports combats alongside tokens and fog; its whole design is that the
//     confirmation names what is destroyed, and a silent third casualty would
//     make that promise false.
//   combatants.combat_id CASCADE — a combatant without its combat is orphaned.
//   combatants.token_id  CASCADE — token_id is NOT NULL, so SET NULL is not
//     available, and a combatant whose token is gone has nothing to point at.
//     Contrast tokens.actor_id, which is SET NULL because the TOKEN remains
//     meaningful without its actor (a corpse, a spare mini). Here the row does
//     not survive its parent, exactly as an inventory row does not survive its
//     actor.
//
// A cascade cannot notify anyone, so the token delete routes broadcast the
// combat delta explicitly — the same lesson DELETE /:sceneId learned when it had
// to emit scene:activated {null} because a foreign key had silently cleared the
// pointer.

exports.up = async function up(knex) {
  await knex.schema.createTable('combat', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('campaign_id').notNullable()
      .references('id').inTable('campaigns').onDelete('CASCADE');
    t.uuid('scene_id').notNullable()
      .references('id').inTable('scenes').onDelete('CASCADE');
    t.string('name', 100);
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    // "At most one ACTIVE combat per scene" is enforced atomically in app logic
    // through withAtomicCap (max: 1), per the standing constraint. It is not a
    // partial unique index here because the cap primitive is where every other
    // "no more than N of X" rule in this project lives, and a second enforcement
    // mechanism for one rule is a second place for it to drift.
    t.index('scene_id');
    t.index('campaign_id');
  });

  await knex.schema.createTable('combatants', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('combat_id').notNullable()
      .references('id').inTable('combat').onDelete('CASCADE');
    t.uuid('token_id').notNullable()
      .references('id').inTable('tokens').onDelete('CASCADE');
    t.integer('sort_order').notNullable().defaultTo(0);
    // Nullable by design: NULL means "this combatant has no per-fight HP of its
    // own", which is the correct state for a player character (their sheet is
    // authoritative) and for an unlinked token.
    t.integer('hp_override');
    t.boolean('hp_visible').notNullable().defaultTo(false);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    t.unique(['combat_id', 'token_id']);
    // SCHEMA_REFERENCE's index list names this one: initiative order loading.
    t.index('combat_id');
  });

  // Deviation 5. Added here rather than in its own migration because the column
  // is meaningless without combat, and rolling combat back should take it away.
  await knex.schema.alterTable('tokens', (t) => {
    t.boolean('is_prop').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('tokens', (t) => {
    t.dropColumn('is_prop');
  });
  // combatants first: it references combat.
  await knex.schema.dropTableIfExists('combatants');
  await knex.schema.dropTableIfExists('combat');
};
