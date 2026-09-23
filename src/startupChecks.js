const fs = require('node:fs');
const path = require('node:path');
// Explicit read-only probes: no Knex migration API (which can create metadata).
const columns = {
  users: '"id", "email", "username", "password_hash", "avatar_url", "created_at", "updated_at", "email_verified_at", "pending_email", "avatar_offset_x", "avatar_offset_y", "avatar_scale"',
  email_verification_tokens: '"id", "user_id", "token_hash", "expires_at", "used_at", "created_at", "purpose"',
  password_reset_tokens: '"id", "user_id", "token_hash", "expires_at", "used_at", "created_at"',
  campaigns: '"id", "owner_id", "name", "description", "img_url", "is_public", "password_hash", "active_scene_id", "settings", "deleted_at", "created_at", "updated_at", "is_open"',
  campaign_members: '"campaign_id", "user_id", "status", "color", "joined_at", "archived_at"',
  scenes: '"id", "campaign_id", "folder_id", "name", "img_url", "width", "height", "grid", "created_at", "updated_at"',
  tokens: '"id", "scene_id", "actor_id", "created_by", "name", "img_url", "x", "y", "width", "height", "rotation", "hidden", "locked", "bar1_value", "bar1_max", "conditions", "created_at", "updated_at", "is_prop", "img_offset_x", "img_offset_y", "img_scale"',
  fog_of_war: '"id", "scene_id", "type", "points", "revealed", "created_at", "updated_at"',
  actors: '"id", "campaign_id", "user_id", "folder_id", "name", "img_url", "is_npc", "level", "class", "race", "size", "hp_current", "hp_max", "hp_temp", "armor_class", "speed", "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma", "death_save_successes", "death_save_failures", "notes", "data", "created_at", "updated_at", "img_offset_x", "img_offset_y", "img_scale", "in_party"',
  items: '"id", "campaign_id", "folder_id", "name", "img_url", "type", "weight", "description", "properties", "identified", "created_at", "updated_at"',
  inventory: '"id", "actor_id", "item_id", "quantity", "equipped", "attuned", "sort_order", "created_at", "updated_at"',
  combat: '"id", "campaign_id", "scene_id", "name", "active", "created_at", "updated_at", "round", "turn_index"',
  combatants: '"id", "combat_id", "token_id", "sort_order", "hp_override", "hp_visible", "created_at", "updated_at"',
  messages: '"id", "campaign_id", "user_id", "speaker_name", "content", "type", "roll_data", "whisper_to", "created_at", "speaker_role", "speaker_as"',
  spells: '"id", "campaign_id", "name", "level", "description", "properties", "created_at", "updated_at"',
  actor_spells: '"actor_id", "spell_id", "prepared", "source", "created_at", "updated_at"',
  assets: '"id", "campaign_id", "user_id", "storage_key", "url", "source_url", "source", "kind", "status", "mime", "bytes", "created_at", "updated_at", "bytes_verified", "reserved_bytes", "etag", "idempotency_key", "upload_attempts"',
  storage_budget: '"id", "committed_bytes", "reserved_bytes", "cleanup_debt_bytes", "class_a_used", "class_b_used", "period_start", "period_end", "period_source", "reconciled_at", "reconcile_complete", "created_at", "updated_at"',
  storage_cleanup: '"id", "storage_key", "bytes", "reason", "attempts", "last_error", "next_attempt_at", "leased_by", "leased_until", "created_at", "updated_at"',
};
async function checkStartup(knex, pool, production) {
  await knex.raw('SELECT 1');
  await pool.query('SELECT 1');
  const prefix = production ? 'public.' : '';
  const expected = fs.readdirSync(path.join(__dirname, 'db/migrations')).filter(n => n.endsWith('.js')).sort();
  const { rows } = await knex.raw(`SELECT name FROM ${prefix}knex_migrations ORDER BY name`);
  if (JSON.stringify(rows.map(r => r.name).sort()) !== JSON.stringify(expected)) throw new Error('STARTUP_MIGRATIONS_INVALID');
  const locks = await knex.raw(`SELECT is_locked FROM ${prefix}knex_migrations_lock`);
  if (locks.rows.length !== 1 || Number(locks.rows[0].is_locked) !== 0) throw new Error('STARTUP_MIGRATIONS_LOCKED');
  for (const [table, names] of Object.entries(columns)) {
    await knex.raw(`SELECT ${names} FROM ${prefix}${table} LIMIT 0`);
  }
  // Development retains connect-pg-simple's lazy table creation behavior.
  if (production) await pool.query('SELECT sid, sess, expire FROM public.session LIMIT 0');
}
module.exports = { checkStartup };
