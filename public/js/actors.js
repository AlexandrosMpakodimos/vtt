// Dev harness for M4 — actors, items, inventory.
//
// Kept in an external file and built with createElement + addEventListener: the
// CSP is `script-src 'self'`, so inline <script> bodies and on*= handlers are
// blocked, and every user-supplied string reaches the DOM through `textContent`
// so it never enters an HTML parsing context. The canvas audit's standing note
// applies here verbatim: names are stored raw server-side, so this file must
// NEVER switch to innerHTML.
//
// Deliberately a SEPARATE page from scene.html. The four jsdom suites
// (test-shortcuts, test-marquee, test-fog-ui, test-bulk-place) `eval` the real
// scene.html/scene.js, so keeping actor CRUD out of those files leaves 134
// assertions untouched.
//
// What this harness is FOR, beyond clicking things: open it as the GM in one
// browser and as a player in another, against the same campaign, and watch the
// socket log. The projection is the hardest part of M4 to believe from a test
// report — here the two roles' payloads sit side by side on screen.

const out = document.getElementById('out');
const logEl = document.getElementById('log');

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

function renderActors() {
  const list = document.getElementById('actorList');
  list.textContent = '';
  if (!actors.length) {
    list.appendChild(el('p', { cls: 'muted', text: 'no characters visible to you' }));
    return;
  }
  for (const a of actors) {
    const card = el('div', { cls: 'card' + (selectedActor === a.id ? ' sel' : '') });

    const head = el('div');
    head.appendChild(el('b', { text: a.name }));
    if (a.is_npc) head.appendChild(el('span', { cls: 'tag npc', text: 'NPC' }));
    if (me && a.user_id === me.id) head.appendChild(el('span', { cls: 'tag mine', text: 'yours' }));
    if (isProjected(a)) head.appendChild(el('span', { cls: 'tag secret', text: 'stats withheld' }));
    card.appendChild(head);

    if (!isProjected(a)) {
      const bits = [
        `lvl ${a.level}`, a.class, a.race, a.size,
        `HP ${a.hp_current}/${a.hp_max}`, `AC ${a.armor_class}`,
        `STR ${a.strength} DEX ${a.dexterity} CON ${a.constitution}`,
        `INT ${a.intelligence} WIS ${a.wisdom} CHA ${a.charisma}`,
      ].filter(Boolean);
      card.appendChild(el('div', { cls: 'stats', text: bits.join(' · ') }));
      if (a.death_save_successes || a.death_save_failures) {
        card.appendChild(el('div', {
          cls: 'stats',
          text: `death saves — ${a.death_save_successes} success / ${a.death_save_failures} failure`,
        }));
      }
      // hp_current may be negative and is never clamped: the server stores the
      // number and does not interpret it. "Dead" is a display state, decided
      // here, and it stays purely cosmetic — nothing is enforced.
      if (a.hp_current <= 0) {
        card.appendChild(el('div', { cls: 'stats', text: '☠ down — the GM adjudicates what that means' }));
      }
      const bar = hpBar(a);
      if (bar) card.appendChild(bar);
    } else {
      card.appendChild(el('div', { cls: 'muted', text: `${a.size} — the GM has not shared its statistics` }));
    }

    const row = el('div', { cls: 'row' });
    row.appendChild(button('open sheet', () => selectActor(a)));

    const mayWrite = isGm || (me && a.user_id === me.id);
    if (mayWrite && !isProjected(a)) {
      const dmg = el('input');
      dmg.type = 'number';
      dmg.value = '1';
      dmg.style.maxWidth = '70px';
      row.appendChild(dmg);
      row.appendChild(button('damage', () => adjustHp(a, -Math.abs(Number(dmg.value) || 0))));
      row.appendChild(button('heal', () => adjustHp(a, Math.abs(Number(dmg.value) || 0))));
      row.appendChild(button('delete', () => deleteActor(a)));
    }
    card.appendChild(row);
    list.appendChild(card);
  }
}

function renderItems() {
  const list = document.getElementById('itemList');
  const picker = document.getElementById('invItem');
  list.textContent = '';
  picker.textContent = '';

  if (!items.length) {
    list.appendChild(el('p', { cls: 'muted', text: 'no items' }));
    return;
  }
  for (const i of items) {
    const known = i.identified === true;
    // An unidentified item arrives with no NAME — the label is derived from its
    // category, which is all a player can honestly be told. This is why the
    // server withholds `name` rather than only the mechanical fields.
    const label = known ? i.name : `Unidentified ${i.type}`;

    const card = el('div', { cls: 'card' });
    const head = el('div');
    head.appendChild(el('b', { text: label }));
    if (!known) head.appendChild(el('span', { cls: 'tag secret', text: 'unidentified' }));
    card.appendChild(head);

    if (known) {
      const bits = [i.type, i.weight ? `${i.weight} lb` : null, i.description].filter(Boolean);
      card.appendChild(el('div', { cls: 'stats', text: bits.join(' · ') }));
    } else {
      card.appendChild(el('div', { cls: 'muted', text: `${i.type} — its properties are unknown` }));
    }

    if (isGm) {
      const row = el('div', { cls: 'row' });
      row.appendChild(button('edit', () => editItem(i)));
      row.appendChild(button(i.identified ? 'un-identify' : 'identify', () => toggleIdentified(i)));
      row.appendChild(button('delete', () => deleteItem(i)));
      card.appendChild(row);
    }
    list.appendChild(card);

    const opt = el('option', { text: label });
    opt.value = i.id;
    picker.appendChild(opt);
  }
}

