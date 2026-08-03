// Dev harness for M5 — combat, chat, dice.
//
// Same constraints as actors.js and for the same reasons: the CSP is
// `script-src 'self'`, so this lives in an external file, is built with
// createElement + addEventListener, and every server-supplied string reaches the
// DOM through `textContent`. Token and character names are stored RAW
// server-side (the canvas audit's standing note), so this file must NEVER switch
// to innerHTML.
//
// Deliberately a SEPARATE page from scene.html, exactly as actors.html is. The
// four jsdom suites (test-shortcuts, test-marquee, test-fog-ui, test-bulk-place)
// `eval` the real scene.html/scene.js, so keeping the tracker out of those files
// leaves 134 assertions untouched. Chat arguably belongs beside the canvas; that
// is a UX compromise the real M6 frontend resolves.
//
// ---------------------------------------------------------------------------
// WHY THE ROSTER IS JOINED CLIENT-SIDE, AND WHAT THAT MAKES VISIBLE
// ---------------------------------------------------------------------------
// A combatant payload carries only `token_id` — no name, no portrait, no
// position. That is a server-side decision (see routes/combat.js): the token
// projection exists in exactly ONE place, so there is no second copy here to
// drift or leak. This page therefore joins combatants against the tokens it
// already holds from the scene load.
//
// That join is also a live integrity check, and it is the most useful thing this
// harness does. Every combatant that legitimately reaches a recipient names a
// token that recipient also has, because BOTH are filtered by the same rule. So
// a card rendered in red as "no token" means a combatant arrived for a token
// that did not — which is precisely the disclosure failure break-combat.js's D1
// probes assert against. If the strip ever shows a red card on a player's
// screen, that is a finding, not a rendering bug.

const out = document.getElementById('out');
const logEl = document.getElementById('log');
const stripEl = document.getElementById('strip');
const chatEl = document.getElementById('chat');

