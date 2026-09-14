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

// Rendered chat rows kept in the DOM. The server's history endpoint caps a page
// at 100, so this is comfortably more than one page.
const MAX_CHAT_ROWS = 300;

function show(label, r) {
  out.textContent = `${label}  →  ${r.status}\n` + JSON.stringify(r.data, null, 2);
}
// [FINDING, fixed 2026-08-03] The socket log grew without bound: every event
// appended to one string that was never trimmed. 50,000 events is ~3 MB of
// string, re-rendered and re-scrolled on every append. A long session at a busy
// table degrades the page on its own, with no attacker involved — and the log is
// the harness's main diagnostic surface, so it dying quietly is the worst way
// for it to fail.
const MAX_LOG_LINES = 500;
let logLines = [];
function log(msg) {
  logLines.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  // Keep the most RECENT: when diagnosing, the tail is what matters.
  if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES);
  logEl.textContent = logLines.join('\n') + '\n';
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
  const el = document.getElementById(id);
  const v = el ? el.value.trim() : '';
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
// User ids currently connected to the game room (maintained by the presence
// socket events). Everyone in `members` is shown in the accordion; those in this
// set get the "connected" indicator.
let onlineUsers = new Set();
let presenceExpanded = true;
let socket = null;
let dice3d = null;        // window.VTTDice once the ES module has loaded
let dice3dOn = true;

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
  const zone = document.getElementById('stripZone');
  const railBtn = document.getElementById('railEncounter');
  const running = !!(combat && combat.active);
  // The rail Encounter button reflects the toggle state: pressed while an
  // encounter is running.
  if (railBtn) railBtn.setAttribute('aria-pressed', running ? 'true' : 'false');
  // The strip is only shown while an encounter is actively RUNNING — no
  // permanent bar at the top for an idle scene or an ended encounter.
  if (!running) {
    if (zone) zone.setAttribute('hidden', '');
    document.getElementById('rosterInfo').textContent = '—';
    if (window.VTTScene && window.VTTScene.highlightToken) window.VTTScene.highlightToken(null);
    return;
  }
  if (zone) zone.removeAttribute('hidden');

  // Round + active-turn pointer. turn_index indexes the roster in render order
  // (sort_order). Clamp defensively for display.
  const roundEl = document.getElementById('roundNum');
  if (roundEl) roundEl.textContent = String(combat.round || 1);
  const activeIdx = combatants.length
    ? Math.max(0, Math.min(combat.turn_index || 0, combatants.length - 1))
    : 0;
  // Also highlight the active combatant's TOKEN on the canvas (scene.js owns the
  // token elements; we hand it the id).
  const activeTokenId = combatants.length ? combatants[activeIdx].token_id : null;
  if (window.VTTScene && window.VTTScene.highlightToken) window.VTTScene.highlightToken(activeTokenId);

  let orphans = 0;
  combatants.forEach((c, i) => {
    const token = tokenFor(c.token_id);
    if (!token) orphans += 1;

    const card = el('div', { cls: 'combatant' + (token ? '' : ' orphan') + (i === activeIdx ? ' is-turn' : '') });
    card.draggable = isGm;
    card.dataset.id = c.id;

    // Position badge (initiative order).
    card.appendChild(el('span', { cls: 'pos', text: String(i + 1) }));

    // Portrait (or a placeholder glyph). Honors the token's framing (offset/zoom)
    // the same way the canvas does, clipped to the slot by a wrapper.
    const img = token && token.img_url;
    if (img) {
      const frame = document.createElement('div');
      frame.className = 'portrait';
      const im = document.createElement('img');
      im.className = 'portrait-img';
      im.src = img;            // attribute, not markup — no parsing context
      im.alt = '';
      im.draggable = false;    // the CARD is the drag source, not the image
      const ox = Number(token.img_offset_x) || 0;
      const oy = Number(token.img_offset_y) || 0;
      const sc = Number(token.img_scale) > 0 ? Number(token.img_scale) : 1;
      im.style.transform = `translate(${ox * 100}%, ${oy * 100}%) scale(${sc})`;
      im.style.transformOrigin = 'center';
      frame.appendChild(im);
      card.appendChild(frame);
    } else {
      card.appendChild(el('div', { cls: 'noimg', text: token ? '⚔' : '⚠' }));
    }

    // Name.
    card.appendChild(el('div', { cls: 'nm', text: token ? (token.name || '(unnamed)') : 'NO TOKEN' }));

    // HP: the GM gets an INLINE editable current-HP with the max beside it
    // (no separate modal); players get a read-only line. Editing PATCHes
    // hp_override for this combatant.
    const hp = hpLine(c, token);
    if (isGm) {
      const hpRow = el('div', { cls: `hp-edit ${hp.cls}` });
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'hp-cur';
      input.value = (c.hp_override === null || c.hp_override === undefined) ? '' : String(c.hp_override);
      input.placeholder = '—';
      input.title = 'Current HP (this fight) — type to change';
      input.setAttribute('aria-label', 'Current HP');
      // Don't start a card drag from inside the input, and don't let clicks
      // bubble to the card's select handler.
      input.draggable = false;
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      const commit = () => saveCombatantHp(c.id, input.value);
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      });
      hpRow.appendChild(input);
      // Max (from the shared actor), shown as "/ max" when known.
      const actor = token && token.actor_id ? actorsById.get(token.actor_id) : null;
      const max = actor && typeof actor.hp_max === 'number' && actor.hp_max > 0 ? actor.hp_max : null;
      hpRow.appendChild(el('span', { cls: 'hp-max', text: max ? `/ ${max}` : '' }));
      card.appendChild(hpRow);
    } else if (hp.cls !== 'none') {
      // Players see an HP line ONLY when there is a concrete number to show.
      // The 'none' states ('hp —' = no per-fight HP, 'hp: sheet' = falls back to
      // the actor sheet) are placeholders that leak "there is something here you
      // can't see"; a player gets nothing rather than that text. The GM still
      // gets both, as real information, via the inline branch above.
      card.appendChild(el('div', { cls: `hp ${hp.cls}`, text: hp.text }));
    }
    if (hp.frac !== null) {
      const bar = el('div', { cls: 'bar' });
      const fill = el('i');
      fill.style.width = `${Math.round(hp.frac * 100)}%`;
      if (hp.frac < 0.34) fill.className = 'low';
      bar.appendChild(fill);
      card.appendChild(bar);
    }

    if (isGm) {
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
  syncHpVisibleToggle();
}