function renderInventory(rows) {
  const list = document.getElementById('invList');
  list.textContent = '';
  if (!rows || !rows.length) {
    list.appendChild(el('p', { cls: 'muted', text: 'bag is empty' }));
    return;
  }
  for (const r of rows) {
    const known = r.item.identified === true;
    const label = known ? r.item.name : `Unidentified ${r.item.type}`;
    const card = el('div', { cls: 'card' });

    const head = el('div');
    head.appendChild(el('b', { text: `${label} ×${r.quantity}` }));
    if (r.equipped) head.appendChild(el('span', { cls: 'tag', text: 'equipped' }));
    if (r.attuned) head.appendChild(el('span', { cls: 'tag mine', text: 'attuned' }));
    if (!known) head.appendChild(el('span', { cls: 'tag secret', text: 'unidentified' }));
    card.appendChild(head);

    const row = el('div', { cls: 'row' });
    const qty = el('input');
    qty.type = 'number';
    qty.min = '1';
    qty.value = String(r.quantity);
    qty.style.maxWidth = '70px';
    row.appendChild(qty);
    row.appendChild(button('set qty', () => patchInv(r, { quantity: Number(qty.value) })));
    row.appendChild(button(r.equipped ? 'unequip' : 'equip',
      () => patchInv(r, { equipped: !r.equipped })));
    row.appendChild(button(r.attuned ? 'un-attune' : 'attune',
      () => patchInv(r, { attuned: !r.attuned })));
    row.appendChild(button('drop', () => dropInv(r)));
    card.appendChild(row);
    list.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function loadCampaign() {
  const id = document.getElementById('campaignId').value.trim();
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
  await refresh();
  connectSocket();
}

// Populate the "controlled by" picker. The server refuses a user_id that is not
// an active member, so offering anything else would only produce 400s.
async function loadMembers() {
  const r = await api('GET', `/api/campaigns/${campaign.id}/members`);
  const sel = document.getElementById('acOwner');
  sel.textContent = '';
  const none = el('option', { text: 'nobody (GM runs it)' });
  none.value = '';
  sel.appendChild(none);
  if (r.status !== 200) return;
  // Active members only. The server refuses a user_id that is not an active
  // member, so listing a kicked or banned one would only manufacture 400s — and
  // that refusal exists for a real reason: assigning a character to a banned
  // user would hand them write access to a row inside a campaign they cannot
  // otherwise reach.
  for (const m of (r.data.members || []).filter((x) => x.status === 'active')) {
    const o = el('option', { text: m.username + (m.is_gm ? ' (GM)' : '') });
    o.value = m.user_id || m.id;
    sel.appendChild(o);
  }
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
  if (selectedActor) { renderSheet(); await loadBag(); }
  if (isGm && document.getElementById('itemEditor').childElementCount === 0) renderItemEditor();

  if (!isGm) {
    const mine = actors.filter((x) => me && x.user_id === me.id).length;
    document.getElementById('actorCap').textContent = `${mine}/3 characters`;
  }
}

async function createActor() {
  if (!campaign) return;
  // Only fields this role may actually write are sent. A player's body carries
  // no ability scores at all, so the server's silent-ignore path is never taken
  // through the UI — see the create/PATCH asymmetry noted in PROJECT_STATE.
  const body = {
    name: str('acName'),
    img_url: str('acImg'),
    hp_current: num('acHp'),
  };
  if (isGm) {
    Object.assign(body, {
      hp_max: num('acHpMax'),
      size: str('acSize'),
      armor_class: num('acAc'),
      level: num('acLevel'),
      speed: num('acSpeed'),
      strength: num('acStr'),
      dexterity: num('acDex'),
      constitution: num('acCon'),
      intelligence: num('acInt'),
      wisdom: num('acWis'),
      charisma: num('acCha'),
      is_npc: document.getElementById('acIsNpc').value === 'true',
      user_id: str('acOwner') || null,
    });
  }
  // Nothing is added for a player. Since 2026-08-02 the server REFUSES a
  // GM-owned field at create rather than discarding it, so sending `size` or
  // `hp_max` here would earn a 403 instead of being quietly dropped — which is
  // the point of the change.

  const r = await api('POST', `/api/campaigns/${campaign.id}/actors`, body);
  show('POST actor', r);
  if (r.status === 409) log('CAP: ' + (r.data.error || 'refused'));
  await refresh();
}

async function adjustHp(a, delta) {
  const r = await api('PATCH', `/api/campaigns/${campaign.id}/actors/${a.id}`, {
    hp_current: a.hp_current + delta,
  });
  show('PATCH hp', r);
  await refresh();
}

async function deleteActor(a) {
  if (!window.confirm(`Delete ${a.name}? Tokens of this character stay on their maps as unlinked markers.`)) return;
  const r = await api('DELETE', `/api/campaigns/${campaign.id}/actors/${a.id}`);
  show('DELETE actor', r);
  if (r.status === 200) log(`${a.name} deleted — ${r.data.tokens_unlinked} token(s) unlinked, not destroyed`);
  if (selectedActor === a.id) {
    selectedActor = null;
    document.getElementById('invWho').textContent = 'select a character above';
    document.getElementById('sheetWho').textContent = 'none selected';
    renderSheet();
  }
  await refresh();
}

// The item editor serves BOTH create and edit from one field set, so a field can
// never exist on one form and be missing from the other. `selectedItem === null`
// is the create state.
let selectedItem = null;

function renderItemEditor() {
  if (!isGm) return;
  const panel = document.getElementById('itemEditor');
  const item = selectedItem ? items.find((i) => i.id === selectedItem) : null;
  document.getElementById('itemWho').textContent = item ? item.name : 'new item';
  window.VTTItemSheet.render(panel, {
    item,
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
}

function editItem(i) {
  selectedItem = i.id;
  renderItemEditor();
}

async function toggleIdentified(i) {
  const r = await api('PATCH', `/api/campaigns/${campaign.id}/items/${i.id}`, { identified: !i.identified });
  show('PATCH identified', r);
  await refresh();
}

async function deleteItem(i) {
  const r = await api('DELETE', `/api/campaigns/${campaign.id}/items/${i.id}`);
  show('DELETE item', r);
  if (r.status === 200) log(`item deleted — removed from ${r.data.inventory_rows_removed} bag(s)`);
  if (selectedItem === i.id) selectedItem = null;
  await refresh();
  if (isGm) renderItemEditor();
}

function selectActor(a) {
  selectedActor = a.id;
  document.getElementById('invWho').textContent = a.name;
  document.getElementById('sheetWho').textContent = a.name;
  renderActors();
  renderSheet();
  loadBag();
}

// The sheet is rendered from the row already in `actors`, which is whatever this
// viewer was allowed to receive — so a projected NPC renders as a projection
// without the sheet needing its own visibility rule. One source of truth for
// "what may I see", decided on the server.
function renderSheet() {
  const panel = document.getElementById('sheetPanel');
  const a = actors.find((x) => x.id === selectedActor);
  if (!a) {
    panel.textContent = '';
    panel.appendChild(el('p', { cls: 'muted', text: 'select a character above' }));
    return;
  }
  window.VTTSheet.render(panel, {
    actor: a,
    isGm,
    me,
    onSave: async (patch) => {
      const r = await api('PATCH', `/api/campaigns/${campaign.id}/actors/${a.id}`, patch);
      show('PATCH actor', r);
      if (r.status === 200) await refresh();
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
  socket = io({ withCredentials: true });

  socket.on('connect', () => {
    socket.emit('campaign:join', { campaign_id: campaign.id }, (ack) => {
      log(ack && ack.ok ? `joined room for ${campaign.name}` : `room join refused: ${JSON.stringify(ack)}`);
    });
  });

  // Printed VERBATIM and un-prettified on purpose. On the GM's screen an
  // actor:updated for an NPC carries hp_current, armor_class and notes; on a
  // player's screen the same event for the same NPC carries only
  // {id, campaign_id, user_id, name, img_url, is_npc, size} — and for an NPC
  // with no visible token, nothing arrives at all. Reading the two logs side by
  // side is more convincing than any assertion.
  for (const ev of ['actor:updated', 'actor:deleted', 'item:created', 'item:updated', 'item:deleted']) {
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

  socket.on('token:unlinked', (d) => log(`token:unlinked  ${JSON.stringify(d)}`));
  socket.on('disconnect', () => log('socket disconnected'));
}

// ---------------------------------------------------------------------------

document.getElementById('loadCampaign').addEventListener('click', loadCampaign);
document.getElementById('createActor').addEventListener('click', createActor);
document.getElementById('newItem').addEventListener('click', newItem);
document.getElementById('addToBag').addEventListener('click', addToBag);
document.getElementById('clearLog').addEventListener('click', () => { logEl.textContent = ''; });

// Convenience: /actors.html?campaign=<uuid> preloads, so the GM and player
// windows can be opened from the same link.
const preset = new URLSearchParams(window.location.search).get('campaign');
if (preset) document.getElementById('campaignId').value = preset;

whoami().then(() => { if (preset) loadCampaign(); });