function show(label, r) {
  out.textContent = `${label}  →  ${r.status}\n` + JSON.stringify(r.data, null, 2);
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

function el(tag, opts = {}) {
  const n = document.createElement(tag);
  if (opts.text !== undefined) n.textContent = opts.text;
  if (opts.cls) n.className = opts.cls;
  return n;
}
function button(label, handler) {
  const b = el('button', { text: label });
  b.addEventListener('click', handler);
  return b;
}
function str(id) {
  const v = document.getElementById(id).value.trim();
  return v === '' ? undefined : v;
}

let me = null;
let campaign = null;
let isGm = false;
let scenes = [];
let sceneId = null;
let tokens = [];          // tokens of the loaded scene, as THIS role receives them
let actorsById = new Map();
let combat = null;
let combatants = [];
let members = [];
let socket = null;

async function whoami() {
  const r = await api('GET', '/api/auth/me');
  me = r.status === 200 ? r.data.user : null;
  document.getElementById('whoami').textContent = me
    ? `logged in as ${me.username}`
    : 'NOT logged in';
}

// ---------------------------------------------------------------------------
// rendering — the initiative strip
// ---------------------------------------------------------------------------

function tokenFor(id) { return tokens.find((t) => t.id === id) || null; }

function hpLine(c, token) {
  // Three distinct states, deliberately distinguishable on screen because they
  // are distinguishable in the data:
  //   a number the GM has published  -> green
  //   a number only the GM can see   -> purple, GM's screen only
  //   no per-fight HP at all         -> grey
  // A player NEVER sees the purple case: hp_visible false means the key is
  // simply absent from their payload, so `hp_override === undefined` here.
  if (c.hp_override === undefined) {
    return { text: 'hp —', cls: 'none', frac: null };
  }
  if (c.hp_override === null) {
    return { text: 'hp: sheet', cls: 'none', frac: null };
  }
  const actor = token && token.actor_id ? actorsById.get(token.actor_id) : null;
  // max comes from the SHARED actor: five goblin tokens have five different
  // currents and one maximum, which is why no hp_override_max column exists.
  const max = actor && typeof actor.hp_max === 'number' && actor.hp_max > 0 ? actor.hp_max : null;
  const cls = (isGm && c.hp_visible === false) ? 'secret' : 'shown';
  return {
    text: max ? `${c.hp_override} / ${max}` : `hp ${c.hp_override}`,
    cls,
    frac: max ? Math.max(0, Math.min(1, c.hp_override / max)) : null,
  };
}

function renderStrip() {
  stripEl.textContent = '';
  if (!combat) {
    stripEl.appendChild(el('p', { cls: 'muted', text: 'no encounter running' }));
    document.getElementById('rosterInfo').textContent = '—';
    return;
  }

  let orphans = 0;
  combatants.forEach((c, i) => {
    const token = tokenFor(c.token_id);
    if (!token) orphans += 1;

    const card = el('div', { cls: 'combatant' + (token ? '' : ' orphan') });
    card.draggable = isGm;
    card.dataset.id = c.id;

    card.appendChild(el('span', { cls: 'pos', text: String(i + 1) }));

    const img = token && token.img_url;
    if (img) {
      const im = document.createElement('img');
      im.className = 'portrait';
      im.src = img;            // attribute, not markup — no parsing context
      im.alt = '';
      card.appendChild(im);
    } else {
      card.appendChild(el('div', { cls: 'noimg', text: token ? '⚔' : '⚠' }));
    }

    card.appendChild(el('div', { cls: 'nm', text: token ? (token.name || '(unnamed)') : 'NO TOKEN' }));

    const hp = hpLine(c, token);
    card.appendChild(el('div', { cls: `hp ${hp.cls}`, text: hp.text }));
    if (hp.frac !== null) {
      const bar = el('div', { cls: 'bar' });
      const fill = el('i');
      fill.style.width = `${Math.round(hp.frac * 100)}%`;
      if (hp.frac < 0.34) fill.className = 'low';
      bar.appendChild(fill);
      card.appendChild(bar);
    }

    if (isGm) {
      card.addEventListener('click', () => selectCombatant(c.id));
      wireDrag(card);
    }
    stripEl.appendChild(card);
  });

  const info = `${combatants.length} combatant(s)`
    + (orphans ? `  —  ${orphans} WITH NO TOKEN (see the header comment: this is a finding)` : '');
  const infoEl = document.getElementById('rosterInfo');
  infoEl.textContent = info;
  infoEl.className = orphans ? 'warn' : 'muted';
  updateNav();
}

// ---- drag to reorder ------------------------------------------------------
// The server takes the COMPLETE ordered id list and validates it as a
// permutation, so this always sends every id — a partial list is refused by
// design (a half-written order leaves gaps the next drag compounds).

let dragId = null;

function wireDrag(card) {
  card.addEventListener('dragstart', (e) => {
    dragId = card.dataset.id;
    card.classList.add('drag-src');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag without payload.
    e.dataTransfer.setData('text/plain', card.dataset.id);
  });
  card.addEventListener('dragend', () => {
    dragId = null;
    card.classList.remove('drag-src');
    [...stripEl.children].forEach((n) => n.classList.remove('drag-over'));
  });
  card.addEventListener('dragover', (e) => {
    if (!dragId || dragId === card.dataset.id) return;
    e.preventDefault();
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    if (!dragId || dragId === card.dataset.id) return;

    const ids = combatants.map((c) => c.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(card.dataset.id);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);

    const r = await api('POST', `${combatPath()}/reorder`, { combatant_ids: ids });
    show('POST reorder', r);
    if (r.status === 200) { combatants = r.data.combatants; renderStrip(); }
  });
}

// ---- carousel -------------------------------------------------------------
// Arrows plus pointer-drag-to-scroll on the strip BACKGROUND. The two drag
// modes never collide: HTML5 dragstart on a card takes precedence over the
// pointer handler below, so dragging a card reorders and dragging the gaps
// scrolls.

let panning = false; let panX = 0; let panScroll = 0;

stripEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.combatant')) return;   // that is a reorder, not a pan
  panning = true;
  panX = e.clientX;
  panScroll = stripEl.scrollLeft;
  stripEl.classList.add('dragging');
  stripEl.setPointerCapture(e.pointerId);
});
stripEl.addEventListener('pointermove', (e) => {
  if (!panning) return;
  stripEl.scrollLeft = panScroll - (e.clientX - panX);
});
function endPan(e) {
  if (!panning) return;
  panning = false;
  stripEl.classList.remove('dragging');
  try { stripEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  updateNav();
}
stripEl.addEventListener('pointerup', endPan);
stripEl.addEventListener('pointercancel', endPan);

// A vertical wheel over a horizontal strip should scroll it sideways.
stripEl.addEventListener('wheel', (e) => {
  if (e.deltaY === 0) return;
  e.preventDefault();
  stripEl.scrollLeft += e.deltaY;
  updateNav();
}, { passive: false });

stripEl.addEventListener('scroll', updateNav);

function page(dir) {
  stripEl.scrollLeft += dir * Math.max(200, stripEl.clientWidth - 120);
}
function updateNav() {
  const maxScroll = stripEl.scrollWidth - stripEl.clientWidth;
  document.getElementById('scrollLeft').disabled = stripEl.scrollLeft <= 2;
  document.getElementById('scrollRight').disabled = stripEl.scrollLeft >= maxScroll - 2;
}

// ---- the selected combatant (GM only) -------------------------------------

function selectCombatant(id) {
  const c = combatants.find((x) => x.id === id);
  const box = document.getElementById('selected');
  box.textContent = '';
  if (!c) return;
  const token = tokenFor(c.token_id);

  box.appendChild(el('hr'));
  box.appendChild(el('b', { text: token ? (token.name || '(unnamed)') : 'NO TOKEN' }));

  const row = el('div', { cls: 'row' });

  const hpWrap = el('div');
  hpWrap.appendChild(el('label', { text: 'hp_override (this fight only)' }));
  const hpIn = document.createElement('input');
  hpIn.type = 'number';
  hpIn.value = c.hp_override === null || c.hp_override === undefined ? '' : String(c.hp_override);
  hpWrap.appendChild(hpIn);
  row.appendChild(hpWrap);

  const visWrap = el('div');
  visWrap.appendChild(el('label', { text: 'hp_visible (players may see it)' }));
  const visIn = document.createElement('input');
  visIn.type = 'checkbox';
  visIn.style.width = 'auto';
  visIn.checked = c.hp_visible === true;
  visWrap.appendChild(visIn);
  row.appendChild(visWrap);

  row.appendChild(button('save', async () => {
    const body = {};
    body.hp_override = hpIn.value === '' ? null : Number(hpIn.value);
    body.hp_visible = visIn.checked;
    const r = await api('PATCH', `${combatPath()}/combatants/${c.id}`, body);
    show('PATCH combatant', r);
    await loadCombat();
  }));

  row.appendChild(button('remove from fight', async () => {
    // The ROW only — the token stays on the board. The durable alternative is
    // tagging the token a prop, which follows it into every future encounter.
    const r = await api('DELETE', `${combatPath()}/combatants/${c.id}`);
    show('DELETE combatant', r);
    await loadCombat();
  }));

  box.appendChild(row);
  box.appendChild(el('p', {
    cls: 'muted',
    text: 'hp_visible governs THIS number only. The linked character\'s own hit points stay '
        + 'behind the NPC projection — five goblin tokens share one actor row, so a '
        + 'per-combatant switch could not disclose a per-actor value coherently.',
  }));
}

// ---------------------------------------------------------------------------
// rendering — tokens and chat
// ---------------------------------------------------------------------------

function renderTokens() {
  const box = document.getElementById('tokens');
  box.textContent = '';
  if (!tokens.length) {
    box.appendChild(el('p', { cls: 'muted', text: 'no tokens on this scene' }));
    return;
  }
  const inFight = new Set(combatants.map((c) => c.token_id));
  for (const t of tokens) {
    const row = el('div', { cls: 'tok' });
    if (t.img_url) {
      const im = document.createElement('img');
      im.src = t.img_url; im.alt = '';
      row.appendChild(im);
    } else {
      row.appendChild(el('span', { text: '▢' }));
    }
    const nm = el('span', { cls: 'grow', text: t.name || '(unnamed)' });
    row.appendChild(nm);
    if (t.is_prop) row.appendChild(el('span', { cls: 'tag prop', text: 'prop' }));
    if (t.hidden) row.appendChild(el('span', { cls: 'tag hidden', text: 'hidden' }));
    row.appendChild(el('span', { cls: 'muted', text: inFight.has(t.id) ? 'in fight' : '—' }));

    if (isGm) {
      row.appendChild(button(t.is_prop ? 'un-prop' : 'make prop', async () => {
        const r = await api('PATCH', `/api/campaigns/${campaign.id}/scenes/${sceneId}/tokens/${t.id}`,
          { is_prop: !t.is_prop });
        show('PATCH token is_prop', r);
        await loadScene();
        await loadCombat();
      }));
      if (combat && combat.active && !inFight.has(t.id)) {
        row.appendChild(button('add', async () => {
          const r = await api('POST', `${combatPath()}/combatants`, { token_id: t.id });
          show('POST combatant', r);
          await loadCombat();
        }));
      }
    }
    box.appendChild(row);
  }
}

function renderMessage(m) {
  const cls = 'msg'
    + (m.whisper_to && m.whisper_to.length ? ' whisper' : '')
    + (m.roll_data ? ' roll' : '');
  const row = el('div', { cls });
  row.appendChild(el('span', { cls: 'who', text: `${m.speaker_name || 'someone'}: ` }));
  if (m.content) row.appendChild(el('span', { text: m.content }));
  if (m.roll_data) {
    row.appendChild(el('span', {
      cls: 'res',
      text: ` ${m.roll_data.formula} → [${m.roll_data.results.join(', ')}] = ${m.roll_data.total}`,
    }));
  }
  if (m.whisper_to && m.whisper_to.length) {
    row.appendChild(el('span', { cls: 'meta', text: `  (whisper ×${m.whisper_to.length})` }));
  }
  chatEl.appendChild(row);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

function combatPath() { return `/api/campaigns/${campaign.id}/combat/${combat.id}`; }

async function loadCampaign() {
  const id = str('campaignId');
  if (!id) return;
  const r = await api('GET', `/api/campaigns/${id}`);
  show('GET campaign', r);
  if (r.status !== 200) {
    document.getElementById('campaignInfo').textContent = 'could not load that campaign';
    return;
  }
  campaign = r.data.campaign;
  isGm = campaign.is_gm === true;
  document.body.classList.toggle('is-gm', isGm);
  document.getElementById('campaignInfo').textContent =
    `${campaign.name} — you are ${isGm ? 'the GM' : 'a player'}`;

  const s = await api('GET', `/api/campaigns/${campaign.id}/scenes`);
  scenes = s.status === 200 ? (s.data.scenes || []) : [];
  const sel = document.getElementById('sceneSel');
  sel.textContent = '';
  for (const sc of scenes) {
    const o = document.createElement('option');
    o.value = sc.id;
    o.textContent = sc.name + (campaign.active_scene_id === sc.id ? '  (active)' : '');
    sel.appendChild(o);
  }
  // Default to the active scene — for a player it is the ONLY one they will see.
  sceneId = campaign.active_scene_id || (scenes[0] && scenes[0].id) || null;
  if (sceneId) sel.value = sceneId;

  await loadMembers();
  await loadScene();
  await loadCombat();
  await loadMessages();
  connectSocket();
}

async function loadMembers() {
  // Whisper targets. A player cannot read manage-players, so fall back to the
  // people who have actually spoken — enough for a harness, and it avoids
  // inventing a members endpoint the milestone does not have.
  members = [];
  if (isGm) {
    const r = await api('GET', `/api/campaigns/${campaign.id}/manage-players`);
    if (r.status === 200) members = (r.data.members || []).map((m) => ({ id: m.user_id, name: m.username }));
  }
  renderWhisperTargets();
}

function renderWhisperTargets() {
  const sel = document.getElementById('whisperTo');
  const chosen = new Set([...sel.selectedOptions].map((o) => o.value));
  sel.textContent = '';
  for (const m of members) {
    if (!m.id || m.id === (me && me.id)) continue;
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name || m.id;
    if (chosen.has(m.id)) o.selected = true;
    sel.appendChild(o);
  }
}

async function loadScene() {
  if (!sceneId) { tokens = []; actorsById = new Map(); renderTokens(); return; }
  const r = await api('GET', `/api/campaigns/${campaign.id}/scenes/${sceneId}`);
  if (r.status !== 200) {
    // For a player this is the expected answer for any non-active scene, and it
    // is 404 rather than 403 on purpose — no map enumeration.
    tokens = []; actorsById = new Map(); renderTokens();
    document.getElementById('combatInfo').textContent =
      `scene not readable (${r.status}) — players only reach the active scene`;
    return;
  }
  tokens = r.data.tokens || [];
  actorsById = new Map((r.data.actors || []).map((a) => [a.id, a]));
  renderTokens();
}

async function loadCombat() {
  combat = null; combatants = [];
  const list = await api('GET', `/api/campaigns/${campaign.id}/combat`);
  const all = list.status === 200 ? (list.data.combats || []) : [];
  const here = all.filter((c) => c.scene_id === sceneId);
  const running = here.find((c) => c.active) || here[0] || null;

  if (running) {
    const r = await api('GET', `/api/campaigns/${campaign.id}/combat/${running.id}`);
    if (r.status === 200) {
      combat = r.data.combat;
      combatants = r.data.combatants || [];
      // The roster's characters, shaped for THIS role. Merged rather than
      // replaced so a character learned from the scene load is not lost.
      for (const a of (r.data.actors || [])) actorsById.set(a.id, a);
    }
  }
  document.getElementById('combatInfo').textContent = combat
    ? `${combat.name || '(unnamed)'} — ${combat.active ? 'RUNNING' : 'ended'} — ${combatants.length} combatant(s)`
    : `no encounter on this scene${all.length && isGm ? ` (${all.length} elsewhere in this campaign)` : ''}`;
  renderStrip();
  renderTokens();
}

async function loadMessages() {
  chatEl.textContent = '';
  const r = await api('GET', `/api/campaigns/${campaign.id}/messages?limit=50`);
  if (r.status !== 200) return;
  for (const m of (r.data.messages || [])) renderMessage(m);
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function startCombat() {
  const r = await api('POST', `/api/campaigns/${campaign.id}/combat`, {
    scene_id: sceneId, name: str('combatName'),
  });
  show('POST combat', r);
  await loadCombat();
}

async function endCombat() {
  if (!combat) return;
  const r = await api('PATCH', combatPath(), { active: false });
  show('PATCH combat (end)', r);
  await loadCombat();
}

async function deleteCombat() {
  if (!combat) return;
  const r = await api('DELETE', combatPath());
  show('DELETE combat', r);
  await loadCombat();
}

async function placeToken() {
  const r = await api('POST', `/api/campaigns/${campaign.id}/scenes/${sceneId}/tokens`, {
    name: str('tokName') || 'Token',
    x: Math.floor(Math.random() * 10),
    y: Math.floor(Math.random() * 10),
    is_prop: document.getElementById('tokProp').checked,
  });
  show('POST token', r);
  await loadScene();
  await loadCombat();
}

function whisperTargets() {
  const sel = document.getElementById('whisperTo');
  const ids = [...sel.selectedOptions].map((o) => o.value);
  return ids.length ? ids : undefined;
}

async function sendChat() {
  const content = str('chatText');
  if (!content) return;
  const r = await api('POST', `/api/campaigns/${campaign.id}/messages`, {
    content, whisper_to: whisperTargets(),
  });
  show('POST message', r);
  if (r.status === 201) document.getElementById('chatText').value = '';
}

async function sendRoll() {
  const r = await api('POST', `/api/campaigns/${campaign.id}/messages`, {
    formula: str('diceFormula'),
    content: str('diceLabel'),
    whisper_to: whisperTargets(),
  });
  show('POST roll', r);
}

// ---------------------------------------------------------------------------
// sockets — the point of the harness
// ---------------------------------------------------------------------------

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ withCredentials: true });

  socket.on('connect', () => {
    socket.emit('campaign:join', { campaign_id: campaign.id }, (ack) => {
      log(ack && ack.ok ? `joined room for ${campaign.name}` : `room join refused: ${JSON.stringify(ack)}`);
    });
  });

  // Printed VERBATIM and un-prettified on purpose. The GM's combat:updated
  // carries every combatant including hidden-token ones, each with hp_override
  // and hp_visible. The player's carries a DIFFERENT NUMBER OF ROWS — hidden
  // ones are dropped entirely rather than blanked, because seven rows against
  // four visible tokens would itself disclose the ambush — and no hp_override
  // at all unless the GM published it. Reading the two logs side by side is more
  // convincing than any assertion.
  socket.on('combat:updated', (d) => {
    log(`combat:updated  ${JSON.stringify(d)}`);
    if (combat && d.combat && d.combat.id === combat.id) {
      combat = d.combat;
      combatants = d.combatants || [];
      renderStrip();
      renderTokens();
    } else {
      loadCombat();
    }
  });

  socket.on('combat:deleted', (d) => {
    log(`combat:deleted  ${JSON.stringify(d)}`);
    loadCombat();
  });

  // A whisper arrives ONLY for its named recipients and its sender. If a message
  // appears in one window and not another, that is the rule working.
  socket.on('message:created', (d) => {
    log(`message:created  ${JSON.stringify(d)}`);
    renderMessage(d);
    // Learn speakers, so a player can whisper back without a members endpoint.
    if (d.user_id && d.user_id !== (me && me.id) && !members.some((m) => m.id === d.user_id)) {
      members.push({ id: d.user_id, name: d.speaker_name });
      renderWhisperTargets();
    }
  });

  for (const ev of ['token:created', 'token:updated', 'token:deleted', 'token:deleted-batch']) {
    socket.on(ev, (d) => {
      log(`${ev}  ${JSON.stringify(d)}`);
      loadScene().then(loadCombat);
    });
  }

  socket.on('scene:activated', (d) => {
    log(`scene:activated  ${JSON.stringify(d)}`);
    if (campaign) campaign.active_scene_id = d.scene_id;
    if (!isGm) { sceneId = d.scene_id; loadScene().then(loadCombat); }
  });

  socket.on('disconnect', () => log('socket disconnected'));
}

