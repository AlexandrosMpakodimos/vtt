// Dev harness for the M2 canvas. External file (the CSP is script-src 'self',
// so no inline <script> or on*= handlers). Function over form, same spirit as
// dashboard.html — but tokens actually render and drag, and a drop persists +
// broadcasts.
//
// Movement model: ON DROP, not streamed. The token follows the pointer locally
// during a drag (cheap, no network), and exactly one token:move is emitted when
// the pointer is released. Live-drag streaming (emitting intermediate positions)
// is a deliberate later optimisation and is NOT done here.

const out = document.getElementById('out');
const logEl = document.getElementById('log');
const stage = document.getElementById('stage');
const stageBg = document.getElementById('stage-bg');

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
let scene = null;              // the open scene row
let joinedRoom = false;
const tokens = new Map();      // token_id -> { row, el }
const GRID_PX = 50;            // one grid unit = 50px on screen

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
  show(`GET scenes → ${r.status}`, r.data);
  const box = document.getElementById('scene-list');
  box.textContent = '';
  if (r.status !== 200) return;
  if (r.data.scenes.length === 0) {
    box.appendChild(document.createTextNode('no scenes yet — create one (GM only)'));
    return;
  }
  for (const s of r.data.scenes) {
    const b = document.createElement('button');
    b.textContent = `open: ${s.name} (${s.width}×${s.height})`;
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
  show(`create scene → ${r.status}`, r.data);
  if (r.status === 201) loadScenes();
});

// --- open a scene: full load, then join the room for live deltas ---
async function openScene(sceneId) {
  const r = await api('GET', `/api/campaigns/${campaignId}/scenes/${sceneId}`);
  show(`open scene → ${r.status}`, { scene: r.data.scene, tokenCount: r.data.tokens && r.data.tokens.length });
  if (r.status !== 200) return;

  scene = r.data.scene;
  document.getElementById('scene-title').textContent = `— ${scene.name}`;

  // Size the stage to the scene's pixel dimensions; paint the background image
  // and a grid overlay.
  stage.style.width = scene.width + 'px';
  stage.style.height = scene.height + 'px';
  stageBg.style.backgroundImage = scene.img_url ? `url("${CSS.escape(scene.img_url)}")` : 'none';
  stage.style.backgroundImage =
    'linear-gradient(#3a3a3a 1px, transparent 1px), linear-gradient(90deg, #3a3a3a 1px, transparent 1px)';
  stage.style.backgroundSize = `${GRID_PX}px ${GRID_PX}px`;

  // Clear and re-render tokens.
  for (const { el } of tokens.values()) el.remove();
  tokens.clear();
  for (const t of r.data.tokens) upsertToken(t);

  // Join the campaign room so token:created / token:moved / token:deleted arrive.
  if (!joinedRoom) joinRoom();
}

// --- token rendering ---
function upsertToken(row) {
  let entry = tokens.get(row.id);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'token';
    const cap = document.createElement('div');
    cap.className = 'cap';
    el.appendChild(cap);
    attachDrag(el, row.id);
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
  // A green border marks a token this client is allowed to move: your own, or
  // anything if you're the GM. Purely a hint — the server is the real authority.
  const canMove = scene && (me && (isGm() || row.created_by === me.id));
  el.classList.toggle('mine', !!canMove);
  el.dataset.locked = row.locked ? '1' : '';
}

function isGm() {
  // Cheap client-side hint; server re-derives from owner_id on every write.
  return currentCampaignOwnerId && me && currentCampaignOwnerId === me.id;
}
let currentCampaignOwnerId = null;

// --- placement ---
document.getElementById('place-token').addEventListener('click', async () => {
  if (!scene) return show('open a scene first');
  const name = document.getElementById('tok-name').value.trim();
  const img_url = document.getElementById('tok-img').value.trim();
  const r = await api('POST', `/api/campaigns/${campaignId}/scenes/${scene.id}/tokens`,
    { name, img_url: img_url || undefined, x: 0, y: 0 });
  show(`place token → ${r.status}`, r.data);
  // No local upsert here: the server broadcasts token:created to the room
  // (including us), and that handler renders it — one code path for everyone.
});

