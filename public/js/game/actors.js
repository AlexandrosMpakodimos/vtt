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
// Character roster, inventory and spellbook behavior used by game.html.
// JSDOM also exercises this module with the actor DOM fixture.
// Render user-controlled text through textContent; do not introduce HTML parsing.

const out = document.getElementById('out');
const logEl = document.getElementById('log');

function show(label, r) {
  out.textContent = `${label}  →  ${r.status}\n` + JSON.stringify(r.data, null, 2);
}
function log(msg) {
  logEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

let recoveringSocket = false, recoveryFailed = false;
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  const out = { status: res.status, data };
  if (recoveringSocket && res.status >= 400) recoveryFailed = true;
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
function num(id) {
  const v = document.getElementById(id).value;
  return v === '' ? undefined : Number(v);
}
function str(id) {
  const v = document.getElementById(id).value.trim();
  return v === '' ? undefined : v;
}

let me = null;
let campaign = null;
let isGm = false;
let actors = [];
let items = [];
let selectedActor = null;
let socket = null;
let invItemDd = null;   // the inventory item picker's vtt-dd controller

async function whoami() {
  const r = await api('GET', '/api/auth/me');
  me = r.status === 200 ? r.data.user : null;
  document.getElementById('whoami').textContent = me
    ? `logged in as ${me.username}`
    : 'NOT logged in';
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

// An actor's payload tells you which tier you are on without being asked: the
// projected form simply has no hp_max key. That is worth surfacing in the UI
// rather than hiding, because it is the whole point of the layer.
function isProjected(a) {
  return !('hp_max' in a);
}

function hpBar(a) {
  // Derived from the ACTOR, never from tokens.bar1_*, which stays meaningful
  // only for unlinked tokens. A projected NPC carries no hp at all, so a player
  // simply gets no bar — the confidentiality rule and the display rule are the
  // same rule.
  if (isProjected(a) || !a.hp_max) return null;
  const wrap = el('div', { cls: 'bar' });
  const fill = el('i');
  const pct = Math.max(0, Math.min(100, (a.hp_current / a.hp_max) * 100));
  fill.style.width = pct + '%';
  if (a.hp_current <= 0) fill.className = 'low';
  wrap.appendChild(fill);
  return wrap;
}

// Initials for the portrait fallback.
function actorInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Roster search + filter state. `type` ∈ '' | 'pc' | 'npc'; `control` ∈ '' |
// 'mine' | 'unassigned'. These narrow ONLY the roster render — the `actors`
// array that token placement, combat, inventory and selectActor read is never
// filtered.
const charFilter = { q: '', type: '', control: '', party: '' };
let charFiltersWired = false;
// UI state belongs to the character, not to DOM rows recreated after mutations.
const characterHpPanels = new Map();

function charVisible(a) {
  if (!isGm && a.in_party !== true && !(me && a.user_id === me.id)) return false;
  if (charFilter.party === 'party' && a.in_party !== true) return false;
  if (charFilter.party === 'outside' && a.in_party === true) return false;
  if (charFilter.q && !String(a.name || '').toLowerCase().includes(charFilter.q)) return false;
  if (charFilter.type === 'pc' && a.is_npc) return false;
  if (charFilter.type === 'npc' && !a.is_npc) return false;
  if (charFilter.control === 'mine' && !(me && a.user_id === me.id)) return false;
  if (charFilter.control === 'unassigned' && a.user_id != null) return false;
  return true;
}

function wireCharFilters() {
  if (charFiltersWired) return;
  const search = document.getElementById('charSearch');
  const typeBox = document.getElementById('charFilterType');
  const controlBox = document.getElementById('charFilterControl');
  const toggle = document.getElementById('charFilterToggle');
  const panel = document.getElementById('charFilterPanel');
  const countBadge = document.getElementById('charFilterCount');
  if (!search || !typeBox || !controlBox) return;
  charFiltersWired = true;

  search.addEventListener('input', () => { charFilter.q = search.value.trim().toLowerCase(); renderActors(); });

  function refreshBadge() {
    const n = (charFilter.type !== '' ? 1 : 0) + (charFilter.control !== '' ? 1 : 0) + (charFilter.party !== '' ? 1 : 0);
    if (countBadge) { countBadge.textContent = String(n); countBadge.hidden = n === 0; }
    if (toggle) toggle.classList.toggle('has-filters', n > 0);
  }
  if (toggle && panel) {
    toggle.addEventListener('click', () => {
      const open = panel.hasAttribute('hidden');
      if (open) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.classList.toggle('open', open);
    });
  }
  function chipGroup(box, options, key) {
    box.textContent = '';
    for (const o of options) {
      const chip = el('button', { cls: 'char-chip', text: o.label }); chip.type = 'button';
      if (charFilter[key] === o.value) chip.classList.add('active');
      chip.addEventListener('click', () => {
        charFilter[key] = (charFilter[key] === o.value) ? '' : o.value;
        chipGroup(box, options, key); refreshBadge(); renderActors();
      });
      box.appendChild(chip);
    }
  }
  chipGroup(typeBox, [
    { value: '', label: 'All' }, { value: 'pc', label: 'Player characters' }, { value: 'npc', label: 'NPCs' },
  ], 'type');
  chipGroup(controlBox, [
    { value: '', label: 'All' }, { value: 'mine', label: 'Yours' }, { value: 'unassigned', label: 'Unassigned' },
  ], 'control');
  const partyBox = document.getElementById('charFilterParty');
  if (partyBox) {
    partyBox.hidden = false;
    chipGroup(partyBox, [{ value: '', label: 'All' }, { value: 'party', label: 'In party' }, { value: 'outside', label: 'Not in party' }], 'party');
  }
  refreshBadge();
}

function renderActors() {
  wireCharFilters();
  const list = document.getElementById('actorList');
  if (!list) return;
  list.textContent = '';

  if (!actors.length || (!isGm && !actors.some((a) => a.in_party === true || (me && a.user_id === me.id)))) {
    list.appendChild(el('p', { cls: 'muted char-empty', text: isGm ? 'No characters yet.' : 'No characters to show. Create your own character or ask the GM to add party members.' }));
    return;
  }
  const shown = actors.filter(charVisible);
  if (!shown.length) {
    const empty = el('div', { cls: 'muted char-empty' });
    empty.appendChild(el('div', { text: 'No characters match your search or filters.' }));
    const clear = el('button', { cls: 'btn small secondary', text: 'Clear search and filters' });
    clear.type = 'button';
    clear.addEventListener('click', () => {
      charFilter.q = ''; charFilter.type = ''; charFilter.control = ''; charFilter.party = '';
      const s = document.getElementById('charSearch'); if (s) s.value = '';
      charFiltersWired = false;
      const panel = document.getElementById('charFilterPanel');
      const toggle = document.getElementById('charFilterToggle');
      if (panel) panel.setAttribute('hidden', '');
      if (toggle) { toggle.classList.remove('open', 'has-filters'); toggle.setAttribute('aria-expanded', 'false'); }
      renderActors();
    });
    empty.appendChild(clear);
    list.appendChild(empty);
    return;
  }

  for (const a of shown) {
    const mayWrite = isGm || (me && a.user_id === me.id);
    const card = el('div', { cls: 'char-card' + (selectedActor === a.id ? ' sel' : '') });

    // ── Main clickable body → opens the sheet ──────────────────────────────
    const main = el('div', { cls: 'char-card-main' });
    main.setAttribute('role', 'button'); main.tabIndex = 0;
    main.setAttribute('aria-label', `Open ${a.name}`);
    const openSheet = () => selectActor(a);
    main.addEventListener('click', openSheet);
    main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(); } });

    const portrait = el('div', { cls: 'char-portrait' });
    if (a.img_url) {
      const img = el('img'); img.alt = '';
      img.src = a.img_url;
      const ox = Number(a.img_offset_x) || 0, oy = Number(a.img_offset_y) || 0, sc = Number(a.img_scale) > 0 ? Number(a.img_scale) : 1;
      window.VTTImageFrame.apply(img, portrait, ox, oy, sc);
      img.addEventListener('error', () => { img.remove(); if (!portrait.querySelector('.char-portrait-fallback')) portrait.appendChild(el('span', { cls: 'char-portrait-fallback', text: actorInitials(a.name) })); });
      portrait.appendChild(img);
    } else {
      portrait.appendChild(el('span', { cls: 'char-portrait-fallback', text: actorInitials(a.name) }));
    }
    main.appendChild(portrait);

    const body = el('div', { cls: 'char-card-body' });
    const nameRow = el('div', { cls: 'char-name-row' });
    nameRow.appendChild(el('span', { cls: 'char-name', text: a.name }));
    const badges = el('div', { cls: 'char-status-row' });
    badges.appendChild(el('span', { cls: 'char-badge ' + (a.is_npc ? 'npc' : 'pc'), text: a.is_npc ? 'NPC' : 'PC' }));
    if (me && a.user_id === me.id) badges.appendChild(el('span', { cls: 'char-badge mine', text: 'Yours' }));
    if (a.in_party === true && isGm) badges.appendChild(el('span', { cls: 'char-badge party', text: 'Party' }));
    body.appendChild(nameRow);
    body.appendChild(badges);

    if (!isProjected(a)) {
      // Level · class · ancestry — only the parts supplied to this viewer.
      const meta = [a.level != null ? `Lvl ${a.level}` : null, a.class, a.race].filter(Boolean).join(' · ');
      if (meta) body.appendChild(el('div', { cls: 'char-meta', text: meta }));

      const vitals = el('div', { cls: 'char-vitals' });
      if (a.hp_current != null && a.hp_max != null) {
        const hp = el('div', { cls: 'char-vital char-health' });
        hp.appendChild(el('span', { cls: 'char-stat-label', text: 'HP' }));
        hp.appendChild(el('span', { cls: 'char-hp-value', text: `${a.hp_current}/${a.hp_max}` }));
        vitals.appendChild(hp);
      }
      if (a.armor_class != null) {
        const ac = el('div', { cls: 'char-vital char-armour' });
        ac.appendChild(el('span', { cls: 'char-stat-label', text: 'AC' }));
        ac.appendChild(el('span', { cls: 'char-ac-value', text: String(a.armor_class) }));
        vitals.appendChild(ac);
      }
      if (vitals.childElementCount) body.appendChild(vitals);
      if (a.hp_max > 0 && a.hp_current != null) {
        const bar = el('div', { cls: 'char-hp-bar' });
        const fill = el('div', { cls: 'char-hp-fill' + (a.hp_current <= 0 ? ' low' : '') });
        fill.style.width = Math.max(0, Math.min(100, (a.hp_current / a.hp_max) * 100)) + '%';
        bar.setAttribute('aria-hidden', 'true');
        bar.appendChild(fill); body.appendChild(bar);
      }
      // Temp HP shown separately when nonzero.
      if (a.hp_temp) body.appendChild(el('div', { cls: 'char-hp-temp', text: `+${a.hp_temp} temp HP` }));
      if (a.hp_current <= 0) body.appendChild(el('div', { cls: 'char-down', text: 'Down' }));
    } else {
      body.appendChild(el('div', { cls: 'char-meta', text: [a.size, 'Statistics unavailable'].filter(Boolean).join(' · ') }));
    }
    main.appendChild(body);
    card.appendChild(main);

    // ── Action strip: quick HP + confirmed deletion (owner/GM only) ─────────
    if (mayWrite && !isProjected(a)) {
      const stateKey = `${campaign ? campaign.id : ''}:${a.id}`;
      if (!characterHpPanels.has(stateKey)) characterHpPanels.set(stateKey, { open: false, amount: '1' });
      const hpState = characterHpPanels.get(stateKey);
      const actions = el('div', { cls: 'char-card-actions' });
      const hpToggle = el('button', { cls: 'btn small secondary char-hp-toggle', text: 'Adjust HP' }); hpToggle.type = 'button';
      hpToggle.setAttribute('aria-expanded', String(hpState.open));
      actions.appendChild(hpToggle);
      if (isGm) {
        const partyToggle = button(a.in_party === true ? 'In party' : 'Add to party', async () => {
          partyToggle.disabled = true;
          let error = card.querySelector('.char-party-error');
          if (error) error.remove();
          try {
            const result = await api('PATCH', `/api/campaigns/${campaign.id}/actors/${a.id}`, { in_party: a.in_party !== true });
            if (result.status !== 200) throw new Error((result.data && result.data.error) || 'Could not update party membership.');
            await refresh();
          } catch (err) {
            error = el('p', { cls: 'char-party-error', text: err.message || 'Could not update party membership.' });
            error.setAttribute('role', 'alert'); card.appendChild(error);
          } finally { partyToggle.disabled = false; }
        });
        partyToggle.type = 'button'; partyToggle.className = 'btn small secondary char-party-toggle';
        partyToggle.setAttribute('aria-pressed', String(a.in_party === true));
        partyToggle.setAttribute('aria-label', `${a.in_party === true ? 'Remove' : 'Add'} ${a.name} ${a.in_party === true ? 'from' : 'to'} party`);
        actions.appendChild(partyToggle);
      }

      const delBtn = iconBtn(`Delete ${a.name}`, 'delete', () => deleteActor(a));
      delBtn.className = 'btn small danger char-trash';
      delBtn.querySelector('svg').setAttribute('aria-hidden', 'true');
      actions.appendChild(delBtn);
      card.appendChild(actions);

      // Inline quick-HP panel. Toggling or using it must NOT open the sheet, so
      // it lives outside .char-card-main and stops propagation.
      const hpPanel = el('div', { cls: 'char-hp-panel' }); hpPanel.hidden = !hpState.open;
      const amt = el('input'); amt.type = 'number'; amt.value = hpState.amount; amt.min = '0'; amt.setAttribute('aria-label', 'HP amount');
      amt.addEventListener('input', () => { hpState.amount = amt.value; });
      const dmgBtn = el('button', { cls: 'btn small secondary', text: 'Damage' }); dmgBtn.type = 'button';
      const healBtn = el('button', { cls: 'btn small secondary', text: 'Heal' }); healBtn.type = 'button';
      dmgBtn.addEventListener('click', (e) => { e.stopPropagation(); hpState.amount = amt.value; adjustHp(a, -Math.abs(Number(amt.value) || 0)); });
      healBtn.addEventListener('click', (e) => { e.stopPropagation(); hpState.amount = amt.value; adjustHp(a, Math.abs(Number(amt.value) || 0)); });
      hpPanel.appendChild(amt); hpPanel.appendChild(dmgBtn); hpPanel.appendChild(healBtn);
      hpToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = hpPanel.hidden;
        hpState.open = open;
        hpPanel.hidden = !open; hpToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      card.appendChild(hpPanel);
    }

    list.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// IMAGE LIBRARY (M6)
// ---------------------------------------------------------------------------
//
// The upload is a three-step conversation and the middle step does not involve
// this application at all:
//
//   1. ask the server to authorise ONE upload   -> presigned URL + asset id
//   2. PUT the file straight to the bucket      -> our server sees nothing
//   3. tell the server it finished              -> it reads the bytes back and
//                                                  verifies them
//
// Step 2 is a plain fetch to a different origin. That is the point: the file
// never passes through the application, so a large upload costs it no memory
// and no bandwidth, and the JSON body limit is irrelevant.
//
// Step 3 is the one that matters. Everything before it is this client's word,
// and the bucket stores raw bytes rather than transcoding them — so the server
// checks the magic numbers before the asset becomes usable. A file that is not
// what it claims to be is deleted rather than stored, and the interface says so.
//
// THE HEADERS IN STEP 2 ARE NOT OPTIONAL. The content type and length are part
// of the signature the server produced; sending anything else makes the bucket
// refuse the PUT before our code is involved. That is how the size limit is
// enforced by the storage provider rather than by trust.

let assets = [];

async function loadAssets() {
  if (!campaign) { assets = []; renderAssets(); return; }
  const r = await api('GET', `/api/assets?campaign_id=${campaign.id}`);
  const campaignAssets = r.data && Array.isArray(r.data.assets) ? r.data.assets : [];
  // Personal images (avatars) are a separate scope with a separate quota, and
  // are fetched separately because they belong to the person, not the campaign.
  const mineRes = await api('GET', '/api/assets');
  const personal = mineRes.data && Array.isArray(mineRes.data.assets) ? mineRes.data.assets : [];
  assets = [...campaignAssets, ...personal];
  renderAssets();
}

const assetCategories = { portrait: 'Portraits', token: 'Token art', item: 'Item art', map: 'Maps', avatar: 'Avatars', cover: 'Campaign covers' };
const assetFilter = { q: '', kind: '' };
function assetName(a) {
  try { return decodeURIComponent(new URL(a.url).pathname.split('/').filter(Boolean).pop() || '') || 'Untitled image'; }
  catch { return 'Untitled image'; }
}
function wireAssetTools(box) {
  if (box.parentNode.querySelector('.image-toolbar')) return;
  const toolbar = el('div', { cls: 'image-toolbar item-toolbar' });
  const row = el('div', { cls: 'item-toolbar-row' });
  const searchWrap = el('div', { cls: 'item-search' });
  function toolbarIcon(paths) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths); svg.appendChild(path); return svg;
  }
  searchWrap.appendChild(toolbarIcon('M19 11a8 8 0 1 1-16 0a8 8 0 1 1 16 0M17 17l4 4'));
  const search = el('input'); search.type = 'search'; search.placeholder = 'Search images…';
  search.setAttribute('aria-label', 'Search images by filename or category');
  search.addEventListener('input', () => { assetFilter.q = search.value; renderAssets(); });
  const filters = el('div', { cls: 'image-filters item-filters' }); filters.hidden = true;
  filters.id = 'imageCategoryFilters';
  const toggle = el('button', { cls: 'item-filter-toggle' }); toggle.type = 'button';
  toggle.setAttribute('aria-controls', filters.id); toggle.setAttribute('aria-expanded', 'false');
  toggle.append(toolbarIcon('M3 5h18M6 12h12M10 19h4'), el('span', { text: 'Filter' }));
  const badge = el('span', { cls: 'item-filter-count', text: '0' }); badge.hidden = true; toggle.appendChild(badge);
  toggle.addEventListener('click', () => { filters.hidden = !filters.hidden; toggle.classList.toggle('open', !filters.hidden); toggle.setAttribute('aria-expanded', String(!filters.hidden)); });
  searchWrap.appendChild(search); row.append(searchWrap, toggle);
  const chips = el('div', { cls: 'image-filter-chips item-filter' });
  chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Image categories');
  for (const [kind, label] of [['', 'All images'], ...Object.entries(assetCategories)]) {
    const chip = button(label, () => { assetFilter.kind = kind; renderAssets(); });
    chip.type = 'button'; chip.className = 'item-chip'; chip.dataset.kind = kind;
    chips.appendChild(chip);
  }
  filters.appendChild(chips);
  const count = el('p', { cls: 'muted image-count' }); count.setAttribute('role', 'status');
  toolbar.append(row, filters, count); box.before(toolbar);
  const kind = document.getElementById('assetKind');
  const common = window.VTTCommon;
  if (kind && common && common.initDropdown) {
    const dd = el('div', { cls: 'vtt-dd' }); dd.dataset.portal = 'body';
    const value = el('input'); value.type = 'hidden'; value.value = kind.value;
    const trigger = el('button', { cls: 'vtt-dd-btn' }); trigger.type = 'button';
    trigger.setAttribute('aria-label', 'Category for new image'); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    const list = el('ul', { cls: 'vtt-dd-list' }); list.hidden = true; list.tabIndex = -1; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Image category');
    dd.append(value, trigger, list); kind.after(dd);
    common.initDropdown(dd, [...kind.options].map(o => ({ value: o.value, label: o.textContent })));
    value.addEventListener('change', () => { kind.value = value.value; });
    kind.hidden = true;
  }
}
function previewAsset(a, invoker) {
  const dialog = el('dialog', { cls: 'image-preview-dialog' });
  dialog.setAttribute('aria-label', 'Image preview: ' + assetName(a));
  const close = button('Close preview', () => {
    if (window.VTTCommon && window.VTTCommon.closeDialog) window.VTTCommon.closeDialog(dialog);
    else dialog.close();
  });
  close.className = 'btn small secondary'; close.type = 'button';
  const img = el('img'); img.src = a.url; img.alt = assetName(a); img.referrerPolicy = 'no-referrer';
  const name = el('p', { text: assetName(a) });
  dialog.append(close, img, name); document.body.appendChild(dialog);
  dialog.addEventListener('close', () => { dialog.remove(); invoker.focus(); }, { once: true });
  if (window.VTTCommon && window.VTTCommon.openDialog) window.VTTCommon.openDialog(dialog, { invoker });
  else dialog.showModal();
}
function renderAssets() {
  const box = document.getElementById('assetList');
  if (!box) return;
  wireAssetTools(box);
  const toolbar = box.parentNode.querySelector('.image-toolbar');
  for (const chip of toolbar.querySelectorAll('[data-kind]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.kind === assetFilter.kind));
    chip.classList.toggle('active', chip.dataset.kind === assetFilter.kind);
  }
  const filterToggle = toolbar.querySelector('.item-filter-toggle');
  filterToggle.classList.toggle('has-filters', !!assetFilter.kind);
  const badge = filterToggle.querySelector('.item-filter-count'); badge.hidden = !assetFilter.kind; badge.textContent = assetFilter.kind ? '1' : '0';
  const shown = assets.filter(a => (!assetFilter.kind || a.kind === assetFilter.kind) &&
    (assetName(a) + ' ' + (assetCategories[a.kind] || a.kind)).toLowerCase().includes(assetFilter.q.trim().toLowerCase()));
  toolbar.querySelector('.image-count').textContent = `${shown.length} of ${assets.length} images` + (assetFilter.kind ? ` · ${assetCategories[assetFilter.kind]}` : '');
  box.textContent = '';
  if (!shown.length) {
    box.appendChild(el('p', { cls: 'muted', text: assets.length ? 'No images match. Try another category or search.' : 'No images yet. Add an image to start your collection.' }));
    return;
  }
  for (const a of shown) {
    const card = el('div', { cls: 'asset' + (a.source === 'external' ? ' external' : '') });
    const preview = button('', () => previewAsset(a, preview)); preview.type = 'button'; preview.className = 'image-thumb';
    preview.setAttribute('aria-label', 'Preview ' + assetName(a));
    const img = document.createElement('img'); img.src = a.url; img.alt = ''; img.loading = 'lazy';
    if (a.source === 'external') img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { img.hidden = true; preview.textContent = 'Preview unavailable'; }, { once: true });
    preview.appendChild(img); card.appendChild(preview);
    card.appendChild(el('div', { cls: 'image-name', text: assetName(a) }));
    card.appendChild(el('div', { cls: 'k', text: assetCategories[a.kind] || a.kind }));
    card.appendChild(el('div', { cls: 'k', text: a.source === 'external' ? 'external link' : 'hosted' }));
    const actions = el('div', { cls: 'image-actions' });
    const copy = button('Copy URL', async () => {
      try { await navigator.clipboard.writeText(a.url); document.getElementById('assetMsg').textContent = 'Image URL copied'; }
      catch { document.getElementById('assetMsg').textContent = a.url; }
    });
    copy.type = 'button'; copy.className = 'btn small secondary'; actions.appendChild(copy);
    if ((me && a.user_id === me.id) || (isGm && a.campaign_id)) {
      const trash = iconBtn('Delete ' + assetName(a), 'delete', () => deleteAsset(a));
      trash.className = 'btn small danger image-trash'; actions.appendChild(trash);
    }
    card.appendChild(actions); box.appendChild(card);
  }
}