// ---------------------------------------------------------------------------

document.getElementById('loadCampaign').addEventListener('click', loadCampaign);
document.getElementById('startCombat').addEventListener('click', startCombat);
document.getElementById('endCombat').addEventListener('click', endCombat);
document.getElementById('deleteCombat').addEventListener('click', deleteCombat);
document.getElementById('placeToken').addEventListener('click', placeToken);
document.getElementById('sendChat').addEventListener('click', sendChat);
document.getElementById('sendRoll').addEventListener('click', sendRoll);
document.getElementById('clearLog').addEventListener('click', () => { logEl.textContent = ''; });
document.getElementById('scrollLeft').addEventListener('click', () => page(-1));
document.getElementById('scrollRight').addEventListener('click', () => page(1));
document.getElementById('chatText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});
document.getElementById('diceFormula').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendRoll();
});
document.getElementById('sceneSel').addEventListener('change', async (e) => {
  sceneId = e.target.value;
  await loadScene();
  await loadCombat();
});

// Convenience: /combat.html?campaign=<uuid> preloads, so the GM and player
// windows can be opened from the same link.
const preset = new URLSearchParams(window.location.search).get('campaign');
if (preset) document.getElementById('campaignId').value = preset;

whoami().then(() => { if (preset) loadCampaign(); });
