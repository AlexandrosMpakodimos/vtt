const EMAIL_RE = /^[a-zA-Z0-9_+&*-]+(?:\.[a-zA-Z0-9_+&*-]+)*@(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;
const USERNAME_RE = /^[\p{L}\p{N}_]{3,30}$/u;
function normalizeEmail(email) { return typeof email === 'string' ? email.trim().toLowerCase() : ''; }
function validateEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return { error: 'email is required' };
  if (e.length > 254) return { error: 'email is too long' };
  if (!EMAIL_RE.test(e)) return { error: 'email format is invalid' };
  return { value: e };
}
function validateUsername(username) {
  const u = typeof username === 'string' ? username.trim() : '';
  if (!u) return { error: 'username is required' };
  if (!USERNAME_RE.test(u)) return { error: 'username must be 3-30 characters: letters, numbers, or underscore' };
  return { value: u };
}
function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) return { error: 'password is required' };
  if (password.length < 8) return { error: 'password must be at least 8 characters' };
  // Argon2id has no short input limit (unlike bcrypt's 72-byte truncation); this
  // generous cap only guards against pathologically long inputs (a DoS vector).
  if (password.length > 64) return { error: 'password is too long (max 64 characters)' }; //64 character limit per NIST's recommendation
  return { value: password };
}
function validateCampaignName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return { error: 'campaign name is required' };
  if (n.length > 100) return { error: 'campaign name is too long (max 100 characters)' };
  return { value: n };
}
function validateCampaignDescription(description) {
  if (description === undefined || description === null || description === '') return { value: null };
  if (typeof description !== 'string') return { error: 'description must be text' };
  const d = description.trim();
  // TEXT is unbounded in Postgres; this only rejects absurd payloads.
  if (d.length > 2000) return { error: 'description is too long (max 2000 characters)' };
  return { value: d || null };
}
// Same treatment as avatar_url in routes/auth.js: parse, restrict the scheme to
// http(s) (which excludes javascript: and data:), and store the NORMALISED href
// so HTML-significant characters are percent-encoded before they are ever stored.
function validateImageUrl(url, field = 'img_url') {
  if (url === undefined || url === null || url === '') return { value: null };
  let u = String(url).trim();
  if (!u) return { value: null };
  if (u.length > 2000) return { error: `${field} is too long (max 2000 characters)` };
  let parsed;
  try { parsed = new URL(u); } catch { return { error: `${field} must be a valid URL` }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `${field} must use http:// or https://` };
  }
  return { value: parsed.href };
}
// A campaign password is a shared room secret, not a personal credential: it is
// told to a table of friends, so NIST's account-password guidance (breach
// screening, 8-char floor) does not transfer. The 128 cap bounds Argon2id work
// from a pathologically long input, matching the reasoning behind the 64-char
// account cap rather than its exact value.
function validateCampaignPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { error: 'a private campaign requires a password' };
  }
  if (password.length < 4) return { error: 'campaign password must be at least 4 characters' };
  if (password.length > 128) return { error: 'campaign password is too long (max 128 characters)' };
  return { value: password };
}
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function validateColor(color) {
  if (color === undefined || color === null || color === '') return { value: null };
  const c = String(color).trim();
  if (!HEX_COLOR_RE.test(c)) return { error: 'color must be a hex value like #A1B2C3' };
  return { value: c.toLowerCase() };
}

// --- scenes & tokens (M2 canvas) ---

function validateSceneName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return { error: 'scene name is required' };
  if (n.length > 100) return { error: 'scene name is too long (max 100 characters)' };
  return { value: n };
}

// Token display name. Optional (a decorative token needs none). Kept to the
// same 100-char bound as other names; stored/rendered as text, never as markup.
function validateTokenName(name) {
  if (name === undefined || name === null || name === '') return { value: null };
  if (typeof name !== 'string') return { error: 'token name must be text' };
  const n = name.trim();
  if (n.length > 100) return { error: 'token name is too long (max 100 characters)' };
  return { value: n || null };
}

