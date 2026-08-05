// Dev harness for the M2 canvas + token manipulation. External file (CSP is
// script-src 'self': no inline <script>, no on*= handlers). Function over form,
// same spirit as dashboard.html.
//
// Interactions:
//   - drag a token           -> move it (syncs ON DROP via token:move)
//   - drag a selection       -> group move (syncs ON DROP via token:move-batch)
//   - drag empty stage        -> marquee-select tokens you may move
//   - click a token          -> select just it; shift-click toggles
//   - click empty            -> clear selection
//   - arrow keys             -> nudge selection by 1 grid unit (authority-checked)
//   - right-click            -> context menu (resize/hide/lock/copy/paste/delete)
//   - ctrl/cmd C / V         -> copy / paste (GM only)
//   - Delete / Backspace     -> delete selection (GM only)
// Movement is ON DROP, never streamed. Server is authoritative on every write.

const out = document.getElementById('out');
const logEl = document.getElementById('log');
const stage = document.getElementById('stage');
const stageBg = document.getElementById('stage-bg');
const marqueeEl = document.getElementById('marquee');
const ctxMenu = document.getElementById('ctx-menu');
const fogLayer = document.getElementById('fog-layer');
const fogPanel = document.getElementById('fog-panel');
const fogModeEl = document.getElementById('fog-mode');
const fogToolEl = document.getElementById('fog-tool');
const fogShapeEl = document.getElementById('fog-shape');