async function uploadAsset() {
  const msg = document.getElementById('assetMsg');
  const input = document.getElementById('assetFile');
  const file = input.files && input.files[0];
  if (!file) { msg.textContent = 'choose a file first'; return; }

  const kind = document.getElementById('assetKind').value;
  // An avatar is personal and has no campaign — the scopes are exclusive, and
  // sending both is refused by the server.
  const params = new URLSearchParams({ kind, mime: file.type });
  if (kind !== 'avatar') {
    if (!campaign) { msg.textContent = 'load a campaign first'; return; }
    params.set('campaign_id', campaign.id);
  }

  // The controlled upload: bytes go THROUGH the server (validated, metered,
  // written once) rather than via a replayable presigned grant. One request,
  // idempotent on retry.
  const idem = `${Date.now()}-${Math.random().toString(16).slice(2)}-${file.size}`;
  msg.textContent = 'uploading…';
  let res; let data;
  try {
    res = await fetch(`/api/assets/upload?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'Idempotency-Key': idem },
      credentials: 'same-origin',
      body: file,
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    msg.textContent = `upload failed (${err.message})`;
    return;
  }
  show('POST upload', { status: res.status, data });
  if (res.status !== 201 && res.status !== 200) {
    msg.textContent = (data && (data.message || data.error)) || `upload was refused (${res.status})`;
    return;
  }

  msg.textContent = 'uploaded';
  input.value = '';
  await loadAssets();
}

async function addAssetLink() {
  const msg = document.getElementById('assetMsg');
  const url = str('assetUrl');
  if (!url) { msg.textContent = 'paste a url first'; return; }

  const kind = document.getElementById('assetKind').value;
  const body = { kind, url };
  if (kind !== 'avatar') {
    if (!campaign) { msg.textContent = 'load a campaign first'; return; }
    body.campaign_id = campaign.id;
  }

  const r = await api('POST', '/api/assets/external', body);
  show('POST external', r);
  if (r.status !== 201) {
    msg.textContent = (r.data && r.data.error) || 'that link was not accepted';
    return;
  }
  msg.textContent = 'link added — players will connect to that host directly';
  document.getElementById('assetUrl').value = '';
  await loadAssets();
}

function deleteAsset(a) {
  const message = 'Delete this image? Characters, items or maps using its URL may lose their image.';
  if (window.VTTGame && window.VTTGame.confirm) {
    window.VTTGame.confirm('Delete image?', message, true, () => performAssetDelete(a));
  } else if (window.confirm(message)) performAssetDelete(a);
}
async function performAssetDelete(a) {
  const r = await api('DELETE', `/api/assets/${a.id}`);
  show('DELETE asset', r);
  if (r.status !== 200) {
    document.getElementById('assetMsg').textContent = (r.data && r.data.error) || 'could not delete';
    return;
  }
  // Stated plainly: the six columns that hold image URLs are not foreign keys
  // to this table, so nothing was rewritten. Anything still pointing here will
  // render a broken image rather than silently changing.
  document.getElementById('assetMsg').textContent =
    'deleted — anything still using it will now show a broken image';
  await loadAssets();
}

// ---------------------------------------------------------------------------
// IMAGE FRAMING (M6)
// ---------------------------------------------------------------------------
//
// A portrait is rarely square and rarely centred on its subject, so dropped into
// a token's square unmodified it crops badly. This positions the art inside the
// frame once; the values are stored on the character and COPIED onto every token
// placed from it afterwards.
//
// The preview stage is deliberately the same construction scene.js uses — an
// absolutely-positioned art layer with `center/cover` and a transform — so what
// is seen here is the crop the canvas will draw, rather than an approximation
// that agrees by coincidence.
//
// The transform is `translate(...) scale(...)`, and the order is load-bearing:
// CSS applies the rightmost first, so the art is scaled and THEN shifted by a
// fraction of the unscaled frame. That is what makes an offset of 0.25 mean "a
// quarter of the square" at any zoom and any token footprint.

// Character portrait framing (M6) is now integrated into the sheet's portrait
// picker (see renderSheet → VTTImagePicker.attach with frame/onChoose), so the
// standalone roster "frame picture" button and its openFrame handler were
// removed: the crop belongs with the portrait, edited in one place.

// initFraming kept as a no-op seam: the harness and game.js both call it, and the
// stage wiring it used to do now lives inside VTTFrameTool.
function initFraming() { /* framing UI moved to VTTFrameTool */ }

// ---------------------------------------------------------------------------
// SPELLS (M6)
// ---------------------------------------------------------------------------
//
// Two panels, mirroring items and inventory, because the server tables mirror
// them: a campaign CATALOGUE the GM authors, and a per-character SPELLBOOK.
//
// One deliberate difference from items, and it is worth stating because the
// asymmetry looks like an oversight: there is no "unidentified" projection here.
// A player must be able to read what a spell does in order to cast it, so the
// catalogue is public to every member. The confidentiality that matters is which
// spells a character has PREPARED, and that lives on the spellbook — where the
// server reuses the same gate that stops a player reading an NPC's bag. A
// player asking for the lich's spellbook gets a 404, so this file never has to
// think about it.

let spells = [];
let spellbook = [];

async function loadSpells() {
  // The whole catalogue, always. Filtering by level/school and searching by name
  // happen CLIENT-side (see spellVisible), so the learn picker and the card grid
  // can draw from the same complete array without the library's view narrowing
  // what a character is allowed to learn. (The old ?level= server filter is gone
  // for that reason — it would have coupled the two.)
  const r = await api('GET', `/api/campaigns/${campaign.id}/spells`);
  // Shape, not status code — a refusal has no spells array.
  spells = r.data && Array.isArray(r.data.spells) ? r.data.spells : [];
  renderSpells();
  renderSpellChoices();
}

const levelLabel = (n) => (n === 0 ? 'cantrip' : `level ${n}`);

// The spell school of a catalogue row, normalised to a string ('' = none).
function spellSchool(sp) {
  const p = sp && sp.properties && typeof sp.properties === 'object' ? sp.properties : {};
  return p.school != null ? String(p.school) : '';
}

// Search + filter state for the spell grid. Mirrors itemFilter. `level` is a
// STRING so that '' (All) and '0' (Cantrip) are distinguishable — treating 0 as
// falsy is exactly the bug the item filter avoids.
const spellFilter = { q: '', level: '', school: '' };
let spellFiltersWired = false;

// A spell is visible when it matches the name search AND the level chip AND the
// school chip. Level 0 (Cantrip) is an active filter like any other.
function spellVisible(sp) {
  if (spellFilter.q) {
    if (!String(sp.name || '').toLowerCase().includes(spellFilter.q)) return false;
  }
  if (spellFilter.level !== '' && String(sp.level) !== spellFilter.level) return false;
  if (spellFilter.school !== '' && spellSchool(sp) !== spellFilter.school) return false;
  return true;
}

// The distinct school values present in the catalogue that are NOT one of the
// known eight — surfaced as extra filter chips and editor options so a legacy or
// imported value stays selectable rather than being silently dropped.
function customSchoolValues() {
  const SS = window.VTTSpellSheet || {};
  const known = new Set(SS.SCHOOLS || []);
  const out = [];
  const seen = new Set();
  for (const sp of spells) {
    const s = spellSchool(sp);
    if (s && !known.has(s) && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

function wireSpellFilters() {
  if (spellFiltersWired) return;
  const SS = window.VTTSpellSheet || {};
  const search = document.getElementById('spellSearch');
  const levelBox = document.getElementById('spellFilterLevel');
  const schoolBox = document.getElementById('spellFilterSchool');
  const toggle = document.getElementById('spellFilterToggle');
  const panel = document.getElementById('spellFilterPanel');
  const countBadge = document.getElementById('spellFilterCount');
  if (!search || !levelBox || !schoolBox) return;   // not a spell-bearing page
  spellFiltersWired = true;

  search.addEventListener('input', () => { spellFilter.q = search.value.trim().toLowerCase(); renderSpells(); });

  // Count only the chip groups (level, school); search is not a filter chip.
  // Guard on '' rather than falsiness so a Cantrip (level '0') filter counts.
  function refreshFilterBadge() {
    const n = (spellFilter.level !== '' ? 1 : 0) + (spellFilter.school !== '' ? 1 : 0);
    if (countBadge) { countBadge.textContent = String(n); countBadge.hidden = n === 0; }
    if (toggle) toggle.classList.toggle('has-filters', n > 0);
  }

  if (toggle && panel) {
    toggle.addEventListener('click', () => {
      const open = panel.hasAttribute('hidden');
      if (open) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.classList.toggle('open', open);
    });
  }

  // One active chip per group; clicking the active chip clears it.
  function chipGroup(box, options, key) {
    box.textContent = '';
    const mk = (value, label, color) => {
      const chip = el('button', { cls: 'spell-chip', text: label });
      chip.type = 'button';
      if (color) chip.style.setProperty('--chip-color', color);
      if (spellFilter[key] === value) chip.classList.add('active');
      chip.addEventListener('click', () => {
        spellFilter[key] = (spellFilter[key] === value) ? '' : value;
        rebuildChips();
        refreshFilterBadge();
        renderSpells();
      });
      box.appendChild(chip);
    };
    mk('', 'All');
    for (const o of options) mk(o.value, o.label, o.color);
  }

  // School chips are rebuilt each time because the custom-value set depends on
  // the loaded catalogue; level chips are fixed.
  function rebuildChips() {
    const LEVELS = SS.LEVELS || [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const levelOpts = LEVELS.map((n) => ({
      value: String(n),
      label: (SS.levelLabel ? SS.levelLabel(n) : (n === 0 ? 'Cantrip' : 'Level ' + n)),
    }));
    chipGroup(levelBox, levelOpts, 'level');

    const SCHOOLS = SS.SCHOOLS || [];
    const labels = SS.SCHOOL_LABELS || {};
    const colors = SS.SCHOOL_COLOR || {};
    const neutral = SS.NEUTRAL_ACCENT || 'var(--border)';
    const schoolOpts = SCHOOLS.map((s) => ({ value: s, label: labels[s] || s, color: colors[s] || neutral }))
      .concat(customSchoolValues().map((s) => ({ value: s, label: s, color: neutral })));
    chipGroup(schoolBox, schoolOpts, 'school');
  }

  rebuildChips();
  refreshFilterBadge();
}

function renderSpells() {
  wireSpellFilters();
  const SS = window.VTTSpellSheet || {};
  const list = document.getElementById('spellList');
  if (!list) return;
  list.textContent = '';

  // Empty catalogue and no-matches are different states with different remedies:
  // an empty catalogue just needs a spell authored; a no-match needs the search
  // or filters cleared.
  if (!spells.length) {
    list.appendChild(el('p', { cls: 'muted spell-empty', text: 'No spells yet.' }));
    return;
  }
  const shown = spells.filter(spellVisible);
  if (!shown.length) {
    const empty = el('div', { cls: 'muted spell-empty' });
    empty.appendChild(el('div', { text: 'No spells match your search or filters.' }));
    const clear = el('button', { cls: 'btn small secondary', text: 'Clear search and filters' });
    clear.type = 'button';
    clear.addEventListener('click', () => {
      spellFilter.q = ''; spellFilter.level = ''; spellFilter.school = '';
      const s = document.getElementById('spellSearch'); if (s) s.value = '';
      spellFiltersWired = false;                       // force chip + badge rebuild
      const panel = document.getElementById('spellFilterPanel');
      const toggle = document.getElementById('spellFilterToggle');
      if (panel) panel.setAttribute('hidden', '');
      if (toggle) { toggle.classList.remove('open', 'has-filters'); toggle.setAttribute('aria-expanded', 'false'); }
      renderSpells();
    });
    empty.appendChild(clear);
    list.appendChild(empty);
    return;
  }

  const schoolColor = SS.schoolColor || (() => 'var(--border)');
  const schoolLabelOf = SS.schoolLabel || ((v) => v);
  const badgeLabel = (n) => (SS.levelLabel ? SS.levelLabel(n) : (Number(n) === 0 ? 'Cantrip' : 'Level ' + n));

  for (const sp of shown) {
    const school = spellSchool(sp);
    const accent = schoolColor(school);

    const card = el('div', { cls: 'spell-card' });
    card.style.setProperty('--card-accent', accent);

    const body = el('div', { cls: 'spell-card-body' });
    const badge = el('span', { cls: 'spell-card-badge', text: badgeLabel(sp.level) });
    badge.style.background = accent;
    body.appendChild(badge);
    body.appendChild(el('div', { cls: 'spell-card-name', text: sp.name }));
    if (school) {
      const sl = el('div', { cls: 'spell-card-school', text: schoolLabelOf(school) });
      sl.style.color = accent;
      body.appendChild(sl);
    }
    if (sp.description) body.appendChild(el('div', { cls: 'spell-card-desc', text: sp.description }));
    card.appendChild(body);

    // Everyone can open the read view (players by clicking the card; the GM gets
    // an explicit icon so the card's edit/delete clicks aren't ambiguous).
    function openView() { if (SS.openPreview) SS.openPreview(sp); }

    if (!isGm) {
      card.classList.add('clickable');
      card.tabIndex = 0; card.setAttribute('role', 'button');
      card.addEventListener('click', openView);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openView(); } });
    } else {
      const actions = el('div', { cls: 'spell-card-actions' });
      actions.appendChild(iconBtn('View', 'preview', openView));
      actions.appendChild(iconBtn('Edit', 'edit', () => editSpell(sp)));
      actions.appendChild(iconBtn('Delete', 'delete', () => deleteSpell(sp)));
      card.appendChild(actions);
    }
    list.appendChild(card);
  }
}

// The "learn" picker. Offers everything in the catalogue the character does not
// already know — a spell already in the book is not a choice.
function renderSpellChoices() {
  const sel = document.getElementById('sbSpell');
  if (!sel) return;
  const known = new Set(spellbook.map((e) => e.spell_id));
  const previous = sel.value;
  sel.textContent = '';
  for (const sp of spells) {
    if (known.has(sp.id)) continue;
    const o = document.createElement('option');
    o.value = sp.id;
    o.textContent = `${sp.name} (${levelLabel(sp.level)})`;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === previous)) sel.value = previous;
  syncSpellbookControls();
}

// The spell editor serves BOTH create and edit from one field set, exactly like
// the item editor. `selectedSpell === null` is the create state.
let selectedSpell = null;

function renderSpellEditor() {
  if (!isGm) return;
  const panel = document.getElementById('spellEditor');
  if (!panel || !window.VTTSpellSheet) return;
  const dialog = document.getElementById('spellDialog');
  const spell = selectedSpell ? spells.find((s) => s.id === selectedSpell) : null;

  const who = document.getElementById('spellWho');
  if (who) who.textContent = spell ? 'Edit spell' : 'New spell';

  let editorDirty = false;
  // Guard EVERY close route (X, Escape, backdrop, Cancel) through the themed
  // discard confirm when there are unsaved edits — the same hook the item editor
  // installs. On the standalone actors.html there is no #spellDialog, so this is
  // skipped and the inline editor simply stays put.
  if (dialog) {
    dialog._vttCloseGuard = function () {
      if (!editorDirty) return true;
      if (window.VTTGame && typeof window.VTTGame.confirm === 'function') {
        window.VTTGame.confirm(
          'Discard changes?',
          'This spell has unsaved changes. If you leave now they will be lost.',
          true,
          function () {
            editorDirty = false;
            if (window.VTTCommon && window.VTTCommon.closeDialog) window.VTTCommon.closeDialog(dialog, { force: true });
            else if (dialog.close) dialog.close();
          }
        );
        return false;
      }
      return true;
    };
  }
  function closeEditor() {
    if (dialog && window.VTTCommon && window.VTTCommon.closeDialog) window.VTTCommon.closeDialog(dialog);
    else if (dialog && dialog.close) dialog.close();
  }

  window.VTTSpellSheet.render(panel, {
    spell,
    // Seed the school dropdown with any custom values already in the catalogue,
    // so a legacy value stays selectable.
    schoolValues: customSchoolValues(),
    onDirtyChange: (d) => { editorDirty = d; },
    requestClose: closeEditor,
    onSave: async (patch, isNew) => {
      const r = isNew
        ? await api('POST', `/api/campaigns/${campaign.id}/spells`, patch)
        : await api('PATCH', `/api/campaigns/${campaign.id}/spells/${spell.id}`, patch);
      show(isNew ? 'POST spell' : 'PATCH spell', r);
      return r;
    },
    onDone: async (r) => {
      // Stay on the spell just created so details can be filled in without
      // hunting for it again.
      if (r.data && r.data.spell) selectedSpell = r.data.spell.id;
      await loadSpells();
      renderSpellEditor();
    },
  });
}

function newSpell() {
  selectedSpell = null;
  renderSpellEditor();
  openSpellDialog();
}

function editSpell(sp) {
  selectedSpell = sp.id;
  renderSpellEditor();
  openSpellDialog();
}

// On game.html the editor lives inside <dialog id="spellDialog">; on the
// standalone actors.html it is an inline fieldset with no dialog. Guarded so
// both work, exactly like openItemDialog.
function openSpellDialog() {
  const d = document.getElementById('spellDialog');
  if (d && window.VTTCommon && typeof window.VTTCommon.openDialog === 'function') {
    window.VTTCommon.openDialog(d, { invoker: document.getElementById('newSpell') });
  }
}

async function performSpellDelete(sp) {
  const r = await api('DELETE', `/api/campaigns/${campaign.id}/spells/${sp.id}`);
  show('DELETE spell', r);
  // The response names its blast radius, exactly as the item and scene deletes
  // do, so the log says what was emptied rather than just "ok".
  if (r.status === 200) {
    log(`spell deleted — removed from ${r.data.deleted.spellbook_entries} spellbook(s)`);
    if (selectedSpell === sp.id) selectedSpell = null;
    await loadSpells();
    await loadSpellbook();
  }
}

function deleteSpell(sp) {
  // Deleting a catalogue spell cascades to every spellbook that learned it. Say
  // so before it happens — the themed confirm on game.html, a window.confirm
  // fallback on the standalone harness.
  const title = `Delete ${sp.name}?`;
  const body = 'This removes the spell from the catalogue and from every character’s spellbook that has learned it. This cannot be undone.';
  if (window.VTTGame && typeof window.VTTGame.confirm === 'function') {
    window.VTTGame.confirm(title, body, true, () => { performSpellDelete(sp); });
    return;
  }
  if (typeof window.confirm === 'function' && !window.confirm(`${title}\n\n${body}`)) return;
  performSpellDelete(sp);
}

// ---- the spellbook ---------------------------------------------------------

let spellbookActorId = null;
let spellbookRequest = 0;
let spellbookBusy = false;
let spellbookLoading = false;
let spellbookAvailable = false;

function mayWriteSpellbook() {
  const actor = actors.find((a) => a.id === selectedActor);
  return !!actor && (isGm || (!actor.is_npc && me && actor.user_id === me.id));
}

// Keep the native select as the value/options source for the existing harness;
// the live game uses the same custom dropdown as the inventory item picker.
function syncBookDropdown(select, disabled) {
  if (!select) return;
  select.disabled = disabled;
  const common = window.VTTCommon;
  if (!common || typeof common.initDropdown !== 'function') return;
  if (!select._bookDropdown) {
    const dd = el('div', { cls: 'vtt-dd spellbook-dd' });
    const value = el('input'); value.type = 'hidden'; value.value = select.value;
    const trigger = el('button', { cls: 'vtt-dd-btn' }); trigger.type = 'button';
    trigger.id = select.id + '-button';
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', select.id === 'sbSpell' ? 'Spell to learn' : 'Spell source');
    const list = el('ul', { cls: 'vtt-dd-list' });
    list.setAttribute('role', 'listbox'); list.setAttribute('tabindex', '-1'); list.hidden = true;
    list.setAttribute('aria-label', select.id === 'sbSpell' ? 'Spells to learn' : 'Spell sources');
    dd.appendChild(value); dd.appendChild(trigger); dd.appendChild(list);
    select.after(dd);
    const controller = common.initDropdown(dd, [...select.options].map((o) => ({ value: o.value, label: o.textContent })));
    if (!controller || !controller.setOptions) { dd.remove(); return; }
    select.hidden = true;
    const label = select.parentNode.querySelector('label'); if (label) label.htmlFor = trigger.id;
    value.addEventListener('change', () => { select.value = value.value; select.dispatchEvent(new Event('change', { bubbles: true })); });
    select.addEventListener('change', () => controller.set(select.value));
    select._bookDropdown = { controller, trigger };
  }
  const { controller, trigger } = select._bookDropdown;
  controller.setOptions(select.options.length ? [...select.options].map((o) => ({ value: o.value, label: o.textContent })) : [{ value: '', label: 'No spells available to learn' }]);
  controller.set(select.value);
  trigger.disabled = disabled;
}

function syncSpellbookControls() {
  const block = document.getElementById('sheetSpellbookBlock');
  const writable = mayWriteSpellbook();
  const ready = writable && spellbookAvailable && spellbookActorId === selectedActor && !spellbookLoading && !spellbookBusy;
  if (block) {
    const row = block.querySelector('.spellbook-learn-row'); if (row) row.hidden = !writable;
  }
  const select = document.getElementById('sbSpell');
  syncBookDropdown(select, !ready || !select.options.length);
  syncBookDropdown(document.getElementById('sbSource'), !ready);
  const learn = document.getElementById('learnSpell');
  if (learn) { learn.hidden = !writable; learn.disabled = !ready || !select || !select.value; }
  document.querySelectorAll('#sbList button, #sbList summary').forEach((button) => {
    if (button.classList.contains('inv-item-name')) return;
    if (button.tagName === 'BUTTON') button.disabled = !ready;
  });
}

function spellbookError(message) {
  const box = document.querySelector('#sheetSpellbookBlock .spellbook-error');
  if (box) { box.textContent = message || ''; box.hidden = !message; }
}

async function loadSpellbook() {
  const who = document.getElementById('sbWho'), list = document.getElementById('sbList');
  const actorId = selectedActor;
  const request = ++spellbookRequest;
  const changed = spellbookActorId !== actorId;
  spellbookLoading = true; spellbookAvailable = false;
  if (changed || !actorId) { spellbook = []; spellbookActorId = actorId; spellbookError(''); renderSpellbook(); renderSpellChoices(); }
  syncSpellbookControls();
  if (!actorId) {
    spellbookLoading = false;
    who.textContent = 'select a character above';
    list.textContent = ''; syncSpellbookControls(); return;
  }
  const actor = actors.find((a) => a.id === actorId);
  who.textContent = actor ? actor.name : actorId;
  try {
    const result = await api('GET', `/api/campaigns/${campaign.id}/actors/${actorId}/spells`);
    if (request !== spellbookRequest || selectedActor !== actorId) return;
    spellbookLoading = false;
    if (result.status !== 200 || !result.data || !Array.isArray(result.data.spells)) {
      spellbook = []; renderSpellbook();
      list.textContent = '';
      list.appendChild(el('p', { cls: 'muted', text: result.status === 403 || result.status === 404 ? 'Spellbook unavailable.' : 'Could not load the spellbook. Reopen the sheet to retry.' }));
      return;
    }
    spellbook = result.data.spells; spellbookAvailable = true;
    renderSpellbook();
  } catch (err) {
    if (request === spellbookRequest && selectedActor === actorId) {
      spellbookLoading = false; spellbook = []; renderSpellbook(); spellbookError('Could not load the spellbook. Reopen the sheet to retry.');
    }
  } finally {
    if (request === spellbookRequest && selectedActor === actorId) {
      spellbookLoading = false; renderSpellChoices(); syncSpellbookControls();
    }
  }
}

function renderSpellbook() {
  const list = document.getElementById('sbList'); list.textContent = '';
  const actorId = selectedActor;
  const writable = mayWriteSpellbook();
  const summary = document.querySelector('#sheetSpellbookBlock .spellbook-summary');
  if (summary) summary.textContent = spellbook.length ? `${spellbook.length} learned · ${spellbook.filter((e) => e.prepared).length} prepared` : '';
  if (!spellbook.length) {
    list.appendChild(el('p', { cls: 'muted', text: spellbookLoading ? 'Loading spells…' : 'No spells learned yet.' }));
    return;
  }
  const SS = window.VTTSpellSheet || {};
  const byLevel = new Map();
  for (const entry of spellbook) {
    const level = entry.spell.level;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(entry);
  }
  for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
    list.appendChild(el('h4', { cls: 'spellbook-level', text: levelLabel(level) }));
    for (const entry of byLevel.get(level).sort((a, b) => a.spell.name.localeCompare(b.spell.name))) {
      const spell = entry.spell;
      const card = el('div', { cls: 'card inv-entry spellbook-entry' });
      card.tabIndex = 0;
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', `Spell: ${spell.name}`);
      card.addEventListener('click', (event) => {
        if (event.target.closest('button, input, select, textarea, a')) return;
        if (SS.openPreview) SS.openPreview(spell);
      });
      card.addEventListener('keydown', (event) => {
        if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          if (SS.openPreview) SS.openPreview(spell);
        }
      });
      const row = el('div', { cls: 'inv-entry-row' });
      const identity = el('div', { cls: 'spellbook-identity' });
      const name = button(spell.name, () => { if (SS.openPreview) SS.openPreview(spell); });
      name.type = 'button'; name.className = 'btn small inv-item-name';
      name.setAttribute('aria-label', `View ${spell.name}`); identity.appendChild(name);
      const school = spell.properties && typeof spell.properties.school === 'string' ? spell.properties.school : '';
      if (school) {
        const label = el('span', { cls: 'spellbook-school', text: SS.schoolLabel ? SS.schoolLabel(school) : school });
        if (SS.schoolColor) label.style.color = SS.schoolColor(school);
        identity.appendChild(label);
      }
      if (entry.source) identity.appendChild(el('span', { cls: 'spellbook-source', text: ({ class: 'Class', race: 'Ancestry', item: 'Item', other: 'Other' })[entry.source] || entry.source }));
      row.appendChild(identity);
      if (writable) {
        const prepared = button('Prepared', () => patchSpellbook(entry, { prepared: !entry.prepared }, actorId));
        prepared.type = 'button'; prepared.className = 'btn small secondary inv-toggle';
        prepared.setAttribute('aria-pressed', String(!!entry.prepared));
        prepared.setAttribute('aria-label', `Prepared: ${spell.name}`); row.appendChild(prepared);
        const forget = iconBtn(`Forget ${spell.name}`, 'delete', () => forgetSpell(entry, actorId));
        forget.className = 'btn small danger inv-trash';
        forget.querySelector('svg').setAttribute('aria-hidden', 'true');
        row.appendChild(forget);
      } else if (entry.prepared) row.appendChild(el('span', { cls: 'tag mine', text: 'Prepared' }));
      card.appendChild(row);
      if (spell.description) card.appendChild(el('p', { cls: 'spellbook-snippet', text: spell.description }));
      list.appendChild(card);
    }
  }
  syncSpellbookControls();
}

async function mutateSpellbook(method, suffix, body, actorId) {
  if (spellbookBusy || actorId !== selectedActor || !mayWriteSpellbook() || !spellbookAvailable || spellbookLoading) return;
  spellbookBusy = true; spellbookError(''); syncSpellbookControls();
  try {
    const result = await api(method, `/api/campaigns/${campaign.id}/actors/${actorId}/spells${suffix}`, body);
    show(`${method} spellbook`, result);
    if (result.status !== (method === 'POST' ? 201 : 200)) throw new Error((result.data && result.data.error) || 'Could not update the spellbook. Try again.');
    if (selectedActor === actorId) await loadSpellbook();
  } catch (err) {
    if (selectedActor === actorId) spellbookError(err.message || 'Could not update the spellbook. Try again.');
  } finally { spellbookBusy = false; syncSpellbookControls(); }
}

async function learnSpell() {
  const spellId = document.getElementById('sbSpell').value;
  if (!spellId) { spellbookError('Choose a spell to learn.'); return; }
  const body = { spell_id: spellId };
  const source = document.getElementById('sbSource').value;
  if (source) body.source = source;
  await mutateSpellbook('POST', '', body, selectedActor);
}

async function patchSpellbook(entry, patch, actorId = selectedActor) {
  await mutateSpellbook('PATCH', `/${entry.spell_id}`, patch, actorId);
}

function forgetSpell(entry, actorId = selectedActor) {
  const title = `Forget ${entry.spell.name}?`;
  const body = 'Remove this spell from this character’s spellbook? The catalogue spell and other characters’ spellbooks stay unchanged.';
  const accept = () => mutateSpellbook('DELETE', `/${entry.spell_id}`, undefined, actorId);
  if (window.VTTGame && window.VTTGame.confirm) window.VTTGame.confirm(title, body, true, accept);
  else if (window.confirm(`${title}\n\n${body}`)) accept();
}

// Filter/search state for the item grid.
const itemFilter = { q: '', type: '', rarity: '' };
let itemFiltersWired = false;

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact'];

function itemVisible(i) {
  const known = i.identified === true;
  // Search: the GM can always find an item by its real name, even unidentified;
  // a player can only match what they can see (the category).
  if (itemFilter.q) {
    let hay;
    if (isGm) hay = ((i.name || '') + ' ' + i.type).toLowerCase();
    else hay = (known ? (i.name || '') : ('unidentified ' + i.type)).toLowerCase();
    if (!hay.includes(itemFilter.q)) return false;
  }
  if (itemFilter.type && i.type !== itemFilter.type) return false;
  if (itemFilter.rarity) {
    // The GM filters by the true rarity even when unidentified; a player has no
    // rarity to filter on for an unidentified item.
    const r = (isGm || known) && i.properties ? i.properties.rarity : '';
    if (r !== itemFilter.rarity) return false;
  }
  return true;
}

function wireItemFilters() {
  if (itemFiltersWired) return;
  const IS = window.VTTItemSheet || {};
  const search = document.getElementById('itemSearch');
  const typeBox = document.getElementById('itemFilterType');
  const rarityBox = document.getElementById('itemFilterRarity');
  const toggle = document.getElementById('itemFilterToggle');
  const panel = document.getElementById('itemFilterPanel');
  const countBadge = document.getElementById('itemFilterCount');
  if (!search || !typeBox || !rarityBox) return;   // not the game page
  itemFiltersWired = true;

  search.addEventListener('input', () => { itemFilter.q = search.value.trim().toLowerCase(); renderItems(); });

  // Reflect how many filters are active on the toggle button; when none are set
  // the badge hides. Called after any chip change.
  function refreshFilterBadge() {
    const n = (itemFilter.type ? 1 : 0) + (itemFilter.rarity ? 1 : 0);
    if (countBadge) { countBadge.textContent = String(n); countBadge.hidden = n === 0; }
    if (toggle) toggle.classList.toggle('has-filters', n > 0);
  }

  // Filter panel toggles open/closed so the chips don't always take space.
  if (toggle && panel) {
    toggle.addEventListener('click', () => {
      const open = panel.hasAttribute('hidden');
      if (open) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.classList.toggle('open', open);
    });
  }

  // A segmented set of filter chips; clicking a chip toggles it (one active per group).
  function chipGroup(box, options, key) {
    box.textContent = '';
    const mk = (value, label, color) => {
      const chip = el('button', { cls: 'item-chip', text: label });
      chip.type = 'button';
      if (color) chip.style.setProperty('--chip-color', color);
      if (itemFilter[key] === value) chip.classList.add('active');
      chip.addEventListener('click', () => {
        itemFilter[key] = (itemFilter[key] === value) ? '' : value;
        chipGroup(box, options, key);   // re-render active state
        refreshFilterBadge();
        renderItems();
      });
      box.appendChild(chip);
    };
    mk('', 'All');
    for (const o of options) mk(o.value, o.label, o.color);
  }
  const TYPES = (IS.TYPES || ['weapon', 'armor', 'consumable', 'misc']);
  const TYPE_LABELS = IS.TYPE_LABELS || {};
  chipGroup(typeBox, TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] || t })), 'type');
  const RARITY_LABELS = IS.RARITY_LABELS || {}, RARITY_COLOR = IS.RARITY_COLOR || {};
  chipGroup(rarityBox, RARITY_ORDER.map((r) => ({ value: r, label: RARITY_LABELS[r] || r, color: RARITY_COLOR[r] })), 'rarity');
  refreshFilterBadge();
}

function renderItems() {
  wireItemFilters();
  const IS = window.VTTItemSheet || {};
  const list = document.getElementById('itemList');
  list.textContent = '';

  // The inventory picker (a themed vtt-dd) always lists everything. Its popup is
  // the app's custom list; the hidden #invItem input carries the chosen id, which
  // addToBag reads. Init once, then just swap the option set.
  const dd = document.getElementById('invItemDd');
  if (dd && window.VTTCommon && window.VTTCommon.initDropdown) {
    const opts = items.map((i) => ({
      value: i.id,
      label: i.identified === true ? i.name : `Unidentified ${i.type}`,
    }));
    if (invItemDd && invItemDd.setOptions) {
      invItemDd.setOptions(opts);
    } else {
      invItemDd = window.VTTCommon.initDropdown(dd, opts);
    }
    // A native <select> defaults to its first option's value; preserve that so
    // "Add to bag" without an explicit pick still targets the first item.
    const hid = document.getElementById('invItem');
    if (hid && !opts.some((o) => o.value === hid.value) && invItemDd && invItemDd.set) {
      invItemDd.set(opts.length ? opts[0].value : '');
    }
  }

  if (!items.length) {
    list.appendChild(el('p', { cls: 'muted item-empty', text: 'No items yet.' }));
    return;
  }
  const shown = items.filter(itemVisible);
  if (!shown.length) {
    list.appendChild(el('p', { cls: 'muted item-empty', text: 'No items match your search or filters.' }));
    return;
  }

  const RARITY_COLOR = IS.RARITY_COLOR || {}, RARITY_LABELS = IS.RARITY_LABELS || {}, TYPE_LABELS = IS.TYPE_LABELS || {};

  for (const i of shown) {
    const known = i.identified === true;
    const label = known ? i.name : `Unidentified ${i.type}`;
    const rarity = known && i.properties ? i.properties.rarity : '';

    const card = el('div', { cls: 'item-card' + (known ? '' : ' unidentified') });
    if (rarity && RARITY_COLOR[rarity]) card.style.setProperty('--card-rarity', RARITY_COLOR[rarity]);

    // Art (image-forward). Honors framing; blurred when unidentified.
    const art = el('div', { cls: 'item-card-art' });
    if (i.img_url) {
      const im = document.createElement('img'); im.alt = ''; im.src = i.img_url; im.draggable = false;
      const props = i.properties || {};
      const ox = Number(props.img_offset_x) || 0, oy = Number(props.img_offset_y) || 0;
      let sc = Number(props.img_scale) > 0 ? Number(props.img_scale) : 1;
      if (!known) sc *= 1.25;   // extra cover for the blur edge
      window.VTTImageFrame.apply(im, art, ox, oy, sc);
      im.addEventListener('error', () => { im.remove(); art.appendChild(el('div', { cls: 'item-card-noart', text: '?' })); });
      art.appendChild(im);
    } else {
      art.appendChild(el('div', { cls: 'item-card-noart', text: known ? '⚔' : '?' }));
    }
    card.appendChild(art);

    // Body: name + type · rarity.
    const body = el('div', { cls: 'item-card-body' });
    body.appendChild(el('div', { cls: 'item-card-name', text: label }));
    const meta = el('div', { cls: 'item-card-meta' });
    meta.appendChild(el('span', { cls: 'item-card-type', text: TYPE_LABELS[i.type] || i.type }));
    if (rarity) {
      const dot = el('span', { cls: 'item-card-dot' });
      if (RARITY_COLOR[rarity]) dot.style.background = RARITY_COLOR[rarity];
      meta.appendChild(dot);
      const rl = el('span', { cls: 'item-card-rarity', text: RARITY_LABELS[rarity] || rarity });
      if (RARITY_COLOR[rarity]) rl.style.color = RARITY_COLOR[rarity];
      meta.appendChild(rl);
    }
    body.appendChild(meta);
    card.appendChild(body);

    // Players click the card to view; the GM gets an explicit action row.
    function openView() {
      if (IS.openPreview) IS.openPreview(previewProjection(i));
    }
    if (!isGm) {
      card.classList.add('clickable');
      card.tabIndex = 0; card.setAttribute('role', 'button');
      card.addEventListener('click', openView);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openView(); } });
    } else {
      const actions = el('div', { cls: 'item-card-actions' });
      actions.appendChild(iconBtn('Preview', 'preview', () => { if (IS.openPreview) IS.openPreview(previewProjection(i)); }));
      actions.appendChild(iconBtn('Edit', 'edit', () => editItem(i)));
      actions.appendChild(iconBtn(known ? 'Hide (un-identify)' : 'Identify', known ? 'hide' : 'reveal', () => toggleIdentified(i)));
      actions.appendChild(iconBtn('Delete', 'delete', () => deleteItem(i)));
      card.appendChild(actions);
    }
    list.appendChild(card);
  }
}

// Build the projection the read-view expects. The GM sees items in full, so the
// preview shows the true player-facing view for that item's identified state.
function previewProjection(i) {
  const known = i.identified === true;
  if (known) {
    return { identified: true, name: i.name, img_url: i.img_url, type: i.type, weight: i.weight, description: i.description, properties: i.properties || {} };
  }
  const props = i.properties || {};
  return { identified: false, type: i.type, img_url: i.img_url,
    properties: { img_offset_x: props.img_offset_x, img_offset_y: props.img_offset_y, img_scale: props.img_scale } };
}

// A compact icon action button for the GM card row.
function iconBtn(title, kind, onClick) {
  const b = el('button', { cls: 'item-icon-btn item-icon-' + kind });
  b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
  const ICONS = {
    preview: '<circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>',
    edit: '<path d="M4 16.5 14.5 6 18 9.5 7.5 20 4 20z"/><path d="M13 7.5 16.5 11"/>',
    reveal: '<circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>',
    hide: '<path d="M2 12s3.5-7 10-7c2 0 3.7.6 5.2 1.5M22 12s-3.5 7-10 7c-2 0-3.7-.6-5.2-1.5"/><path d="M3 3l18 18"/>',
    delete: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICONS[kind] || '';
  b.appendChild(svg);
  b.addEventListener('click', onClick);
  return b;
}

function renderInventory(rows) {
  const list = document.getElementById('invList');
  list.textContent = '';
  const actorId = selectedActor;
  const actor = actors.find((a) => a.id === actorId);
  const mayWrite = !!actor && (isGm || (!actor.is_npc && me && actor.user_id === me.id));
  const add = document.getElementById('addToBag');
  if (add) add.hidden = !mayWrite;
  if (!rows || !rows.length) {
    list.appendChild(el('p', { cls: 'muted', text: 'bag is empty' }));
    return;
  }
  for (const r of rows) {
    const known = r.item.identified === true;
    const label = known ? r.item.name : `Unidentified ${r.item.type}`;
    const card = el('div', { cls: 'card inv-entry' });
    const row = el('div', { cls: 'inv-entry-row' });
    const name = button(label, () => {
      if (window.VTTItemSheet && window.VTTItemSheet.openPreview) {
        window.VTTItemSheet.openPreview(previewProjection(r.item));
      }
    });
    name.type = 'button';
    name.className = 'btn small inv-item-name';
    name.setAttribute('aria-label', `View ${label}`);
    row.appendChild(name);
    const error = el('p', { cls: 'inv-error' });
    error.setAttribute('role', 'alert');
    error.hidden = true;
    let busy = false;
    async function mutate(method, patch) {
      if (busy || !mayWrite) return;
      busy = true;
      error.hidden = true;
      const controls = [...row.querySelectorAll('button, input')];
      controls.forEach((n) => { n.disabled = true; });
      try {
        const result = await api(method,
          `/api/campaigns/${campaign.id}/actors/${actorId}/inventory/${r.id}`, patch);
        show(`${method} inventory`, result);
        if (result.status !== 200) {
          throw new Error((result.data && result.data.error) || 'Could not update this item. Try again.');
        }
        if (selectedActor === actorId) await loadBag();
      } catch (err) {
        error.textContent = err.message || 'Could not update this item. Try again.';
        error.hidden = false;
      } finally {
        busy = false;
        controls.forEach((n) => { n.disabled = false; });
      }
    }
    if (mayWrite) {
      const quantity = el('div', { cls: 'inv-quantity' });
      const qtyLabel = el('label', { cls: 'inv-qty-label', text: 'Qty' });
      const qty = el('input', { cls: 'inv-qty' });
      qty.type = 'number'; qty.min = '1'; qty.max = '9999'; qty.step = '1'; qty.required = true;
      qty.value = String(r.quantity);
      qty.setAttribute('aria-label', `Quantity of ${label}`);
      qtyLabel.appendChild(qty);
      quantity.appendChild(qtyLabel);
      const save = button('✓', () => saveQuantity());
      save.type = 'button'; save.className = 'btn small secondary inv-qty-save';
      save.setAttribute('aria-label', `Save quantity of ${label}`);
      save.title = 'Save quantity'; save.hidden = true;
      function saveQuantity() {
        if (qty.value === String(r.quantity)) return;
        if (!qty.reportValidity()) return;
        mutate('PATCH', { quantity: Number(qty.value) });
      }
      qty.addEventListener('input', () => { save.hidden = qty.value === String(r.quantity); });
      qty.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); saveQuantity(); }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation(); qty.value = String(r.quantity); save.hidden = true;
        }
      });
      quantity.appendChild(save);
      row.appendChild(quantity);
      for (const [key, title] of [['equipped', 'Equipped'], ['attuned', 'Attuned']]) {
        const toggle = button(title, () => mutate('PATCH', { [key]: !r[key] }));
        toggle.type = 'button'; toggle.className = 'btn small secondary inv-toggle';
        toggle.setAttribute('aria-pressed', String(!!r[key]));
        toggle.setAttribute('aria-label', `${title}: ${label}`);
        row.appendChild(toggle);
      }
      const remove = iconBtn(`Remove ${label} from bag`, 'delete', () => {
        const title = `Remove ${label}?`;
        const body = `Remove the entire stack (${r.quantity}) from this character’s bag? The catalogue item stays available. This does not place an item on the map.`;
        if (window.VTTGame && window.VTTGame.confirm) {
          window.VTTGame.confirm(title, body, true, () => mutate('DELETE'));
        } else if (window.confirm(`${title}\n\n${body}`)) mutate('DELETE');
      });
      remove.className = 'btn small danger inv-trash';
      remove.querySelector('svg').setAttribute('aria-hidden', 'true');
      row.appendChild(remove);
    } else {
      row.appendChild(el('span', { cls: 'inv-read-qty', text: `Qty ${r.quantity}` }));
      if (r.equipped) row.appendChild(el('span', { cls: 'tag', text: 'Equipped' }));
      if (r.attuned) row.appendChild(el('span', { cls: 'tag mine', text: 'Attuned' }));
    }
    card.appendChild(row); card.appendChild(error); list.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function loadCampaign(idArg, reconnect = false) {
  // Seam: the harness reads the id from #campaignId; the game shell passes it in
  // via boot() (deferred to the first Characters/Library open). Reading the
  // input would throw on a page without it, so only read when no id was given.
  const _ci = document.getElementById('campaignId');
  const id = idArg != null ? idArg : (_ci ? _ci.value.trim() : '');
  if (!id) return;
  const r = await api('GET', `/api/campaigns/${id}`);
  show('GET campaign', r);
  if (r.status !== 200) {
    campaign = null;
    document.getElementById('campaignInfo').textContent = 'could not load that campaign';
    return;
  }
  campaign = r.data.campaign;
  isGm = campaign.is_gm === true;
  document.body.classList.toggle('is-gm', isGm);
  document.getElementById('campaignInfo').textContent =
    `${campaign.name} — you are ${isGm ? 'the GM' : 'a player'}` +
    (campaign.active_scene_id ? '' : ' · no active scene (NPCs stay hidden until one is set)');

  if (isGm) await loadMembers();
  if (isGm) renderItemEditor();
  if (isGm) renderSpellEditor();
  await refresh();
  if (!reconnect) connectSocket();
}

// Active members, for the creation modal's "Controlled by" dropdown. Stored in a
// module variable rather than injected into a <select> now that creation is a
// themed modal. Active members only: the server refuses a user_id that is not an
// active member (assigning a character to a banned user would hand them write
// access to a campaign they cannot otherwise reach), so offering one would only
// manufacture 400s.
let memberOptions = [];
async function loadMembers() {
  const r = await api('GET', `/api/campaigns/${campaign.id}/members`);
  if (r.status !== 200) { memberOptions = []; return; }
  memberOptions = (r.data.members || [])
    .filter((x) => x.status === 'active')
    .map((m) => ({ id: m.user_id || m.id, label: m.username + (m.is_gm ? ' (GM)' : '') }));
}

async function refresh() {
  if (!campaign) return;
  const [a, i] = await Promise.all([
    api('GET', `/api/campaigns/${campaign.id}/actors`),
    api('GET', `/api/campaigns/${campaign.id}/items`),
  ]);
  actors = a.status === 200 ? a.data.actors : [];
  items = i.status === 200 ? i.data.items : [];
  renderActors();
  renderItems();
  await loadSpells();
  await loadAssets();
  // A background refresh must NOT clobber an in-progress sheet edit. Re-render
  // the sheet only when it is not dirty; the bag and spellbook are read-only
  // views and always refresh.
  if (selectedActor) {
    if (!sheetDirty) renderSheet();
    await loadBag(); await loadSpellbook();
  }
  if (isGm && document.getElementById('itemEditor').childElementCount === 0) renderItemEditor();
  { const sp = document.getElementById('spellEditor'); if (isGm && sp && sp.childElementCount === 0) renderSpellEditor(); }
  { const ae = document.getElementById('actorEditor'); if (ae && ae.childElementCount <= 1) renderActorEditor(); }

  // Character cap, shown to everyone: a player sees their per-player cap, the GM
  // the campaign-wide count.
  const capEl = document.getElementById('actorCap');
  if (capEl) {
    if (isGm) capEl.textContent = `${actors.length} character(s) in this campaign`;
    else {
      const mine = actors.filter((x) => me && x.user_id === me.id).length;
      capEl.textContent = `${mine}/3 characters · The GM chooses which characters appear in the party.`;
    }
  }
}

// Character creation now lives in the themed #actorDialog, driven by
// VTTActorSheet. The form sends only the caller's tier of fields (the server
// forces user_id/is_npc for a player and refuses GM fields), and portrait +
// framing ride along in the SAME create request.
function renderActorEditor() {
  const panel = document.getElementById('actorEditor');
  if (!panel || !window.VTTActorSheet) return;
  const dialog = document.getElementById('actorDialog');

  let editorDirty = false;
  if (dialog) {
    dialog._vttCloseGuard = function () {
      if (!editorDirty) return true;
      if (window.VTTGame && typeof window.VTTGame.confirm === 'function') {
        window.VTTGame.confirm(
          'Discard new character?',
          'This character has not been created yet. If you leave now your entries will be lost.',
          true,
          function () {
            editorDirty = false;
            if (window.VTTCommon && window.VTTCommon.closeDialog) window.VTTCommon.closeDialog(dialog, { force: true });
            else if (dialog.close) dialog.close();
          }
        );
        return false;
      }
      return true;
    };
  }
  function closeEditor() {
    if (dialog && window.VTTCommon && window.VTTCommon.closeDialog) window.VTTCommon.closeDialog(dialog);
    else if (dialog && dialog.close) dialog.close();
  }

  window.VTTActorSheet.render(panel, {
    isGm,
    members: memberOptions,
    onDirtyChange: (d) => { editorDirty = d; },
    requestClose: closeEditor,
    // Opening/cancelling image selection must not discard the draft — the picker
    // only calls back with a chosen url + frame, and VTTActorSheet keeps them in
    // its own draft until Create.
    onPickImage: (current, cb, curFrame) => {
      if (!window.VTTImagePicker) return;
      window.VTTImagePicker.open({
        campaignId: campaign ? campaign.id : null,
        kind: 'portrait',
        current,
        frame: curFrame,
        onChoose: (url, frame) => cb(url, frame),
      });
    },
    onSave: async (body) => {
      const r = await api('POST', `/api/campaigns/${campaign.id}/actors`, body);
      show('POST actor', r);
      if (r.status === 409) log('CAP: ' + (r.data.error || 'refused'));
      return r;
    },
    onDone: async (data) => {
      editorDirty = false;
      closeEditor();
      await refresh();
      // Open the new character's sheet.
      if (data && data.actor) selectActor(data.actor);
    },
  });
}

function newActor() {
  renderActorEditor();
  openActorDialog();
}

function openActorDialog() {
  const d = document.getElementById('actorDialog');
  if (d && window.VTTCommon && typeof window.VTTCommon.openDialog === 'function') {
    window.VTTCommon.openDialog(d, { invoker: document.getElementById('newActor') });
  }
}

async function adjustHp(a, delta) {
  const r = await api('PATCH', `/api/campaigns/${campaign.id}/actors/${a.id}`, {
    hp_current: a.hp_current + delta,
  });
  show('PATCH hp', r);
  await refresh();
}

async function performActorDelete(a) {
  const r = await api('DELETE', `/api/campaigns/${campaign.id}/actors/${a.id}`);
  show('DELETE actor', r);
  if (r.status === 200) {
    log(`${a.name} deleted — ${r.data.tokens_unlinked} token(s) unlinked, ${r.data.spellbook_entries} spellbook entr(ies) removed`);
  }
  if (selectedActor === a.id) {
    selectedActor = null;
    document.getElementById('invWho').textContent = 'select a character above';
    document.getElementById('sheetWho').textContent = 'none selected';
    renderSheet();
    loadSpellbook();
  }
  await refresh();
}

function deleteActor(a) {
  // Deleting a character removes its inventory and spellbook entries and leaves
  // any placed tokens on their maps as UNLINKED markers (the FK is SET NULL, not
  // CASCADE). Name that blast radius before it happens.
  const title = `Delete ${a.name}?`;
  const body = 'This removes the character along with its inventory and spellbook entries. Any tokens of it stay on their maps as unlinked markers. This cannot be undone.';
  if (window.VTTGame && typeof window.VTTGame.confirm === 'function') {
    window.VTTGame.confirm(title, body, true, () => { performActorDelete(a); });
    return;
  }
  if (typeof window.confirm === 'function' && !window.confirm(`${title}\n\n${body}`)) return;
  performActorDelete(a);
}

// The item editor serves BOTH create and edit from one field set, so a field can
// never exist on one form and be missing from the other. `selectedItem === null`
// is the create state.
let selectedItem = null;

function renderItemEditor() {
  if (!isGm) return;
  const panel = document.getElementById('itemEditor');
  const dialog = document.getElementById('itemDialog');
  const item = selectedItem ? items.find((i) => i.id === selectedItem) : null;
  // The editor owns its own identity header; the dialog title stays generic so
  // the name is not repeated in two places. (#itemWho kept for callers/tests.)
  const who = document.getElementById('itemWho');
  if (who) who.textContent = item ? 'Edit item' : 'New item';
  let editorDirty = false;
  // Guard EVERY close route (X button, Escape, backdrop click, and the editor's
  // own Cancel) through the themed discard confirm when there are unsaved edits.
  if (dialog) {
    dialog._vttCloseGuard = function () {
      if (!editorDirty) return true;                 // nothing to lose
      if (window.VTTGame && typeof window.VTTGame.confirm === 'function') {
        window.VTTGame.confirm(
          'Discard changes?',
          'This item has unsaved changes. If you leave now they will be lost.',
          true,
          function () {
            editorDirty = false;
            if (window.VTTCommon && window.VTTCommon.closeDialog) window.VTTCommon.closeDialog(dialog, { force: true });
            else if (dialog.close) dialog.close();
          }
        );
        return false;                                // veto for now; confirm closes it
      }
      return true;
    };
  }
  function closeEditor() {
    // Cancel routes through the same guard as every other close affordance.
    if (dialog && window.VTTCommon && window.VTTCommon.closeDialog) window.VTTCommon.closeDialog(dialog);
    else if (dialog && dialog.close) dialog.close();
  }
  window.VTTItemSheet.render(panel, {
    item,
    onDirtyChange: (d) => { editorDirty = d; },
    requestClose: closeEditor,
    // Open the site's shared image picker (the same grid modal the dashboard
    // uses for avatars) so item art is chosen from the campaign's uploaded
    // images, a fresh upload, or a URL.
    onPickImage: (current, choose, currentFrame) => {
      if (!window.VTTImagePicker || !window.VTTImagePicker.open) return;
      window.VTTImagePicker.open({
        kind: 'item',
        campaignId: campaign.id,
        current: current || null,
        frame: currentFrame || { offsetX: 0, offsetY: 0, scale: 1 },
        frameTitle: 'Frame the item image',
        frameNote: 'Drag to move · scroll to zoom. This is how the item art will be cropped.',
        onChoose: (url, framing) => choose(url, framing),
      });
    },
    onSave: async (patch, isNew) => {
      const r = isNew
        ? await api('POST', `/api/campaigns/${campaign.id}/items`, patch)
        : await api('PATCH', `/api/campaigns/${campaign.id}/items/${item.id}`, patch);
      show(isNew ? 'POST item' : 'PATCH item', r);
      return r;
    },
    onDone: async (r) => {
      // Stay on the item just created so its properties can be filled in
      // without hunting for it in the list again.
      if (r.data && r.data.item) selectedItem = r.data.item.id;
      await refresh();
      renderItemEditor();
    },
  });
}

function newItem() {
  selectedItem = null;
  renderItemEditor();
  openItemDialog();
}

function editItem(i) {
  selectedItem = i.id;
  renderItemEditor();
  openItemDialog();
}

// On game.html the item editor lives inside <dialog id="itemDialog">, which has
// to be opened explicitly; on the standalone actors.html the editor is an inline
// fieldset with no dialog. Guarded so both work: open the dialog if present,
// otherwise the inline editor is already visible.
function openItemDialog() {
  const d = document.getElementById('itemDialog');
  if (d && window.VTTCommon && typeof window.VTTCommon.openDialog === 'function') {
    window.VTTCommon.openDialog(d, { invoker: document.getElementById('newItem') });
  }
}

async function toggleIdentified(i) {
  const r = await api('PATCH', `/api/campaigns/${campaign.id}/items/${i.id}`, { identified: !i.identified });
  show('PATCH identified', r);
  await refresh();
}

async function performItemDelete(i) {
  const r = await api('DELETE', `/api/campaigns/${campaign.id}/items/${i.id}`);
  show('DELETE item', r);
  if (r.status === 200) log(`item deleted — removed from ${r.data.inventory_rows_removed} bag(s)`);
  if (selectedItem === i.id) selectedItem = null;
  await refresh();
  if (isGm) renderItemEditor();
}

function deleteItem(i) {
  // Deleting a catalogue item cascades to every character's inventory that holds
  // it. Warn before it happens — the themed confirm on game.html, a window.confirm
  // fallback on the standalone harness. Mirrors deleteSpell.
  const title = `Delete ${i.name}?`;
  const body = 'This removes the item from the catalogue and from every character’s inventory that has it. This cannot be undone.';
  if (window.VTTGame && typeof window.VTTGame.confirm === 'function') {
    window.VTTGame.confirm(title, body, true, () => { performItemDelete(i); });
    return;
  }
  if (typeof window.confirm === 'function' && !window.confirm(`${title}\n\n${body}`)) return;
  performItemDelete(i);
}

// True while the open sheet has unsaved edits — consulted before a background
// refresh/socket update re-renders it, so a dirty draft is never silently
// overwritten.
let sheetDirty = false;

function selectActor(a) {
  // Switching characters replaces the sheet draft. If the current one is dirty,
  // confirm through the themed prompt before discarding it.
  if (sheetDirty && selectedActor && selectedActor !== a.id) {
    if (window.VTTGame && typeof window.VTTGame.confirm === 'function') {
      window.VTTGame.confirm(
        'Discard changes?',
        'The character sheet you are editing has unsaved changes. Switching characters now will lose them.',
        true,
        () => { sheetDirty = false; selectActor(a); }
      );
      return;
    }
    if (typeof window.confirm === 'function' && !window.confirm('Discard unsaved sheet changes and switch characters?')) return;
    sheetDirty = false;
  }

  selectedActor = a.id;
  document.getElementById('invWho').textContent = a.name;
  const who = document.getElementById('sheetWho'); if (who) who.textContent = a.name;
  sheetDirty = false;
  renderActors();
  renderSheet();
  openSheetDialog();
  loadBag();
  loadSpellbook();
}

// On game.html the sheet lives inside <dialog id="sheetDialog">, which must be
// opened explicitly. On the standalone actors.html the sheet is an inline panel
// with no dialog, so this is a guarded no-op there.
function openSheetDialog() {
  const d = document.getElementById('sheetDialog');
  if (d && window.VTTCommon && typeof window.VTTCommon.openDialog === 'function') {
    window.VTTCommon.openDialog(d, { invoker: document.getElementById('actorList') });
  }
}

// The sheet is rendered from the row already in `actors`, which is whatever this
// viewer was allowed to receive — so a projected NPC renders as a projection
// without the sheet needing its own visibility rule. One source of truth for
// "what may I see", decided on the server.
function renderSheet() {
  const panel = document.getElementById('sheetPanel');
  if (!panel) return;
  const oldTab = panel.querySelector('.fo-tab[aria-selected="true"]');
  const oldPage = panel.querySelector('.fo-page:not([hidden])');
  const activeTab = oldTab && oldPage && panel.dataset.actorId === selectedActor
    ? ['character', 'features', 'inventory', 'spellbook', 'journal'].find((id) => oldPage.classList.contains('fo-page-' + id)) : 'character';
  // Park the live block before any sheet clear, including no-selection/projected views.
  const bookBlock = document.getElementById('sheetSpellbookBlock');
  if (bookBlock) { bookBlock.hidden = true; panel.parentNode.appendChild(bookBlock); }
  panel.dataset.actorId = selectedActor || '';
  const a = actors.find((x) => x.id === selectedActor);
  if (!a) {
    panel.textContent = '';
    panel.appendChild(el('p', { cls: 'muted', text: 'select a character above' }));
    return;
  }

  const dialog = document.getElementById('sheetDialog');
  // Rescue the inventory block out of #sheetPanel before VTTSheet.render wipes
  // the panel — otherwise the relocated block would be destroyed on re-render.
  // It is re-inserted into the Inventory tab via onInventoryMount below. Parked
  // on the dialog's card-inner (or the dialog) so it survives the wipe.
  {
    const invBlock = document.getElementById('sheetInvBlock');
    if (invBlock && dialog) {
      const parkTo = dialog.querySelector('.card-inner') || dialog;
      invBlock.hidden = true;            // hidden while parked (e.g. projected NPC)
      parkTo.appendChild(invBlock);
    }
  }
  if (dialog) {
    dialog._vttCloseGuard = function () {
      if (!sheetDirty) return true;
      if (window.VTTGame && typeof window.VTTGame.confirm === 'function') {
        window.VTTGame.confirm(
          'Discard changes?',
          'This character sheet has unsaved changes. If you leave now they will be lost.',
          true,
          function () {
            sheetDirty = false;
            if (window.VTTCommon && window.VTTCommon.closeDialog) window.VTTCommon.closeDialog(dialog, { force: true });
            else if (dialog.close) dialog.close();
          }
        );
        return false;
      }
      return true;
    };
  }

  const mayWriteActor = isGm || (me && a.user_id === me.id);
  window.VTTSheet.render(panel, {
    actor: a,
    isGm,
    me,
    onDirtyChange: (d) => { sheetDirty = d; },
    // The Inventory tab hands us its mount; move the existing inventory block
    // (subhead + add-to-bag row + #invList, with their ids and one-time bindings
    // intact) into it. Moving — not recreating — preserves the actors.js wiring.
    // On the standalone harness there is no such block, so this is a no-op.
    activeTab,
    onSpellbookMount: (mount) => {
      const src = document.getElementById('sheetSpellbookBlock');
      if (src && mount) { src.hidden = false; mount.appendChild(src); syncSpellbookControls(); }
    },
    onInventoryMount: (mount) => {
      const src = document.getElementById('sheetInvBlock');
      if (src && mount) { src.hidden = false; mount.appendChild(src); }
    },
    requestClose: () => {
      if (dialog && window.VTTCommon && window.VTTCommon.closeDialog) window.VTTCommon.closeDialog(dialog);
      else if (dialog && dialog.close) dialog.close();
    },
    // The portrait's hover-pencil calls this. It opens the shared image picker
    // (same grid modal as the dashboard/items). A chosen URL is handed back to
    // the sheet's hidden #sheet-img_url field (marking the draft dirty so Save
    // appears); framing is applied to the crop columns and PATCHed immediately,
    // exactly as the old attach() flow did — the crop lives with the portrait.
    onPickPortrait: (current, setUrl) => {
      if (!window.VTTImagePicker || !window.VTTImagePicker.open || !mayWriteActor) return;
      window.VTTImagePicker.open({
        campaignId: campaign ? campaign.id : null,
        kind: 'portrait',
        current,
        frame: {
          offsetX: Number(a.img_offset_x) || 0,
          offsetY: Number(a.img_offset_y) || 0,
          scale: Number(a.img_scale) > 0 ? Number(a.img_scale) : 1,
        },
        frameTitle: 'Frame the portrait',
        frameNote: 'Drag to move · scroll to zoom. This is the crop tokens will use.',
        onChoose: async (url, framing) => {
          setUrl(url || '');
          if (framing) {
            const r = await api('PATCH', `/api/campaigns/${campaign.id}/actors/${a.id}`, {
              img_offset_x: framing.offsetX, img_offset_y: framing.offsetY, img_scale: framing.scale,
            });
            show('PATCH framing', r);
            if (r.status === 200) await refresh();
          }
        },
      });
    },
    onSave: async (patch) => {
      const r = await api('PATCH', `/api/campaigns/${campaign.id}/actors/${a.id}`, patch);
      show('PATCH actor', r);
      if (r.status === 200) { sheetDirty = false; await refresh(); }
      return r;
    },
  });
}

async function loadBag() {
  if (!selectedActor) return;
  const r = await api('GET', `/api/campaigns/${campaign.id}/actors/${selectedActor}/inventory`);
  if (r.status !== 200) { renderInventory([]); return; }
  renderInventory(r.data.inventory);
}

async function addToBag() {
  if (!selectedActor) { show('add to bag', { status: 0, data: { error: 'select a character first' } }); return; }
  const r = await api('POST', `/api/campaigns/${campaign.id}/actors/${selectedActor}/inventory`, {
    item_id: document.getElementById('invItem').value,
    quantity: num('invQty'),
  });
  show('POST inventory', r);
  await loadBag();
}

async function patchInv(r0, patch) {
  const r = await api('PATCH',
    `/api/campaigns/${campaign.id}/actors/${selectedActor}/inventory/${r0.id}`, patch);
  show('PATCH inventory', r);
  // The 3-item attunement cap is enforced atomically; surface the refusal
  // rather than letting the button appear to do nothing.
  if (r.status === 409) log('CAP: ' + (r.data.error || 'refused'));
  await loadBag();
}

async function dropInv(r0) {
  const r = await api('DELETE',
    `/api/campaigns/${campaign.id}/actors/${selectedActor}/inventory/${r0.id}`);
  show('DELETE inventory', r);
  await loadBag();
}

// ---------------------------------------------------------------------------
// sockets — the point of the harness
// ---------------------------------------------------------------------------

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ withCredentials: true, transports: ['websocket'] });

  window.VTTCommon.watchCampaignSocket('actors', socket, () => campaign && campaign.id,
    async () => {
      recoveringSocket = true; recoveryFailed = false;
      try {
        await loadCampaign(campaign.id, true);
        if (recoveryFailed) throw new Error('State refresh failed');
      }
      finally { recoveringSocket = false; }
    });

  // Printed VERBATIM and un-prettified on purpose. On the GM's screen an
  // actor:updated for an NPC carries hp_current, armor_class and notes; on a
  // player's screen the same event for the same NPC carries only
  // {id, campaign_id, user_id, name, img_url, is_npc, size} — and for an NPC
  // with no visible token, nothing arrives at all. Reading the two logs side by
  // side is more convincing than any assertion.
  for (const ev of ['actor:updated', 'actor:deleted', 'party:changed', 'item:created', 'item:updated', 'item:deleted']) {
    socket.on(ev, (d) => {
      log(`${ev}  ${JSON.stringify(d)}`);
      refresh();
    });
  }

  // Carries only { actor_id } by design: the authorised read path is the only
  // thing that ever shapes item data, so there is no second place for the
  // projection to drift.
  socket.on('inventory:changed', (d) => {
    log(`inventory:changed  ${JSON.stringify(d)}`);
    if (selectedActor === d.actor_id) loadBag();
  });

  // Carries only an actor_id — the same decision inventory:changed made, so a
  // spellbook event can never become a second disclosure channel. Clients
  // re-fetch through the authorised path, which re-applies the NPC gate.
  socket.on('spellbook:changed', (d) => {
    log(`spellbook:changed  ${JSON.stringify(d)}`);
    if (selectedActor === d.actor_id) loadSpellbook();
  });

  for (const ev of ['spell:created', 'spell:updated', 'spell:deleted']) {
    socket.on(ev, (d) => {
      log(`${ev}  ${JSON.stringify(d)}`);
      loadSpells();
    });
  }

  socket.on('token:unlinked', (d) => log(`token:unlinked  ${JSON.stringify(d)}`));
  socket.on('disconnect', () => log('socket disconnected'));
}

// ---------------------------------------------------------------------------

// Seam: the harness "load" button is gone on the game page; guarded. All other
// bindings below use ids that survive into game.html.
{ const _lc = document.getElementById('loadCampaign'); if (_lc) _lc.addEventListener('click', () => loadCampaign()); }
{ const _na = document.getElementById('newActor'); if (_na) _na.addEventListener('click', newActor); }
document.getElementById('newItem').addEventListener('click', newItem);
document.getElementById('addToBag').addEventListener('click', addToBag);
document.getElementById('clearLog').addEventListener('click', () => { logEl.textContent = ''; });

// Fixture compatibility: a campaign query parameter preloads, so the GM and player
// windows can be opened from the same link.
initFraming();

document.getElementById('assetUpload').addEventListener('click', uploadAsset);
document.getElementById('assetLink').addEventListener('click', addAssetLink);
// The inline "add spell" form and the server-side level <select> are gone —
// authoring is now the modal editor, filtering is client-side. Bindings guarded
// so a page without these elements (should not happen now) doesn't throw.
{ const _ns = document.getElementById('newSpell'); if (_ns) _ns.addEventListener('click', newSpell); }
{ const _ls = document.getElementById('learnSpell'); if (_ls) _ls.addEventListener('click', learnSpell); }

const preset = new URLSearchParams(window.location.search).get('campaign');
{ const _ci = document.getElementById('campaignId'); if (_ci && preset) _ci.value = preset; }

// Seam: on the harness, preset auto-loads. On the game page there is no
// #campaignId input, so this never fires — the shell defers VTTActors.boot(id)
// to the first Characters/Library open (the heavy half of the old boot).
{ const _hasInput = !!document.getElementById('campaignId');
  whoami().then(() => { if (preset && _hasInput) loadCampaign(); }); }

// The game shell's entry point: the characters/items/spells/assets loader.
function boot(campaignId) { return loadCampaign(campaignId); }
window.VTTActors = { boot };


/* --- expose internals the jsdom test suite reads via window.* --- */
  try { window.loadCampaign = loadCampaign; } catch (e) {}
  try { window.selectActor = selectActor; } catch (e) {}
})();
