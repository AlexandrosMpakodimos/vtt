// Stage C: server-tracked turn sequencing — combat.round and combat.turn_index.
//
// This migration REVERSES deviation #6 of 20260803000000_create_combat.js, which
// cut turn sequencing from M5 scope with this reasoning:
//
//   "combat.round and combat.turn_index are NOT CREATED [...]. Turn sequencing
//    was cut from M5 scope by explicit decision: the order is a visual aid the GM
//    arranges by hand, not a pointer the server advances."
//
// That decision is now overturned by an explicit product decision: the GM wants
// to run turn order — a round counter with Next/Back navigation, an active-turn
// highlight, and (the reason this is a SERVER concern rather than client-only)
// every player must see whose turn it is and which round the fight is on. A
// GM-local counter cannot do that; the pointer has to live on the row the
// combat:updated broadcast already carries to both transports. So the two
// columns SCHEMA_REFERENCE always described are created here, and the scope
// amendment is recorded — declared in the header, never added quietly, per the
// house rule established across M2–M5.
//
//   combat.round      — the current round, 1-based. DEFAULT 1: a fight that has
//                       just started is on round one, and the not-yet-advanced
//                       state is the natural one. NOT NULL for the same reason
//                       `active` is: there is no meaningful "unknown round".
//
//   combat.turn_index — the 0-based position, WITHIN the current round, of the
//                       combatant whose turn it is, indexing the roster ordered
//                       by sort_order. DEFAULT 0: the top of the initiative order
//                       goes first. NOT NULL, same reasoning.
//
//                       It is an INDEX, not a combatant id, deliberately: the
//                       roster is already ordered by sort_order (the column that
//                       survived deviation #6 and does the ordering), and an
//                       index into that order is stable under the operations the
//                       GM performs mid-fight in a way an id is not — reordering
//                       cards changes who is at position N, which is exactly the
//                       "whose turn is it" semantics wanted, whereas an id would
//                       pin the highlight to a specific creature regardless of
//                       where it was dragged. Removing a combatant shrinks the
//                       roster; the client clamps turn_index into range and the
//                       server validates it against the live count, so a stale
//                       index can never point past the end.
//
//   combatants.initiative is STILL NOT CREATED. sort_order remains the single
//   source of order — adding a separate initiative number would reintroduce the
//   exact redundancy deviation #6 removed (two columns, one of them sorted by).
//
// No new table, no new foreign key, no new index: these are two scalar columns on
// a row that is already loaded, broadcast and access-controlled. The one-active-
// combat-per-scene cap, the disclosure rules and the broadcast paths are all
// unchanged — round and turn_index are GM-writable and world-readable, carrying
// no secret, so they ride the existing combat:updated projection to everyone.

exports.up = async function up(knex) {
  await knex.schema.alterTable('combat', (t) => {
    t.integer('round').notNullable().defaultTo(1);
    t.integer('turn_index').notNullable().defaultTo(0);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('combat', (t) => {
    t.dropColumn('turn_index');
    t.dropColumn('round');
  });
};
