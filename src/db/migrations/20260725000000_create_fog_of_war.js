// M3 fog of war: fog_of_war.
//
// Columns follow SCHEMA_REFERENCE.md, with ONE deliberate, documented deviation
// (note 1 below) — the same treatment tokens.created_by received in the M2
// canvas migration.
//
//   1. updated_at (TIMESTAMPTZ, DEFAULT NOW()) is NOT in SCHEMA_REFERENCE, which
//      lists only created_at for this table. It is added because `revealed` is a
//      TOGGLED column and regions are movable/reshapable: an updatable row with
//      no updated_at contradicts the schema's own "timestamps on every table —
//      non-negotiable for debugging real-time systems" principle. Every other
//      mutable table here (users, campaigns, scenes, tokens) already carries it.
//
// Decisions recorded here so the migration explains itself:
//
//   - type is a plain VARCHAR(20) with NO CHECK constraint, validated instead by
//     a fixed allow-list in services/validators.js ({'rect','circle','poly'}).
//     The house convention is app-logic allow-lists, not DB constraints;
//     campaign_members.status is the ONE stated exception, and it earned that
//     exception because status drives AUTHORISATION. fog type drives rendering
//     only, so it stays in app logic. Adding a CHECK here would also make every
//     future shape type a migration.
//
//   - points is JSONB and is the ONLY geometry storage. Per database-decisions,
//     name / x / y / width / height / z_index / rotation / locked / hidden were
//     all dropped as redundant with points. Every type stores a homogeneous
//     array of {x, y} pairs in GRID UNITS (1 = one square), the same coordinate
//     space tokens use, validated by the same validateGridCoord:
//         rect   — exactly 2 points, opposite corners (normalised to min/max)
//         circle — exactly 2 points, [centre, a point on the rim]; radius is
//                  derived, never stored, so no radius column is needed
//         poly   — 3..MAX_FOG_POINTS vertices
//     Vertex count is bounded in validation, not here: the real payload risk is
//     one region with 50,000 vertices, which no row cap would catch.
//
//   - NO created_by column. tokens.created_by exists because it is LOAD-BEARING
//     for a per-user rule (a player may place one token and move only their
//     own). Fog is GM-only in every operation, so there is no per-user rule for
//     an attribution column to enforce, and adding one would be speculative.
//
//   - scene_id is ON DELETE CASCADE, matching tokens: fog is meaningless without
//     its scene, and a deleted scene must not leave orphan geometry behind.
//
//   - The index on scene_id is created in this migration (per the index list in
//     SCHEMA_REFERENCE): every scene load fetches all fog for that scene.
//
// Render rule the geometry is designed for (order-independent, which is what
// makes it legal in a schema that deliberately has no z_index):
//     fog = union(regions WHERE revealed = false) - union(regions WHERE revealed = true)
// so "paint fog onto a clear map" and "cover the map, then punch windows" are
// the same mechanism, and toggling revealed is symmetric in both directions.

exports.up = async function (knex) {
  await knex.schema.createTable('fog_of_war', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('scene_id').notNullable()
      .references('id').inTable('scenes').onDelete('CASCADE');
    // 'rect' | 'circle' | 'poly' — allow-listed in services/validators.js.
    t.string('type', 20).notNullable();
    // Array of {x, y} in grid units. Shape/length rules are per-type (header).
    t.jsonb('points').notNullable();
    // false = this region is fog. true = this region is revealed (a hole).
    // Default false so a freshly drawn region covers, which is what a GM
    // dragging a shape onto the map means by the gesture.
    t.boolean('revealed').notNullable().defaultTo(false);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    // See header note 1 — deviation from SCHEMA_REFERENCE, deliberate.
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    t.index('scene_id'); // every scene load fetches all fog for that scene
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('fog_of_war');
};