// A bounded, finite number. Rejects NaN/Infinity and — critically — anything
// that is not already a number or a plain numeric string. An earlier version
// used bare Number() coercion, which silently accepted values that are not
// numbers at all: Number([[5]]) === 5 and Number([5]) === 5 (JS recursively
// stringifies single-element arrays) and Number(true) === 1. A client could
// therefore smuggle an array or boolean into a numeric column. Found by
// break-canvas.js (type confusion, OWASP API3/BOPLA class).
// Returns { value } (a Number) or { error }.
function finiteInRange(v, { min, max, field }) {
  let n;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string' && v.trim() !== '') {
    // Accept a numeric string (form inputs arrive as strings), nothing else.
    n = Number(v);
  } else {
    return { error: `${field} must be a number` };
  }
  if (!Number.isFinite(n)) return { error: `${field} must be a finite number` };
  if (n < min || n > max) return { error: `${field} must be between ${min} and ${max}` };
  return { value: n };
}

// Grid-unit coordinate. A scene is at most a few hundred squares on a side;
// -10000..10000 is far past any real canvas yet bounds a hostile input.
const COORD_MIN = -10000;
const COORD_MAX = 10000;
function validateGridCoord(v, field) {
  return finiteInRange(v, { min: COORD_MIN, max: COORD_MAX, field });
}

// Token size in grid units. Must be positive; a token cannot be 0 or negative
// squares. Capped so it cannot be made to blanket an entire scene.
function validateTokenSize(v, field) {
  const r = finiteInRange(v, { min: 0.1, max: 100, field });
  return r;
}

// Scene canvas dimension in pixels. Positive integer, bounded to sane limits.
function validateSceneDimension(v, field, dflt) {
  if (v === undefined || v === null || v === '') return { value: dflt };
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) return { error: `${field} must be a whole number of pixels` };
  if (n < 100 || n > 20000) return { error: `${field} must be between 100 and 20000 pixels` };
  return { value: n };
}

// A batch of token ids (for group move / delete / copy). Rejects non-arrays,
// empties, over-long batches (a DoS bound), and any malformed uuid — so a
// hostile body can never reach the DB or spin the server on a huge list.
// De-duplicates, since selecting the same token twice is meaningless.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCH = 500; // far past any real selection; bounds a hostile payload
function validateTokenIdList(ids, field = 'token_ids') {
  if (!Array.isArray(ids)) return { error: `${field} must be an array` };
  if (ids.length === 0) return { error: `${field} is empty` };
  if (ids.length > MAX_BATCH) return { error: `${field} has too many items (max ${MAX_BATCH})` };
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return { error: `${field} contains an invalid id` };
    }
    seen.add(id);
  }
  return { value: [...seen] };
}

// --- fog of war (M3) ---

// Shape types. A fixed allow-list in app logic rather than a DB CHECK: the house
// convention is app-logic allow-lists, and campaign_members.status is the one
// stated exception because it drives AUTHORISATION. Fog type drives rendering.
const FOG_TYPES = ['rect', 'circle', 'poly'];

// Vertices per region. The row cap (MAX_FOG_REGIONS_PER_SCENE, in routes/scenes.js)
// bounds how many regions exist; this bounds how big ONE of them can be. That
// second bound is the one that actually matters: 200 regions of 50,000 vertices
// each is a trivially small number of requests that poisons every future scene
// load, and no row cap would catch it.
const MAX_FOG_POINTS = 500;

function validateFogType(v) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!FOG_TYPES.includes(t)) {
    return { error: `type must be one of: ${FOG_TYPES.join(', ')}` };
  }
  return { value: t };
}

