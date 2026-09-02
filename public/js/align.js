/* VTT-IIFE-WRAP: this file shares top-level const names (out, log, api,
   show, whoami, campaign, scene, GRID_PX, ...) with the other game-page
   scripts. On its own dev harness that was fine (one script per page); on
   game.html all four load into one global scope and the second declaration
   of any shared const throws "already declared", killing the whole file.
   Wrapping in an IIFE makes those declarations function-scoped so they no
   longer collide. window.VTTXxx (used by game.js) is set inside the body as
   before; the internal names the jsdom suite reaches are re-published on
   window at the end. Same pattern sheet.js / itemsheet.js already use. */
;(function () {
// Grid alignment tool (M6).
//
// Same constraints as every other client file here: the CSP is
// `script-src 'self'`, so this is an external classic script built with
// createElement and addEventListener, and every server-supplied string reaches
// the DOM through textContent.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SEPARATE PAGE
// ---------------------------------------------------------------------------
// The obvious home is scene.html, which already draws the map. It was rejected
// for the reason M4 and M5 both rejected it: public/js/scene.js is covered by
// 134 jsdom assertions across four suites, and an alignment tool needs its own
// pointer handling, its own scroll behaviour and its own transient state. Adding
// all of that to the file those probes cover is how a presentational feature
// breaks a canvas suite.
//
// scene.js gained exactly two small functions instead — applyGridAlignment and
// applyGridOverlay — which READ the saved settings and change nothing else.
//
// ---------------------------------------------------------------------------
// WHAT "ALIGNING" ACTUALLY MEANS HERE
// ---------------------------------------------------------------------------
// The naive model is that the grid moves to fit the map. The stored model is the
// reverse, and it is worth stating because the arithmetic only makes sense once:
//
//   scene.grid.size      the size of one printed cell, IN THE IMAGE'S OWN PIXELS
//   scene.grid.offset_x  where that printed grid starts, also in image pixels
//
// The canvas then scales the image by GRID_PX / size so one printed cell becomes
// one token cell. Token coordinates are in grid units and never change, which is
// why aligning moves nothing in the database.
//
// This tool therefore previews at the SAME scale the canvas will use, so what is
// seen here is what will be seen there.

const GRID_PX = 50; // must match scene.js; one grid unit on the canvas.

const out = document.getElementById('out');
const viewport = document.getElementById('viewport');
const mapEl = document.getElementById('map');
const overlay = document.getElementById('overlay');

let campaign = null;
let scenes = [];
let scene = null;
let natural = { w: 0, h: 0 };

// The live, unsaved alignment.
const state = { size: 70, ox: 0, oy: 0, type: 'square', color: '#3a3a3a', opacity: 0.5 };
let gridTypeDD = null;   // themed overlay dropdown API (set once inputs are wired)

function show(label, r) {
  out.textContent = `${label}  →  ${r.status}\n` + JSON.stringify(r.data, null, 2);
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

const num = (id) => Number(document.getElementById(id).value);

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render() {
  const scale = state.size > 0 ? GRID_PX / state.size : 1;

  if (scene && scene.img_url && natural.w) {
    mapEl.style.backgroundImage = `url("${CSS.escape(scene.img_url)}")`;
    mapEl.style.backgroundSize = `${natural.w * scale}px ${natural.h * scale}px`;
    mapEl.style.backgroundPosition = `${-state.ox * scale}px ${-state.oy * scale}px`;
  } else {
    mapEl.style.backgroundImage = 'none';
  }

  // The overlay is drawn at GRID_PX regardless of the cell size, because that is
  // what the canvas will use. Aligning means making the map's printed lines
  // arrive underneath these.
  if (state.type === 'none') {
    overlay.style.backgroundImage = 'none';
  } else {
    overlay.style.backgroundImage =
      `linear-gradient(${state.color} 1px, transparent 1px), `
      + `linear-gradient(90deg, ${state.color} 1px, transparent 1px)`;
    overlay.style.backgroundSize = `${GRID_PX}px ${GRID_PX}px`;
    overlay.style.opacity = String(state.opacity);
  }

  document.getElementById('cellSize').value = String(state.size);
  document.getElementById('offX').value = String(round2(state.ox));
  document.getElementById('offY').value = String(round2(state.oy));
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

async function loadCampaign() {
  // Harness only: reads align's own #campaignId input. On the game page this
  // input is gone and the shell calls boot(id, scene) instead.
  const _ci = document.getElementById('campaignId');
  const id = _ci ? _ci.value.trim() : '';
  if (!id) return;
  const r = await api('GET', `/api/campaigns/${id}`);
  show('GET campaign', r);
  if (r.status !== 200) return;
  campaign = r.data.campaign;

  if (!campaign.is_gm) {
    document.getElementById('info').textContent =
      'you are not the GM of this campaign — alignment is GM-only';
    return;
  }

  const s = await api('GET', `/api/campaigns/${campaign.id}/scenes`);
  scenes = s.status === 200 ? (s.data.scenes || []) : [];
  const sel = document.getElementById('sceneSel');
  sel.textContent = '';
  for (const sc of scenes) {
    const o = document.createElement('option');
    o.value = sc.id;
    o.textContent = sc.name;
    sel.appendChild(o);
  }
  if (scenes.length) { sel.value = scenes[0].id; await selectScene(scenes[0].id); }
}

async function selectScene(sceneId) {
  const r = await api('GET', `/api/campaigns/${campaign.id}/scenes/${sceneId}`);
  if (r.status !== 200) { show('GET scene', r); return; }
  scene = r.data.scene;

  const grid = scene.grid || {};
  state.size = Number(grid.size) || 70;
  state.ox = Number(grid.offset_x) || 0;
  state.oy = Number(grid.offset_y) || 0;
  state.type = grid.type || 'square';
  state.color = grid.color || '#3a3a3a';
  state.opacity = grid.opacity === undefined ? 0.5 : Number(grid.opacity);

  // Reflect the loaded overlay type on the custom dropdown (updates its button
  // label, not just the hidden value). Falls back to the raw value before the
  // dropdown is wired.
  if (gridTypeDD) gridTypeDD.set(state.type);
  else document.getElementById('gridType').value = state.type;
  document.getElementById('gridColor').value = state.color;
  document.getElementById('gridOpacity').value = String(state.opacity);
  document.getElementById('mapUrl').value = scene.img_url || '';

  const tokenCount = (r.data.tokens || []).length;
  document.getElementById('info').textContent =
    `${scene.name} — ${scene.width}×${scene.height}px, ${tokenCount} token(s)`;
  // (The pre-emptive "changing the cell size moves tokens" warning was removed.)
  document.getElementById('hazard').textContent = '';

  await measureNatural();
  render();
}

// The image's own pixel dimensions. Needed because CSS cannot scale a background
// by a factor without being told what it is scaling.
function measureNatural() {
  return new Promise((resolve) => {
    natural = { w: 0, h: 0 };
    if (!scene || !scene.img_url) { resolve(); return; }
    const probe = new Image();
    probe.onload = () => { natural = { w: probe.naturalWidth, h: probe.naturalHeight }; resolve(); };
    probe.onerror = () => resolve();
    probe.src = scene.img_url;
  });
}

// ---------------------------------------------------------------------------
// interaction
// ---------------------------------------------------------------------------

let pan = null;

viewport.addEventListener('pointerdown', (e) => {
  if (!scene) return;
  pan = { x: e.clientX, y: e.clientY, ox: state.ox, oy: state.oy };
  viewport.classList.add('dragging');
  viewport.setPointerCapture(e.pointerId);
});
viewport.addEventListener('pointermove', (e) => {
  if (!pan) return;
  // Screen pixels divided by the scale gives IMAGE pixels, which is the unit the
  // offset is stored in. Dragging right must move the image right, so the offset
  // — which is subtracted when positioning — decreases.
  const scale = GRID_PX / state.size;
  state.ox = pan.ox - (e.clientX - pan.x) / scale;
  state.oy = pan.oy - (e.clientY - pan.y) / scale;
  render();
});
function endPan(e) {
  if (!pan) return;
  pan = null;
  viewport.classList.remove('dragging');
  try { viewport.releasePointerCapture(e.pointerId); } catch { /* released */ }
}
viewport.addEventListener('pointerup', endPan);
viewport.addEventListener('pointercancel', endPan);

viewport.addEventListener('wheel', (e) => {
  if (!scene) return;
  e.preventDefault();
  // Whole pixels: a cell size of 70.3 is not something a printed map has, and
  // fractional sizes make the arithmetic hard to reason about while nudging.
  const next = state.size + (e.deltaY < 0 ? 1 : -1);
  state.size = Math.max(5, Math.min(500, next));
  render();
}, { passive: false });

viewport.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 10 : 1;
  const map = { ArrowLeft: ['ox', -step], ArrowRight: ['ox', step], ArrowUp: ['oy', -step], ArrowDown: ['oy', step] };
  const m = map[e.key];
  if (!m) return;
  e.preventDefault();
  state[m[0]] += m[1];
  render();
});

for (const [id, key] of [['cellSize', 'size'], ['offX', 'ox'], ['offY', 'oy']]) {
  document.getElementById(id).addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) { state[key] = v; render(); }
  });
}
// The overlay selector is the themed custom dropdown (VTTCommon.initDropdown),
// not a native <select>. Its hidden #gridType input carries the value and fires
// `change`, so the listener below is unchanged; gridTypeDD.set() is used by
// render() to reflect a loaded scene's overlay type on the button.
const gridTypeDD_init = (window.VTTCommon && window.VTTCommon.initDropdown)
  ? window.VTTCommon.initDropdown('gridTypeDD', [
      { value: 'square', label: 'Square' },
      { value: 'none', label: 'None' },
    ])
  : null;
