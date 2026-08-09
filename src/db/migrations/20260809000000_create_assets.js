// Assets — uploaded images, and a record of externally-linked ones.
//
// Until now an image was a bare URL in a text column: users.avatar_url,
// campaigns.img_url, scenes.img_url, tokens.img_url, actors.img_url,
// items.img_url. Six places, and nothing anywhere knew what existed. That is
// fine while every image is somebody else's problem and stops being fine the
// moment we host them.
//
// This table exists for three things a bare column cannot do.
//
//   1. A QUOTA. The standing constraint is that every "no more than N of X" is
//      enforced atomically at the database — and an upload allowance is exactly
//      that. Without rows there is nothing to count, so the rule could not be
//      applied at all. R2's free tier is 10 GB, which is roughly 1,500 battle
//      maps; the cap here trips long before Cloudflare's does.
//
//   2. DELETION. Change a portrait and the old object stays in the bucket
//      forever. Delete a campaign and every image it used is orphaned. Nothing
//      can clean up what it cannot enumerate.
//
//   3. PROVENANCE. An uploaded image and a pasted link are rendered the same
//      way and are not the same thing: one is ours, the other is a request every
//      player's browser makes to a third party. The distinction has to be
//      recorded or it cannot be reasoned about.
//
// ---------------------------------------------------------------------------
// WHY campaign_id IS NULLABLE
// ---------------------------------------------------------------------------
// Profile pictures are not campaign-scoped: users.avatar_url belongs to a
// person, not a table. So an asset is scoped to a campaign OR to a user, and
// the quota has two scopes accordingly — per campaign for maps, portraits and
// item art, per user for avatars. A single global cap would let one campaign
// exhaust an unrelated one's allowance.
//
// user_id is NOT NULL: every asset has an uploader, and that is who the
// per-user quota counts against. It is SET NULL on account deletion for the
// same reason messages.user_id is — the object still exists in the bucket and
// the row still has to describe it.
//
// ---------------------------------------------------------------------------
// WHY status EXISTS
// ---------------------------------------------------------------------------
// The upload is a THREE-STEP conversation and each step can be the last one:
//
//   pending   the server issued a presigned URL. The client may never use it.
//   ready     the bytes arrived AND the server verified them.
//   rejected  the bytes arrived and were not what they claimed to be.
//
// Without the pending state there is no record of an issued-but-unused
// authorisation, and the quota could be exhausted by asking for URLs and never
// uploading. With it, a sweep can reclaim them — the same hourly, fail-soft
// shape as the token and soft-deleted-campaign sweeps already in server.js.
//
// A row is only usable at `ready`. That is the whole point of the verification
// step: R2 stores and serves raw bytes, unlike an image CDN that transcodes, so
// the file's declared type is a claim by the client and nothing more.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NO FOREIGN KEY FROM actors.img_url ET AL.
// ---------------------------------------------------------------------------
// The six columns stay as URLs and do not become asset references.
//
// It is tempting to make them foreign keys — it would give referential
// integrity and make orphan detection trivial. It was rejected because those
// columns must ALSO hold external links, which have no row here to point at,
// and a nullable-FK-or-text pair is two representations of one field. It would
// also make deleting an asset able to fail or cascade into six tables, turning
// a storage-cleanup operation into a game-state operation.
//
// Instead the link is by VALUE: an asset knows its own public URL, and orphan
// detection is a query rather than a constraint. The cost is honest — a
// dangling reference is possible and the sweep has to look for it — and it is
// the same trade the schema already makes for denormalised speaker names.

exports.up = async function up(knex) {
  await knex.schema.createTable('assets', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Campaign-scoped (maps, portraits, item art) or NULL for a personal
    // avatar. See the header: the quota has two scopes because of this.
    t.uuid('campaign_id').nullable()
      .references('id').inTable('campaigns').onDelete('CASCADE');
    t.uuid('user_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL');

    // Where the bytes live in R2. NULL for an external link, which has no
    // object of ours. Unique so the same key cannot be claimed twice.
    t.text('storage_key').unique();

    // The URL anything renders from. For an upload this is the public bucket
    // URL; for an external link it is what the user pasted.
    t.text('url').notNullable();

    // The ORIGINAL address, kept when an external image was imported into R2.
    // Attribution, debugging and re-import — never rendering. Once an asset is
    // ours, the third party is out of the loop permanently.
    t.text('source_url');

    // 'upload'   the user chose a file
    // 'imported' the user pasted a URL and their BROWSER copied it into R2, so
    //            our server never contacted the third party
    // 'external' the user pasted a URL we could not import; players will
    //            connect to that host directly
    t.string('source', 20).notNullable().defaultTo('upload');

    // What the asset is for. Drives the size limit and who may create it, not
    // authorisation over the row itself.
    t.string('kind', 20).notNullable();

    // pending | ready | rejected — see the header.
    t.string('status', 20).notNullable().defaultTo('pending');

    // What the bytes turned out to be, established by inspection rather than by
    // the client's declaration. NULL until verified.
    t.string('mime', 60);
    t.integer('bytes');

    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    // The quota counts by scope, and the sweep looks for stale pending rows.
    t.index(['campaign_id', 'status']);
    t.index(['user_id', 'status']);
    t.index(['status', 'created_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('assets');
};
