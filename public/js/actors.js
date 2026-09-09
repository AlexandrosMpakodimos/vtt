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

    // M6 framing. Offered whenever there is a picture AND the caller may write
    // the character — the same tier as img_url itself, because a player who can
    // set their portrait and then cannot stop it cropping their head off has
    // half a feature. Deliberately NOT gated on isProjected: a projected NPC is
    // read-only for a player anyway, and mayWrite is already false for them.
    if (mayWrite && a.img_url) {
      row.appendChild(button('frame picture', () => openFrame(a)));
    }

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

function renderAssets() {
  const box = document.getElementById('assetList');
  if (!box) return;
  box.textContent = '';
  if (!assets.length) {
    box.appendChild(el('p', { cls: 'muted', text: 'no images yet' }));
    return;
  }
  for (const a of assets) {
    const card = el('div', { cls: 'asset' + (a.source === 'external' ? ' external' : '') });

    const img = document.createElement('img');
    img.src = a.url;
    img.alt = '';
    // A pasted link is fetched from a third party by every viewer. Suppressing
    // the referrer does not hide the viewer's address — nothing can, short of
    // proxying — but it does stop this application's URLs being handed to that
    // host along with the request.
    if (a.source === 'external') img.referrerPolicy = 'no-referrer';
    card.appendChild(img);

    card.appendChild(el('div', { cls: 'k', text: a.kind }));
    card.appendChild(el('div', {
      cls: 'k',
      text: a.source === 'external' ? 'external link' : 'hosted',
    }));

    const copy = button('copy url', async () => {
      try {
        await navigator.clipboard.writeText(a.url);
        document.getElementById('assetMsg').textContent = 'url copied';
      } catch {
        // Clipboard access can be refused; showing the value is a usable
        // fallback and better than a silent no-op.
        document.getElementById('assetMsg').textContent = a.url;
      }
    });
    card.appendChild(copy);
    card.appendChild(button('delete', () => deleteAsset(a)));
    box.appendChild(card);
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
  const body = { kind, mime: file.type, bytes: file.size };
  if (kind !== 'avatar') {
    if (!campaign) { msg.textContent = 'load a campaign first'; return; }
    body.campaign_id = campaign.id;
  }

  msg.textContent = 'requesting authorisation…';
  const pres = await api('POST', '/api/assets/presign', body);
  show('POST presign', pres);
  if (pres.status !== 201) {
    msg.textContent = (pres.data && pres.data.error) || 'upload was not authorised';
    return;
  }

  const { asset, upload } = pres.data;

  msg.textContent = 'uploading…';
  let put;
  try {
    // Straight to the bucket. Note this is NOT the api() helper: it is a
    // different origin, carries no session cookie, and must send exactly the
    // headers the signature covers.
    put = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: file,
    });
  } catch (err) {
    // A network error here is usually the bucket's CORS policy, which is
    // invisible from the server side — worth naming rather than reporting a
    // bare failure.
    msg.textContent = `upload failed (${err.message}) — check the bucket CORS policy`;
    return;
  }
  if (!put.ok) {
    msg.textContent = `the storage service refused the upload (${put.status})`;
    return;
  }

  msg.textContent = 'verifying…';
  const done = await api('POST', `/api/assets/${asset.id}/confirm`);
  show('POST confirm', done);
  if (done.status !== 200) {
    msg.textContent = (done.data && done.data.error) || 'verification failed';
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

async function deleteAsset(a) {
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

// Character portrait framing (M6). The stage/drag/zoom logic now lives in the
// reusable VTTFrameTool; here we just open it for a character and PATCH the
// three columns on save. The values are copied onto every token placed from
// this character (server-side), so the crop set here is what the canvas draws.
function openFrame(a) {
  if (!window.VTTFrameTool) return;
  window.VTTFrameTool.open({
    imageUrl: a.img_url,
    offsetX: Number(a.img_offset_x) || 0,
    offsetY: Number(a.img_offset_y) || 0,
    scale: Number(a.img_scale) > 0 ? Number(a.img_scale) : 1,
    title: 'Frame the picture',
    note: 'Drag to move · scroll to zoom. This is the crop tokens will use.',
    onSave: async (vals) => {
      const r = await api('PATCH', `/api/campaigns/${campaign.id}/actors/${a.id}`, {
        img_offset_x: vals.offsetX, img_offset_y: vals.offsetY, img_scale: vals.scale,
      });
      show('PATCH framing', r);
      if (r.status !== 200) return { error: (r.data && r.data.error) || 'save failed' };
      // Framing is COPIED onto a token when it is placed, so tokens already on a
      // board keep the framing they were given.
      await refresh();
      return { ok: true };
    },
  });
}

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
  const level = document.getElementById('spFilter').value;
  const q = level === '' ? '' : `?level=${encodeURIComponent(level)}`;
  const r = await api('GET', `/api/campaigns/${campaign.id}/spells${q}`);
  // Shape, not status code — a refusal has no spells array.
  spells = r.data && Array.isArray(r.data.spells) ? r.data.spells : [];
  renderSpells();
  renderSpellChoices();
}

const levelLabel = (n) => (n === 0 ? 'cantrip' : `level ${n}`);

function renderSpells() {
  const list = document.getElementById('spellList');
  list.textContent = '';
  if (!spells.length) {
    list.appendChild(el('p', { cls: 'muted', text: 'no spells in the catalogue' }));
    return;
  }
  for (const sp of spells) {
    const card = el('div', { cls: 'card' });
    const head = el('div');
    head.appendChild(el('b', { text: sp.name }));
    head.appendChild(el('span', { cls: 'tag', text: levelLabel(sp.level) }));
    card.appendChild(head);
    if (sp.description) card.appendChild(el('div', { cls: 'muted', text: sp.description }));

    // properties is a free blob; render its keys rather than assuming a shape,
    // because the server stores whatever the GM put there.
    const props = sp.properties && typeof sp.properties === 'object' ? sp.properties : {};
    const keys = Object.keys(props);
    if (keys.length) {
      card.appendChild(el('div', {
        cls: 'muted',
        text: keys.map((k) => `${k}: ${props[k]}`).join(' · '),
      }));
    }

    if (isGm) {
      const row = el('div', { cls: 'row' });
      row.appendChild(button('delete', () => deleteSpell(sp)));
      card.appendChild(row);
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
}

async function createSpell() {
  const name = str('spName');
  if (!name) { show('POST spell', { status: 0, data: { error: 'a spell needs a name' } }); return; }
  const body = { name, level: Number(document.getElementById('spLevel').value) };
  const desc = str('spDesc');
  if (desc) body.description = desc;
  const r = await api('POST', `/api/campaigns/${campaign.id}/spells`, body);
  show('POST spell', r);
  if (r.status === 201) {
    document.getElementById('spName').value = '';
    document.getElementById('spDesc').value = '';
    await loadSpells();
  }
}

async function deleteSpell(sp) {
  const r = await api('DELETE', `/api/campaigns/${campaign.id}/spells/${sp.id}`);
  show('DELETE spell', r);
  // The response names its blast radius, exactly as the item and scene deletes
  // do, so the log says what was emptied rather than just "ok".
  if (r.status === 200) {
    log(`spell deleted — removed from ${r.data.deleted.spellbook_entries} spellbook(s)`);
    await loadSpells();
    await loadSpellbook();
  }
}

// ---- the spellbook ---------------------------------------------------------

async function loadSpellbook() {
  const who = document.getElementById('sbWho');
  const list = document.getElementById('sbList');
  if (!selectedActor) {
    spellbook = [];
    who.textContent = 'select a character above';
    list.textContent = '';
    renderSpellChoices();
    return;
  }
  const r = await api('GET',
    `/api/campaigns/${campaign.id}/actors/${selectedActor}/spells`);
  if (!r.data || !Array.isArray(r.data.spells)) {
    // A player reading an NPC's spellbook gets a 404 — the same gate that
    // guards a bag. Say so plainly rather than rendering an empty list, which
    // would read as "the lich knows no spells".
    spellbook = [];
    list.textContent = '';
    list.appendChild(el('p', { cls: 'muted', text: 'that spellbook is not yours to read' }));
    renderSpellChoices();
    return;
  }
  spellbook = r.data.spells;
  const a = actors.find((x) => x.id === selectedActor);
  who.textContent = a ? a.name : selectedActor;
  renderSpellbook();
  renderSpellChoices();
}

function renderSpellbook() {
  const list = document.getElementById('sbList');
  list.textContent = '';
  if (!spellbook.length) {
    list.appendChild(el('p', { cls: 'muted', text: 'knows no spells' }));
    return;
  }
  // Grouped by level, which is the only ordering a spell list is ever read in.
  const byLevel = new Map();
  for (const e of spellbook) {
    const lv = e.spell.level;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(e);
  }
  for (const lv of [...byLevel.keys()].sort((x, y) => x - y)) {
    list.appendChild(el('div', { cls: 'muted', text: levelLabel(lv) }));
    for (const e of byLevel.get(lv)) {
      const card = el('div', { cls: 'card' });
      const head = el('div');
      head.appendChild(el('b', { text: e.spell.name }));
      if (e.prepared) head.appendChild(el('span', { cls: 'tag mine', text: 'prepared' }));
      if (e.source) head.appendChild(el('span', { cls: 'tag', text: e.source }));
      card.appendChild(head);
      if (e.spell.description) {
        card.appendChild(el('div', { cls: 'muted', text: e.spell.description }));
      }
      const row = el('div', { cls: 'row' });
      row.appendChild(button(e.prepared ? 'unprepare' : 'prepare',
        () => patchSpellbook(e, { prepared: !e.prepared })));
      row.appendChild(button('forget', () => forgetSpell(e)));
      card.appendChild(row);
      list.appendChild(card);
    }
  }
}

async function learnSpell() {
  if (!selectedActor) {
    show('learn', { status: 0, data: { error: 'select a character first' } });
    return;
  }
  const spellId = document.getElementById('sbSpell').value;
  if (!spellId) { show('learn', { status: 0, data: { error: 'no spell selected' } }); return; }
  const body = { spell_id: spellId };
  const src = document.getElementById('sbSource').value;
  if (src) body.source = src;
  const r = await api('POST',
    `/api/campaigns/${campaign.id}/actors/${selectedActor}/spells`, body);
  show('POST spellbook', r);
  if (r.status === 201) await loadSpellbook();
}

async function patchSpellbook(entry, patch) {
  const r = await api('PATCH',
    `/api/campaigns/${campaign.id}/actors/${selectedActor}/spells/${entry.spell_id}`, patch);
  show('PATCH spellbook', r);
  if (r.status === 200) await loadSpellbook();
}

async function forgetSpell(entry) {
  const r = await api('DELETE',
    `/api/campaigns/${campaign.id}/actors/${selectedActor}/spells/${entry.spell_id}`);
  show('DELETE spellbook', r);
  if (r.status === 200) await loadSpellbook();
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
  const picker = document.getElementById('invItem');
  list.textContent = '';
  if (picker) picker.textContent = '';

  // The inventory picker (separate control) always lists everything.
  if (picker) {
    for (const i of items) {
      const known = i.identified === true;
      const opt = el('option', { text: known ? i.name : `Unidentified ${i.type}` });
      opt.value = i.id; picker.appendChild(opt);
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
      im.style.transform = `translate(${ox * 100}%, ${oy * 100}%) scale(${sc})`;
      im.style.transformOrigin = 'center';
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

async function loadCampaign(idArg) {
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
  await loadSpells();
  await loadAssets();
  if (selectedActor) { renderSheet(); await loadBag(); await loadSpellbook(); }
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
    loadSpellbook();
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
  loadSpellbook();
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

  // The sheet's portrait field is rendered from a field list by sheet.js, so
  // the element does not exist until this point and the picker has to be
  // attached AFTER every render rather than once at load.
  //
  // attach() is idempotent — it marks the input and refuses a second button —
  // which is what makes calling it on every render safe rather than accumulating
  // one button per re-render.
  if (window.VTTImagePicker) {
    window.VTTImagePicker.attach('sheet-img_url', {
      campaignId: () => (campaign ? campaign.id : null),
      // A character's own picture is a portrait; framing then places it inside
      // the token square. Two separate steps, deliberately: the image belongs to
      // the character, the crop belongs to the square.
      kind: 'portrait',
    });
  }
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
document.getElementById('createActor').addEventListener('click', createActor);
document.getElementById('newItem').addEventListener('click', newItem);
document.getElementById('addToBag').addEventListener('click', addToBag);
document.getElementById('clearLog').addEventListener('click', () => { logEl.textContent = ''; });

// Convenience: /actors.html?campaign=<uuid> preloads, so the GM and player
// windows can be opened from the same link.
initFraming();

// M6: fill the new-character image field from the library. The character sheet
// has its own img_url field rendered by sheet.js from a field list, so it is
// attached lazily below rather than here — the element does not exist until a
// sheet is opened.
if (window.VTTImagePicker) {
  window.VTTImagePicker.attach('acImg', {
    campaignId: () => (campaign ? campaign.id : null),
    kind: 'portrait',
  });
}

document.getElementById('assetUpload').addEventListener('click', uploadAsset);
document.getElementById('assetLink').addEventListener('click', addAssetLink);
document.getElementById('createSpell').addEventListener('click', createSpell);
document.getElementById('learnSpell').addEventListener('click', learnSpell);
document.getElementById('spFilter').addEventListener('change', loadSpells);

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