gridTypeDD = gridTypeDD_init;
document.getElementById('gridType').addEventListener('change', (e) => {
  state.type = e.target.value; render();
});
document.getElementById('gridColor').addEventListener('input', (e) => {
  state.color = e.target.value; render();
});
document.getElementById('gridOpacity').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  if (Number.isFinite(v)) { state.opacity = Math.max(0, Math.min(1, v)); render(); }
});

// ---- measure two lines ------------------------------------------------------
// Eyeballing a cell size works badly on a map whose grid is 63.4 px. Clicking
// two grid intersections and saying how many cells apart they are derives the
// size arithmetically, which is both faster and more accurate than nudging.
let measuring = null;

document.getElementById('measure').addEventListener('click', () => {
  if (!scene) return;
  measuring = { points: [] };
  document.getElementById('ruler').style.display = 'none';
  document.getElementById('saveMsg').textContent =
    'click two grid intersections on the map, then say how many cells apart they are';
});

viewport.addEventListener('click', (e) => {
  if (!measuring) return;
  const rect = viewport.getBoundingClientRect();
  measuring.points.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  if (measuring.points.length < 2) return;

  const [a, b] = measuring.points;
  const scale = GRID_PX / state.size;
  const dxScreen = Math.abs(b.x - a.x);
  const dyScreen = Math.abs(b.y - a.y);
  // Measure along whichever axis the GM actually dragged across.
  const spanScreen = Math.max(dxScreen, dyScreen);
  const spanImage = spanScreen / scale;

  const answer = window.prompt('How many cells apart were those two points?', '5');
  measuring = null;
  document.getElementById('saveMsg').textContent = '';
  const cells = Number(answer);
  if (!Number.isFinite(cells) || cells <= 0) return;

  const derived = spanImage / cells;
  if (derived < 5 || derived > 500) {
    document.getElementById('saveMsg').textContent =
      `that gives a cell size of ${round2(derived)}px, outside the allowed 5–500`;
    return;
  }
  // Anchor the offset on the FIRST point clicked, so the grid starts on a line
  // the GM actually identified rather than wherever it happened to be.
  const firstImageX = a.x / scale + state.ox;
  const firstImageY = a.y / scale + state.oy;
  state.size = Math.round(derived);
  const s2 = GRID_PX / state.size;
  state.ox = firstImageX - Math.round(a.x / s2 / state.size) * state.size;
  state.oy = firstImageY - Math.round(a.y / s2 / state.size) * state.size;
  render();
});

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------