// ---- add combatants via the dim-canvas picker (Stage D) -------------------
// Open scene.js's token-picking mode (dims the canvas, click tokens to choose),
// then add each chosen token to the running combat. Used both when an encounter
// starts and when adding more later. `firstTime` tweaks the wording.
function pickAndAddCombatants(firstTime) {
  if (!combat || !combat.active) return;
  if (!(window.VTTScene && window.VTTScene.pickTokens)) return;
  const inFight = new Set(combatants.map((c) => c.token_id));
  window.VTTScene.pickTokens(
    {
      exclude: inFight,
      hint: firstTime
        ? 'Click the tokens taking part, then confirm.'
        : 'Click tokens to add them to the encounter.',
      confirmLabel: firstTime ? 'Start with these' : 'Add selected',
    },
    async (ids) => {
      if (!ids || !ids.length) return;   // cancelled or nothing chosen
      for (const tokenId of ids) {
        const r = await api('POST', `${combatPath()}/combatants`, { token_id: tokenId });
        show('POST combatant (picker)', r);
      }
      await loadCombat();
    },
  );
}

// ---- turn navigation (Stage C) --------------------------------------------
// Next/Back walk turn_index through the roster; wrapping past the last combatant
// advances the round, and stepping back before the first rewinds it. round never
// drops below 1. The pointer + round live on the combat row, so the PATCH's
// broadcast shows every player the same "round N, X's turn".
async function stepTurn(dir) {
  if (!combat || !combat.active) return;
  const n = combatants.length;
  if (!n) return;
  let round = combat.round || 1;
  let idx = Math.max(0, Math.min(combat.turn_index || 0, n - 1));
  idx += dir;
  if (idx >= n) { idx = 0; round += 1; }               // past the end -> next round
  else if (idx < 0) {                                  // before the start -> prev round
    if (round > 1) { idx = n - 1; round -= 1; }
    else { idx = 0; }                                  // already on round 1, turn 1
  }
  if (round === (combat.round || 1) && idx === (combat.turn_index || 0)) return;
  const r = await api('PATCH', combatPath(), { round, turn_index: idx });
  show('PATCH combat (turn)', r);
  await loadCombat();
}

// ---- inline HP editing + global HP visibility (Stage B) --------------------

// Save a combatant's current HP (hp_override) from an inline card input. Empty
// clears it (falls back to the sheet). Optimistic-ish: we PATCH then reload so
// the bar and roster reflect the server's truth.
async function saveCombatantHp(id, rawValue) {
  const c = combatants.find((x) => x.id === id);
  if (!c) return;
  const v = String(rawValue).trim();
  const next = v === '' ? null : Number(v);
  if (v !== '' && !Number.isFinite(next)) return;   // ignore garbage
  // No-op if unchanged.
  const cur = (c.hp_override === undefined) ? null : c.hp_override;
  if (cur === next) return;
  const r = await api('PATCH', `${combatPath()}/combatants/${id}`, { hp_override: next });
  show('PATCH combatant hp', r);
  await loadCombat();
}

// One toggle governs hp_visible for EVERY combatant — the GM decides, per fight,
// whether players see HP numbers, rather than per-card. Applied to all rows.
async function setHpVisibleAll(visible) {
  if (!combat) return;
  for (const c of combatants) {
    if (c.hp_visible === visible) continue;
    await api('PATCH', `${combatPath()}/combatants/${c.id}`, { hp_visible: visible });
  }
  await loadCombat();
}

// Reflect the current roster's HP-visibility on the toggle (checked only if
// every combatant is visible).
function syncHpVisibleToggle() {
  const t = document.getElementById('hpVisibleAll');
  if (!t) return;
  t.checked = combatants.length > 0 && combatants.every((c) => c.hp_visible === true);
}

// ---- drag to reorder ------------------------------------------------------
// The server takes the COMPLETE ordered id list and validates it as a
// permutation, so this always sends every id — a partial list is refused by
// design (a half-written order leaves gaps the next drag compounds).

let dragId = null;
let droppedInStrip = false;   // set true when a card is dropped onto/within the
                              // strip (a reorder); if it stays false at dragend
                              // the card was dragged AWAY -> remove that combatant