// One {x, y} vertex in GRID UNITS — the same coordinate space tokens live in,
// validated by the same validateGridCoord (which wraps finiteInRange, the
// post-audit numeric path that rejects [[5]], [5], true and other coercion
// smuggling). No second numeric path is defined here on purpose: duplicating
// that logic is exactly how the type-confusion bug arrived the first time.
function validateFogPoint(p, i) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { error: `points[${i}] must be an object like {x, y}` };
  }
  const x = validateGridCoord(p.x, `points[${i}].x`);
  if (x.error) return { error: x.error };
  const y = validateGridCoord(p.y, `points[${i}].y`);
  if (y.error) return { error: y.error };
  return { value: { x: x.value, y: y.value } };
}

// Validate + NORMALISE a region's geometry for a given (already validated) type.
// Returns { value: [{x,y}, ...] } or { error }.
//
//   rect   — exactly 2 opposite corners. Stored canonically as [min, max] so a
//            backwards drag (bottom-right to top-left) and a forwards one that
//            describe the same rectangle store identically. A zero-width or
//            zero-height rect is rejected: it renders as nothing, so it is a
//            junk row that only consumes the scene's region cap.
//   circle — exactly 2 points: [centre, a point on the rim]. The radius is
//            DERIVED from the two, never stored, which is why the schema needs
//            no radius column. A zero radius is rejected for the same reason a
//            zero-area rect is. The rim point is stored as given rather than
//            rotated to a canonical angle: canonicalising it would push the
//            stored point outside the ±10000 coordinate bound for a circle
//            drawn near the edge of a large scene, and a circle has no
//            orientation worth normalising anyway.
//   poly   — 3..MAX_FOG_POINTS vertices, stored in the order drawn (winding
//            order is the renderer's business, not the database's).
function validateFogPoints(type, points) {
  if (!Array.isArray(points)) return { error: 'points must be an array' };
  if (points.length > MAX_FOG_POINTS) {
    return { error: `points has too many items (max ${MAX_FOG_POINTS})` };
  }

  const need = (n) => `a ${type} needs exactly ${n} points`;
  if ((type === 'rect' || type === 'circle') && points.length !== 2) {
    return { error: need(2) };
  }
  if (type === 'poly' && points.length < 3) {
    return { error: 'a poly needs at least 3 points' };
  }

  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = validateFogPoint(points[i], i);
    if (p.error) return { error: p.error };
    out.push(p.value);
  }

  if (type === 'rect') {
    const [a, b] = out;
    if (a.x === b.x || a.y === b.y) {
      return { error: 'a rect must have a non-zero width and height' };
    }
    return {
      value: [
        { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
        { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
      ],
    };
  }

  if (type === 'circle') {
    const [c, rim] = out;
    if (c.x === rim.x && c.y === rim.y) {
      return { error: 'a circle must have a non-zero radius' };
    }
    return { value: out };
  }

  return { value: out };
}

// A tri-state boolean from a request body: true if === true or 'true', false if
// === false or 'false', else an error. Avoids the JS truthiness trap where any
// non-empty string flips a flag on.
function validateBool(v, field) {
  if (v === true || v === 'true') return { value: true };
  if (v === false || v === 'false') return { value: false };
  return { error: `${field} must be true or false` };
}

// --- actors, items & inventory (M4) ---

// The uuid shape check, exported so the M4 routes do not define a fourth copy of
// this regex. campaignAuth.js and routes/scenes.js keep their own local copies:
// they work and rewriting them would be churn for no behavioural gain, but new
// code has one place to import from.
const validUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// A bounded INTEGER. Built on finiteInRange so it inherits the post-audit
// numeric path that rejects [[5]], [5], true and the rest of the coercion
// smuggling found by break-canvas.js — then additionally requires wholeness,
// because an actor cannot have 12.4 hit points or 3.5 levels.
function validateInt(v, { min, max, field }) {
  const r = finiteInRange(v, { min, max, field });
  if (r.error) return r;
  if (!Number.isInteger(r.value)) return { error: `${field} must be a whole number` };
  return { value: r.value };
}

// Bounds for the actor's numeric columns. Every one of these is a BOUND, not a
// RULE: the server refuses absurd input and then never looks at the value again.
// Nothing here is enforced, derived or auto-applied. In particular:
//   - hp_current may go NEGATIVE and is never clamped to hp_max. Clamping is a
//     rule, and "dead" is a display state the client derives from hp_current<=0.
//   - the death-save counters are bounded generously rather than at 3, so that
//     the bound cannot be mistaken for the 5e three-strikes rule. The server
//     never acts on them: no auto-stabilisation, no auto-death.
//   - level tops out at 20 as an abuse bound, not as a progression cap.
const ACTOR_INT_FIELDS = {
  level:                { min: 1,     max: 20 },
  hp_current:           { min: -9999, max: 9999 },
  hp_max:               { min: 0,     max: 9999 },
  hp_temp:              { min: 0,     max: 9999 },
  armor_class:          { min: 0,     max: 99 },
  speed:                { min: 0,     max: 999 },
  strength:             { min: 1,     max: 30 },
  dexterity:            { min: 1,     max: 30 },
  constitution:         { min: 1,     max: 30 },
  intelligence:         { min: 1,     max: 30 },
  wisdom:               { min: 1,     max: 30 },
  charisma:             { min: 1,     max: 30 },
  death_save_successes: { min: 0,     max: 10 },
  death_save_failures:  { min: 0,     max: 10 },
};

function validateActorInt(field, v) {
  const spec = ACTOR_INT_FIELDS[field];
  if (!spec) return { error: `${field} is not a numeric actor field` };
  return validateInt(v, { min: spec.min, max: spec.max, field });
}

// A short optional free-text field (actor class / race). Not allow-listed: the
// system is D&D-INSPIRED, not 5e, so there is no canonical class list to check
// against and inventing one would be exactly the rules-system creep this project
// excludes. Stored as text, rendered via textContent, never as markup.
function validateShortText(v, field, max = 50) {
  if (v === undefined || v === null || v === '') return { value: null };
  if (typeof v !== 'string') return { error: `${field} must be text` };
  const s = v.trim();
  if (s.length > max) return { error: `${field} is too long (max ${max} characters)` };
  return { value: s || null };
}

// Creature size category. Allow-listed against the SAME six 5e size names the
// token size presets already use (routes/scenes.js SIZE_PRESETS), because this
// column's job is to supply a token's default footprint when a token is placed
// from an actor. Matched case-insensitively, stored Title-cased to match the
// column's 'Medium' default in the schema.
const ACTOR_SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
function validateActorSize(v) {
  if (v === undefined || v === null || v === '') return { value: 'Medium' };
  if (typeof v !== 'string') return { error: 'size must be text' };
  const wanted = v.trim().toLowerCase();
  const hit = ACTOR_SIZES.find((s) => s.toLowerCase() === wanted);
  if (!hit) return { error: `size must be one of: ${ACTOR_SIZES.join(', ')}` };
  return { value: hit };
}

// Long-form free text (actor notes, item description).
function validateLongText(v, field, max = 5000) {
  if (v === undefined || v === null || v === '') return { value: null };
  if (typeof v !== 'string') return { error: `${field} must be text` };
  const s = v.trim();
  if (s.length > max) return { error: `${field} is too long (max ${max} characters)` };
  return { value: s || null };
}

// A JSONB overflow blob (actors.data, items.properties).
//
// This is the one input in the project with no natural shape to validate — that
// is the entire point of an overflow bucket, and it is exactly why it needs
// bounds instead. actors.data is PLAYER-WRITABLE (it holds their currency, spell
// slots and proficiencies), so without a cap a player could POST a 40 MB
// document, or a 10,000-deep nested structure that costs more to parse than to
// send. The row caps elsewhere in this project bound how MANY rows exist; this
// bounds how big ONE of them can be — the same argument as MAX_FOG_POINTS, and
// the same reason that bound mattered more than the region cap.
//
// Bounds are chosen, not measured: a real character sheet's overflow is a few
// hundred bytes.
const MAX_JSON_BYTES = 8192;
const MAX_JSON_DEPTH = 6;
const MAX_JSON_KEYS = 200;

function jsonShapeError(v, field, depth = 1) {
  if (depth > MAX_JSON_DEPTH) return `${field} is nested too deeply (max ${MAX_JSON_DEPTH})`;
  if (Array.isArray(v)) {
    for (const el of v) {
      const e = jsonShapeError(el, field, depth + 1);
      if (e) return e;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const e = jsonShapeError(v[k], field, depth + 1);
      if (e) return e;
    }
    return null;
  }
  return null;
}

function countJsonKeys(v) {
  if (Array.isArray(v)) return v.reduce((n, el) => n + countJsonKeys(el), 0);
  if (v && typeof v === 'object') {
    return Object.keys(v).reduce((n, k) => n + 1 + countJsonKeys(v[k]), 0);
  }
  return 0;
}

function validateJsonBlob(v, field) {
  if (v === undefined || v === null || v === '') return { value: {} };
  // Must be a plain object. An array would be valid JSON but changes what the
  // column means, and node-pg turns a bare JS array into a Postgres array
  // literal rather than jsonb (the trap M3 hit with fog points), so refusing it
  // here avoids a confusing 500 later.
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { error: `${field} must be a JSON object` };
  }
  const shape = jsonShapeError(v, field);
  if (shape) return { error: shape };
  if (countJsonKeys(v) > MAX_JSON_KEYS) {
    return { error: `${field} has too many keys (max ${MAX_JSON_KEYS})` };
  }
  let serialised;
  try {
    serialised = JSON.stringify(v);
  } catch {
    // Circular structures cannot arrive over JSON, but a defensive catch keeps
    // a malformed body from throwing inside the route.
    return { error: `${field} is not serialisable` };
  }
  if (serialised === undefined) return { error: `${field} must be a JSON object` };
  if (Buffer.byteLength(serialised, 'utf8') > MAX_JSON_BYTES) {
    return { error: `${field} is too large (max ${MAX_JSON_BYTES} bytes)` };
  }
  return { value: v };
}