// --- drag to move; emit ONE token:move on drop ---
function attachDrag(el, tokenId) {
  let dragging = false;
  let startX = 0, startY = 0, originLeft = 0, originTop = 0;

  el.addEventListener('pointerdown', (e) => {
    const entry = tokens.get(tokenId);
    if (!entry) return;
    // Client-side gate mirrors the server rule so a forbidden token simply
    // doesn't pick up. The server still enforces it regardless.
    const canMove = me && (isGm() || entry.row.created_by === me.id);
    if (!canMove || entry.row.locked) return;

    dragging = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    startX = e.clientX; startY = e.clientY;
    originLeft = parseFloat(el.style.left) || 0;
    originTop = parseFloat(el.style.top) || 0;
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // Local-only follow: no network traffic during the drag.
    el.style.left = (originLeft + (e.clientX - startX)) + 'px';
    el.style.top = (originTop + (e.clientY - startY)) + 'px';
  });

  el.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    el.releasePointerCapture(e.pointerId);

    // Snap pixels back to grid units and emit exactly one move.
    const gx = Math.round((parseFloat(el.style.left) || 0) / GRID_PX);
    const gy = Math.round((parseFloat(el.style.top) || 0) / GRID_PX);
    emitMove(tokenId, gx, gy);
  });
}

function emitMove(tokenId, x, y) {
  socket.emit('token:move',
    { campaign_id: campaignId, scene_id: scene.id, token_id: tokenId, x, y },
    (ack) => {
      if (ack && ack.ok) {
        log(`moved ${tokenId.slice(0, 8)} → (${x},${y})`);
        // The authoritative row also comes back via the token:moved broadcast;
        // painting from the ack keeps the mover snappy without waiting for it.
        upsertToken(ack.token);
      } else {
        log(`move refused: ${ack && ack.error}`);
        // Server said no — repaint from our last known good row to snap back.
        const entry = tokens.get(tokenId);
        if (entry) paintToken(entry);
      }
    });
}

// --- socket wiring ---
const socket = io({ withCredentials: true });
socket.on('connect', () => log(`socket connected (${socket.id})`));
socket.on('unauthorized', (d) => log(`UNAUTHORIZED: ${d.error} — log in first`));
socket.on('disconnect', (r) => log(`socket disconnected: ${r}`));
socket.on('campaign:evicted', (d) => log(`EVICTED from ${d.campaign_id} (${d.reason})`));

socket.on('token:created', (t) => {
  if (!scene || t.scene_id !== scene.id) return;
  log(`+ token ${t.name || '(token)'} placed`);
  upsertToken(t);
});
socket.on('token:moved', (t) => {
  if (!scene || t.scene_id !== scene.id) return;
  const entry = tokens.get(t.id);
  // Ignore the echo of our own just-acked move (we already painted it), but
  // still apply if the server adjusted it.
  upsertToken(t);
  if (!entry) log(`token ${t.id.slice(0, 8)} appeared at (${t.x},${t.y})`);
});
socket.on('token:deleted', (d) => {
  const entry = tokens.get(d.id);
  if (entry) { entry.el.remove(); tokens.delete(d.id); log(`- token removed`); }
});

function joinRoom() {
  socket.emit('campaign:join', { campaign_id: campaignId }, (ack) => {
    joinedRoom = !!(ack && ack.ok);
    log(joinedRoom ? `joined room campaign:${campaignId}` : `join failed: ${ack && ack.error}`);
    // Grab owner_id so the GM hint works, via the campaign detail endpoint.
    if (joinedRoom) fetchOwner();
  });
}
async function fetchOwner() {
  const r = await api('GET', `/api/campaigns/${campaignId}`);
  if (r.status === 200) currentCampaignOwnerId = r.data.campaign.owner_id;
  // Repaint hints now that we know who the GM is.
  for (const entry of tokens.values()) paintToken(entry);
}

whoami();