function wireDrag(card) {
  card.addEventListener('dragstart', (e) => {
    dragId = card.dataset.id;
    droppedInStrip = false;   // reset; a drop on the strip sets this true
    card.classList.add('drag-src');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag without payload.
    e.dataTransfer.setData('text/plain', card.dataset.id);

    // The ghost is the WHOLE CARD, stated rather than inferred. Without this
    // the browser picks a drag image from whatever element the gesture began
    // on, which is how grabbing the portrait produced a floating picture.
    //
    // The offset keeps the card under the cursor exactly where it was grabbed —
    // passing 0,0 would snap the card's corner to the pointer and make it jump
    // the moment the drag starts.
    if (e.dataTransfer.setDragImage) {
      const r = card.getBoundingClientRect();
      e.dataTransfer.setDragImage(card, e.clientX - r.left, e.clientY - r.top);
    }
  });
  card.addEventListener('dragend', async () => {
    const id = card.dataset.id;
    const wasInStrip = droppedInStrip;
    dragId = null;
    droppedInStrip = false;
    card.classList.remove('drag-src');
    [...stripEl.children].forEach((n) => n.classList.remove('drag-over'));
    // Dropped AWAY from the strip (not onto another card, not over the strip) —
    // remove the combatant from the encounter. This is the drag-off gesture.
    if (!wasInStrip) removeCombatant(id);
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
    droppedInStrip = true;   // dropped onto a card -> a reorder, not a removal
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

// Remove a combatant from the encounter (the drag-off-the-strip gesture, and the
// selected-panel delete). No confirm — the drag-off gesture is deliberate, and
// a removed combatant is trivially re-added from the Add picker.
async function removeCombatant(id) {
  const c = combatants.find((x) => x.id === id);
  if (!c) return;
  const r = await api('DELETE', `${combatPath()}/combatants/${id}`);
  show('DELETE combatant (drag-off)', r);
  if (r.status === 200) await loadCombat();
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

// (The old per-combatant selectCombatant panel was removed: HP is edited inline
// on each card, HP-visibility is one toggle for the whole roster, and a
// combatant is removed by dragging its card off the strip.)

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
      // Same reason as the roster portraits above: a native image drag would
      // compete with whatever gesture this row is part of.
      im.draggable = false;
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

// A roll that arrives — from my own POST or from anyone else's broadcast —
// animates the numbers the SERVER produced. showRoll returns false when the die
// has no mesh (d5, d7, d30…), in which case the text line below is the whole
// answer, which is exactly what it was before the tray existed.
//
// This is called from renderMessage rather than from the send handlers, so a
// roll animates once per client regardless of who threw it, and a whispered
// roll animates only where the message actually landed — the confidentiality
// rule does that work, not this code.
function animateRoll(m) {
  if (!dice3dOn || !dice3d || !m || !m.roll_data) return;
  // The roller's colour, joined client-side from the member list. A message
  // whose author has left the campaign has no member row, so the colour falls
  // back to the id-derived one rather than the dice silently going grey.
  const api = diceApi();
  const color = colorForUser(m.user_id)
    || (m.user_id && api ? api.stableColorFor(m.user_id) : null);
  dice3d.showRoll(m.roll_data, color);
}

function renderMessage(m) {
  const cls = 'msg'
    + (m.whisper_to && m.whisper_to.length ? ' whisper' : '')
    + (m.roll_data ? ' roll' : '');
  const row = el('div', { cls });
  // "AlexBako (DM)" / "Maria (Aria)" / "Maria (Player)".
  //
  // Read from the ROW, not derived from the current member list: ownership can
  // be transferred, and deriving would relabel every historical line the moment
  // the GM changes. The fallback covers rows written before speaker_role
  // existed — they read as a plain name rather than being asserted to be
  // something they never recorded.
  let tag = '';
  if (m.speaker_as) tag = ` (${m.speaker_as})`;
  else if (m.speaker_role === 'gm') tag = ' (GM)';
  else if (m.speaker_role === 'player') tag = ' (Player)';
  const who = el('span', { cls: 'who', text: `${m.speaker_name || 'someone'}${tag}: ` });
  // Same colour identity in the log as on the dice, but rendered in the variant
  // that reads on the current theme (deeper in light mode, vibrant in dark). The
  // canonical hex is stashed on the node so a live theme toggle can re-resolve
  // every name in place without re-fetching the log (see the theme observer).
  const c = colorForUser(m.user_id);
  if (c) { who.dataset.color = c; who.style.color = colorForTheme(c); }
  row.appendChild(who);
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
  // [FINDING, fixed 2026-08-03] Same unbounded-growth problem as the socket log:
  // one <div> per message, never trimmed. History loads 50 and every live
  // message adds another for as long as the page is open. Trimmed from the top,
  // since chat is read from the bottom.
  while (chatEl.children.length > MAX_CHAT_ROWS) chatEl.removeChild(chatEl.firstChild);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// History replay must NOT re-throw fifty old rolls on page load, so
// animateRoll is wired to the socket path only, never to loadMessages().

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

function combatPath() { return `/api/campaigns/${campaign.id}/combat/${combat.id}`; }

async function loadCampaign(idArg) {
  // Seam: the harness reads the campaign id from the #campaignId input; the game
  // shell passes it in through boot(). str() would throw on a page without the
  // input, so only read it when no id was supplied.
  const id = idArg != null ? idArg : str('campaignId');
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
  await loadSpeakable();
  await loadScene();
  await loadCombat();
  await loadMessages();
  connectSocket();
}

async function loadMembers() {
  // GET /api/campaigns/:id is requireMember and already returns every ACTIVE
  // member with their `color`. The earlier version used manage-players, which is
  // requireOwner — so a player got an empty member list, could not whisper to
  // anyone, and would have had no colours either. Fixed here rather than by
  // adding an endpoint, because the data was already reachable.
  members = [];
  const r = await api('GET', `/api/campaigns/${campaign.id}`);
  if (r.status === 200) {
    members = (r.data.members || []).map((m) => ({
      id: m.user_id,
      name: m.username,
      // campaign_members.color is nullable and nothing forces it at join time,
      // so most members have none. The fallback is derived from the user id, so
      // it is identical in every browser at the table with no coordination.
      color: memberColor(m),
      // The colour actually stored against the membership, as opposed to the
      // id-derived fallback above. The palette must show what is CLAIMED — a
      // generated colour is not a claim and must not grey out a swatch.
      assigned: (diceApi() && diceApi().normalizeHex(m.color)) || null,
      is_gm: m.is_gm,
    }));
  }
  renderWhisperTargets();
  renderLegend();
  renderPalette();
  renderPresence();
}

// Read the bridge at CALL TIME rather than through the `dice3d` variable, which
// is only assigned once `vtt-dice-ready` fires. The ES module is deferred and
// combat.js is not, so the two are ordered only by accident: loadCampaign
// happens to run after a `whoami` round trip today, and a faster cache or a
// reordered <script> would flip it. Load-order luck is not a mechanism.
//
// Caught by test-combat-ui.js on its first run — every member came back grey.
function diceApi() { return window.VTTDice || null; }

function memberColor(m) {
  const api = diceApi();
  if (!api) return '#b0b0b0';
  return api.normalizeHex(m.color) || api.stableColorFor(m.user_id) || '#b0b0b0';
}

function colorForUser(userId) {
  const m = members.find((x) => x.id === userId);
  return m ? m.color : null;
}

// Whisper recipients. Selections are preserved across a re-render so that a
// member list refreshing mid-compose does not silently drop who you were
// whispering to.
function renderWhisperTargets() {
  const sel = document.getElementById('whisperTo');
  if (!sel) return;
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
  // Keep the native selection as the shared API for chat and dice; expose
  // themed checkboxes so multiple recipients need no modifier-key gestures.
  sel.hidden = true;
  let picker = sel.parentElement.querySelector('.whisper-picker');
  if (!picker) {
    picker = document.createElement('details');
    picker.className = 'whisper-picker';
    const summary = document.createElement('summary');
    summary.className = 'vtt-dd-btn';
    summary.setAttribute('aria-label', 'Message recipients');
    picker.appendChild(summary);
    const choices = el('div', { cls: 'whisper-options' });
    picker.appendChild(choices);
    sel.after(picker);
    document.addEventListener('click', (e) => { if (!picker.contains(e.target)) picker.open = false; });
    picker.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { picker.open = false; summary.focus(); }
    });
  }
  const summary = picker.querySelector('summary');
  const choices = picker.querySelector('.whisper-options');
  const refreshLabel = () => {
    const selected = [...sel.selectedOptions];
    summary.textContent = selected.length ? `Whisper · ${selected.map(o => o.textContent).join(', ')}` : 'Everyone';
    summary.title = summary.textContent;
    picker.classList.toggle('is-private', selected.length > 0);
  };
  choices.textContent = '';
  const reset = el('button', { cls: 'btn small secondary', text: 'Everyone — clear whispers' });
  reset.type = 'button';
  reset.addEventListener('click', () => {
    for (const o of sel.options) o.selected = false;
    for (const input of choices.querySelectorAll('input')) input.checked = false;
    refreshLabel();
  });
  choices.appendChild(reset);
  for (const o of sel.options) {
    const label = el('label', { cls: 'whisper-option' });
    const check = document.createElement('input');
    check.type = 'checkbox'; check.checked = o.selected;
    check.addEventListener('change', () => { o.selected = check.checked; refreshLabel(); });
    label.append(check, document.createTextNode(o.textContent));
    choices.appendChild(label);
  }
  if (!sel.options.length) choices.appendChild(el('span', { cls: 'muted', text: 'No other players yet.' }));
  refreshLabel();
}

// Who is which colour. Without this the dice are pretty but unreadable — a
// colour only identifies someone if you can look up what it means.
// A fixed palette rather than a free-form colour input. Twelve well-separated,
// legible colours against a member cap of 8 means exhaustion is not a concern,
// and a swatch grid can show what is TAKEN — which a colour input cannot.
//
// Each colour has TWO tuned variants, because a single hex can't stay legible on
// both a near-black surface and light parchment: `dark` is the vibrant version
// for dark mode, `light` is the deeper/richer version for light mode. The `dark`
// hex is the CANONICAL value — it is what gets stored, claimed, and uniqueness-
// checked — so existing claims keep working and no migration is needed. The
// light-mode partner is looked up only at render time (see colorForTheme).
const PALETTE_PAIRS = [
  { dark: '#f2555a', light: '#aa0005' },  // red
  { dark: '#ff8c42', light: '#a74100' },  // orange
  { dark: '#f5c518', light: '#8c6d00' },  // amber
  { dark: '#9ccc3c', light: '#577d0c' },  // lime
  { dark: '#3fb96a', light: '#126f33' },  // green
  { dark: '#20c4b0', light: '#01796a' },  // teal
  { dark: '#28c0e0', light: '#007189' },  // cyan
  { dark: '#4a90e2', light: '#01489b' },  // sky
  { dark: '#5a6cf0', light: '#0015ac' },  // blue
  { dark: '#9b6ef0', light: '#3f00b6' },  // violet
  { dark: '#c15ee8', light: '#7a00aa' },  // purple
  { dark: '#e055c8', light: '#9c0482' },  // magenta
  { dark: '#f26fa8', light: '#b80050' },  // pink
  { dark: '#d98890', light: '#a01825' },  // rose
  { dark: '#a9744f', light: '#653a1c' },  // brown
  { dark: '#cbb083', light: '#8d6421' },  // tan
  { dark: '#9fb0c4', light: '#355983' },  // slate
  { dark: '#7d8a2e', light: '#5d6a11' },  // olive
];
const PALETTE = PALETTE_PAIRS.map((p) => p.dark);   // canonical values
const LIGHT_FOR = new Map(PALETTE_PAIRS.map((p) => [p.dark, p.light]));

// Is the page currently in light mode? Read from the same data-theme attribute
// the token system uses, so this tracks the live theme (including toggles).
function isLightTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light';
}

// Resolve a stored (canonical/dark) hex to the variant that reads on the active
// theme. In dark mode the stored hex is used as-is. In light mode its deeper
// partner is used; a legacy hex not in the palette is darkened as a fallback so
// it still contrasts against parchment rather than washing out.
function colorForTheme(hex) {
  if (!hex) return hex;
  if (!isLightTheme()) return hex;
  const paired = LIGHT_FOR.get(String(hex).toLowerCase());
  if (paired) return paired;
  const api = diceApi();
  return (api && api.shade) ? api.shade(hex, -0.4) : hex;   // darken legacy hexes for light bg
}

// When the theme toggles, every colour that was resolved for the old theme is
// now the wrong variant. Re-resolve them in place: chat names from their stashed
// canonical hex, and the palette/legend by re-rendering (both are cheap). No
// message re-fetch — the canonical values are already in the DOM / member list.
(function watchThemeForColours() {
  const reresolve = () => {
    document.querySelectorAll('#chat .who[data-color]').forEach((el2) => {
      el2.style.color = colorForTheme(el2.dataset.color);
    });
    renderPalette();
    renderLegend();
    renderPresence();
  };
  const obs = new MutationObserver((muts) => {
    for (const mu of muts) {
      if (mu.type === 'attributes' && mu.attributeName === 'data-theme') { reresolve(); break; }
    }
  });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();

function renderPalette() {
  const box = document.getElementById('palette');
  if (!box) return;
  box.textContent = '';
  // A colour is "taken" if any OTHER member holds it. Derived from the member
  // list every member already receives, so no new endpoint and no new
  // disclosure — the server re-checks on write regardless, via the unique index.
  const takenBy = new Map();
  for (const m of members) if (m.assigned) takenBy.set(m.assigned, m.id);

  for (const hex of PALETTE) {
    const owner = takenBy.get(hex);
    const mine = owner === (me && me.id);
    const b = document.createElement('button');
    b.style.background = colorForTheme(hex);   // show the variant that will render on this theme
    b.className = (owner && !mine ? 'taken' : '') + (mine ? ' mine' : '');
    b.title = owner ? (mine ? 'yours' : 'taken') : 'claim this colour';
    if (owner && !mine) {
      b.disabled = true;
    } else {
      b.addEventListener('click', () => claimColor(hex));   // claim the canonical (dark) value
    }
    box.appendChild(b);
  }
}

// The chat settings popover: the top gear opens it; a close button, Escape, and
// an outside click dismiss it. Holds the dice-render controls and the palette.
(function wireChatSettings() {
  const panel = document.getElementById('chatSettings');
  const gear = document.getElementById('chatGear');
  const closeBtn = document.getElementById('chatSettingsClose');
  if (!panel || !gear) return;
  const setOpen = (open) => {
    panel.hidden = !open;
    gear.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
    } else {
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onEsc, true);
    }
  };
  const isOpen = () => !panel.hidden;
  function onOutside(e) {
    if (!panel.contains(e.target) && e.target !== gear && !gear.contains(e.target)) setOpen(false);
  }
  function onEsc(e) { if (e.key === 'Escape') { setOpen(false); gear.focus(); } }
  gear.addEventListener('click', () => setOpen(!isOpen()));
  if (closeBtn) closeBtn.addEventListener('click', () => { setOpen(false); gear.focus(); });
})();

async function claimColor(hex) {
  const msg = document.getElementById('paletteMsg');
  const r = await api('PATCH', `/api/campaigns/${campaign.id}/me`, { color: hex });
  show('PATCH my colour', r);
  if (r.status === 409) {
    // Losing the race is an ordinary outcome, not an error: somebody clicked the
    // same swatch a moment earlier. Refresh so the grid shows the truth.
    msg.textContent = r.data.error;
    await loadMembers();
    return;
  }
  msg.textContent = r.status === 200 ? '' : (r.data && r.data.error) || '';
  await loadMembers();
}

// The players accordion above the chat log: every member with their colour, and
// a "connected" indicator for those currently at the table. Expanded by default; it lists the players and shares vertical space
// with the chat log proportionally to how many there are (capped so the log is
// never crowded out). Built with createElement (no innerHTML — CSP).
function renderPresence() {
  const wrap = document.getElementById('presence');
  if (!wrap) return;
  const head = document.getElementById('presenceHead');
  const list = document.getElementById('presenceList');
  const countEl = document.getElementById('presenceCount');

  const online = members.filter((m) => onlineUsers.has(m.id)).length;
  if (countEl) countEl.textContent = `${online}/${members.length} online`;

  wrap.classList.toggle('expanded', presenceExpanded);
  if (head) head.setAttribute('aria-expanded', presenceExpanded ? 'true' : 'false');
  // Visibility is driven by the .expanded class in CSS (.presence.expanded
  // .presence-list { display:block }); we also keep the hidden property in sync
  // for assistive tech and for any code that reads it.
  if (list) { if (presenceExpanded) list.removeAttribute('hidden'); else list.setAttribute('hidden', ''); }

  // Dynamic space-sharing: the expanded list's height scales with the number of
  // members, capped at 5 rows' worth so it never swallows the chat log. The chat
  // log flexes to fill whatever remains.
  const rows = Math.min(members.length, 5);
  wrap.style.setProperty('--presence-rows', String(rows));

  if (!list) return;
  list.textContent = '';
  if (!members.length) {
    list.appendChild(el('div', { cls: 'presence-empty muted', text: 'No players yet.' }));
    return;
  }
  // Online first, then by name, so who's here is easy to scan.
  const sorted = [...members].sort((a, b) => {
    const ao = onlineUsers.has(a.id) ? 0 : 1;
    const bo = onlineUsers.has(b.id) ? 0 : 1;
    return ao - bo || (a.name || '').localeCompare(b.name || '');
  });
  for (const m of sorted) {
    const isOn = onlineUsers.has(m.id);
    const row = el('div', { cls: 'presence-row' + (isOn ? '' : ' offline') });
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `${m.name}, ${isOn ? 'connected' : 'offline'}`);
    const dot = el('span', { cls: 'presence-color' });
    dot.style.background = colorForTheme(m.color);
    row.appendChild(dot);
    row.appendChild(el('span', { cls: 'presence-name', text: m.name + (m.is_gm ? ' (GM)' : '') }));
    const status = el('span', { cls: 'presence-status' + (isOn ? ' on' : '') });
    status.title = isOn ? 'connected' : 'offline';
    row.appendChild(status);
    list.appendChild(row);
  }
}

(function wirePresenceToggle() {
  const head = document.getElementById('presenceHead');
  if (!head) return;
  head.addEventListener('click', () => {
    presenceExpanded = !presenceExpanded;
    renderPresence();
  });
})();

function renderLegend() {
  const box = document.getElementById('diceLegend');
  if (!box) return;
  box.textContent = '';
  if (!members.length) { box.textContent = '—'; return; }
  for (const m of members) {
    const chip = el('span', { cls: 'swatch' });
    const dot = el('i');
    dot.style.background = colorForTheme(m.color);
    chip.appendChild(dot);
    chip.appendChild(el('span', { text: m.name + (m.is_gm ? ' (GM)' : '') }));
    box.appendChild(chip);
  }
}

// Characters this caller may speak as. A player gets their own; the GM gets
// every character in the campaign, which is what running NPCs requires. The
// server re-checks on every message — this list is convenience, not authority.
let speakable = [];

async function loadSpeakable() {
  speakable = [];
  const r = await api('GET', `/api/campaigns/${campaign.id}/actors`);
  if (r.status === 200) {
    speakable = (r.data.actors || []).filter((a) => isGm || a.user_id === (me && me.id));
  }
  renderSpeakAs();
}

let speakAsDD = null;

function renderSpeakAs() {
  const dd = document.getElementById('speakAsDD');
  if (!dd) return;
  dd.dataset.portal = 'body';
  const options = [{ value: '', label: isGm ? 'GM' : 'Player' }];
  for (const a of speakable) {
    options.push({ value: a.id, label: a.name + (a.is_npc ? ' (NPC)' : '') });
  }
  const dropdownApi = window.VTTCommon && window.VTTCommon.initDropdown;
  if (!speakAsDD && dropdownApi) {
    speakAsDD = window.VTTCommon.initDropdown('speakAsDD', options);
    // Persist the pick per campaign, mirroring the old select behaviour. The
    // dropdown fires a change event on the hidden #speakAs input when chosen.
    const hidden = document.getElementById('speakAs');
    if (hidden) hidden.addEventListener('change', () => {
      localSet(`vtt.speakAs.${campaign.id}`, hidden.value);
    });
  } else if (speakAsDD) {
    speakAsDD.setOptions(options);
  }
  // Restore the last choice. THIS is the "active character" M4 declined to make
  // a column: a local default, remembered per campaign, with no server state and
  // no exactly-one invariant to enforce.
  const remembered = localGet(`vtt.speakAs.${campaign.id}`) || '';
  if (speakAsDD) speakAsDD.set(options.some((o) => o.value === remembered) ? remembered : '');
}

function localGet(k) { try { return window.localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } }

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

// Entry point for the Encounter button (game.js): a TOGGLE. If an encounter is
// actively running on this scene, end it (the strip hides). Otherwise start one
// (or reactivate an ended one), and the strip appears. No name prompt.
async function toggleEncounter() {
  if (!isGm) return;
  if (!sceneId) { show('no active scene for an encounter'); return; }
  await loadCombat();               // settle current state on this scene
  if (combat && combat.active) {    // running -> end it
    const r = await api('PATCH', combatPath(), { active: false });
    show('PATCH combat (toggle end)', r);
    await loadCombat();
    return;
  }
  if (combat && !combat.active) {   // ended one exists -> reactivate
    const r = await api('PATCH', combatPath(), { active: true });
    show('PATCH combat (toggle reactivate)', r);
    await loadCombat();
    return;
  }
  // None on this scene yet — create one, then open the picker so the GM chooses
  // who is in the fight by clicking tokens on the (now dimmed) canvas.
  const r = await api('POST', `/api/campaigns/${campaign.id}/combat`, { scene_id: sceneId });
  show('POST combat (toggle begin)', r);
  await loadCombat();
  pickAndAddCombatants(true);
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

function speakingAs() {
  const v = document.getElementById('speakAs').value;
  return v === '' ? undefined : v;
}

async function sendChat() {
  const content = str('chatText');
  if (!content) return;
  const r = await api('POST', `/api/campaigns/${campaign.id}/messages`, {
    content, whisper_to: whisperTargets(), actor_id: speakingAs(),
  });
  show('POST message', r);
  if (r.status === 201) document.getElementById('chatText').value = '';
}

async function sendRoll() {
  const r = await api('POST', `/api/campaigns/${campaign.id}/messages`, {
    formula: str('diceFormula'),
    content: str('diceLabel'),
    whisper_to: whisperTargets(),
    actor_id: speakingAs(),
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

  // [ADDED 2026-08-10] The roster joins portraits and names from tokens, whose
  // pictures are inherited from their characters — so a character edit changes
  // what this panel should draw. Refetching rather than patching in place: the
  // roster is filtered per recipient server-side, and reconstructing that
  // filter here would be a second copy of a disclosure rule.
  socket.on('actor:updated', (d) => {
    log(`actor:updated  ${JSON.stringify(d)}`);
    loadSpeakable();
    if (!combat) return;
    loadScene().then(loadCombat);
  });

  socket.on('actor:deleted', () => loadSpeakable());
  socket.on('party:changed', () => loadSpeakable());

  socket.on('member:updated', (d) => {
    log(`member:updated  ${JSON.stringify(d)}`);
    loadMembers();
  });

  // Presence: who is currently at the table. The server seeds this socket with
  // the present set on join (campaign:presence), then sends deltas as people
  // come and go (user-joined / user-left). We keep a Set of online user ids and
  // re-render the players accordion whenever it changes.
  socket.on('campaign:presence', (d) => {
    if (!d || d.campaign_id !== campaign.id) return;
    onlineUsers = new Set(d.user_ids || []);
    renderPresence();
  });
  socket.on('campaign:user-joined', (d) => {
    if (!d || d.campaign_id !== campaign.id || !d.user_id) return;
    onlineUsers.add(d.user_id);
    renderPresence();
  });
  socket.on('campaign:user-left', (d) => {
    if (!d || d.campaign_id !== campaign.id || !d.user_id) return;
    onlineUsers.delete(d.user_id);
    renderPresence();
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
    animateRoll(d);
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

// Seam: the harness "load" button is gone on the game page (boot supplies the
// id), so this binding is guarded. Everything below binds ids that survive.
{ const _lc = document.getElementById('loadCampaign'); if (_lc) _lc.addEventListener('click', () => loadCampaign()); }
document.getElementById('startCombat').addEventListener('click', startCombat);
document.getElementById('endCombat').addEventListener('click', endCombat);
document.getElementById('deleteCombat').addEventListener('click', deleteCombat);
document.getElementById('placeToken').addEventListener('click', placeToken);
document.getElementById('sendChat').addEventListener('click', sendChat);
// #sendRoll was merged into the single bottom-tray Roll button (#trayRoll,
// wired below): it rolls the pool when one exists, else the formula field.
document.getElementById('clearLog').addEventListener('click', () => {
  logLines = [];
  logEl.textContent = '';
});
document.getElementById('scrollLeft').addEventListener('click', () => page(-1));
document.getElementById('scrollRight').addEventListener('click', () => page(1));
{
  const hv = document.getElementById('hpVisibleAll');
  if (hv) hv.addEventListener('change', () => setHpVisibleAll(hv.checked));
  const tn = document.getElementById('turnNext');
  if (tn) tn.addEventListener('click', () => stepTurn(1));
  const tb = document.getElementById('turnBack');
  if (tb) tb.addEventListener('click', () => stepTurn(-1));
  const sa = document.getElementById('stripAdd');
  if (sa) sa.addEventListener('click', () => pickAndAddCombatants(false));
  // The strip itself accepts drops (over its padding / between cards) so a
  // release inside the strip counts as "kept", and only a release OUTSIDE the
  // strip is treated as a drag-off removal.
  if (stripEl) {
    stripEl.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
    stripEl.addEventListener('drop', (e) => { if (dragId) { e.preventDefault(); droppedInStrip = true; } });
  }
}
document.getElementById('chatText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});
document.getElementById('diceFormula').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendRoll();
});
document.getElementById('speakAs').addEventListener('change', (e) => {
  if (campaign) localSet(`vtt.speakAs.${campaign.id}`, e.target.value);
});

document.getElementById('sceneSel').addEventListener('change', async (e) => {
  sceneId = e.target.value;
  await loadScene();
  await loadCombat();
});

// ---------------------------------------------------------------------------
// 3D dice — entirely optional, entirely presentational
// ---------------------------------------------------------------------------
//
// Everything below degrades to nothing. Delete /js/dice3d.js and its <script>
// tag and this harness behaves exactly as it did before: rolls still happen on
// the server, still land in the log, still broadcast. The tray adds pixels.

// ---- the dice tray: build a pool, roll it in one go --------------------
//
// The server accepts multiple groups since the 2026-08-03 scope amendment, so
// "1d20 + 2d6 + 3" is ONE roll with ONE result line and ONE animation — not
// three separate messages that the reader has to add up themselves.
//
// The pool is kept as a map of sides -> count so clicking d6 three times reads
// as 3d6 rather than d6+d6+d6. Both are legal notation; the first is what a
// person would write.
const pool = new Map();

function poolFormula() {
  if (!pool.size) return null;
  // Descending by sides: 1d20+2d6 is how it is said out loud.
  const parts = [...pool.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([sides, count]) => `${count}d${sides}`);
  const mod = Number(document.getElementById('trayMod').value) || 0;
  let f = parts.join('+');
  if (mod > 0) f += `+${mod}`;
  else if (mod < 0) f += String(mod);
  return f;
}

// Reflect the pool on the die icons in the bar: an in-pool die gets a gold ring
// and a count badge, echoing its tag in the pool row. createElement only (CSP).
function syncDieButtons() {
  for (const b of document.querySelectorAll('.die')) {
    const sides = Number(b.dataset.sides);
    const count = pool.get(sides) || 0;
    b.classList.toggle('in-pool', count > 0);
    let badge = b.querySelector('.die-count');
    if (count > 0) {
      if (!badge) { badge = el('span', { cls: 'die-count' }); b.appendChild(badge); }
      badge.textContent = String(count);
    } else if (badge) {
      badge.remove();
    }
  }
}

// A small ✕ glyph as an SVG, matching the tray's line-icon vocabulary.
function xIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M6 6l12 12M18 6L6 18');
  svg.appendChild(p);
  return svg;
}

// The pool row: one removable tag per die TYPE (e.g. "3d6"), each with its own
// ✕ that removes that whole type. The row is hidden while the pool is empty.
function renderPool() {
  const box = document.getElementById('trayPool');
  const row = document.getElementById('dicePoolRow');
  if (box) {
    box.textContent = '';
    // Descending by sides: 1d20 before 2d6, how it is said out loud.
    for (const [sides, count] of [...pool.entries()].sort((a, b) => b[0] - a[0])) {
      const tag = el('span', { cls: 'pool-tag' });
      tag.title = 'Right-click to remove one die';
      tag.addEventListener('contextmenu', (e) => { e.preventDefault(); removeOneDie(sides); });
      tag.setAttribute('role', 'listitem');
      tag.appendChild(el('span', { text: `${count}d${sides}` }));
      // The remove control is its own labelled button, distinct from the tag —
      // one click removes the ENTIRE type from the pool, per the redesign.
      const x = el('button', { cls: 'pool-tag-x' });
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${count}d${sides} from the pool`);
      x.title = `Remove all d${sides}`;
      x.appendChild(xIcon());
      x.addEventListener('click', () => { pool.delete(sides); renderPool(); });
      tag.appendChild(x);
      box.appendChild(tag);
    }
  }
  if (row) row.hidden = pool.size === 0;
  syncDieButtons();
}

function removeOneDie(sides) {
  const count = pool.get(sides) || 0;
  if (count <= 1) pool.delete(sides);
  else pool.set(sides, count - 1);
  renderPool();
}

for (const b of document.querySelectorAll('.quick')) {
  b.title = `Add d${b.dataset.sides}; right-click to remove one`;
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    removeOneDie(Number(b.dataset.sides));
  });
  b.addEventListener('click', () => {
    const sides = Number(b.dataset.sides);
    pool.set(sides, (pool.get(sides) || 0) + 1);
    renderPool();
  });
}

document.getElementById('trayClear').addEventListener('click', () => {
  pool.clear();
  document.getElementById('trayMod').value = '';
  renderPool();
});

// The Roll button rolls the built pool (dice + modifier). poolFormula() already
// folds in #trayMod. Writes the freeform (now hidden) #diceFormula that
// sendRoll() reads, so the roll pipeline is unchanged.
document.getElementById('trayRoll').addEventListener('click', async () => {
  const f = poolFormula();
  if (!f) return;                     // nothing in the pool: nothing to roll
  document.getElementById('diceFormula').value = f;
  await sendRoll();
  // The pool survives the roll deliberately — an attack is usually thrown more
  // than once, and rebuilding it every time would be the annoying choice.
});

document.getElementById('trayMod').addEventListener('input', renderPool);
// The 'mod' hint should get out of the way the moment the field is focused, so
// the user types into an empty box; it comes back on blur if nothing was entered.
{
  const modEl = document.getElementById('trayMod');
  if (modEl) {
    modEl.addEventListener('focus', () => { modEl.placeholder = ''; });
    modEl.addEventListener('blur', () => { if (modEl.value === '') modEl.placeholder = 'mod'; });
  }
}

document.getElementById('dice3d').addEventListener('change', (e) => {
  dice3dOn = e.target.checked;
  document.getElementById('diceTray').classList.toggle('on', dice3dOn);
  if (!dice3dOn && dice3d) dice3d.clearDice();
});

// Clear MY dice from the table: local box.clearDice() only, never broadcast, so
// one player tidying their own view doesn't sweep anyone else's dice.
document.getElementById('diceClear').addEventListener('click', () => {
  if (dice3d) dice3d.clearDice();
});

// How long dice sit before clearing themselves. 0 keeps them indefinitely, which
// matters because auto-fade is what makes simultaneous rolls sustainable — with
// add() never sweeping, something has to take the dice away.
document.getElementById('diceFade').addEventListener('change', (e) => {
  if (dice3d) dice3d.setFadeSeconds(e.target.value);
});

// The dice-colour-set picker was removed from settings — a player's dice colour
// now follows their claimed table colour. The binding is guarded so its absence
// doesn't throw; if the element is ever reintroduced it wires up again.
{
  const dc = document.getElementById('diceColor');
  if (dc) dc.addEventListener('change', (e) => {
    if (dice3d) dice3d.setColorset(e.target.value);
  });
}

// The module sets window.VTTDice and fires 'vtt-dice-ready'. A failed or blocked
// module load leaves the rest of the page working instead of throwing on first
// roll.
//
// The race this guards against: dice3d.js is a <script type="module"> and
// combat.js is a classic <script defer>. Both wait for parsing, but a module is
// NOT guaranteed to execute after the deferred classics — with a warm cache the
// module often runs (and dispatches the event) BEFORE combat.js attaches this
// listener, so a one-shot event alone would be missed and the dice would never
// initialise. So: if VTTDice is already present, set up now; otherwise wait for
// the event. Exactly one branch fires, whichever order the two scripts run in.
async function onDiceReady() {
  dice3d = window.VTTDice;
  // If a campaign loaded before the module announced itself, its members were
  // coloured with the fallback. Recompute now rather than leaving the table grey
  // until the next reload.
  if (campaign && members.length) {
    for (const m of members) m.color = memberColor({ color: m.color, user_id: m.id });
    renderLegend();
  }

  const sel = document.getElementById('diceColor');
  if (sel) {
    sel.textContent = '';
    for (const c of dice3d.colorsets()) {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    }
  }

  try {
    document.getElementById('diceTray').classList.add('on');
    await dice3d.initDice('#diceTray');
    log('3D dice ready — they animate the server\'s result, they do not roll it');
  } catch (err) {
    // WebGL unavailable, assets missing, whatever. The chat log is the
    // authoritative surface and it is untouched by this failing.
    dice3d = null;
    document.getElementById('diceTray').classList.remove('on');
    document.getElementById('dice3d').checked = false;
    log(`3D dice unavailable (${err && err.message}) — rolls still work, they just print`);
  }
}

// Run-now-or-wait: covers the module executing either before or after this
// classic script. If VTTDice is already set, the module won this race and the
// event has already fired — call setup directly. Otherwise the listener catches
// the event when the module runs. { once: true } so a stray re-dispatch can't
// double-initialise.
if (window.VTTDice) {
  onDiceReady();
} else {
  document.addEventListener('vtt-dice-ready', onDiceReady, { once: true });
}

// Convenience: /combat.html?campaign=<uuid> preloads, so the GM and player
// windows can be opened from the same link. Guarded: on the game page the
// #campaignId input is gone and the shell drives boot() instead.
const preset = new URLSearchParams(window.location.search).get('campaign');
{ const _ci = document.getElementById('campaignId'); if (_ci && preset) _ci.value = preset; }

// Seam: on the harness, preset auto-loads as before. On the game page there is
// no #campaignId input, so this never fires — the shell calls VTTCombat.boot(id).
{ const _hasInput = !!document.getElementById('campaignId');
  whoami().then(() => { if (preset && _hasInput) loadCampaign(); }); }

// The game shell's entry point: the encounter/chat/dice loader, parameterised.
async function boot(campaignId) { await whoami(); return loadCampaign(campaignId); }
window.VTTCombat = { boot, toggleEncounter };


/* --- expose internals the jsdom test suite reads via window.* --- */
  try { window.loadCampaign = loadCampaign; } catch (e) {}
  try { window.loadCombat = loadCombat; } catch (e) {}
  try { window.loadScene = loadScene; } catch (e) {}
})();