document.getElementById('setMap').addEventListener('click', async () => {
  if (!scene) return;
  const url = document.getElementById('mapUrl').value.trim();
  const r = await api('PATCH', `/api/campaigns/${campaign.id}/scenes/${scene.id}`,
    { img_url: url || null });
  show('PATCH img_url', r);
  if (r.status === 200) { scene = r.data.scene; await measureNatural(); render(); }
});

document.getElementById('save').addEventListener('click', async () => {
  if (!scene) return;
  const msg = document.getElementById('saveMsg');
  // Only the alignment keys are sent. The server MERGES rather than replaces, so
  // sending a partial grid is the supported path — and it means this tool cannot
  // clobber a setting it does not know about.
  const r = await api('PATCH', `/api/campaigns/${campaign.id}/scenes/${scene.id}`, {
    grid: {
      size: Math.round(state.size),
      offset_x: round2(state.ox),
      offset_y: round2(state.oy),
      type: state.type,
      color: state.color,
      opacity: state.opacity,
    },
  });
  show('PATCH grid', r);
  if (r.status !== 200) { msg.textContent = (r.data && r.data.error) || 'save failed'; return; }
  scene = r.data.scene;
  // Saving is done — close the modal. (Previously this left a "N tokens now sit
  // differently" message in place; the GM asked for the modal to close on save.)
  const dlg = document.getElementById('alignDialog');
  if (dlg && typeof dlg.close === 'function' && dlg.open) dlg.close();
  else { msg.textContent = 'saved'; }
});

