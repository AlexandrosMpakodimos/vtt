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
const GRID_PX = 50;

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
  const r = await api('GET', `/api/campaigns/${campaignId}/scenes`);
  show(`GET scenes -> ${r.status}`, r.data);
  const box = document.getElementById('scene-list');
  box.textContent = '';
  if (r.status !== 200) return;
  if (r.data.scenes.length === 0) {
    box.appendChild(document.createTextNode('no scenes yet — create one (GM only)'));
    return;
  }
  for (const s of r.data.scenes) {
    const b = document.createElement('button');
    b.textContent = `open: ${s.name} (${s.width}x${s.height})`;
    b.addEventListener('click', () => openScene(s.id));
    box.appendChild(b);
    box.appendChild(document.createTextNode(' '));
  }
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
  stage.style.backgroundImage =
    'linear-gradient(#3a3a3a 1px, transparent 1px), linear-gradient(90deg, #3a3a3a 1px, transparent 1px)';
  stage.style.backgroundSize = `${GRID_PX}px ${GRID_PX}px`;

  for (const { el } of tokens.values()) el.remove();
  tokens.clear();
  selection.clear();
  for (const t of r.data.tokens) upsertToken(t);

  if (!joinedRoom) joinRoom();
}

// --- rendering ---
function upsertToken(row) {
  let entry = tokens.get(row.id);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'token';
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

function paintToken({ row, el }) {
  el.style.left = (row.x * GRID_PX) + 'px';
  el.style.top = (row.y * GRID_PX) + 'px';
  el.style.width = (row.width * GRID_PX) + 'px';
  el.style.height = (row.height * GRID_PX) + 'px';
  el.style.backgroundImage = row.img_url ? `url("${CSS.escape(row.img_url)}")` : 'none';
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
    const r = await api('POST', `/api/campaigns/${campaignId}/scenes/${scene.id}/tokens`,
      { name, img_url: img_url || undefined, x: origin.x, y: origin.y,
        width: footprint, height: footprint });
    show(`place token -> ${r.status}`, r.data);
    return;
  }
  if (!isGm()) return show('only the GM can place multiple tokens at once');

  const offsets = packOffsets(count, footprint);
  const specs = offsets.map((o, i) => ({
    name: instanceName(name, i),
    img_url: img_url || undefined,
    width: footprint,
    height: footprint,
    hidden: false,
    x: origin.x + o.dx,
    y: origin.y + o.dy,
  }));

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
  if (!marquee) return;
  const x = e.clientX - marquee.rect.left, y = e.clientY - marquee.rect.top;
  const left = Math.min(x, marquee.sx), top = Math.min(y, marquee.sy);
  const w = Math.abs(x - marquee.sx), h = Math.abs(y - marquee.sy);
  marqueeEl.style.left = left + 'px'; marqueeEl.style.top = top + 'px';
  marqueeEl.style.width = w + 'px'; marqueeEl.style.height = h + 'px';
});
stage.addEventListener('pointerup', () => {
  if (!marquee) return;
  const box = { left: parseFloat(marqueeEl.style.left), top: parseFloat(marqueeEl.style.top),
                w: parseFloat(marqueeEl.style.width), h: parseFloat(marqueeEl.style.height) };
  marqueeEl.style.display = 'none';
  marquee = null;
  if (box.w < 3 && box.h < 3) return;   // a click, not a drag
  // A real drag just ended. The browser will now fire a `click` on #stage-bg
  // (pointerdown+pointerup on the same element), and the clear-selection handler
  // below would wipe the selection we are about to make. Suppress that one click.
  suppressNextClear = true;
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

// --- keyboard ---
// Shortcut order matters: the ones that must work with NOTHING selected
// (select-all, escape) are handled before the "needs a selection" guard.
const BIG_NUDGE = 5;   // squares moved per Shift+arrow

document.addEventListener('keydown', (e) => {
  // Never hijack typing in a form field.
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (!scene) return;

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

function joinRoom() {
  socket.emit('campaign:join', { campaign_id: campaignId }, (ack) => {
    joinedRoom = !!(ack && ack.ok);
    log(joinedRoom ? `joined room campaign:${campaignId}` : `join failed: ${ack && ack.error}`);
    if (joinedRoom) fetchOwner();
  });
}
async function fetchOwner() {
  const r = await api('GET', `/api/campaigns/${campaignId}`);
  if (r.status === 200) currentCampaignOwnerId = r.data.campaign.owner_id;
  for (const entry of tokens.values()) paintToken(entry);
}

whoami();