// Item category. A fixed app-logic allow-list (no DB CHECK), per the house
// convention stated on fog `type`.
const ITEM_TYPES = ['weapon', 'armor', 'consumable', 'misc'];
function validateItemType(v) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!ITEM_TYPES.includes(t)) {
    return { error: `type must be one of: ${ITEM_TYPES.join(', ')}` };
  }
  return { value: t };
}

// Item weight. Fractional (a dagger is 1 lb, a coin is 0.02), non-negative, and
// bounded. Weight is STORED AND DISPLAYED ONLY — encumbrance is cut by name in
// database-decisions.md, so no movement penalty is ever derived from it.
function validateItemWeight(v) {
  if (v === undefined || v === null || v === '') return { value: 0 };
  return finiteInRange(v, { min: 0, max: 10000, field: 'weight' });
}

// A stack size in a bag.
function validateQuantity(v) {
  if (v === undefined || v === null || v === '') return { value: 1 };
  return validateInt(v, { min: 1, max: 9999, field: 'quantity' });
}

function validateSortOrder(v) {
  if (v === undefined || v === null || v === '') return { value: 0 };
  return validateInt(v, { min: 0, max: 9999, field: 'sort_order' });
}

// ---------------------------------------------------------------------------
// M5 — combat and chat
// ---------------------------------------------------------------------------