document.getElementById('reset').addEventListener('click', () => {
  state.size = 70; state.ox = 0; state.oy = 0;
  render();
});

// Seam: align's own scene picker and load button die on the game page — the
// #sceneSel there is combat's encounter picker, not align's, and the shell
// injects the current scene through boot(). Both bindings are therefore guarded
// behind align's own #campaignId input, which only the align harness has.
{
  const _ownInput = document.getElementById('campaignId');
  if (_ownInput) {
    document.getElementById('sceneSel').addEventListener('change', (e) => selectScene(e.target.value));
    document.getElementById('loadCampaign').addEventListener('click', loadCampaign);
  }
}

// M6: the map image can be chosen from the library instead of pasted. Map is a
// GM-only kind server-side, and this page is GM-only anyway, so the picker and
// the route agree without either enforcing it twice.
if (window.VTTImagePicker) {
  window.VTTImagePicker.attach('mapUrl', {
    campaignId: () => (campaign ? campaign.id : null),
    kind: 'map',
    // Setting the field is not saving it. Applying immediately means one click
    // does what a person means by "choose this map", instead of leaving a
    // filled box and a button they still have to find.
    onChoose: () => document.getElementById('setMap').click(),
  });
}

const preset = new URLSearchParams(window.location.search).get('campaign');
{
  const _ownInput = document.getElementById('campaignId');
  if (_ownInput && preset) {
    _ownInput.value = preset;
    loadCampaign();
  }
}
render();

// The game shell's entry point (spec §2): align operates on the CURRENT scene,
// injected by game.js, instead of its own campaign/scene pickers. The shell only
// opens this for the GM, so is_gm is assumed here (the server still enforces it
// on save). Loading the scene reuses selectScene unchanged.
async function boot(campaignId, scene) {
  // The game shell opens align on the campaign's current scene. Rather than
  // depend on the caller threading a scene object, resolve it here the same way
  // the harness did: confirm the campaign (for is_gm + active_scene_id) and load
  // the scenes list, then select the injected scene if given, else the active
  // scene, else the first. This is why align works whenever a scene exists.
  const r = await api('GET', `/api/campaigns/${campaignId}`);
  if (r.status !== 200 || !r.data || !r.data.campaign) {
    document.getElementById('info').textContent = 'could not load this campaign';
    return;
  }
  campaign = r.data.campaign;
  if (!campaign.is_gm) {
    document.getElementById('info').textContent =
      'you are not the GM of this campaign — alignment is GM-only';
    return;
  }

  const s = await api('GET', `/api/campaigns/${campaign.id}/scenes`);
  scenes = s.status === 200 ? (s.data.scenes || []) : [];

  // Pick the scene to align: the one handed in, else the campaign's active
  // scene, else the first scene that exists.
  let pick = null;
  if (scene && scene.id) pick = scene.id;
  else if (campaign.active_scene_id) pick = campaign.active_scene_id;
  else if (scenes.length) pick = scenes[0].id;

  if (pick) return selectScene(pick);
  document.getElementById('info').textContent = 'no scenes yet — create one first';
}
window.VTTAlign = { boot };


/* --- expose internals the jsdom test suite reads via window.* --- */
  try { window.loadCampaign = loadCampaign; } catch (e) {}
})();