function show(label, data) {
  out.textContent = label + (data === undefined ? '' : '\n' + JSON.stringify(data, null, 2));
}
function log(msg) {
  logEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let me = null;
let campaignId = null;
let scene = null;
let joinedRoom = false;
let currentCampaignOwnerId = null;
const tokens = new Map();          // token_id -> { row, el }
const selection = new Set();       // selected token ids
// The clipboard holds SNAPSHOTS of token data, not ids. That is what makes cut
// work: once the source row is deleted there is nothing to look up, so the
// clipboard has to carry the data itself.
let clipboard = [];
// Last known pointer position over the stage, in grid units. Paste drops tokens
// here; duplicate ignores it and offsets from the original instead.
let cursorGrid = { x: 0, y: 0 };
// Set when a marquee drag ends, to swallow the click the browser fires right
// after it (see the #stage-bg click handler).
let suppressNextClear = false;
let activeSceneId = null;      // the campaign's active scene, per the server
let lastSceneList = [];        // last list the server sent, for cheap re-render
const GRID_PX = 50;

// --- fog state (M3) ---
// Fog lives in a parallel world to tokens on purpose. FOG MODE is the switch:
// while it is off, every token code path below behaves exactly as it did before
// fog existed, and the fog layer is pointer-events:none. While it is on, clicks
// reach fog and not tokens. That separation is deliberate — the schema has no
// z_index, so there is no principled way to decide whether a click on a fogged
// square means "the token under it" or "the fog over it". A mode answers the
// question instead of inventing an ordering rule.
const fog = new Map();             // fog_id -> row
const fogSelection = new Set();    // selected fog ids
let fogClipboard = [];             // SNAPSHOTS ({type, points}), never ids
let fogMode = false;
let fogDraw = null;                // in-progress drag: {tool, x0, y0, x1, y1}
let polyPoints = [];               // in-progress polygon vertices, grid units
// Moving a region by mouse needs the SVG nodes to SURVIVE the gesture, so the
// drag path deliberately does not re-render: it transforms the existing nodes
// and only rebuilds on drop. fogNodes is that handle.
const fogNodes = new Map();        // fog_id -> [element, ...] (mask shape + outline)
let fogMove = null;                // {startX, startY, moved}
let fogRenderPending = false;      // a render suppressed mid-drag, replayed after

const SIZE_PRESETS = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'];

function isGm() { return currentCampaignOwnerId && me && currentCampaignOwnerId === me.id; }
function canMoveRow(row) { return !!(me && (isGm() || row.created_by === me.id)); }

async function whoami() {
  const r = await api('GET', '/api/auth/me');
  me = r.status === 200 ? r.data.user : null;
  document.getElementById('whoami').textContent = me
    ? `logged in as ${me.username} (${me.id})`
    : 'NOT logged in — log in first';
}

// --- scene management ---
document.getElementById('load-scenes').addEventListener('click', loadScenes);
async function loadScenes() {
  campaignId = document.getElementById('campaign-id').value.trim();
  if (!campaignId) return;
  // Ownership decides what this list even means, so settle it before rendering.
  await fetchOwner();
  const r = await api('GET', `/api/campaigns/${campaignId}/scenes`);
  show(`GET scenes -> ${r.status}`, r.data);
  lastSceneList = r.status === 200 ? r.data.scenes : [];
  renderSceneList(lastSceneList);
  if (!joinedRoom) joinRoom();

  // A player never chooses a scene: they land on whatever the GM has active,
  // and the server only sent them that one anyway.
  if (!isGm()) {
    if (activeSceneId) openScene(activeSceneId);
    else closeScene('the GM has not opened a scene yet');
  }
}

// The GM's scene manager. Two separate actions on purpose:
//   OPEN     — loads the scene for the GM alone (prep, or checking the next map
//              mid-session without dragging the table into it).
//   ACTIVATE — makes it the campaign's active scene, which moves every player
//              into it immediately.
// Players get no list at all: with only the active scene returned to them, and
// the server refusing every other scene, there is nothing for them to choose.
function renderSceneList(scenes) {
  const box = document.getElementById('scene-list');
  box.textContent = '';
  if (!isGm()) {
    box.appendChild(document.createTextNode(
      activeSceneId ? 'the GM controls which scene is open' : 'waiting for the GM to open a scene'));
    return;
  }
  if (!scenes.length) {
    box.appendChild(document.createTextNode('no scenes yet — create one'));
    return;
  }
  for (const sc of scenes) {
    const row = document.createElement('div');
    row.className = 'scene-row';

    const label = document.createElement('span');
    const isActive = sc.id === activeSceneId;
    label.textContent = `${sc.name} (${sc.width}x${sc.height})${isActive ? '  ← ACTIVE' : ''}`;
    if (isActive) label.className = 'active-scene';
    row.appendChild(label);
    row.appendChild(document.createTextNode(' '));

    const openBtn = document.createElement('button');
    openBtn.textContent = 'open';
    openBtn.title = 'load this scene for you only — players are not moved';
    openBtn.addEventListener('click', () => openScene(sc.id));
    row.appendChild(openBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'delete';
    delBtn.title = 'permanently delete this scene, its tokens and its fog';
    delBtn.addEventListener('click', () => deleteScene(sc));
    row.appendChild(delBtn);

    const actBtn = document.createElement('button');
    actBtn.textContent = isActive ? 'active' : 'activate';
    actBtn.disabled = isActive;
    actBtn.title = 'make this the active scene — every player is moved here';
    actBtn.addEventListener('click', () => activateScene(sc.id));
    row.appendChild(actBtn);

    box.appendChild(row);
  }
}

// GM only. The server refuses this for anyone else, so the button is convenience.
async function activateScene(sceneId) {
  const r = await api('PUT', `/api/campaigns/${campaignId}/scenes/active`, { scene_id: sceneId });
  show(`activate scene -> ${r.status}`, r.data);
  if (r.status === 200) {
    activeSceneId = r.data.active_scene_id;
    if (!scene || scene.id !== activeSceneId) await openScene(activeSceneId);
    await loadScenes();
  }
}

// GM only. Deletion is permanent and cascades to every token and every fog
// region on the scene, so the confirmation NAMES what is about to be destroyed
// rather than asking a bare "are you sure?" — the same standard the recorded
// account-deletion decision set. The counts come from loading the scene first;
// they are worth one extra request on a destructive, irreversible action.
async function deleteScene(sc) {
  const peek = await api('GET', `/api/campaigns/${campaignId}/scenes/${sc.id}`);
  let blast = 'its tokens and fog';
  if (peek.status === 200) {
    const t = peek.data.tokens.length, f = (peek.data.fog || []).length;
    blast = `${t} token${t === 1 ? '' : 's'} and ${f} fog region${f === 1 ? '' : 's'}`;
  }
  const active = sc.id === activeSceneId ? '\n\nThis is the ACTIVE scene — every player will be dropped out of it.' : '';
  if (!window.confirm(`Delete "${sc.name}"?\n\nThis permanently removes the scene and ${blast}. It cannot be undone.${active}`)) return;

  const r = await api('DELETE', `/api/campaigns/${campaignId}/scenes/${sc.id}`);
  show(`delete scene -> ${r.status}`, r.data);
  if (r.status !== 200) return;
  log(`deleted "${sc.name}" (${r.data.deleted.tokens} tokens, ${r.data.deleted.fog} fog regions)`);
  if (scene && scene.id === sc.id) closeScene('scene deleted');
  if (r.data.was_active) activeSceneId = null;
  await loadScenes();
}

// Tear the canvas down — used when a player's scene stops being the active one.
function closeScene(reason) {
  scene = null;
  for (const { el } of tokens.values()) el.remove();
  tokens.clear(); selection.clear();
  fog.clear(); fogSelection.clear();
  fogLayer.textContent = '';
  document.getElementById('scene-title').textContent = reason ? `— ${reason}` : '';
  log(reason || 'scene closed');
}

document.getElementById('create-scene').addEventListener('click', async () => {
  campaignId = document.getElementById('campaign-id').value.trim();
  const name = document.getElementById('new-scene-name').value.trim();
  if (!campaignId || !name) return show('need a campaign id and a scene name');
  const r = await api('POST', `/api/campaigns/${campaignId}/scenes`, { name });
  show(`create scene -> ${r.status}`, r.data);
  if (r.status === 201) loadScenes();
});

// --- open a scene ---
async function openScene(sceneId) {
  const r = await api('GET', `/api/campaigns/${campaignId}/scenes/${sceneId}`);
  show(`open scene -> ${r.status}`, { scene: r.data.scene, tokenCount: r.data.tokens && r.data.tokens.length });
  if (r.status !== 200) return;

  scene = r.data.scene;
  document.getElementById('scene-title').textContent = `— ${scene.name}`;
  stage.style.width = scene.width + 'px';
  stage.style.height = scene.height + 'px';
  stageBg.style.backgroundImage = scene.img_url ? `url("${CSS.escape(scene.img_url)}")` : 'none';
  applyGridAlignment();
  applyGridOverlay();

  for (const { el } of tokens.values()) el.remove();
  tokens.clear();
  selection.clear();
  for (const t of r.data.tokens) upsertToken(t);

  // M6: refresh the character picker. Deliberately NOT from r.data.actors —
  // see renderActorPicker's header for why that array is the wrong source.
  loadActorPicker();

  // Fog arrives in the same "load heavy" payload as the tokens.
  fog.clear();
  fogSelection.clear();
  fogLayer.setAttribute('width', scene.width);
  fogLayer.setAttribute('height', scene.height);
  fogLayer.setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`);
  for (const f of (r.data.fog || [])) fog.set(f.id, f);
  renderFog();

  if (!joinedRoom) joinRoom();
}

// --- rendering ---
// M6: place the map image so its printed grid lines up with OUR grid.
//
// The obvious approach is the other way round — read scene.grid.size and render
// the token grid at that many pixels per unit. It was rejected because GRID_PX
// is 50 everywhere in this file and in the 134 jsdom assertions covering it;
// making it dynamic would touch every coordinate conversion and every one of
// those probes, for a change that is purely presentational.
//
// So the IMAGE is scaled to the grid instead of the grid to the image. The
// result on screen is identical, token coordinates keep meaning exactly what
// they meant, and nothing in the existing suites is disturbed.
//
// scene.grid.size is the cell size measured in the IMAGE's own pixels; the
// offsets are where that grid begins, also in image pixels. Scaling by
// GRID_PX / size makes one printed cell exactly one of our cells.
//
// Background-size is set from the image's NATURAL dimensions, which means a
// probe load — CSS has no way to say "scale this background by 1.4" without
// knowing what it is scaling.
function applyGridAlignment() {
  const grid = (scene && scene.grid) || {};
  const cell = Number(grid.size) || 0;

  if (!scene || !scene.img_url || !cell) {
    // No alignment set: fall back to the pre-M6 behaviour exactly.
    stageBg.style.backgroundSize = 'cover';
    stageBg.style.backgroundPosition = 'center';
    return;
  }

  const scale = GRID_PX / cell;
  const ox = Number(grid.offset_x) || 0;
  const oy = Number(grid.offset_y) || 0;

  const probe = new Image();
  probe.onload = () => {
    // Guard against a slow load resolving after the GM switched scenes.
    if (!scene || scene.img_url !== probe.src) return;
    stageBg.style.backgroundSize =
      `${probe.naturalWidth * scale}px ${probe.naturalHeight * scale}px`;
    stageBg.style.backgroundPosition = `${-ox * scale}px ${-oy * scale}px`;
    stageBg.style.backgroundRepeat = 'no-repeat';
  };
  probe.src = scene.img_url;
}

// The grid overlay itself, drawn from the scene's own settings rather than the
// hardcoded dark lines. Colour and opacity are presentational and validated
// server-side; type 'none' hides the overlay for a map that has its own printed
// grid already aligned underneath.
function applyGridOverlay() {
  const grid = (scene && scene.grid) || {};
  if (grid.type === 'none') {
    stage.style.backgroundImage = 'none';
    return;
  }
  const color = grid.color || '#3a3a3a';
  stage.style.backgroundImage =
    `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`;
  stage.style.backgroundSize = `${GRID_PX}px ${GRID_PX}px`;
  stage.style.opacity = '';
}

function upsertToken(row) {
  let entry = tokens.get(row.id);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'token';
    // The art layer sits BEHIND the caption, so framing never moves the name.
    const art = document.createElement('div');
    art.className = 'art';
    el.appendChild(art);
    const cap = document.createElement('div');
    cap.className = 'cap';
    el.appendChild(cap);
    attachTokenPointer(el, row.id);
    stage.appendChild(el);
    entry = { row, el };
    tokens.set(row.id, entry);
  }
  entry.row = row;
  paintToken(entry);
}

// M6: draw the token's art with its framing applied.
//
// Offsets are a FRACTION of the frame, so a CSS percentage translate is the
// exact primitive: it is already relative to the element's own size, which means
// the same values render correctly whether the token is 1x1 or 3x3. A pixel
// offset would have to be rescaled per footprint, and would be wrong the moment
// a Large creature borrowed a Medium's portrait.
//
// Transform order matters. In CSS the RIGHTMOST function applies first, so
// `translate(...) scale(...)` scales the art and then shifts it by a fraction of
// the UNSCALED frame — which is what makes an offset of 0.25 mean "a quarter of
// the square" at every zoom level.
//
// At the identity transform this is `translate(0%, 0%) scale(1)`, which renders
// byte-identically to the pre-M6 build.
function paintArt(el, row) {
  const art = el.querySelector('.art');
  if (!art) return;
  art.style.backgroundImage = row.img_url ? `url("${CSS.escape(row.img_url)}")` : 'none';
  const ox = Number(row.img_offset_x) || 0;
  const oy = Number(row.img_offset_y) || 0;
  const sc = Number(row.img_scale);
  const scale = Number.isFinite(sc) && sc > 0 ? sc : 1;
  art.style.transform = `translate(${ox * 100}%, ${oy * 100}%) scale(${scale})`;
}

function paintToken({ row, el }) {
  el.style.left = (row.x * GRID_PX) + 'px';
  el.style.top = (row.y * GRID_PX) + 'px';
  el.style.width = (row.width * GRID_PX) + 'px';
  el.style.height = (row.height * GRID_PX) + 'px';
  paintArt(el, row);
  el.querySelector('.cap').textContent = row.name || '(token)';
  el.classList.toggle('mine', canMoveRow(row));
  el.classList.toggle('locked', !!row.locked);
  el.classList.toggle('hidden-tok', !!row.hidden);   // only GM ever receives hidden rows
  el.classList.toggle('selected', selection.has(row.id));
}

function removeToken(id) {
  const entry = tokens.get(id);
  if (entry) { entry.el.remove(); tokens.delete(id); }
  selection.delete(id);
}

// --- selection ---
function setSelection(ids) {
  selection.clear();
  for (const id of ids) selection.add(id);
  for (const entry of tokens.values()) entry.el.classList.toggle('selected', selection.has(entry.row.id));
}
function toggleSelected(id) {
  if (selection.has(id)) selection.delete(id); else selection.add(id);
  const entry = tokens.get(id);
  if (entry) entry.el.classList.toggle('selected', selection.has(id));
}
// The tokens in the current selection this client may actually move.
function movableSelection() {
  return [...selection].map((id) => tokens.get(id)).filter((e) => e && canMoveRow(e.row));
}

// --- placement ---

// Characters this caller may place a token for.
//
// [CORRECTED] The first version populated this from the scene load's `actors`
// array, which was wrong and visibly so: that array is built from
// `tokens.map(t => t.actor_id)`, so it contains only characters ALREADY ON THE
// BOARD. For a picker whose entire purpose is putting a character on the board
// for the first time, that is exactly backwards — and on an empty scene it is
// empty, which is how it was noticed.
//
// The campaign actor list is the right source, and it is already role-shaped by
// the server: a GM receives every character, a player receives their own plus
// any NPC whose token they can already see. Filtering below to the caller's own
// characters for a player is therefore belt-and-braces — the server refuses a
// token placed for somebody else's character with a 404 regardless.
async function loadActorPicker() {
  const r = await api('GET', `/api/campaigns/${campaignId}/actors`);
  // Shape, not status code: a refusal has no actors array, and keying on the
  // exact number 200 makes this brittle for no gain.
  const list = r.data && Array.isArray(r.data.actors) ? r.data.actors : [];
  renderActorPicker(list);
}

function renderActorPicker(list) {
  const sel = document.getElementById('tok-actor');
  if (!sel) return;
  const previous = sel.value;
  sel.textContent = '';

  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— no character —';
  sel.appendChild(none);

  for (const a of list) {
    if (!isGm() && !(me && a.user_id === me.id)) continue;
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.name + (a.is_npc ? ' (NPC)' : '');
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === previous)) sel.value = previous;
}



// D&D 5e creature sizes -> footprint in grid units. Mirrors SIZE_PRESETS on the
// server (src/routes/scenes.js); the server re-derives its own values, this copy
// is only so the client can lay out the block before sending.
const SIZE_UNITS = { tiny: 0.5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };

// Lay N tokens out in the most compact rectangle possible, rather than a long
// line: cols = ceil(sqrt(N)) gives a near-square block (4 -> 2x2, 6 -> 3x2,
// 9 -> 3x3, 12 -> 4x3). Each cell steps by the token's own footprint so Large+
// creatures don't overlap. Returns [{dx, dy}, ...] offsets from the origin.
function packOffsets(count, footprint) {
  const cols = Math.ceil(Math.sqrt(count));
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      dx: (i % cols) * footprint,
      dy: Math.floor(i / cols) * footprint,
    });
  }
  return out;
}

// Name the i-th instance. First is bare ("Goblin"), extras are numbered from 2
// ("Goblin 2", "Goblin 3"...), which is what makes a pile of identical monsters
// individually referable in play.
//
// NOTE (deliberate, not an oversight): numbering restarts each placement. Placing
// 6 goblins twice yields two tokens named "Goblin" and two named "Goblin 2".
// Continuing the sequence would mean parsing existing token names to find the
// highest suffix (and ideally filling gaps left by killed monsters). That is
// name-parsing logic inside a placement feature; deferred as a refinement.
function instanceName(base, i) {
  if (!base) return base;                    // unnamed tokens stay unnamed
  return i === 0 ? base : `${base} ${i + 1}`;
}

document.getElementById('place-token').addEventListener('click', async () => {
  if (!scene) return show('open a scene first');
  const name = document.getElementById('tok-name').value.trim();
  const img_url = document.getElementById('tok-img').value.trim();
  const sizeKey = document.getElementById('tok-size').value;
  const actorId = document.getElementById('tok-actor').value;

  // INHERITANCE IS BY ABSENCE. The server fills a token's name, picture, framing
  // and footprint from the character only when the corresponding field is
  // MISSING from the body — not when it is empty. So an empty box must be sent
  // as `undefined`, never as '' or a default, or the character's own values are
  // silently overwritten with blanks.
  //
  // That is why the size select gained an explicit "from character" option: a
  // <select> always has a value, so there was no way to express "don't send
  // one" until there was an option that meant it.
  const inheritSize = actorId && sizeKey === '';
  const footprint = SIZE_UNITS[sizeKey] || 1;

  // Bound the count client-side; the server independently bounds the batch too.
  let count = parseInt(document.getElementById('tok-count').value, 10);
  if (!Number.isFinite(count) || count < 1) count = 1;
  if (count > 50) count = 50;

  // Place where the pointer is, like paste does.
  const origin = { x: cursorGrid.x, y: cursorGrid.y };

  // A single token goes through the normal placement endpoint, so that PLAYERS
  // (who may place one) can still use this form. Bulk placement uses the paste
  // endpoint, which is GM-only — a player asking for >1 is told so plainly
  // rather than getting a confusing 403.
  if (count === 1) {
    const body = { x: origin.x, y: origin.y };
    if (actorId) body.actor_id = actorId;
    // Omitted when blank so the character's own value comes through. With no
    // character selected this is identical to the pre-M6 behaviour, because the
    // server treats an absent name on an unlinked token as no name.
    if (name) body.name = name;
    if (img_url) body.img_url = img_url;
    if (!inheritSize) { body.width = footprint; body.height = footprint; }

    const r = await api('POST', `/api/campaigns/${campaignId}/scenes/${scene.id}/tokens`, body);
    show(`place token -> ${r.status}`, r.data);
    return;
  }
  if (!isGm()) return show('only the GM can place multiple tokens at once');

  // Bulk placement inherits per spec, on the same absence rule. Numbering still
  // applies to an explicitly typed name; a character's own name is left to the
  // server, so five goblins placed from one character all arrive called
  // "Goblin" rather than being numbered — the numbering lives here, and here it
  // has no name to number.
  const offsets = packOffsets(count, footprint);
  const specs = offsets.map((o, i) => {
    const spec = { hidden: false, x: origin.x + o.dx, y: origin.y + o.dy };
    if (actorId) spec.actor_id = actorId;
    if (name) spec.name = instanceName(name, i);
    if (img_url) spec.img_url = img_url;
    if (!inheritSize) { spec.width = footprint; spec.height = footprint; }
    return spec;
  });

  // Keep the whole block on the canvas: if it would overflow the scene, shift it
  // back rather than dropping tokens off the edge. Scene dimensions are pixels;
  // the grid is GRID_PX per unit.
  const sceneCols = Math.floor(scene.width / GRID_PX);
  const sceneRows = Math.floor(scene.height / GRID_PX);
  const maxX = Math.max(...specs.map((s) => s.x + footprint));
  const maxY = Math.max(...specs.map((s) => s.y + footprint));
  const shiftX = Math.max(0, maxX - sceneCols);
  const shiftY = Math.max(0, maxY - sceneRows);
  if (shiftX || shiftY) {
    for (const s of specs) {
      s.x = Math.max(0, s.x - shiftX);
      s.y = Math.max(0, s.y - shiftY);
    }
  }

  const r = await api('POST', `/api/campaigns/${campaignId}/scenes/${scene.id}/tokens/copy`,
    { tokens: specs });
  show(`place ${count} -> ${r.status}`, {
    at: origin, block: `${Math.ceil(Math.sqrt(count))} wide`,
    created: r.data && r.data.tokens && r.data.tokens.length,
  });
});

// --- token pointer: click to select, drag to move (single or group) ---
function attachTokenPointer(el, tokenId) {
  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0;
  let groupOrigins = [];   // [{id, el, left, top}] for everything being dragged

  el.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;             // right-click handled by contextmenu
    const entry = tokens.get(tokenId);
    if (!entry) return;
    e.stopPropagation();                    // don't start a marquee

    // Clicking a token that isn't in the selection selects just it (unless
    // shift-clicking, which toggles it into the selection).
    if (e.shiftKey) {
      toggleSelected(tokenId);
    } else if (!selection.has(tokenId)) {
      setSelection([tokenId]);
    }

    // Only tokens the client may move actually drag. If this token isn't movable
    // (or is locked), we still allowed the selection above, but no drag starts.
    if (!canMoveRow(entry.row) || entry.row.locked) return;

    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    // Drag the movable subset of the selection together.
    groupOrigins = movableSelection().map((en) => ({
      id: en.row.id, el: en.el,
      left: parseFloat(en.el.style.left) || 0,
      top: parseFloat(en.el.style.top) || 0,
    }));
    for (const g of groupOrigins) g.el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    for (const g of groupOrigins) {
      g.el.style.left = (g.left + dx) + 'px';
      g.el.style.top = (g.top + dy) + 'px';
    }
  });

  el.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    for (const g of groupOrigins) g.el.classList.remove('dragging');
    el.releasePointerCapture(e.pointerId);
    if (!moved) return;                     // a click, not a drag

    const moves = groupOrigins.map((g) => ({
      token_id: g.id,
      x: Math.round((parseFloat(g.el.style.left) || 0) / GRID_PX),
      y: Math.round((parseFloat(g.el.style.top) || 0) / GRID_PX),
    }));
    if (moves.length === 1) emitMove(moves[0]);
    else emitMoveBatch(moves);
  });
}

function emitMove(m) {
  socket.emit('token:move',
    { campaign_id: campaignId, scene_id: scene.id, token_id: m.token_id, x: m.x, y: m.y },
    (ack) => {
      if (ack && ack.ok) { log(`moved ${m.token_id.slice(0, 8)} -> (${m.x},${m.y})`); upsertToken(ack.token); }
      else { log(`move refused: ${ack && ack.error}`); const en = tokens.get(m.token_id); if (en) paintToken(en); }
    });
}

function emitMoveBatch(moves) {
  socket.emit('token:move-batch',
    { campaign_id: campaignId, scene_id: scene.id, moves },
    (ack) => {
      if (ack && ack.ok) {
        log(`batch move: ${ack.applied.length} moved, ${ack.rejected.length} rejected`);
        for (const t of ack.applied) upsertToken(t);
        // Snap back any that were rejected to their last known good position.
        for (const r of ack.rejected) { const en = tokens.get(r.token_id); if (en) paintToken(en); }
      } else {
        log(`batch move failed: ${ack && ack.error}`);
        for (const m of moves) { const en = tokens.get(m.token_id); if (en) paintToken(en); }
      }
    });
}

// Track the pointer over the stage in GRID units, so paste can drop tokens where
// the user is looking. Uses the capture phase so it still fires when the pointer
// is over a token (whose own handlers stop propagation during a drag).
stage.addEventListener('pointermove', (e) => {
  const rect = stage.getBoundingClientRect();
  cursorGrid = {
    x: Math.round((e.clientX - rect.left) / GRID_PX),
    y: Math.round((e.clientY - rect.top) / GRID_PX),
  };
}, true);

// --- marquee selection (drag on empty stage) ---
let marquee = null;
stage.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return;
  // Fog mode owns the gesture entirely. Nothing below this block runs, so the
  // token drag/marquee paths are untouched rather than conditionally patched.
  if (fogMode) {
    hideCtxMenu();
    // TOOL FIRST. A draw tool always draws, even when the drag starts on top of
    // an existing region — that is what makes it possible to open a window
    // inside fog, or lay fog over an already-revealed area. Only the select tool
    // hit-tests, so drawing can never be swallowed by whatever is underneath.
    if (fogToolEl.value !== 'select') { beginFogDraw(e); return; }

    // Hit-testing is done in JS against the geometry, not by SVG document order,
    // so overlaps resolve by the rule we chose: most recently created wins.
    //
    // Alt/Option forces a marquee. Without it, a scene that has been fully
    // covered has NO empty space left to start a marquee from — every point is
    // inside some region — and box-selection would become unreachable exactly
    // when a GM has the most regions to manage.
    const g = stageGrid(e);
    const picked = e.altKey ? null : fogPick(g.x, g.y);
    if (picked) {
      if (e.shiftKey) toggleFogSelected(picked.id);
      else if (!fogSelection.has(picked.id)) setFogSelection([picked.id]);
      // Clicking an already-selected region keeps the whole selection, so a
      // multi-region drag works the same way a multi-token drag does.
      beginFogMove(e);
      return;
    }
    // Empty space with the select tool: marquee.
    const r0 = stage.getBoundingClientRect();
    const sx0 = e.clientX - r0.left, sy0 = e.clientY - r0.top;
    marquee = { sx: sx0, sy: sy0, rect: r0 };
    marqueeEl.style.left = sx0 + 'px'; marqueeEl.style.top = sy0 + 'px';
    marqueeEl.style.width = '0px'; marqueeEl.style.height = '0px';
    marqueeEl.style.display = 'block';
    if (!e.shiftKey) setFogSelection([]);
    return;
  }
  if (e.target !== stage && e.target !== stageBg) return; // only empty space
  hideCtxMenu();
  const rect = stage.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  marquee = { sx, sy, rect };
  marqueeEl.style.left = sx + 'px'; marqueeEl.style.top = sy + 'px';
  marqueeEl.style.width = '0px'; marqueeEl.style.height = '0px';
  marqueeEl.style.display = 'block';
  if (!e.shiftKey) setSelection([]);
});
stage.addEventListener('pointermove', (e) => {
  if (fogMode && fogDraw) { updateFogDraw(e); return; }
  if (fogMode && fogMove) { updateFogMove(e); return; }
  if (!marquee) return;
  const x = e.clientX - marquee.rect.left, y = e.clientY - marquee.rect.top;
  const left = Math.min(x, marquee.sx), top = Math.min(y, marquee.sy);
  const w = Math.abs(x - marquee.sx), h = Math.abs(y - marquee.sy);
  marqueeEl.style.left = left + 'px'; marqueeEl.style.top = top + 'px';
  marqueeEl.style.width = w + 'px'; marqueeEl.style.height = h + 'px';
});
stage.addEventListener('pointerup', (e) => {
  // A shape being dragged out commits on release — the same "on drop" discipline
  // token movement uses, so a drag is one write and not a stream of them.
  if (fogMode && fogDraw) { commitFogDraw(); return; }
  if (fogMode && fogMove) { commitFogMove(e); return; }
  if (!marquee) return;
  const box = { left: parseFloat(marqueeEl.style.left), top: parseFloat(marqueeEl.style.top),
                w: parseFloat(marqueeEl.style.width), h: parseFloat(marqueeEl.style.height) };
  marqueeEl.style.display = 'none';
  marquee = null;
  if (box.w < 3 && box.h < 3) return;   // a click, not a drag
  suppressNextClear = true;

  // Fog marquee: bounding-box intersection. Approximate on purpose — a sweep
  // wants cheap and forgiving; the exact test belongs to a click (fogHitTest).
  if (fogMode) {
    const hits = [];
    for (const row of fog.values()) {
      const b = fogBBox(row);
      const intersects = px(b.x0) < box.left + box.w && px(b.x1) > box.left &&
                         px(b.y0) < box.top + box.h && px(b.y1) > box.top;
      if (intersects) hits.push(row.id);
    }
    for (const id of hits) fogSelection.add(id);
    renderFog();
    log(`marquee selected ${hits.length} region(s)`);
    return;
  }
  // A real drag just ended. The browser will now fire a `click` on #stage-bg
  // (pointerdown+pointerup on the same element), and the clear-selection handler
  // below would wipe the selection we are about to make. Suppress that one click.
  // (Set above, before the fog branch, so both paths are covered.)
  // Select tokens intersecting the rectangle that this client may move.
  const hits = [];
  for (const { row, el } of tokens.values()) {
    const tl = parseFloat(el.style.left), tt = parseFloat(el.style.top);
    const tw = parseFloat(el.style.width), th = parseFloat(el.style.height);
    const intersects = tl < box.left + box.w && tl + tw > box.left &&
                       tt < box.top + box.h && tt + th > box.top;
    if (intersects && canMoveRow(row)) hits.push(row.id);
  }
  for (const id of hits) selection.add(id);
  for (const entry of tokens.values()) entry.el.classList.toggle('selected', selection.has(entry.row.id));
  log(`marquee selected ${hits.length}`);
});
// Clicking empty space (no drag) clears selection. A click that is the tail of a
// marquee drag is skipped — otherwise it would immediately undo the selection
// the drag just made (#stage-bg spans the whole stage, so every marquee drag
// ends in a click on it).
stageBg.addEventListener('click', (e) => {
  if (suppressNextClear) { suppressNextClear = false; return; }
  if (e.target === stageBg) setSelection([]);
});

// --- context menu ---
stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // Record where the menu was opened, so a paste from the menu lands there
  // rather than wherever the pointer drifted afterwards.
  const rect = stage.getBoundingClientRect();
  cursorGrid = {
    x: Math.round((e.clientX - rect.left) / GRID_PX),
    y: Math.round((e.clientY - rect.top) / GRID_PX),
  };
  const tokenEl = e.target.closest('.token');
  if (fogMode) {
    // In fog mode the menu acts on regions. Right-clicking an unselected region
    // selects just it first, mirroring the token behaviour below.
    const g = stageGrid(e);
    const picked = fogPick(g.x, g.y);
    if (picked && !fogSelection.has(picked.id)) setFogSelection([picked.id]);
    if (fogSelection.size === 0) return;
    openFogCtxMenu(e.clientX, e.clientY);
    return;
  }
  if (tokenEl) {
    // Right-clicking a token not in the selection selects just it first.
    const id = [...tokens.entries()].find(([, en]) => en.el === tokenEl)?.[0];
    if (id && !selection.has(id)) setSelection([id]);
  }
  if (selection.size === 0) return;
  openCtxMenu(e.clientX, e.clientY);
});

function openCtxMenu(px, py) {
  ctxMenu.textContent = '';
  const gm = isGm();
  const sel = [...selection];

  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = `${sel.length} selected`;
  ctxMenu.appendChild(head);

  const item = (label, handler) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = label;
    d.addEventListener('click', () => { hideCtxMenu(); handler(); });
    ctxMenu.appendChild(d);
  };
  const sep = () => { const s = document.createElement('div'); s.className = 'sep'; ctxMenu.appendChild(s); };

  if (gm) {
    const sizeHead = document.createElement('div');
    sizeHead.className = 'head'; sizeHead.textContent = 'resize (5e)';
    ctxMenu.appendChild(sizeHead);
    for (const size of SIZE_PRESETS) item(`  ${size}`, () => resizeSelection(size));
    sep();
    item('hide', () => setFlagSelection('hidden', true));
    item('show', () => setFlagSelection('hidden', false));
    item('lock', () => setFlagSelection('locked', true));
    item('unlock', () => setFlagSelection('locked', false));
    sep();
    item('copy', copySelection);
    item('cut', cutSelection);
    item('duplicate', duplicateSelection);
    item('paste', pasteClipboard);
    item('delete', deleteSelection);
  } else {
    const note = document.createElement('div');
    note.className = 'head'; note.textContent = '(GM-only actions)';
    ctxMenu.appendChild(note);
  }

  ctxMenu.style.display = 'block';
  // Keep the menu on-screen.
  const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(px, window.innerWidth - w - 4) + 'px';
  ctxMenu.style.top = Math.min(py, window.innerHeight - h - 4) + 'px';
}
function hideCtxMenu() { ctxMenu.style.display = 'none'; }
document.addEventListener('click', (e) => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); });
document.addEventListener('scroll', hideCtxMenu, true);

// --- GM actions (HTTP; each broadcasts its own delta) ---
async function resizeSelection(size) {
  for (const id of [...selection]) {
    const r = await api('PATCH', `/api/campaigns/${campaignId}/scenes/${scene.id}/tokens/${id}`, { size });
    if (r.status !== 200) log(`resize ${id.slice(0, 8)} failed: ${r.data && r.data.error}`);
  }
  log(`resized ${selection.size} -> ${size}`);
}
async function setFlagSelection(flag, value) {
  for (const id of [...selection]) {
    const r = await api('PATCH', `/api/campaigns/${campaignId}/scenes/${scene.id}/tokens/${id}`, { [flag]: value });
    if (r.status !== 200) log(`${flag} ${id.slice(0, 8)} failed: ${r.data && r.data.error}`);
  }
  log(`${flag}=${value} on ${selection.size}`);
}
async function deleteSelection() {
  const ids = [...selection];
  if (ids.length === 0) return;
  const r = await api('POST', `/api/campaigns/${campaignId}/scenes/${scene.id}/tokens/batch-delete`,
    { token_ids: ids });
  show(`batch-delete -> ${r.status}`, r.data);
}
// Snapshot the fields a paste needs to recreate a token. Deliberately excludes
// id / created_by / scene_id — the server assigns those; a snapshot is data, not
// a reference to a row.
function snapshotToken(row) {
  return {
    name: row.name,
    img_url: row.img_url,
    width: Number(row.width),
    height: Number(row.height),
    hidden: !!row.hidden,
    // Kept only to preserve the shape of a multi-token selection on paste.
    x: Number(row.x),
    y: Number(row.y),
  };
}

function copySelection() {
  const snaps = [...selection].map((id) => tokens.get(id)).filter(Boolean).map((e) => snapshotToken(e.row));
  if (snaps.length === 0) return;
  clipboard = snaps;
  log(`copied ${snaps.length}`);
}

// Paste at the cursor. A multi-token paste keeps the group's relative layout:
// the top-left of the copied cluster lands under the pointer and the rest hold
// their offsets from it.
async function pasteClipboard() {
  if (clipboard.length === 0) return log('clipboard empty');
  const minX = Math.min(...clipboard.map((t) => t.x));
  const minY = Math.min(...clipboard.map((t) => t.y));
  const specs = clipboard.map((t) => ({
    name: t.name,
    img_url: t.img_url || undefined,
    width: t.width,
    height: t.height,
    hidden: t.hidden,
    x: cursorGrid.x + (t.x - minX),   // preserve relative layout
    y: cursorGrid.y + (t.y - minY),
  }));
  const r = await api('POST', `/api/campaigns/${campaignId}/scenes/${scene.id}/tokens/copy`, { tokens: specs });
  show(`paste -> ${r.status}`, { at: cursorGrid, count: r.data && r.data.tokens && r.data.tokens.length });
}

// Duplicate the current selection in place (Ctrl/Cmd+D). Unlike paste, this
// ignores the cursor and offsets +1/+1 from each original, and it does NOT touch
// the clipboard — so Ctrl+D never clobbers what you copied earlier.
async function duplicateSelection() {
  const rows = [...selection].map((id) => tokens.get(id)).filter(Boolean).map((e) => e.row);
  if (rows.length === 0) return;
  const specs = rows.map((row) => {
    const s = snapshotToken(row);
    return { ...s, img_url: s.img_url || undefined, x: s.x + 1, y: s.y + 1 };
  });
  const r = await api('POST', `/api/campaigns/${campaignId}/scenes/${scene.id}/tokens/copy`, { tokens: specs });
  show(`duplicate -> ${r.status}`, { count: r.data && r.data.tokens && r.data.tokens.length });
}

// Cut = snapshot to clipboard, then delete. Because the clipboard holds data
// rather than ids, the cut tokens remain pasteable after the originals are gone.
async function cutSelection() {
  if (selection.size === 0) return;
  copySelection();
  await deleteSelection();
}

// Select everything this client has authority over. For the GM that is every
// token in the scene (including hidden ones, which only the GM receives at all);
// for a player it is only the tokens they placed.
function selectAll() {
  const ids = [];
  for (const { row } of tokens.values()) if (canMoveRow(row)) ids.push(row.id);
  setSelection(ids);
  log(`selected all (${ids.length})`);
}

// ============================================================================
// FOG OF WAR (M3)
// ============================================================================
//
// THE RENDER RULE
//   fog = union(regions where revealed = false) - union(regions where revealed = true)
//
// It is a SET rule, not a layering rule, and that is what makes it legal in a
// schema with no z_index: the result does not depend on the order the regions
// were drawn in. It also collapses two mental models into one mechanism —
// "paint fog onto a clear map" and "cover the map, then punch windows" are the
// same operation, and toggling `revealed` is symmetric in both directions.
//
// It maps exactly onto an SVG mask: white shows, black hides. Start with a black
// rect (nothing painted), fill covered regions white, then fill revealed regions
// black on top. One dark rectangle masked by that is the fog.

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs) => {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};
const px = (n) => n * GRID_PX;

// Geometry is computed from the row data, never read back off the DOM: jsdom has
// no getBBox(), and more importantly the data is the source of truth.
function fogRadius(row) {
  const [c, rim] = row.points;
  return Math.hypot(rim.x - c.x, rim.y - c.y);
}
function fogBBox(row) {
  if (row.type === 'rect') {
    const [a, b] = row.points;
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }
  if (row.type === 'circle') {
    const [c] = row.points; const r = fogRadius(row);
    return { x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r };
  }
  const xs = row.points.map((p) => p.x), ys = row.points.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// Precise hit test for a click. Marquee selection uses bounding boxes instead
// (below) — the cheap approximation is the right one for a sweep, the exact test
// is the right one for a click.
function fogHitTest(row, gx, gy) {
  if (row.type === 'rect') {
    const [a, b] = row.points;
    return gx >= a.x && gx <= b.x && gy >= a.y && gy <= b.y;
  }
  if (row.type === 'circle') {
    const [c] = row.points;
    return Math.hypot(gx - c.x, gy - c.y) <= fogRadius(row);
  }
  // Ray casting for the polygon: count edge crossings on a ray heading +x.
  const pts = row.points;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    const straddles = (yi > gy) !== (yj > gy);
    if (straddles && gx < ((xj - xi) * (gy - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const translatePoints = (points, dx, dy) => points.map((p) => ({ x: p.x + dx, y: p.y + dy }));

// Build one SVG shape for a region, in pixels, with the given attributes.
function fogShape(row, attrs) {
  if (row.type === 'rect') {
    const [a, b] = row.points;
    return svgEl('rect', { x: px(a.x), y: px(a.y), width: px(b.x - a.x), height: px(b.y - a.y), ...attrs });
  }
  if (row.type === 'circle') {
    const [c] = row.points;
    return svgEl('circle', { cx: px(c.x), cy: px(c.y), r: px(fogRadius(row)), ...attrs });
  }
  return svgEl('polygon', { points: row.points.map((p) => `${px(p.x)},${px(p.y)}`).join(' '), ...attrs });
}

// Rebuild the whole overlay. Fog changes are rare (a GM drawing, not a token
// being dragged), so a full rebuild is simpler and cheap enough — there is no
// per-frame path here to optimise.
function renderFog() {
  // A move-drag transforms live nodes; rebuilding mid-gesture would detach the
  // very elements being dragged (and any socket delta could trigger that at any
  // moment). Defer instead, and replay once the drag commits.
  if (fogMove && fogMove.moved) { fogRenderPending = true; return; }

  fogLayer.textContent = '';
  fogNodes.clear();
  if (!scene) return;

  const editing = fogMode && isGm();
  const covered = [...fog.values()].filter((f) => !f.revealed);
  const revealed = [...fog.values()].filter((f) => f.revealed);

  const defs = svgEl('defs');
  const mask = svgEl('mask', { id: 'fog-mask' });
  // Black base: nothing is painted until a covered region says otherwise.
  mask.appendChild(svgEl('rect', { x: 0, y: 0, width: scene.width, height: scene.height, fill: 'black' }));
  const remember = (id, el) => {
    if (!fogNodes.has(id)) fogNodes.set(id, []);
    fogNodes.get(id).push(el);
    return el;
  };
  for (const f of covered) mask.appendChild(remember(f.id, fogShape(f, { fill: 'white' })));
  // Revealed regions punch back through, whatever order they were drawn in.
  for (const f of revealed) mask.appendChild(remember(f.id, fogShape(f, { fill: 'black' })));
  defs.appendChild(mask);
  fogLayer.appendChild(defs);

  // The GM sees through their own fog; players do not. This is a rendering
  // choice, NOT a security boundary: the scene image reaches every member
  // regardless, so fog conceals nothing that a player could not already fetch.
  const painted = svgEl('rect', {
    x: 0, y: 0, width: scene.width, height: scene.height,
    fill: '#0b0b12', 'fill-opacity': isGm() ? 0.55 : 1, mask: 'url(#fog-mask)',
  });
  painted.setAttribute('pointer-events', 'none');
  fogLayer.appendChild(painted);

  fogLayer.classList.toggle('editing', editing);
  fogLayer.classList.toggle('tool-select', editing && fogToolEl.value === 'select');
  if (editing) {
    // One transparent surface receives every pointer event. Which region a click
    // landed on is decided in JS by fogPick(), so overlapping regions resolve by
    // a rule we control (most recent wins) rather than by SVG document order.
    fogLayer.appendChild(svgEl('rect', {
      x: 0, y: 0, width: scene.width, height: scene.height, fill: 'transparent', class: 'fog-catch',
    }));
    for (const f of fog.values()) {
      const cls = 'fog-outline' + (f.revealed ? ' revealed' : '') + (fogSelection.has(f.id) ? ' selected' : '');
      const outline = fogShape(f, { class: cls });
      outline.setAttribute('pointer-events', 'none');
      fogLayer.appendChild(remember(f.id, outline));
    }
  }

  // In-progress drawing preview sits on top of everything.
  if (fogDraw) {
    const preview = previewRow();
    if (preview) {
      const p = fogShape(preview, { class: 'fog-preview' });
      p.setAttribute('pointer-events', 'none');
      fogLayer.appendChild(p);
    }
  }
  if (polyPoints.length) {
    for (const pt of polyPoints) {
      const dot = svgEl('circle', { cx: px(pt.x), cy: px(pt.y), r: 4, fill: '#6cf' });
      dot.setAttribute('pointer-events', 'none');
      fogLayer.appendChild(dot);
    }
  }
}

// Which region is under a point. Overlapping regions resolve by MOST RECENTLY
// CREATED, which is both what the GM sees on top and a rule derived from
// created_at — a column that already exists. It is deliberately not a z_index:
// the render rule is order-independent, and only this pick is ordered.
function fogPick(gx, gy) {
  const hits = [...fog.values()].filter((f) => fogHitTest(f, gx, gy));
  if (!hits.length) return null;
  hits.sort((a, b) => {
    const ta = +new Date(a.created_at || 0), tb = +new Date(b.created_at || 0);
    return ta === tb ? String(a.id).localeCompare(String(b.id)) : ta - tb;
  });
  return hits[hits.length - 1];
}

// The shape currently being dragged out, as a row-shaped object renderFog can
// draw. Returns null when the drag is still degenerate (a click, not a shape).
function previewRow() {
  if (!fogDraw) return null;
  const { tool, x0, y0, x1, y1 } = fogDraw;
  if (tool === 'rect') {
    if (x0 === x1 || y0 === y1) return null;
    return { type: 'rect', points: [{ x: Math.min(x0, x1), y: Math.min(y0, y1) },
      { x: Math.max(x0, x1), y: Math.max(y0, y1) }] };
  }
  if (x0 === x1 && y0 === y1) return null;
  return { type: 'circle', points: [{ x: x0, y: y0 }, { x: x1, y: y1 }] };
}

// --- fog selection ---
function setFogSelection(ids) {
  fogSelection.clear();
  for (const id of ids) fogSelection.add(id);
  renderFog();
}
function toggleFogSelected(id) {
  if (fogSelection.has(id)) fogSelection.delete(id); else fogSelection.add(id);
  renderFog();
}

// --- fog HTTP actions (structural writes; each broadcasts its own delta) ---
const fogUrl = () => `/api/campaigns/${campaignId}/scenes/${scene.id}/fog`;

async function createFog(type, points, revealed) {
  const r = await api('POST', fogUrl(), { type, points, revealed: !!revealed });
  if (r.status !== 201) log(`fog draw failed: ${r.data && r.data.error}`);
  else log(`+ fog ${type}${revealed ? ' (revealed)' : ''}`);
  return r;
}

async function toggleFogSelection() {
  const ids = [...fogSelection];
  if (!ids.length) return;
  for (const id of ids) {
    const row = fog.get(id);
    if (!row) continue;
    const r = await api('PATCH', `${fogUrl()}/${id}`, { revealed: !row.revealed });
    if (r.status !== 200) log(`fog toggle failed: ${r.data && r.data.error}`);
  }
  log(`toggled ${ids.length} region(s)`);
}

// Moving a region rewrites its points. Committed ON DROP / on keypress, over
// HTTP — fog is structural, so it never becomes a per-frame socket delta.
async function nudgeFogSelection(dx, dy) {
  for (const id of [...fogSelection]) {
    const row = fog.get(id);
    if (!row) continue;
    const r = await api('PATCH', `${fogUrl()}/${id}`, { points: translatePoints(row.points, dx, dy) });
    if (r.status !== 200) log(`fog move failed: ${r.data && r.data.error}`);
  }
}

async function deleteFogSelection() {
  const ids = [...fogSelection];
  if (!ids.length) return;
  const r = await api('POST', `${fogUrl()}/batch-delete`, { fog_ids: ids });
  show(`fog batch-delete -> ${r.status}`, r.data);
}

// Snapshots, not ids — the same reasoning as the token clipboard: a cut deletes
// the source rows, so a pointer to them could never be pasted.
const snapshotFog = (row) => ({ type: row.type, points: row.points.map((p) => ({ x: p.x, y: p.y })), revealed: !!row.revealed });

function copyFogSelection() {
  const snaps = [...fogSelection].map((id) => fog.get(id)).filter(Boolean).map(snapshotFog);
  if (!snaps.length) return;
  fogClipboard = snaps;
  log(`copied ${snaps.length} region(s)`);
}

// Paste at the cursor, preserving the cluster's relative layout — the top-left
// of the copied group's combined bounding box lands under the pointer.
async function pasteFogClipboard() {
  if (!fogClipboard.length) return log('fog clipboard empty');
  const boxes = fogClipboard.map(fogBBox);
  const minX = Math.min(...boxes.map((b) => b.x0));
  const minY = Math.min(...boxes.map((b) => b.y0));
  const regions = fogClipboard.map((f) => ({
    type: f.type,
    revealed: f.revealed,
    points: translatePoints(f.points, cursorGrid.x - minX, cursorGrid.y - minY),
  }));
  const r = await api('POST', `${fogUrl()}/copy`, { regions });
  show(`fog paste -> ${r.status}`, { at: cursorGrid, count: r.data && r.data.fog && r.data.fog.length });
}

async function duplicateFogSelection() {
  const rows = [...fogSelection].map((id) => fog.get(id)).filter(Boolean);
  if (!rows.length) return;
  const regions = rows.map((row) => ({ type: row.type, revealed: !!row.revealed, points: translatePoints(row.points, 1, 1) }));
  const r = await api('POST', `${fogUrl()}/copy`, { regions });
  show(`fog duplicate -> ${r.status}`, { count: r.data && r.data.fog && r.data.fog.length });
}

async function cutFogSelection() {
  if (!fogSelection.size) return;
  copyFogSelection();
  await deleteFogSelection();
}

function selectAllFog() {
  setFogSelection([...fog.keys()]);
  log(`selected all fog (${fog.size})`);
}

// --- fog drawing on the stage ---
// Only reached while fog mode is on; the token handlers return early in that
// case, so these two worlds never contend for the same gesture.
function stageGrid(e) {
  const rect = stage.getBoundingClientRect();
  return {
    x: Math.round((e.clientX - rect.left) / GRID_PX),
    y: Math.round((e.clientY - rect.top) / GRID_PX),
  };
}

const drawingRevealed = () => fogToolEl.value === 'reveal';

function beginFogDraw(e) {
  const shape = fogShapeEl.value;
  const g = stageGrid(e);
  if (shape === 'poly') {
    polyPoints.push(g);
    renderFog();
    return;
  }
  fogDraw = { tool: shape, x0: g.x, y0: g.y, x1: g.x, y1: g.y };
}

function updateFogDraw(e) {
  if (!fogDraw) return;
  const g = stageGrid(e);
  fogDraw.x1 = g.x; fogDraw.y1 = g.y;
  renderFog();
}

async function commitFogDraw() {
  const preview = previewRow();
  const revealed = drawingRevealed();
  fogDraw = null;
  if (!preview) { renderFog(); return; }
  await createFog(preview.type, preview.points, revealed);
  renderFog();
}

async function closePolygon() {
  const pts = polyPoints;
  polyPoints = [];
  if (pts.length < 3) { log('a polygon needs at least 3 points'); renderFog(); return; }
  await createFog('poly', pts, drawingRevealed());
  renderFog();
}

// --- moving a region with the mouse ---
// The nodes are transformed in place and the write happens ON DROP, so a drag is
// one PATCH per region rather than a stream of them — the same discipline token
// dragging uses. renderFog() is suppressed for the duration (see its guard).
function beginFogMove(e) {
  fogMove = { startX: e.clientX, startY: e.clientY, moved: false };
  stage.setPointerCapture(e.pointerId);
}

function updateFogMove(e) {
  if (!fogMove) return;
  const dx = e.clientX - fogMove.startX, dy = e.clientY - fogMove.startY;
  if (!fogMove.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;  // still a click
  fogMove.moved = true;
  // Snap the preview to whole grid squares so what you see is what gets sent.
  const sx = Math.round(dx / GRID_PX) * GRID_PX, sy = Math.round(dy / GRID_PX) * GRID_PX;
  for (const id of fogSelection) {
    for (const el of (fogNodes.get(id) || [])) el.setAttribute('transform', `translate(${sx},${sy})`);
  }
}

async function commitFogMove(e) {
  if (!fogMove) return;
  const { moved, startX, startY } = fogMove;
  fogMove = null;
  try { stage.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  if (!moved) return;                       // a click, not a drag
  const dx = Math.round((e.clientX - startX) / GRID_PX);
  const dy = Math.round((e.clientY - startY) / GRID_PX);
  if (dx === 0 && dy === 0) { renderFog(); return; }
  await nudgeFogSelection(dx, dy);
  // Any render suppressed during the drag happens now, once, with fresh rows.
  fogRenderPending = false;
  renderFog();
}

// --- fog panel wiring ---
// The ONLY way fog mode is entered or left. The checkbox, the F shortcut and
// fetchOwner() all funnel through here, so the GM-only gate exists in exactly
// one place and cannot be missed by a new call site. A player who forces this
// (or forges the checkbox in devtools) still lands on fogMode = false, and every
// fog write would be refused by the server regardless — this is convenience,
// not access control.
function setFogMode(on) {
  const next = !!on && isGm();
  fogMode = next;
  fogModeEl.checked = next;          // keeps the checkbox honest when F is used
  // Leaving fog mode drops any in-progress drawing and any fog selection, so the
  // two modes never hand state to each other.
  fogDraw = null; polyPoints = [];
  if (!next) fogSelection.clear();
  setSelection([]);
  hideCtxMenu();
  renderFog();
  log(next ? 'fog mode ON (tokens are not clickable)' : 'fog mode off');
}

fogModeEl.addEventListener('change', () => setFogMode(fogModeEl.checked));

fogToolEl.addEventListener('change', () => {
  // Switching tool abandons any half-drawn shape rather than carrying it over.
  fogDraw = null; polyPoints = [];
  renderFog();
});

document.getElementById('fog-cover-all').addEventListener('click', async () => {
  if (!scene) return show('open a scene first');
  const cols = scene.width / GRID_PX, rows = scene.height / GRID_PX;
  await createFog('rect', [{ x: 0, y: 0 }, { x: cols, y: rows }], false);
});

document.getElementById('fog-clear-all').addEventListener('click', async () => {
  if (!scene) return show('open a scene first');
  const r = await api('POST', `${fogUrl()}/batch-delete`, { all: true });
  show(`clear all fog -> ${r.status}`, r.data);
});

// --- fog context menu ---
function openFogCtxMenu(px_, py_) {
  ctxMenu.textContent = '';
  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = `${fogSelection.size} region(s)`;
  ctxMenu.appendChild(head);
  const item = (label, handler) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = label;
    d.addEventListener('click', () => { hideCtxMenu(); handler(); });
    ctxMenu.appendChild(d);
  };
  const sep = () => { const s = document.createElement('div'); s.className = 'sep'; ctxMenu.appendChild(s); };

  item('toggle cover / reveal', toggleFogSelection);
  sep();
  item('copy', copyFogSelection);
  item('cut', cutFogSelection);
  item('duplicate', duplicateFogSelection);
  item('paste', pasteFogClipboard);
  item('delete', deleteFogSelection);

  ctxMenu.style.display = 'block';
  const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(px_, window.innerWidth - w - 4) + 'px';
  ctxMenu.style.top = Math.min(py_, window.innerHeight - h - 4) + 'px';
}

// Fog keyboard handling. Returns true when it consumed the event, so the token
// handler below can bail out and stay exactly as it was.
function fogKeydown(e) {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (e.key === 'Enter' && polyPoints.length) { e.preventDefault(); closePolygon(); return true; }
  if (e.key === 'Escape') {
    if (ctxMenu.style.display === 'block') hideCtxMenu();
    else if (polyPoints.length || fogDraw) { polyPoints = []; fogDraw = null; renderFog(); }
    else setFogSelection([]);
    return true;
  }
  if (mod && key === 'a') { e.preventDefault(); selectAllFog(); return true; }
  if (mod && key === 'v') { e.preventDefault(); pasteFogClipboard(); return true; }

  if (fogSelection.size === 0) return true;   // consumed: fog mode owns the keys

  const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  if (arrows[e.key]) {
    e.preventDefault();
    const step = e.shiftKey ? BIG_NUDGE : 1;
    const [dx, dy] = arrows[e.key];
    nudgeFogSelection(dx * step, dy * step);
    return true;
  }
  if (key === 't') { e.preventDefault(); toggleFogSelection(); return true; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteFogSelection(); return true; }
  if (mod && key === 'c') { copyFogSelection(); return true; }
  if (mod && key === 'x') { e.preventDefault(); cutFogSelection(); return true; }
  if (mod && key === 'd') { e.preventDefault(); duplicateFogSelection(); return true; }
  return true;
}

// ============================================================================

// --- keyboard ---
// Shortcut order matters: the ones that must work with NOTHING selected
// (select-all, escape) are handled before the "needs a selection" guard.
const BIG_NUDGE = 5;   // squares moved per Shift+arrow

document.addEventListener('keydown', (e) => {
  // Never hijack typing in a form field.
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (!scene) return;

  // F toggles fog mode — GM ONLY. Handled BEFORE the fog branch below so it
  // works symmetrically in both directions; inside fogKeydown() it would only
  // ever be reachable while fog mode was already on, and there would be no way
  // back in from the keyboard. Bare F rather than Ctrl/Cmd+F, which is the
  // browser's find; it sits alongside T the same way.
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'f') {
    if (!isGm()) return;             // a player gets nothing at all from F
    e.preventDefault();
    setFogMode(!fogMode);
    return;
  }

  // Fog mode gets first refusal and consumes everything, so no fog keystroke can
  // fall through and move a token instead. With fog mode off this line is a
  // no-op and the token handling below is exactly what it always was.
  if (fogMode && fogKeydown(e)) return;

  const mod = e.ctrlKey || e.metaKey;   // Ctrl on Win/Linux, Cmd on macOS
  const key = e.key.toLowerCase();

  // --- work regardless of whether anything is selected ---

  // Escape: close the context menu if open, else clear the selection.
  if (e.key === 'Escape') {
    if (ctxMenu.style.display === 'block') hideCtxMenu();
    else setSelection([]);
    return;
  }

  // Ctrl/Cmd+A — select everything this client may move.
  if (mod && key === 'a') {
    e.preventDefault();          // don't select the page's text
    selectAll();
    return;
  }

  // Ctrl/Cmd+V — paste works with an empty selection (the clipboard is the input).
  if (mod && key === 'v' && isGm()) { e.preventDefault(); pasteClipboard(); return; }

  // --- everything below needs a selection ---
  if (selection.size === 0) return;

  // Arrows nudge; Shift+arrow nudges further.
  const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  if (arrows[e.key]) {
    e.preventDefault();          // don't scroll the page
    const step = e.shiftKey ? BIG_NUDGE : 1;
    const [dx, dy] = arrows[e.key];
    const moves = movableSelection().map(({ row }) => ({
      token_id: row.id, x: Number(row.x) + dx * step, y: Number(row.y) + dy * step,
    }));
    if (moves.length === 1) emitMove(moves[0]);
    else if (moves.length > 1) emitMoveBatch(moves);
    return;
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && isGm()) {
    e.preventDefault();          // Backspace would otherwise navigate back
    deleteSelection();
    return;
  }
  if (mod && key === 'c' && isGm()) { copySelection(); return; }
  if (mod && key === 'x' && isGm()) { e.preventDefault(); cutSelection(); return; }
  if (mod && key === 'd' && isGm()) { e.preventDefault(); duplicateSelection(); return; }
});

// --- socket wiring ---
const socket = io({ withCredentials: true });
socket.on('connect', () => log(`socket connected (${socket.id})`));
socket.on('unauthorized', (d) => log(`UNAUTHORIZED: ${d.error} — log in first`));
socket.on('disconnect', (r) => log(`socket disconnected: ${r}`));
socket.on('campaign:evicted', (d) => log(`EVICTED from ${d.campaign_id} (${d.reason})`));

socket.on('token:created', (t) => {
  if (!scene || t.scene_id !== scene.id) return;
  log(`+ token ${t.name || '(token)'}`);
  upsertToken(t);
});
socket.on('token:updated', (t) => {
  if (!scene || t.scene_id !== scene.id) return;
  upsertToken(t);
});
socket.on('token:moved', (t) => {
  if (!scene || t.scene_id !== scene.id) return;
  upsertToken(t);
});
socket.on('token:moved-batch', (d) => {
  if (!scene || !d.tokens) return;
  for (const t of d.tokens) if (t.scene_id === scene.id) upsertToken(t);
});
socket.on('token:deleted', (d) => {
  if (d.id) { removeToken(d.id); log('- token removed'); }
});
socket.on('token:deleted-batch', (d) => {
  if (!d.ids) return;
  for (const id of d.ids) removeToken(id);
  log(`- ${d.ids.length} token(s) removed`);
});

// --- fog deltas ---
// Fog is broadcast to the whole room, GM and players alike: a player has to draw
// the fog, so the geometry they receive is exactly the geometry rendered on
// their screen. (Contrast token:updated for a hidden token, which players never
// receive at all — that one IS a confidentiality boundary.)
socket.on('fog:created', (f) => {
  if (!scene || f.scene_id !== scene.id) return;
  fog.set(f.id, f);
  renderFog();
  log(`+ fog ${f.type}${f.revealed ? ' (revealed)' : ''}`);
});
socket.on('fog:updated', (f) => {
  if (!scene || f.scene_id !== scene.id) return;
  fog.set(f.id, f);
  renderFog();
});
socket.on('fog:deleted', (d) => {
  if (!d.id) return;
  fog.delete(d.id); fogSelection.delete(d.id);
  renderFog();
  log('- fog region removed');
});
socket.on('fog:deleted-batch', (d) => {
  if (!d.ids) return;
  for (const id of d.ids) { fog.delete(id); fogSelection.delete(id); }
  renderFog();
  log(`- ${d.ids.length} fog region(s) removed`);
});

// GM-only: a player never hears about scenes they cannot open. If the deleted
// scene was the active one, players are told separately via scene:activated.
socket.on('scene:deleted', (d) => {
  if (!campaignId || d.campaign_id !== campaignId) return;
  if (scene && scene.id === d.id) closeScene('this scene was deleted');
  lastSceneList = lastSceneList.filter((x) => x.id !== d.id);
  renderSceneList(lastSceneList);
  log('a scene was deleted');
});

// The GM runs the board: when they set the active scene, every client follows.
socket.on('scene:activated', (d) => {
  if (!campaignId || d.campaign_id !== campaignId) return;
  activeSceneId = d.scene_id || null;

  // The GM is only INFORMED — they may be prepping another map and must not be
  // yanked out of it by their own activation. Players are MOVED: the server has
  // already stopped serving them anything else.
  if (isGm()) {
    log(d.scene_id ? 'active scene changed' : 'active scene cleared');
    renderSceneList(lastSceneList);
    return;
  }
  if (!d.scene_id) { closeScene('the GM closed the scene'); renderSceneList([]); return; }
  if (scene && scene.id === d.scene_id) return;   // already here
  log('GM switched the active scene — following');
  openScene(d.scene_id);
  renderSceneList([]);
});

function joinRoom() {
  socket.emit('campaign:join', { campaign_id: campaignId }, (ack) => {
    joinedRoom = !!(ack && ack.ok);
    log(joinedRoom ? `joined room campaign:${campaignId}` : `join failed: ${ack && ack.error}`);
    if (joinedRoom) fetchOwner();
  });
}
async function fetchOwner() {
  const r = await api('GET', `/api/campaigns/${campaignId}`);
  if (r.status === 200) {
    currentCampaignOwnerId = r.data.campaign.owner_id;
    activeSceneId = r.data.campaign.active_scene_id || null;
  }
  for (const entry of tokens.values()) paintToken(entry);
  // The fog panel is GM-only, and fog opacity depends on GM-ness (the GM sees
  // through their own fog), so both wait until ownership is known. A player who
  // forced the panel visible would still be refused by the server on every
  // write — this is convenience, not access control.
  fogPanel.classList.toggle('hidden-panel', !isGm());
  if (!isGm()) setFogMode(false);
  renderFog();
}

whoami();