// Combat name. Optional; a fight does not need a title.
function validateCombatName(v) {
  return validateShortText(v, 'name', 100);
}

// Per-instance hit points for one combatant. NULL is meaningful and is NOT an
// absent value: it means "this combatant has no per-fight HP of its own", which
// is the correct state for a player character (their sheet is authoritative) and
// for an unlinked token.
//
// Bounds match actors.hp_current in ACTOR_INT_FIELDS deliberately, negatives
// included: hp_current may go negative and is never clamped, because death is
// not a mechanic in this project, and a per-fight override that could not go
// negative would be a stricter rule than the column it stands in for.
function validateHpOverride(v) {
  if (v === null || v === '') return { value: null };
  if (v === undefined) return { value: undefined };
  return validateInt(v, { min: -9999, max: 9999, field: 'hp_override' });
}

// Message body types. An app-level allow-list with no DB CHECK, consistent with
// FOG_TYPES and ITEM_TYPES. Note this does NOT gate confidentiality: whisper_to
// being non-empty is the only thing that makes a row private, so a 'chat' with a
// populated whisper_to is private and a 'whisper' with an empty one is not.
const MESSAGE_TYPES = ['chat', 'roll', 'system', 'whisper'];
function validateMessageType(v) {
  if (v === undefined || v === null || v === '') return { value: 'chat' };
  if (typeof v !== 'string') return { error: 'type must be text' };
  const s = v.trim().toLowerCase();
  if (!MESSAGE_TYPES.includes(s)) {
    return { error: `type must be one of: ${MESSAGE_TYPES.join(', ')}` };
  }
  return { value: s };
}

