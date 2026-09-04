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
  const out = { status: res.status, data };
  // Surface a closed-campaign refusal wherever it happens, rather than leaving
  // the page to render nothing and look broken. Hooked into api() rather than
  // into each caller because EVERY request can hit it — the gate is on the
  // whole game surface, so a per-caller check would be a list to keep complete.
  if (window.VTTClosedNotice) {
    if (!window.VTTClosedNotice.check(out) && res.status < 400) window.VTTClosedNotice.hide();
  }
  return out;
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
// The same position UNROUNDED, in fractional grid units.
//
// cursorGrid is deliberately snapped — a pasted token belongs in a square, and
// every existing consumer wants that. A ping does not: it marks the spot the
// person pointed at, and rounding it to a square moves the mark by up to half a
// cell from where they clicked. So both are recorded and each consumer takes
// the one it means.
let cursorPoint = { x: 0, y: 0 };
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
let fogClickCandidate = null;      // region under a fog-draw press; if the press
                                   // turns out to be a click (no drag), it is
                                   // selected instead of drawing a zero-size shape
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
// Seam: the harness supplies the campaign id through the #campaign-id input and
// the "Load scenes" button; the game shell supplies it through boot(id). The
// wiring is guarded so binding does not throw on a page (game.html, the jsdom
// suite's shell) that has no such input/button.
{
  const _loadBtn = document.getElementById('load-scenes');
  const _cidInput = document.getElementById('campaign-id');
  if (_loadBtn) {
    _loadBtn.addEventListener('click', () => {
      // Harness: the id comes from the #campaign-id input. Game page: the input
      // is gone, the button is the Scenes-modal refresh, and campaignId is
      // already set by boot() — so only re-read when the input is present.
      if (_cidInput) campaignId = _cidInput.value.trim();
      if (campaignId) loadScenes();
    });
  }
}
// The game shell's entry point: set the campaign id (bypassing the dead input)
// then run the file's existing scene-load body unchanged.
function boot(id) {
  campaignId = id;
  return loadScenes();
}
async function loadScenes() {
  if (!campaignId) return;
  // Ownership decides what this list even means, so settle it before rendering.
  await fetchOwner();
  const r = await api('GET', `/api/campaigns/${campaignId}/scenes`);
  show(`GET scenes -> ${r.status}`, r.data);
  lastSceneList = r.status === 200 ? r.data.scenes : [];
  renderSceneList(lastSceneList);
  if (!joinedRoom) joinRoom();

  updateCanvasEmpty();

  // Everyone lands on the active scene automatically when the game opens.
  // Players never choose a scene — the server only sent them the active one.
  // The GM previously got just the list and a blank canvas; now the GM also
  // opens straight onto the active scene (they can still open others from the
  // Scenes modal). If nothing is active, the canvas shows an empty state.
  if (!scene) {
    if (activeSceneId) {
      openScene(activeSceneId);
    } else {
      closeScene(isGm()
        ? (lastSceneList.length ? 'no scene is active yet — open one from Scenes' : '')
        : 'the GM has not opened a scene yet');
    }
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
    const note = document.createElement('p');
    note.className = 'scenes-empty';
    note.textContent = activeSceneId
      ? 'The GM controls which scene is open.'
      : 'Waiting for the GM to open a scene…';
    box.appendChild(note);
    return;
  }
  if (!scenes.length) {
    const note = document.createElement('p');
    note.className = 'scenes-empty';
    note.textContent = 'No scenes yet — create one above.';
    box.appendChild(note);
    return;
  }
  for (const sc of scenes) {
    const isActive = sc.id === activeSceneId;
    const isOpen = scene && sc.id === scene.id;

    // A scene TILE: the map fills it as a background, the name sits on a scrim at
    // the bottom, badges mark active/open state, and a compact action bar runs
    // along the very bottom. The map is the anchor — a GM scans by picture.
    const tile = document.createElement('div');
    tile.className = 'scene-tile' + (isActive ? ' is-active' : '');

    // The map (or a placeholder). img_url is normalised http(s) by the server,
    // so it is safe to embed in a CSS url().
    const art = document.createElement('div');
    art.className = 'scene-art';
    if (sc.img_url) {
      art.style.backgroundImage = 'url("' + sc.img_url + '")';
    } else {
      art.classList.add('no-map');
      art.textContent = 'No map yet';
    }
    tile.appendChild(art);

    // State badge (top-left), always visible while scanning.
    if (isActive || (isOpen && !isActive)) {
      const badge = document.createElement('span');
      badge.className = 'scene-badge ' + (isActive ? 'active' : 'open');
      badge.textContent = isActive ? 'Active' : 'Open';
      badge.title = isActive
        ? 'Every player is on this scene'
        : 'You have this scene loaded (players are not here)';
      tile.appendChild(badge);
    }

    // Name on a bottom scrim, readable over any map.
    const name = document.createElement('div');
    name.className = 'scene-tile-name';
    name.textContent = sc.name;
    name.title = sc.name;
    tile.appendChild(name);

    // Action bar along the bottom edge. Weighted: Open (quiet) · Activate
    // (primary, moves everyone) · Delete (danger). On their own bar so they're
    // reachable on touch and never triggered by an accidental tile click.
    const actions = document.createElement('div');
    actions.className = 'scene-tile-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn small secondary';
    openBtn.textContent = 'Open';
    openBtn.title = 'Load this scene for you only — players are not moved';
    openBtn.addEventListener('click', () => openScene(sc.id));
    actions.appendChild(openBtn);

    const actBtn = document.createElement('button');
    actBtn.type = 'button';
    actBtn.className = 'btn small primary';
    actBtn.textContent = isActive ? 'Active' : 'Activate';
    actBtn.disabled = isActive;
    actBtn.title = 'Make this the active scene — every player is moved here';
    actBtn.addEventListener('click', () => activateScene(sc.id));
    actions.appendChild(actBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn small danger scene-del';
    delBtn.setAttribute('aria-label', 'Delete scene');
    delBtn.title = 'Permanently delete this scene, its tokens and its fog';
    // Minimalist line-icon trash can (same stroke style as the toolbar icons);
    // currentColor so it follows the button's danger colour and flips on hover.
    const delSvg = svgEl('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    });
    delSvg.appendChild(svgEl('path', { d: 'M4 7h16' }));                         // lid line
    delSvg.appendChild(svgEl('path', { d: 'M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1z' })); // handle
    delSvg.appendChild(svgEl('path', { d: 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13' })); // can body
    delSvg.appendChild(svgEl('path', { d: 'M10 11v6M14 11v6' }));                // ribs
    delBtn.appendChild(delSvg);
    delBtn.addEventListener('click', () => deleteScene(sc));
    actions.appendChild(delBtn);

    tile.appendChild(actions);
    box.appendChild(tile);
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
  const active = sc.id === activeSceneId
    ? ' This is the active scene — every player will be dropped out of it.' : '';
  const body = `This permanently removes the scene and ${blast}. It cannot be undone.${active}`;

  // Use the shared themed confirm dialog (same as the dashboard's "Delete this
  // game?"), not the browser's window.confirm. The delete runs on confirm.
  const runDelete = async () => {
    const r = await api('DELETE', `/api/campaigns/${campaignId}/scenes/${sc.id}`);
    show(`delete scene -> ${r.status}`, r.data);
    if (r.status !== 200) return;
    log(`deleted "${sc.name}" (${r.data.deleted.tokens} tokens, ${r.data.deleted.fog} fog regions)`);
    if (scene && scene.id === sc.id) closeScene('scene deleted');
    if (r.data.was_active) activeSceneId = null;
    await loadScenes();
  };
  if (window.VTTGame && typeof window.VTTGame.confirm === 'function') {
    window.VTTGame.confirm(`Delete "${sc.name}"?`, body, true, runDelete);
  } else if (window.confirm(`Delete "${sc.name}"?\n\n${body}`)) {
    await runDelete();
  }
}

// Tear the canvas down — used when a player's scene stops being the active one.
function closeScene(reason) {
  scene = null;
  for (const { el } of tokens.values()) el.remove();
  tokens.clear(); selection.clear();
  fog.clear(); fogSelection.clear();
  fogLayer.textContent = '';
  document.getElementById('scene-title').textContent = reason ? `— ${reason}` : '';
  updateCanvasEmpty();
  log(reason || 'scene closed');
}

// The empty-canvas prompt ("No scenes yet — create one") shows only for a GM
// who has NO scenes at all and no scene open. Any scene existing or open hides
// it. Players never see it (it's gm-only in markup and guarded here too).
function updateCanvasEmpty() {
  const el = document.getElementById('canvasEmpty');
  if (!el) return;
  const show = isGm() && !scene && lastSceneList.length === 0;
  if (show) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
}

document.getElementById('create-scene').addEventListener('click', async () => {
  // Seam: read the harness's #campaign-id input when present; on the game page
  // the input is gone and campaignId is already set by boot(), so keep it.
  const _cid = document.getElementById('campaign-id');
  if (_cid) campaignId = _cid.value.trim();
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
  updateCanvasEmpty();
  centerView();   // frame the map in the middle of the canvas on load
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
// How far the grid reaches past the map image, in whole squares.
//
// A WHOLE NUMBER of squares, deliberately: the pad element starts at
// -PAD_SQUARES * GRID_PX, so a multiple keeps its background lines on the same
// lattice as the stage origin. A pad of, say, 470px would draw a grid half a
// square out of step with the one over the image, which is the sort of thing
// nobody notices until they try to line a token up across the seam.
const PAD_SQUARES = 12;
const PAD_PX = PAD_SQUARES * GRID_PX;

function applyGridOverlay() {
  const grid = (scene && scene.grid) || {};
  const pad = document.getElementById('grid-pad');

  // Sized and placed here rather than in the stylesheet, because it depends on
  // the scene's dimensions and those are only known once a scene has loaded.
  if (scene) {
    pad.style.left = -PAD_PX + 'px';
    pad.style.top = -PAD_PX + 'px';
    pad.style.width = (scene.width + PAD_PX * 2) + 'px';
    pad.style.height = (scene.height + PAD_PX * 2) + 'px';
  }

  if (grid.type === 'none') {
    pad.style.backgroundImage = 'none';
    return;
  }
  const color = grid.color || '#3a3a3a';
  pad.style.backgroundImage =
    `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`;
  pad.style.backgroundSize = `${GRID_PX}px ${GRID_PX}px`;
  pad.style.opacity = grid.opacity === undefined ? '' : String(grid.opacity);
  // The grid used to live on #stage itself, which is why it stopped at the
  // image. Cleared so the two cannot both draw.
  stage.style.backgroundImage = 'none';
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

// Highlight one token on the canvas as the active turn (or clear, with null).
// combat.js calls this so the creature whose turn it is is obvious on the board,
// not only in the strip. Purely visual — no state, no server call.
function highlightToken(tokenId) {
  for (const [id, entry] of tokens) {
    entry.el.classList.toggle('is-turn', !!tokenId && id === tokenId);
  }
}

// ── Token-picking mode (Stage D) ────────────────────────────────────────────
// Dim the canvas (everything but the tokens) and let the GM click tokens to
// choose them, then confirm or cancel. combat.js uses this to add combatants:
// "start an encounter with these" and "add these". Options:
//   { exclude: Set<id>, hint: string, confirmLabel: string }
// exclude = tokens already in the fight — shown dimmed and NOT selectable.
// Resolves via onDone(idsArray) on confirm, or onDone(null) on cancel.
let pickState = null;   // { chosen:Set, exclude:Set, onDone } while active

function pickTokens(options, onDone) {
  if (!isGm()) { onDone && onDone(null); return; }
  if (pickState) endPick(null);   // never stack two pickers
  const exclude = options && options.exclude ? options.exclude : new Set();
  pickState = { chosen: new Set(), exclude, onDone: onDone || null };

  // Dim overlay: a scrim INSIDE #stage (same stacking context as the tokens,
  // which is a transformed element), above the map but below the tokens, so the
  // selectable tokens sit at full brightness over the dimmed map.
  const stage = document.getElementById('stage');
  let dim = document.getElementById('pick-dim');
  if (!dim) {
    dim = document.createElement('div');
    dim.id = 'pick-dim';
    stage.appendChild(dim);
  }
  dim.hidden = false;
  const wrap = document.getElementById('stage-wrap');
  wrap.classList.add('picking');   // raises tokens above the scrim + shows rings

  // Mark excluded tokens as non-selectable/dimmed.
  for (const [id, entry] of tokens) {
    entry.el.classList.toggle('pick-excluded', exclude.has(id));
    entry.el.classList.remove('pick-on');
  }

  // Confirm / cancel bar.
  let bar = document.getElementById('pick-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pick-bar';
    document.body.appendChild(bar);
  }
  const hint = (options && options.hint) || 'Click tokens to add them to the encounter.';
  const confirmLabel = (options && options.confirmLabel) || 'Add selected';
  bar.textContent = '';
  const msg = document.createElement('span');
  msg.className = 'pick-hint';
  msg.textContent = hint;
  const count = document.createElement('span');
  count.className = 'pick-count';
  count.id = 'pick-count';
  count.textContent = '0 selected';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn small secondary';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => endPick(null));
  const done = document.createElement('button');
  done.type = 'button'; done.className = 'btn small primary';
  done.textContent = confirmLabel;
  done.addEventListener('click', () => {
    const ids = [...pickState.chosen];
    endPick(ids);
  });
  bar.appendChild(msg); bar.appendChild(count); bar.appendChild(cancel); bar.appendChild(done);
  bar.hidden = false;

  // Capture-phase pointerdown on the stage: while picking, a click on a token
  // TOGGLES it (and never starts a drag); a click on empty space does nothing.
  wrap.addEventListener('pointerdown', pickPointer, true);
  // Esc cancels.
  document.addEventListener('keydown', pickKey, true);
}

function pickPointer(e) {
  if (!pickState) return;
  // Find the token element under the pointer, if any.
  let node = e.target;
  let tokenEl = null;
  while (node && node !== document) {
    if (node.classList && node.classList.contains('token')) { tokenEl = node; break; }
    node = node.parentNode;
  }
  if (!tokenEl) return;                 // empty space: let pan happen? no — swallow to avoid surprises
  e.preventDefault(); e.stopPropagation();
  // Which id is this element?
  let id = null;
  for (const [tid, entry] of tokens) { if (entry.el === tokenEl) { id = tid; break; } }
  if (!id || pickState.exclude.has(id)) return;   // excluded tokens aren't selectable
  if (pickState.chosen.has(id)) { pickState.chosen.delete(id); tokenEl.classList.remove('pick-on'); }
  else { pickState.chosen.add(id); tokenEl.classList.add('pick-on'); }
  const c = document.getElementById('pick-count');
  if (c) c.textContent = `${pickState.chosen.size} selected`;
}

function pickKey(e) {
  if (!pickState) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endPick(null); }
}

function endPick(result) {
  if (!pickState) return;
  const onDone = pickState.onDone;
  const wrap = document.getElementById('stage-wrap');
  wrap.classList.remove('picking');
  wrap.removeEventListener('pointerdown', pickPointer, true);
  document.removeEventListener('keydown', pickKey, true);
  const dim = document.getElementById('pick-dim'); if (dim) dim.hidden = true;
  const bar = document.getElementById('pick-bar'); if (bar) bar.hidden = true;
  for (const [, entry] of tokens) { entry.el.classList.remove('pick-on', 'pick-excluded'); }
  pickState = null;
  if (onDone) onDone(result);
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
    o.dataset.name = a.name;   // raw name, for numbering multiples ("Frog 2"...)
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

  // The base used to number multiples. A typed name wins; otherwise, when a
  // character is chosen, fall back to that character's OWN name (read from the
  // picker option) so a pile placed from one character still comes out
  // "Frog", "Frog 2", "Frog 3"… rather than five identical "Frog"s. Single
  // placement and inheritance are unaffected — this only feeds the numbering.
  let numberBase = name;
  if (!numberBase && actorId) {
    const optEl = document.querySelector('#tok-actor option[value="' + (window.CSS && CSS.escape ? CSS.escape(actorId) : actorId) + '"]');
    if (optEl && optEl.dataset && optEl.dataset.name) numberBase = optEl.dataset.name;
  }

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

  // Bulk placement inherits per spec, on the same absence rule. Numbering now
  // uses numberBase — a typed name, or the character's own name when none was
  // typed — so a pile placed from one character is individually referable
  // ("Frog", "Frog 2"…). Sending an explicit name also means the server keeps
  // it rather than re-filling the character's bare name on every token.
  const offsets = packOffsets(count, footprint);
  const specs = offsets.map((o, i) => {
    const spec = { hidden: false, x: origin.x + o.dx, y: origin.y + o.dy };
    if (actorId) spec.actor_id = actorId;
    if (numberBase) spec.name = instanceName(numberBase, i);
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
    // Right button: NOT this token's business. It either opens the context menu
    // or starts a marquee, and both of those live on the stage — so the event
    // is left to bubble rather than stopped here.
    //
    // [CHANGED 2026-08-10] This used to return before stopPropagation, which
    // happened to be correct when the marquee was on the left button and became
    // wrong when it moved: a right-drag beginning on top of a token reached the
    // stage listener only by luck of ordering. Stating it as "the right button
    // belongs to the stage" makes the behaviour intentional.
    if (e.button === 2) return;
    const entry = tokens.get(tokenId);
    if (!entry) return;
    e.stopPropagation();                    // a left drag here is a token drag, not a pan

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
    // Screen movement divided by the zoom, because `style.left` is a STAGE
    // coordinate and the stage is scaled. Without it, dragging at 200% moved a
    // token twice as far as the pointer went, and at 50% half as far.
    //
    // The `moved` threshold stays in SCREEN pixels: "did the user's hand move"
    // is a question about the pointer, not about the map, and a three-pixel
    // twitch should not become a drag just because the map is zoomed in.
    const sdx = e.clientX - startX, sdy = e.clientY - startY;
    if (Math.abs(sdx) > 2 || Math.abs(sdy) > 2) moved = true;
    const dx = sdx / view.z, dy = sdy / view.z;
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
  cursorGrid = stageGrid(e);
  const cp = stagePoint(e);
  cursorPoint = { x: cp.x / GRID_PX, y: cp.y / GRID_PX };
}, true);

// --- pan, zoom, and the right-drag marquee -----------------------------------
//
// The WRAPPER is the viewport and the STAGE is the world: panning and zooming
// transform the stage, and the wrapper stays put. That choice is what made this
// cheap — every coordinate conversion in this file already goes through
// stage.getBoundingClientRect(), which returns POST-TRANSFORM screen
// coordinates, so token placement, marquee hit-testing and fog picking all
// keep working with no arithmetic changes at all.
//
// Ten call sites, 134 assertions, and none of them had to move.
const wrap = document.getElementById('stage-wrap');
const zoomHud = document.getElementById('zoom-hud');

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

// The zoom a focus ping imposes, unless the GM is already closer than this.
//
// [ADDED 2026-08-10] A focus ping that keeps the current zoom can be a NO-OP,
// and was: with a 1400px scene in a 1400px viewport there is no slack at 100%,
// so the clamp centres the map and centreOn's result is discarded entirely.
// Focus looked identical to a normal ping — correctly, because there was
// nothing to move.
//
// Zooming in is what creates the room. At 200% the map is twice the viewport,
// so there is a full viewport of slack and the pinged point can actually be
// brought to the middle. This is the "force zoom" half of the feature rather
// than an arbitrary preference: without it, focus only works on maps that
// happen to be larger than the window.
const FOCUS_ZOOM = 2;
const view = { x: 0, y: 0, z: 1 };

// [REMOVED 2026-08-10] `rightDragMoved` used to live here.
//
// It existed to suppress the context menu at the end of a right-drag, and it
// worked in every probe and in no browser: on macOS `contextmenu` arrives with
// the mouse DOWN, before any movement, so the flag was always false when it was
// read. The menu opened at the start of every marquee.
//
// The menu is now opened from the RELEASE, where the marquee's own size already
// says whether the gesture was a click or a drag. Nothing has to be tracked, so
// nothing can be tracked wrongly — the flag is gone rather than corrected.

// Keep the map inside the viewport.
//
// [ADDED 2026-08-10] Nothing constrained the pan, so the map could be dragged —
// or FOCUSED — into a position where most of the viewport was empty
// background. Focusing a ping near the left edge of a map slid it right until a
// third of the screen was black and six hundred pixels of map hung off the
// other side. The ping was still dead centre, which is why it read as "the
// camera is offset" rather than as "the ping is wrong": the centring was exact
// and the framing was absurd.
//
// The rule is the ordinary one for maps:
//   larger than the viewport  -> no empty edge is allowed; pan up to the edges
//   smaller than the viewport -> centred, and it stays centred
//
// Applied in applyView rather than at each call site, so panning, zooming and
// focusing are all constrained by one function — three callers with three
// copies of a clamp is how they drift apart.
function clampView() {
  if (!scene) return;
  // clientWidth, not getBoundingClientRect().width: the content box is where
  // the stage actually sits, and the border is what made the centring land one
  // pixel out.
  const vw = wrap.clientWidth;
  const vh = wrap.clientHeight;

  // The pannable world is the image PLUS the pad on every side, so the clamp
  // stops at the edge of the grid rather than at the edge of the picture. This
  // is what gives the overshoot room, and it is the same rule as before applied
  // to a larger rectangle rather than a second rule bolted alongside it.
  //
  // The world starts at stage-local -PAD_PX, not 0, so the upper bound on
  // view.x is PAD_PX * z rather than 0 — the map may be pushed right until the
  // grid's left edge reaches the viewport's, and no further.
  const sw = (scene.width + PAD_PX * 2) * view.z;
  const sh = (scene.height + PAD_PX * 2) * view.z;
  const originX = PAD_PX * view.z;
  const originY = PAD_PX * view.z;

  view.x = sw <= vw
    ? (vw - sw) / 2 + originX
    : Math.min(originX, Math.max(vw - sw + originX, view.x));
  view.y = sh <= vh
    ? (vh - sh) / 2 + originY
    : Math.min(originY, Math.max(vh - sh + originY, view.y));
}

function applyView() {
  clampView();
  stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  if (zoomHud) zoomHud.textContent = `${Math.round(view.z * 100)}%`;
}

// Centre the map in the viewport at the current zoom. clampView already centres a
// map SMALLER than the viewport, but a larger one is otherwise clamped to its
// top-left corner on load; this sets the pan so the middle of the map sits in the
// middle of the canvas, then applyView() clamps it (which is a no-op when already
// centred). Called when a scene is opened so entering a game frames the map.
function centerView() {
  if (!scene) return;
  const vw = wrap.clientWidth;
  const vh = wrap.clientHeight;
  const sw = (scene.width + PAD_PX * 2) * view.z;
  const sh = (scene.height + PAD_PX * 2) * view.z;
  const originX = PAD_PX * view.z;
  const originY = PAD_PX * view.z;
  view.x = (vw - sw) / 2 + originX;
  view.y = (vh - sh) / 2 + originY;
  applyView();
}

function setZoom(next, anchor) {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
  if (z === view.z) return;
  // Zoom about a point rather than about the origin, so the map grows toward
  // the cursor instead of sliding away from it. Without this, zooming in on
  // something in the corner pushes it off screen — which is the difference
  // between a usable map and a frustrating one.
  const r = wrap.getBoundingClientRect();
  const ax = anchor ? anchor.x - r.left : r.width / 2;
  const ay = anchor ? anchor.y - r.top : r.height / 2;
  const k = z / view.z;
  view.x = ax - (ax - view.x) * k;
  view.y = ay - (ay - view.y) * k;
  view.z = z;
  applyView();
}

function resetView() {
  view.x = 0; view.y = 0; view.z = 1;
  // applyView clamps, so a map smaller than the viewport lands centred rather
  // than pinned to the top-left corner.
  applyView();
}

// Wheel zooms. preventDefault because the wrapper no longer scrolls — the
// transform is the only thing that moves the map, and letting the page scroll
// underneath a map you are zooming is the worst of both.
wrap.addEventListener('wheel', (e) => {
  if (!scene) return;
  e.preventDefault();
  // Multiplicative, so a step feels the same at 25% as at 400%.
  setZoom(view.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12), { x: e.clientX, y: e.clientY });
}, { passive: false });

// Left-drag on empty space pans. Attached to the WRAPPER, not the stage: the
// stage is the thing being moved, and a drag handler on a moving element
// chases its own transform.
let pan = null;
wrap.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !scene) return;
  // A token, a fog region or a fog draw tool owns the left button where it
  // applies. Panning is what is left over — empty space only.
  if (e.target !== stage && e.target !== stageBg && e.target !== wrap) return;
  if (fogMode) return;
  pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  wrap.classList.add('panning');
  wrap.setPointerCapture(e.pointerId);
});
wrap.addEventListener('pointermove', (e) => {
  if (!pan) return;
  // One screen pixel of drag is one screen pixel of movement at any zoom: the
  // translate is applied OUTSIDE the scale in the transform string, so it is
  // already in screen units and must not be divided by the zoom.
  view.x = pan.vx + (e.clientX - pan.x);
  view.y = pan.vy + (e.clientY - pan.y);
  applyView();
});
function endPan(e) {
  if (!pan) return;
  pan = null;
  wrap.classList.remove('panning');
  try { wrap.releasePointerCapture(e.pointerId); } catch { /* already released */ }
}
wrap.addEventListener('pointerup', endPan);
wrap.addEventListener('pointercancel', endPan);

// --- marquee selection (RIGHT-drag) ---
let marquee = null;
stage.addEventListener('pointerdown', (e) => {
  // [CHANGED 2026-08-10] The gestures were reassigned:
  //
  //   LEFT  on empty space  -> pan the map        (was: marquee)
  //   RIGHT drag            -> marquee select     (was: context menu only)
  //   RIGHT click, no drag  -> context menu       (unchanged)
  //   wheel                 -> zoom
  //
  // Left-drag-to-pan is what every map interface does, and box-select on the
  // right button is how the two coexist without a modifier key. The cost is
  // that right-drag and right-click now share a button, so the context menu can
  // only be suppressed once a drag has actually MOVED — see the contextmenu
  // handler, which is where that decision is enforced.
  //
  // Left-drag on empty space no longer selects, so the pan handler is attached
  // to the WRAPPER rather than here: the stage moves, and a handler on a moving
  // element fights its own transform.
  if (e.button === 2) {
    // A NEW right press starts a new gesture, so any suppression owed to the
    // previous one is spent. Cleared here as well as in the contextmenu
    // handler, and the pair is the actual rule:
    //
    //   pointerdown  arms it (false)
    //   pointermove  sets it (true)
    //   contextmenu  reads and clears it
    //
    // Right-drag: marquee. Everything below is the old left-button path, and it
    // is reached with the button swapped rather than duplicated.
    // Fog mode always keeps the left button (it draws AND moves regions — see the
    // dispatch below), so a right press here always means marquee.
  } else if (e.button === 0) {
    // Left on a token is handled by the token's own listener. Left on empty
    // space is a pan, which the wrapper owns — so there is nothing to do here.
    if (!fogMode) return;
    // In fog mode the left button both draws and moves regions.
  } else {
    return;
  }
  // Fog mode owns the gesture entirely. Nothing below this block runs, so the
  // token drag/marquee paths are untouched rather than conditionally patched.
  if (fogMode) {
    hideCtxMenu();
    const g = stageGrid(e);

    // There is no separate "select" tool any more. The shape tool always DRAWS —
    // including on top of existing fog, which is how you open a window inside
    // fog or lay fog over a revealed area. Selection of a region is folded in by
    // gesture, like tokens: a DRAG draws; a CLICK (press+release without moving)
    // on a region selects it instead (resolved in commitFogDraw). Right-drag
    // marquees; Alt-drag on a selected region MOVES it.
    if (e.button === 0) {
      const pk = fogPick(g.x, g.y);
      // Press on a region that is ALREADY SELECTED -> move it (plain drag), the
      // same way a selected token drags. This is what makes "click to select,
      // then drag to move" work without a separate select tool.
      if (pk && fogSelection.has(pk.id) && !e.altKey) { beginFogMove(e); return; }
      // Shift-click on any region toggles it in/out of the selection (no draw).
      if (pk && e.shiftKey) { toggleFogSelected(pk.id); renderFog(); return; }
      // Otherwise DRAW — including on top of an unselected region, which is how
      // you open a window inside fog or lay fog over a revealed area. If the
      // press turns out to be a click (no drag) on a region, commitFogDraw
      // selects that region instead of creating a zero-size shape.
      fogClickCandidate = (fogShapeEl.value !== 'poly') ? pk : null;
      beginFogDraw(e);
      return;
    }

    // Right button -> marquee. Capture, for the same reason fog drawing does: a
    // marquee dragged past the edge of the map otherwise stops receiving
    // movement and never sees its own release, leaving the rectangle stuck.
    if (e.button !== 2) return;
    const p0 = stagePoint(e);
    const sx0 = p0.x, sy0 = p0.y;
    marquee = { sx: sx0, sy: sy0, pointerId: e.pointerId };
    try { stage.setPointerCapture(e.pointerId); } catch { /* capture unavailable */ }
    marqueeEl.style.left = sx0 + 'px'; marqueeEl.style.top = sy0 + 'px';
    marqueeEl.style.width = '0px'; marqueeEl.style.height = '0px';
    marqueeEl.style.display = 'block';
    if (!e.shiftKey) setFogSelection([]);
    return;
  }
  // Right-drag marquees from ANYWHERE, including from on top of a token. That
  // is the point of moving it to the right button: with left-drag panning,
  // there would otherwise be no way to box-select on a crowded map — the same
  // reasoning that gave fog mode its Alt-forces-marquee escape hatch.
  if (e.button !== 2 && e.target !== stage && e.target !== stageBg) return;
  hideCtxMenu();
  const p = stagePoint(e);
  const sx = p.x, sy = p.y;
  marquee = {
    sx, sy, pointerId: e.pointerId,
    // Screen coordinates of the press, so movement can be MEASURED rather than
    // merely detected — see the threshold in pointermove.
    px0: e.clientX, py0: e.clientY,
  };
  try { stage.setPointerCapture(e.pointerId); } catch { /* capture unavailable */ }
  marqueeEl.style.left = sx + 'px'; marqueeEl.style.top = sy + 'px';
  marqueeEl.style.width = '0px'; marqueeEl.style.height = '0px';
  marqueeEl.style.display = 'block';

  // [FIXED 2026-08-10] Clearing the selection is DEFERRED until the drag
  // actually moves.
  //
  // Every right press now starts a marquee, because a right-drag has to be able
  // to begin anywhere — including on top of a token. But a right press is also
  // how the context menu opens, and clearing here meant the token being
  // right-clicked was deselected before the menu ran, so the menu found an
  // empty selection and returned without opening. Right-clicking a token did
  // nothing at all; fog was unaffected because it selects by hit-test rather
  // than from an existing selection.
  //
  // Deferring costs nothing: a marquee that never moves selects nothing anyway,
  // so there was never anything to clear at the moment of the press.
  if (!e.shiftKey) marquee.clearOnMove = true;
});
stage.addEventListener('pointermove', (e) => {
  if (fogMode && fogDraw) { updateFogDraw(e); return; }
  if (fogMode && fogMove) { updateFogMove(e); return; }
  if (!marquee) return;
  // [FIXED 2026-08-10] A THRESHOLD, not "any movement at all".
  //
  // The previous version set this on the first pointermove, on the reasoning
  // that a three-pixel marquee selects nothing anyway so the strict test cost
  // nothing. That reasoning was wrong about how mice work: a real pointer emits
  // a continuous stream of move events, including from the hand tremor of
  // somebody holding still to click. So the flag was set between every press
  // and its menu, and the context menu NEVER OPENED.
  //
  // Every probe passed, because a test fires pointermove only when it means a
  // drag. The bug lived entirely in the gap between "a drag is a move" and "a
  // click also produces moves" — which is a property of the input device, not
  // of the code, and therefore not visible to any amount of synthetic
  // dispatching.
  // The press deferred this so that a right-CLICK could reach the context menu
  // with its selection intact. Now that the drag has moved, it is a marquee and
  // the old selection goes.
  if (marquee.clearOnMove) { setSelection([]); marquee.clearOnMove = false; }
  // Stage coordinates, not screen: the marquee element is a CHILD of the stage,
  // so it is drawn inside the same transform. Positioning it from screen deltas
  // made it drift away from the pointer at any zoom other than 100%.
  const p = stagePoint(e);
  const x = p.x, y = p.y;
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
  try { stage.releasePointerCapture(marquee.pointerId); } catch { /* not captured */ }
  marqueeEl.style.display = 'none';
  marquee = null;
  if (box.w < 3 && box.h < 3) {
    // A click, not a drag. This is where the context menu opens — see the
    // contextmenu handler for why it cannot be opened there.
    if (e.button === 2) openMenuAt(e);
    return;
  }
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

// [ADDED 2026-08-10] pointercancel is the OTHER way a drag ends, and nothing
// listened for it.
//
// Capture keeps events arriving when the cursor leaves the element. It does not
// help when the BROWSER takes the gesture away — a touch becoming a scroll, the
// window losing focus, a system gesture interrupting. In those cases pointerup
// never fires at all, and a drag with no cancel path is stuck exactly as it was
// before capture existed.
//
// Treated as a release rather than as an abort: the shape the user had drawn is
// what they had drawn, and discarding it would make an interrupted gesture lose
// work rather than finish early.
stage.addEventListener('pointercancel', (e) => {
  if (fogMode && fogDraw) { commitFogDraw(); return; }
  if (fogMode && fogMove) { commitFogMove(e); return; }
  if (!marquee) return;
  try { stage.releasePointerCapture(marquee.pointerId); } catch { /* not captured */ }
  marqueeEl.style.display = 'none';
  marquee = null;
});
// Clicking empty space (no drag) clears selection. A click that is the tail of a
// marquee drag is skipped — otherwise it would immediately undo the selection
// the drag just made (#stage-bg spans the whole stage, so every marquee drag
// ends in a click on it).
stageBg.addEventListener('click', (e) => {
  if (suppressNextClear) { suppressNextClear = false; return; }
  if (e.target === stageBg) setSelection([]);
});

// --- pings -------------------------------------------------------------------
//
// A transient marker: point at a spot, everyone sees a circle for a moment.
// Nothing is stored — see the server handler for why an ephemeral event is
// deliberately not a table.
//
// The circle takes the pinger's CAMPAIGN COLOUR, which is the same colour their
// dice and their chat name already use. That is the whole reason the colour is
// unique per campaign: one identity, expressed the same way everywhere, so
// "who is pointing at that" needs no label.
function showPing(p) {
  if (!scene || p.scene_id !== scene.id) return;

  const dot = document.createElement('div');
  dot.className = 'ping';
  // currentColor, so every ring follows one value and the colour is set once.
  dot.style.color = p.color || '#ffcc00';
  // The coordinates ARE the centre. No half-cell offset: they are no longer a
  // square to be centred within, they are the point that was pointed at.
  dot.style.left = (p.x * GRID_PX) + 'px';
  dot.style.top = (p.y * GRID_PX) + 'px';
  // Two rings, expanding outward and staggered — see the stylesheet for why the
  // direction and the delay are the parts that matter.
  dot.appendChild(document.createElement('i'));
  dot.appendChild(document.createElement('i'));
  stage.appendChild(dot);

  // Removed when the LAST ring finishes, not the first. animationend fires once
  // per animating child, so counting them is what distinguishes "a ring ended"
  // from "the ping ended" — removing on the first would cut the second ring off
  // mid-flight, which is exactly the stagger that makes it read as radar.
  let done = 0;
  dot.addEventListener('animationend', () => {
    done += 1;
    if (done >= 2) dot.remove();
  });

  if (p.focus) {
    // A focus ping imposes the GM's ZOOM as well as their target, so everyone
    // ends up looking at the same thing at the same size. Sending the GM's own
    // level rather than a fixed constant means "look at this" shows what the GM
    // is actually seeing — if they are studying one corridor, so is the table.
    //
    // Re-clamped on arrival even though the server bounds it. The server is the
    // authority and this is not a second opinion: it is the same rule stated
    // where the value is used, so a payload from a future version cannot push
    // this client somewhere its own controls could not reach.
    //
    // Zoom BEFORE centring, because centreOn multiplies by view.z — centring
    // first and zooming after would frame the old scale and then abandon it.
    if (Number.isFinite(p.zoom)) {
      view.z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, p.zoom));
    }
    centreOn(p.x, p.y);
  }
  log(`ping at (${p.x},${p.y})${p.focus ? ' — focus' : ''}`);
}

// Move the viewport so a grid square sits in the middle of it.
//
// This is the only place anything moves a user's view for them, and it is
// GM-only for that reason: drawing on somebody's screen is one thing, taking
// their viewport is another. The zoom is left alone — the GM is directing
// attention, not deciding how close anyone looks.
function centreOn(gx, gy) {
  // Same reasoning as showPing: the coordinates are already a point, so adding
  // half a cell would put the focus half a square off the thing being pointed
  // at.
  //
  // clientWidth rather than the bounding rect, because the stage sits in the
  // CONTENT box — measuring the border box put the centring one pixel out,
  // which is small but was real and is now simply gone.
  //
  // This asks for a perfect centre and applyView may refuse part of it: a point
  // near the edge of the map cannot be centred without showing empty
  // background, and filling the viewport matters more than centring exactly.
  // The point is always brought into view; it is not always brought to the
  // middle.
  view.x = wrap.clientWidth / 2 - gx * GRID_PX * view.z;
  view.y = wrap.clientHeight / 2 - gy * GRID_PX * view.z;
  applyView();
}

function sendPing(gx, gy, focus) {
  if (!scene) return;
  socket.emit('scene:ping',
    {
      campaign_id: campaignId,
      scene_id: scene.id,
      x: gx,
      y: gy,
      focus: !!focus,
      // Only meaningful on a focus ping, and the server ignores it otherwise.
      //
      // The GREATER of the GM's own zoom and FOCUS_ZOOM: focusing must zoom in
      // far enough to have somewhere to move, and a GM already studying
      // something at 300% should not be pulled back out to 200% by their own
      // ping. Computed once, at the sender, so every client — the GM's own
      // included — ends up at the same level.
      zoom: focus ? Math.max(view.z, FOCUS_ZOOM) : undefined,
    },
    (ack) => { if (!(ack && ack.ok)) log(`ping refused: ${ack && ack.error}`); });
}

// --- context menu ---
// [RESTRUCTURED 2026-08-10] The menu is opened from the RELEASE, never from the
// contextmenu event.
//
// The previous version suppressed the menu when a right-drag had moved, using a
// flag set during pointermove. It passed every probe and failed on the actual
// machine, because WHEN `contextmenu` fires is platform-dependent: on macOS it
// arrives with the mouse DOWN, before any movement has happened, so the flag was
// always false and the menu opened at the START of every marquee — the drag then
// continued underneath it.
//
// Deferring to pointerup removes the timing question entirely. By then it is
// known whether the gesture was a click or a drag, because the marquee's own
// size says so, and no flag has to guess.
//
// contextmenu therefore only suppresses the NATIVE menu. It decides nothing.
stage.addEventListener('contextmenu', (e) => { e.preventDefault(); });

// Open the menu for a right-click that did not turn into a drag.
function openMenuAt(e) {
  // Record where the menu was opened, so a ping or a paste from it lands there
  // rather than wherever the pointer drifted afterwards.
  cursorGrid = stageGrid(e);
  const cp = stagePoint(e);
  cursorPoint = { x: cp.x / GRID_PX, y: cp.y / GRID_PX };

  const tokenEl = e.target.closest && e.target.closest('.token');
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
  // The menu opens on empty space too: ping acts on the POINT that was
  // right-clicked rather than on a selection, so there is something to offer
  // even with nothing selected.
  openCtxMenu(e.clientX, e.clientY);
}

function openCtxMenu(px, py) {
  ctxMenu.textContent = '';
  const gm = isGm();
  const sel = [...selection];

  const head = document.createElement('div');
  head.className = 'head';
  // No 'map' label when nothing is selected — the menu just shows the actions
  // that actually apply (ping for everyone; paste for a GM with a clipboard).
  head.textContent = sel.length ? `${sel.length} selected` : '';
  if (sel.length) ctxMenu.appendChild(head);

  const item = (label, handler) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = label;
    d.addEventListener('click', () => { hideCtxMenu(); handler(); });
    ctxMenu.appendChild(d);
  };
  const sep = () => { const s = document.createElement('div'); s.className = 'sep'; ctxMenu.appendChild(s); };

  // Ping first, and available to EVERYONE including with nothing selected: it
  // acts on the point that was right-clicked rather than on a selection, and
  // pointing at the map is the one thing every person at the table needs to do.
  //
  // cursorGrid was recorded when the menu opened, so the ping lands where the
  // right-click happened rather than wherever the pointer drifted while the
  // menu was up — the same reasoning that already positions a paste.
  // The EXACT point, not the snapped square: a ping marks where the person
  // pointed. Still expressed in grid units, so the server's existing bounds
  // check applies unchanged — it validates a finite number inside the scene,
  // and never required that number to be whole.
  const at = { x: cursorPoint.x, y: cursorPoint.y };
  item('ping here', () => sendPing(at.x, at.y, false));
  if (gm) {
    // A focus ping MOVES every player's view. GM-only, and named so the
    // difference is visible in the menu rather than being a surprise.
    item('ping and focus everyone', () => sendPing(at.x, at.y, true));
  }

  if (gm && sel.length) {
    // Actions on the current selection — only shown when something is selected,
    // so the menu never lists size/hide/lock/copy/delete that would silently do
    // nothing on an empty selection.
    sep();
    const sizeHead = document.createElement('div');
    sizeHead.className = 'head'; sizeHead.textContent = 'resize (5e)';
    ctxMenu.appendChild(sizeHead);
    for (const size of SIZE_PRESETS) item(`  ${size}`, () => resizeSelection(size));
    sep();
    // Hide/show and lock/unlock are single toggles, not both at once: read the
    // current state of the selection and offer the action that changes it. If
    // any selected token is already hidden/locked, offer to reveal/unlock the
    // whole selection; otherwise offer to hide/lock it.
    const rows = sel.map((id) => tokens.get(id)).filter(Boolean).map((e) => e.row);
    const anyHidden = rows.some((r) => r && r.hidden);
    const anyLocked = rows.some((r) => r && r.locked);
    if (anyHidden) item('reveal', () => setFlagSelection('hidden', false));
    else item('hide', () => setFlagSelection('hidden', true));
    if (anyLocked) item('unlock', () => setFlagSelection('locked', false));
    else item('lock', () => setFlagSelection('locked', true));
    sep();
    item('copy', copySelection);
    item('cut', cutSelection);
    item('duplicate', duplicateSelection);
    item('delete', deleteSelection);
  }

  // Paste is the one GM action that works with nothing selected — it drops the
  // clipboard at the point that was right-clicked. Only offered when there is
  // something to paste, so it never appears as a dead item.
  if (gm && clipboard.length) {
    if (!sel.length) sep();
    item('paste', pasteClipboard);
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
  // No select-only cursor state any more: in fog mode the layer both draws
  // (crosshair, from .fog-catch) and hit-tests for region selection.
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
// Screen coordinates -> STAGE coordinates.
//
// [FIXED 2026-08-10] getBoundingClientRect() returns the transformed ORIGIN, so
// subtracting rect.left lands on the right point — but the remaining offset is
// still in SCREEN pixels, and the stage is scaled. Dividing that by GRID_PX
// alone gives the right answer only at 100% zoom: at 200% every distance came
// out half of what it should be, so clicks landed off-target, the marquee
// tracked away from the pointer, and dragging a token moved it the wrong
// distance.
//
// I had assumed getBoundingClientRect handled this on its own, said so, and
// shipped it. It handles the ORIGIN and nothing else; the scale has to be
// divided out explicitly, in every conversion, which is why they all go through
// here now rather than each doing the arithmetic inline.
function stagePoint(e) {
  const rect = stage.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / view.z,
    y: (e.clientY - rect.top) / view.z,
  };
}

// The same conversion, rounded to whole grid squares.
function stageGrid(e) {
  const p = stagePoint(e);
  return { x: Math.round(p.x / GRID_PX), y: Math.round(p.y / GRID_PX) };
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
  fogDraw = { tool: shape, x0: g.x, y0: g.y, x1: g.x, y1: g.y, pointerId: e.pointerId };
  // [FIXED 2026-08-10] Capture the pointer, so movement and release keep
  // arriving here after the cursor leaves the stage.
  //
  // Without capture, dragging past the edge of the map left the drag with no
  // way to END: pointermove stopped arriving so the preview froze, and
  // pointerup landed on whatever element was under the cursor instead, so
  // releasing the button did nothing. The shape stayed stuck to the pointer and
  // the only escape was a reload.
  //
  // Two other drags in this file already captured — token movement and fog
  // region movement — and the two that did not are exactly the two that begin
  // on empty space, which is also where a drag is most likely to run off the
  // edge.
  try { stage.setPointerCapture(e.pointerId); } catch { /* capture unavailable */ }
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
  const candidate = fogClickCandidate;
  fogClickCandidate = null;
  // Release before anything can fail. An awaited request that throws would
  // otherwise leave the pointer captured for the life of the page, which is a
  // worse version of the bug this capture exists to fix.
  if (fogDraw) { try { stage.releasePointerCapture(fogDraw.pointerId); } catch { /* not captured */ } }
  fogDraw = null;
  if (!preview) {
    // The press never became a drag. If it landed on an existing region, treat
    // it as a CLICK that selects that region (this is how you pick a region to
    // move/delete without a separate select tool). Otherwise it selected empty
    // space, which clears the selection.
    if (candidate) setFogSelection([candidate.id]);
    else setFogSelection([]);
    renderFog();
    return;
  }
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
  // dx/dy arrive in screen pixels; the SVG transform is applied inside the
  // scaled stage, so they have to be converted first — same correction as the
  // token drag above.
  const sx = Math.round((dx / view.z) / GRID_PX) * GRID_PX;
  const sy = Math.round((dy / view.z) / GRID_PX) * GRID_PX;
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
  const dx = Math.round(((e.clientX - startX) / view.z) / GRID_PX);
  const dy = Math.round(((e.clientY - startY) / view.z) / GRID_PX);
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
  fogDraw = null; polyPoints = []; fogClickCandidate = null;
  if (!next) fogSelection.clear();
  setSelection([]);
  hideCtxMenu();
  renderFog();
  log(next ? 'fog mode ON (tokens are not clickable)' : 'fog mode off');
}

fogModeEl.addEventListener('change', () => setFogMode(fogModeEl.checked));

fogToolEl.addEventListener('change', () => {
  // Switching tool abandons any half-drawn shape rather than carrying it over.
  fogDraw = null; polyPoints = []; fogClickCandidate = null;
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

  // (The bare-F fog-mode toggle was removed: the fog panel now opens fog mode
  // when it opens and closes it when it closes, so a keyboard toggle would only
  // desync the panel from the mode. The in-fog-mode editing keys below —
  // Delete, arrows, Enter/Esc for the polygon, Ctrl+C/V/X/D, T — are unchanged.)

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

// [ADDED 2026-08-10] A character changed. Its tokens' pictures are INHERITED
// rather than copied, so the canvas has to repaint them — otherwise a portrait
// edited on the character page shows the old image here until a reload, which
// is the symptom that produced the change in the first place.
//
// This file never handled actor:updated at all. The server has broadcast it
// since M4 and no canvas listened, so a character edit reached the character
// page and stopped there. Fixing the copy alone would not have fixed the
// symptom: it was two defects wearing one appearance.
//
// The projected payload carries img_url and the framing for a character a
// player is allowed to know about, and the server withholds the event entirely
// otherwise — so applying it unconditionally here discloses nothing.
// Registered here rather than beside showPing, because that helper is defined
// above the point where `socket` is created — a listener attached at definition
// time would run before the connection exists.
socket.on('scene:ping', showPing);

socket.on('actor:updated', (a) => {
  if (!a || !scene) return;
  let touched = 0;
  for (const entry of tokens.values()) {
    if (entry.row.actor_id !== a.id) continue;
    // Only repaint what INHERITS. A token with its own picture keeps it, and
    // overwriting that would be the opposite bug — a deliberate override
    // reverting silently whenever the character was edited.
    //
    // The FLAGS decide this, not the values. The server resolves an inherited
    // picture to the character's URL before sending it, so the payload cannot
    // be inspected to tell the two apart: an earlier version tested
    // `img_url == null` here and consequently matched nothing at all, which is
    // why a character edit appeared to do nothing until the page was reloaded.
    //
    // Picture and framing are checked separately because they are inherited
    // separately.
    let changed = false;
    if (entry.row.img_inherited) {
      entry.row.img_url = a.img_url || null;
      changed = true;
    }
    if (entry.row.frame_inherited) {
      entry.row.img_offset_x = a.img_offset_x;
      entry.row.img_offset_y = a.img_offset_y;
      entry.row.img_scale = a.img_scale;
      changed = true;
    }
    if (changed) {
      paintToken(entry);
      touched += 1;
    }
  }
  if (touched) log(`actor:updated — repainted ${touched} token(s)`);
});

// [ADDED 2026-08-10] The map or the grid alignment changed. Repaint the
// background without reloading tokens or fog: a presentational change should
// not flicker the whole board.
//
// This was written during the alignment work and never landed in the file — the
// patch was reported as applied and the handler was not there. Found by
// comparing the events the server emits against the ones each client handles,
// which is a check worth repeating whenever an event is added.
socket.on('scene:updated', (d) => {
  if (!scene || !d || d.id !== scene.id) return;
  scene = d;
  stage.style.width = scene.width + 'px';
  stage.style.height = scene.height + 'px';
  stageBg.style.backgroundImage = scene.img_url ? `url("${CSS.escape(scene.img_url)}")` : 'none';
  applyGridAlignment();
  applyGridOverlay();
  log('scene:updated — background repainted');
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

// Seam: the game shell's left-rail ping mode. On the next canvas pointerdown it
// calls pingAt(event); we convert to the exact (unsnapped) grid point the same
// way the context menu's "ping here" does (openMenuAt), then reuse sendPing.
function pingAt(e) {
  const cp = stagePoint(e);
  sendPing(cp.x / GRID_PX, cp.y / GRID_PX, false);
}

// The game shell drives this file through boot(id) and pingAt(e); every other
// render path, socket handler and shortcut is unchanged and still runs at load.
window.VTTScene = { boot, pingAt, highlightToken, pickTokens };

// M6: let the token image field be filled from the campaign's image library
// rather than by pasting a URL. Guarded, because the field must keep working on
// a page that has not loaded the picker — and because the jsdom suites covering
// this file construct a DOM without it.
if (window.VTTImagePicker) {
  window.VTTImagePicker.attach('tok-img', {
    campaignId: () => campaignId,
    // A token's art is token art whether or not it is linked to a character.
    kind: 'token',
  });
}

