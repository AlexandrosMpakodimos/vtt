// Explicit allow-list. password_hash is absent by construction, so no response
// can leak it — the same discipline as SAFE_COLUMNS in routes/auth.js.
const SAFE_COLUMNS = [
  'id', 'owner_id', 'name', 'description', 'img_url',
  'is_public', 'is_open', 'active_scene_id', 'settings', 'created_at', 'updated_at',
];

// Shapes a campaign for the client. has_password is exposed as a BOOLEAN (never
// the hash) so the UI knows whether to prompt; is_gm is derived per-viewer.
function publicCampaign(c, viewerId) {
  if (!c) return null;
  return {
    id: c.id,
    owner_id: c.owner_id,
    name: c.name,
    description: c.description,
    img_url: c.img_url,
    is_public: c.is_public,
    // Whether the game is open. Sent to EVERY member, not just the GM: a player
    // needs to know why the table is unreachable, and a dashboard that shows a
    // campaign but cannot say it is closed is worse than one that hides it.
    is_open: c.is_open !== false,
    has_password: !!c.password_hash,
    is_gm: viewerId != null && c.owner_id === viewerId,
    // The GM's display name, present only when the query joined users in (the
    // list and search do; detail does not). Lets a card show whose game it is.
    ...(c.owner_username !== undefined ? { owner_username: c.owner_username } : {}),
    active_scene_id: c.active_scene_id,
    settings: c.settings,
    created_at: c.created_at,
    updated_at: c.updated_at,
    // archived is the VIEWER's own dashboard state (from their campaign_members
    // row), not a property of the campaign — two viewers can disagree on it.
    // Only present when this campaign was loaded with a membership row joined in.
    ...(c.archived_at !== undefined ? { archived: c.archived_at !== null } : {}),
    ...(c.deleted_at !== undefined && c.deleted_at !== null ? { deleted_at: c.deleted_at } : {}),
  };
}

function publicMember(m) {
  return {
    user_id: m.user_id,
    username: m.username,
    avatar_url: m.avatar_url,
    status: m.status,
    color: m.color,
    joined_at: m.joined_at,
    is_gm: m.is_gm === true,
  };
}

// Search results are seen by non-members, so they get a narrower shape: enough
// to decide whether to join, nothing about who is inside.
function searchResult(c) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    img_url: c.img_url,
    is_public: c.is_public,
    is_open: c.is_open !== false,
    has_password: !!c.password_hash,
    owner_username: c.owner_username,
    member_count: Number(c.member_count) || 0,
    created_at: c.created_at,
  };
}

module.exports = { SAFE_COLUMNS, publicCampaign, publicMember, searchResult };