// A chat line. Shorter than actors.notes (5000) on purpose: this is a message in
// a live log, not a document, and every one of them is broadcast to every
// recipient and then held in the campaign's history.
const MAX_MESSAGE_LENGTH = 2000;
function validateMessageContent(v) {
  if (typeof v !== 'string' || !v.trim()) return { error: 'content is required' };
  const s = v.trim();
  if (s.length > MAX_MESSAGE_LENGTH) {
    return { error: `content is too long (max ${MAX_MESSAGE_LENGTH} characters)` };
  }
  return { value: s };
}

// The whisper recipient list. Shape only — MEMBERSHIP of each id is checked in
// the route against the campaign, because that needs the database and this
// module has none. Both halves are required: an id that is well-formed but
// belongs to a stranger is a row deliberately emitted to a stranger, since
// whisper_to is a disclosure list rather than a display field.
//
// An empty array is normalised to null ("everyone") rather than kept as [], so
// there is exactly one representation of a public message and no route has to
// test for both.
const MAX_WHISPER_RECIPIENTS = 20;
function validateWhisperTo(v) {
  if (v === undefined || v === null) return { value: null };
  if (!Array.isArray(v)) return { error: 'whisper_to must be an array' };
  if (v.length === 0) return { value: null };
  if (v.length > MAX_WHISPER_RECIPIENTS) {
    return { error: `whisper_to has too many recipients (max ${MAX_WHISPER_RECIPIENTS})` };
  }
  const seen = new Set();
  for (const id of v) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return { error: 'whisper_to contains an invalid id' };
    }
    seen.add(id);
  }
  return { value: [...seen] };
}

module.exports = {
  normalizeEmail, validateEmail, validateUsername, validatePassword,
  validateCampaignName, validateCampaignDescription, validateImageUrl,
  validateCampaignPassword, validateColor,
  validateSceneName, validateTokenName, validateGridCoord, validateTokenSize,
  validateSceneDimension, validateTokenIdList, validateBool,
  validateFogType, validateFogPoints, FOG_TYPES, MAX_FOG_POINTS,
  validUuid, validateInt, validateActorInt, ACTOR_INT_FIELDS,
  validateShortText, validateLongText, validateActorSize, ACTOR_SIZES,
  validateJsonBlob, MAX_JSON_BYTES, MAX_JSON_DEPTH, MAX_JSON_KEYS,
  validateItemType, ITEM_TYPES, validateItemWeight,
  validateQuantity, validateSortOrder,
  validateCombatName, validateHpOverride,
  validateMessageType, MESSAGE_TYPES,
  validateMessageContent, MAX_MESSAGE_LENGTH,
  validateWhisperTo, MAX_WHISPER_RECIPIENTS,
};