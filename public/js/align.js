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
  const id = document.getElementById('campaignId').value.trim();
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

  document.getElementById('gridType').value = state.type;
  document.getElementById('gridColor').value = state.color;
  document.getElementById('gridOpacity').value = String(state.opacity);
  document.getElementById('mapUrl').value = scene.img_url || '';

  const tokenCount = (r.data.tokens || []).length;
  document.getElementById('info').textContent =
    `${scene.name} — ${scene.width}×${scene.height}px, ${tokenCount} token(s)`;
  // The hazard is stated BEFORE the GM changes anything, not after they save.
  document.getElementById('hazard').textContent = tokenCount
    ? `${tokenCount} token(s) are on this scene. Changing the cell size moves them `
      + 'relative to the artwork — their grid coordinates do not change, so they keep '
      + 'their squares, not their positions over the picture.'
    : '';

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
  // The server reports whether the grid actually changed and how many tokens sit
  // on the scene. Reported, not compensated — see the route's header.
  msg.textContent = r.data.grid_changed
    ? `saved — ${r.data.affected_tokens} token(s) now sit differently over the artwork`
    : 'saved';
});

document.getElementById('reset').addEventListener('click', () => {
  state.size = 70; state.ox = 0; state.oy = 0;
  render();
});

document.getElementById('sceneSel').addEventListener('change', (e) => selectScene(e.target.value));
document.getElementById('loadCampaign').addEventListener('click', loadCampaign);

const preset = new URLSearchParams(window.location.search).get('campaign');
if (preset) {
  document.getElementById('campaignId').value = preset;
  loadCampaign();
}
render();
