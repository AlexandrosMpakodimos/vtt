const { rootPath } = require('../helpers/paths');
// Character sheet + item editor UI suite. jsdom only — no server, no database:
//   node tests/unit/test-sheet-ui.js
//
// Loads the REAL public/actors.html, public/js/sheet.js and
// public/js/itemsheet.js and drives them with synthetic events, the way
// test-fog-ui.js drives the scene harness.
//
// The two things most worth gating here:
//
//   1. THE FIELD-TIER LISTS ARE A DUPLICATE OF THE SERVER'S. `sheet.js` carries
//      its own copy of PLAYER_WRITABLE / GM_WRITABLE so it can disable the right
//      inputs. That is a second source of truth, and this project's recorded
//      lesson about second sources of truth is that they drift. This suite
//      PARSES src/routes/actors.js and asserts the two agree field by field, so
//      the check runs on every commit instead of once by hand.
//
//   2. `data` AND `properties` ARE SINGLE COLUMNS. Both sheets scatter one JSONB
//      column across dozens of inputs and must reassemble it losslessly on every
//      save — including preserving keys the current viewer cannot edit, and
//      refusing a raw-JSON key that already has its own field. A bug here
//      silently deletes a player's spell slots, and no server test would catch
//      it because the payload would be perfectly valid.
//
// Network is stubbed: this suite asserts what the CLIENT builds and sends.
// Whether the server accepts it is test-actors.js / break-actors.js.

const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM(fs.readFileSync(rootPath('public/actors.html'), 'utf8'), {
  runScripts: 'outside-only',
  url: 'http://localhost:3000/actors.html',
});
const { window } = dom;
const { document } = window;
window.io = () => ({ on() {}, emit() {} });
window.fetch = async () => ({ status: 200, json: async () => ({}) });
if (!window.TextEncoder) window.TextEncoder = require('util').TextEncoder;
// jsdom has no layout; vtt-dd calls scrollIntoView when opening.
window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || function () {};

// common.js provides VTTCommon.initDropdown, which the item editor's Type /
// Rarity / Armour lists use. Loading it here means those custom dropdowns are
// tested for real (not the degraded fallback), so a wrong initDropdown call
// signature is caught instead of silently showing an empty list.
window.eval(fs.readFileSync(rootPath('public/js/imageframe.js'), 'utf8'));
window.eval(fs.readFileSync(rootPath('public/js/common.js'), 'utf8'));
window.eval(fs.readFileSync(rootPath('public/js/sheet.js'), 'utf8'));
window.eval(fs.readFileSync(rootPath('public/js/itemsheet.js'), 'utf8'));
window.eval(fs.readFileSync(rootPath('public/js/spellsheet.js'), 'utf8'));
window.eval(fs.readFileSync(rootPath('public/js/actorsheet.js'), 'utf8'));
const Sheet = window.VTTSheet;
const ItemSheet = window.VTTItemSheet;
const SpellSheet = window.VTTSpellSheet;
const ActorSheet = window.VTTActorSheet;

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  ' + detail); }
}

const GM = { id: 'gm-1' };
const PLAYER = { id: 'pl-1' };

function baseActor(over = {}) {
  return Object.assign({
    id: 'a-1', campaign_id: 'c-1', user_id: PLAYER.id, folder_id: null,
    name: 'Aria', img_url: null, is_npc: false,
    level: 3, class: 'Rogue', race: 'Elf', size: 'Medium',
    hp_current: 11, hp_max: 18, hp_temp: 0, armor_class: 15, speed: 30,
    strength: 10, dexterity: 16, constitution: 12,
    intelligence: 13, wisdom: 11, charisma: 14,
    death_save_successes: 0, death_save_failures: 0,
    notes: 'wants revenge', data: {},
    created_at: 1, updated_at: 1,
  }, over);
}
// What a player receives for an NPC: no hp_max key at all.
function projectedActor() {
  return { id: 'a-2', campaign_id: 'c-1', user_id: null, name: 'Goblin', img_url: null, is_npc: true, size: 'Small' };
}

// Only ONE mount lives in the document at a time. Every sheet renders inputs
// with fixed ids (`sheet-strength`), so two mounts would put duplicate ids in
// the document — and jsdom optimises `#id` selectors through getElementById,
// which returns the FIRST match in document order and then rejects it for not
// being inside the container. A scoped lookup on the second mount would return
// null rather than finding its own field.
let lastMount = null;
function mount() {
  if (lastMount && lastMount.parentNode) lastMount.parentNode.removeChild(lastMount);
  const d = document.createElement('div');
  document.body.appendChild(d);
  lastMount = d;
  return d;
}
function field(container, key) { return container.querySelector('#sheet-' + key); }
function itemField(container, key) { return container.querySelector('#item-' + key); }
function spellField(container, key) { return container.querySelector('#spell-' + key); }
function saveButton(container) {
  // Prefer the footer's primary action. The folio has TWO .btn.primary buttons
  // ("Edit sheet" in the edit bar and "Save changes" in the footer), and a bare
  // `button.primary` selector returns the first in DOM order (Edit sheet), so
  // scope to the footer first.
  const footerPrimary = container.querySelector('.ie-footer .btn.primary, .fo-footer .btn.primary');
  if (footerPrimary) return footerPrimary;
  const primary = container.querySelector('button.primary');
  if (primary) return primary;
  return [...container.querySelectorAll('button')].find((b) => /^(save changes|create item|save|create)$/i.test(b.textContent.trim()));
}
// The folio has no edit mode — every control is always live. Kept as a no-op so
// existing call sites read naturally.
function enterEdit(/* container */) { /* no edit mode; controls are always live */ }
async function clickSave(container) {
  const b = saveButton(container);
  b.dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 0));
}

(async () => {
  // ======================================================================
  // 1. the duplicated allow-lists must match the server, field by field
  // ======================================================================
  const server = fs.readFileSync(rootPath('src/routes/actors.js'), 'utf8');
  const parseList = (name) => server
    .match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`, 's'))[1]
    .split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
  const PW = parseList('PLAYER_WRITABLE');
  const GW = parseList('GM_WRITABLE');

  const columnFields = Sheet.FIELDS.filter((f) => f.path !== 'data');
  const mismatches = [];
  for (const f of columnFields) {
    if (f.tier === 'player' && !PW.includes(f.key)) mismatches.push(`${f.key}: sheet says player-writable, server does not`);
    if (f.tier === 'gm' && (PW.includes(f.key) || !GW.includes(f.key))) mismatches.push(`${f.key}: sheet says GM-only, server disagrees`);
  }
  check('every sheet field agrees with the server allow-lists', mismatches.length === 0, mismatches.join(' | '));

  const onSheet = new Set(columnFields.map((f) => f.key));
  // Columns that are writable but deliberately NOT sheet fields. Each earns its
  // exemption for a stated reason, and the list is short on purpose — it is the
  // escape hatch that would otherwise let this probe rot into meaninglessness.
  //
  //   is_npc, user_id            campaign management, not description (M4)
  //   img_offset_x/y, img_scale  presentation, not description (M6). They are
  //                              set by dragging the picture inside its frame,
  //                              so rendering them as three numeric inputs
  //                              beside Strength would be a worse interface AND
  //                              a false claim that the sheet is where they
  //                              live.
  // in_party is managed by the GM from the roster cards.
  const NOT_SHEET_FIELDS = ['is_npc', 'in_party', 'user_id', 'img_offset_x', 'img_offset_y', 'img_scale'];
  const missing = GW.filter((k) => !onSheet.has(k) && !NOT_SHEET_FIELDS.includes(k));
  check('no writable column is missing from the sheet', missing.length === 0, missing.join(', '));

  // The exemption must not become a place things are quietly dropped: every
  // exempt column has to actually exist on the server, or a rename would leave
  // a stale name here silencing a real gap.
  const staleExemptions = NOT_SHEET_FIELDS.filter((k) => !GW.includes(k));
  check('every sheet exemption names a real writable column',
    staleExemptions.length === 0, staleExemptions.join(', '));
  check('is_npc and user_id are deliberately absent (campaign management, not description)',
    !onSheet.has('is_npc') && !onSheet.has('user_id'));

  // every `data` sub-field must be player-tier, because `data` itself is
  const dataFields = Sheet.FIELDS.filter((f) => f.path === 'data');
  check('every data sub-field is player-writable, matching the column',
    dataFields.every((f) => f.tier === 'player'), 'a GM-only data key cannot be enforced — data is one column');
  check('the sheet carries the saving throws and skills added by the scope amendment',
    dataFields.filter((f) => f.key.startsWith('sk_') && !f.key.endsWith('_p')).length === 18
    && dataFields.filter((f) => f.key.startsWith('sv_') && !f.key.endsWith('_p')).length === 6,
    `${dataFields.filter((f) => f.key.startsWith('sk_')).length} skill keys`);

  // ======================================================================
  // 2. permission rendering
  // ======================================================================
  let c = mount();
  Sheet.render(c, { actor: baseActor(), isGm: false, me: PLAYER, onSave: async () => ({ status: 200 }) });
  check('a player may edit their own current HP', field(c, 'hp_current').disabled === false);
  check('a player may edit notes', field(c, 'notes').disabled === false);
  check('a player may edit their own strength', field(c, 'strength').disabled === false);
  check('a player may edit their own max HP', field(c, 'hp_max').disabled === false);
  check('a player may edit their own level', field(c, 'level').disabled === false);
  // Shown-but-disabled rather than hidden: a player should be able to READ their
  // own armour class. Hiding it would make the sheet lie about the character.
  check('a player may edit their own AC', field(c, 'armor_class').disabled === false);
  check('and their value is visible', field(c, 'armor_class').value === '15');

  c = mount();
  Sheet.render(c, { actor: baseActor(), isGm: true, me: GM, onSave: async () => ({ status: 200 }) });
  check('the GM may edit every field', ['strength', 'hp_max', 'level', 'notes', 'hp_current']
    .every((k) => field(c, k).disabled === false));

  c = mount();
  Sheet.render(c, { actor: baseActor({ user_id: 'someone-else' }), isGm: false, me: PLAYER, onSave: async () => ({ status: 200 }) });
  check('another player\'s character is entirely read-only',
    Sheet.FIELDS.filter((f) => f.path !== 'data' && f.key !== 'data')
      .every((f) => field(c, f.key) === null || field(c, f.key).disabled === true));
  check('and no save button is offered', saveButton(c) === undefined);

  c = mount();
  Sheet.render(c, { actor: projectedActor(), isGm: false, me: PLAYER, onSave: async () => ({ status: 200 }) });
  check('a projected NPC renders as a projection, not a page of blanks', field(c, 'hp_max') === null);
  check('and says so plainly', /Statistics unavailable/.test(c.textContent));
  check('...and a projected NPC has NO ability blocks', c.querySelectorAll('.fo-ability').length === 0);
  check('...and offers no Edit action', ![...c.querySelectorAll('button')].some((b) => /Edit sheet/.test(b.textContent)));

  // ======================================================================
  // 2.5 the folio: inline editing, tabbed, footer-on-change, Cancel reverts
  // ======================================================================
  c = mount();
  Sheet.render(c, { actor: baseActor(), isGm: true, me: GM, onSave: async () => ({ status: 200 }) });
  check('the folio renders (two-column root)', !!c.querySelector('.fo-root'));
  check('every field is a live control from the start', field(c, 'strength') !== null && field(c, 'hp_current') !== null);
  check('all six ability blocks are present and expanded', c.querySelectorAll('.fo-ability').length === 6);
  check('skills are nested (18 skill rows total)', c.querySelectorAll('.fo-skill-row').length === 18);
  check('Stats / Features / Inventory / Spellbook / Backstory tabs exist',
    [...c.querySelectorAll('.fo-tab')].map((t) => t.textContent).join(',') === 'Stats,Features,Inventory,Spellbook,Backstory');
  check('there is NO separate Edit sheet action', ![...c.querySelectorAll('button')].some((b) => /Edit sheet/.test(b.textContent)));
  check('the Save/Cancel footer is hidden until the first change', c.querySelector('.fo-footer').hidden === true);

  // Changing any field reveals the footer.
  field(c, 'hp_current').value = '9';
  field(c, 'hp_current').dispatchEvent(new window.Event('input'));
  check('changing a field reveals the Save/Cancel footer', c.querySelector('.fo-footer').hidden === false);
  check('...and marks the folio dirty', c.classList.contains('fo-dirty'));

  // Currency moved to the Inventory tab; the Backstory tab is narrative-only.
  check('the currency strip lives on the Inventory page',
    !!c.querySelector('.fo-page-inventory .fo-currency') && !c.querySelector('.fo-page-journal .fo-currency'));
  check('the Inventory page exposes a mount for the bag UI', !!c.querySelector('.fo-page-inventory .fo-inv-mount'));
  check('the size field is a themed vtt-dd (not a native select)',
    !!c.querySelector('#sheet-size') && c.querySelector('#sheet-size').type === 'hidden' && !!c.querySelector('#sheet-size').closest('.vtt-dd'));
  check('the Advanced data section is gone from the Backstory tab',
    !c.querySelector('.fo-advanced') && ![...c.querySelectorAll('summary')].some((s) => /Advanced/.test(s.textContent)));
  check('...but the data node is still built (unknown keys still round-trip)', !!c.querySelector('#sheet-data'));

  // Tab switching must NOT save/discard — a pending edit survives a tab change.
  field(c, 'personality_traits').value = 'Bold and reckless';
  field(c, 'personality_traits').dispatchEvent(new window.Event('input'));
  check('Spellbook has a mount for its live controls', !!c.querySelector('.fo-page-spellbook .fo-spellbook-mount'));
  const bookTab = [...c.querySelectorAll('.fo-tab')].find((t) => t.textContent === 'Spellbook');
  bookTab.click();
  check('Spellbook tab opens its page', !c.querySelector('.fo-page-spellbook').hidden);
  check('Spellbook tab preserves dirty HP', field(c, 'hp_current').value === '9' && !c.querySelector('.fo-footer').hidden);
  const featTab = [...c.querySelectorAll('.fo-tab')].find((t) => t.textContent === 'Features');
  featTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const charTab = [...c.querySelectorAll('.fo-tab')].find((t) => t.textContent === 'Stats');
  charTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('a pending edit survives a tab switch', field(c, 'personality_traits').value === 'Bold and reckless');
  check('...and the footer stays visible after switching tabs', c.querySelector('.fo-footer').hidden === false);

  // Cancel reverts every field to its loaded value and hides the footer.
  const cancelBtn = [...c.querySelectorAll('.fo-footer button')].find((b) => /^Cancel$/.test(b.textContent));
  cancelBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('Cancel reverts an edited number to its loaded value', field(c, 'hp_current').value === String(baseActor().hp_current));
  check('...reverts an edited narrative field too', field(c, 'personality_traits').value === '');
  check('...and hides the footer again', c.querySelector('.fo-footer').hidden === true);
  check('...and clears the dirty state', !c.classList.contains('fo-dirty'));

  // A failed save keeps the sheet open with the footer + edits intact.
  {
    const fc = mount();
    Sheet.render(fc, { actor: baseActor(), isGm: true, me: GM, onSave: async () => ({ status: 403, data: { error: 'only the GM may change: strength' } }) });
    field(fc, 'strength').value = '18';
    field(fc, 'strength').dispatchEvent(new window.Event('input'));
    await clickSave(fc);
    check('a failed save keeps the footer showing', fc.querySelector('.fo-footer').hidden === false);
    check('...and the edited value is retained', field(fc, 'strength').value === '18');
    check('...and the error is surfaced', /only the GM may change/.test(fc.textContent));
  }

  // A successful save hides the footer and rebaselines (Cancel afterwards is a
  // no-op — nothing to revert).
  {
    const sc2 = mount();
    Sheet.render(sc2, { actor: baseActor(), isGm: true, me: GM, onSave: async () => ({ status: 200 }) });
    field(sc2, 'hp_current').value = '7';
    field(sc2, 'hp_current').dispatchEvent(new window.Event('input'));
    await clickSave(sc2);
    check('a successful save hides the footer', sc2.querySelector('.fo-footer').hidden === true);
    check('...and clears the dirty state', !sc2.classList.contains('fo-dirty'));
  }

  // The portrait is edited through a hover-pencil button that opens the shared
  // picker via ctx.onPickPortrait — NOT a visible URL field or "choose…" button.
  {
    const pc2 = mount();
    let pickedCurrent = null; let handOff = null;
    Sheet.render(pc2, {
      actor: baseActor({ img_url: 'old.png' }), isGm: true, me: GM,
      onPickPortrait: (current, setUrl) => { pickedCurrent = current; handOff = setUrl; },
      onSave: async () => ({ status: 200 }),
    });
    const pbtn = pc2.querySelector('.fo-portrait-btn');
    check('the portrait is an edit button with a pencil overlay',
      !!pbtn && !!pc2.querySelector('.fo-portrait-overlay'));
    check('there is no visible raw URL text field', pc2.querySelector('#sheet-img_url').type === 'hidden');
    check('there is no "choose…" button in the identity column',
      ![...pc2.querySelectorAll('button')].some((b) => /choose/i.test(b.textContent)));
    pbtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('clicking the portrait opens the picker with the current url', pickedCurrent === 'old.png');
    check('...and the footer is not yet shown (nothing changed)', pc2.querySelector('.fo-footer').hidden === true);
    // The picker hands back a chosen URL.
    handOff('new.png');
    check('a chosen url lands in the hidden field', pc2.querySelector('#sheet-img_url').value === 'new.png');
    check('...and reveals the footer (the draft is now dirty)', pc2.querySelector('.fo-footer').hidden === false);
    await clickSave(pc2);
  }

  // A read-only viewer (another player's PC) gets the composed sheet with NO
  // editable control and no footer.
  {
    const rc2 = mount();
    Sheet.render(rc2, { actor: baseActor({ user_id: 'someone-else' }), isGm: false, me: PLAYER, onSave: async () => ({ status: 200 }) });
    check('a read-only viewer still sees the composed folio', !!rc2.querySelector('.fo-root') && rc2.querySelectorAll('.fo-ability').length === 6);
    check('...with every control disabled', [...rc2.querySelectorAll('.fo-slot input, .fo-slot select, .fo-slot textarea')].every((n) => n.disabled));
    check('...and no Save/Cancel footer', rc2.querySelector('.fo-footer') === null);
  }

  // ======================================================================
  // 3. only dirty fields are sent
  // ======================================================================
  let sent = null;
  c = mount();
  Sheet.render(c, {
    actor: baseActor(), isGm: true, me: GM,
    onSave: async (p) => { sent = p; return { status: 200 }; },
  });
  await clickSave(c);
  check('an untouched sheet sends nothing at all', sent === null, JSON.stringify(sent));

  // Same case with a POPULATED blob: reassembly reorders keys, so a naive
  // stringify comparison reports an untouched sheet as dirty and PATCHes the
  // whole column on every save. This is the probe that caught it.
  sent = null;
  c = mount();
  Sheet.render(c, {
    actor: baseActor({ data: { gold: 5, sk_stealth: '+7', familiar: 'owl' } }),
    isGm: true, me: GM,
    onSave: async (p) => { sent = p; return { status: 200 }; },
  });
  await clickSave(c);
  check('an untouched sheet with populated data still sends nothing', sent === null, JSON.stringify(sent));

  sent = null;
  c = mount();
  Sheet.render(c, {
    actor: baseActor(), isGm: true, me: GM,
    onSave: async (p) => { sent = p; return { status: 200 }; },
  });
  field(c, 'hp_current').value = '4';
  await clickSave(c);
  check('editing one field sends exactly that field', sent && Object.keys(sent).length === 1 && sent.hp_current === 4, JSON.stringify(sent));
  check('and sends it as a NUMBER, not a string', sent && typeof sent.hp_current === 'number');

  sent = null;
  c = mount();
  Sheet.render(c, {
    actor: baseActor(), isGm: false, me: PLAYER,
    onSave: async (p) => { sent = p; return { status: 200 }; },
  });
  field(c, 'hp_current').value = '2';
  await clickSave(c);
  check('a player\'s save never carries a GM-only field',
    sent && !Object.keys(sent).some((k) => ['user_id', 'is_npc', 'in_party'].includes(k)),
    JSON.stringify(sent));

  sent = null;
  c = mount();
  Sheet.render(c, { actor: baseActor(), isGm: false, me: PLAYER, onSave: async (p) => { sent = p; return { status: 200 }; } });
  const statChanges = { hp_max: 42, armor_class: 18, level: 5, speed: 40, strength: 17, dexterity: 16, constitution: 15, intelligence: 14, wisdom: 13, charisma: 12 };
  for (const [key, value] of Object.entries(statChanges)) {
    check('owner can edit ' + key, field(c, key).disabled === false);
    field(c, key).value = String(value);
  }
  await clickSave(c);
  check('owner stat edits reach the save callback as numbers', sent && Object.entries(statChanges).every(([key, value]) => baseActor()[key] === value ? !(key in sent) : sent[key] === value));

  // ======================================================================
  // 4. `data` is ONE column — reassembly must be lossless
  // ======================================================================
  sent = null;
  c = mount();
  Sheet.render(c, {
    actor: baseActor({ data: { gold: 120, familiar: 'owl', sk_stealth: '+7' } }),
    isGm: false, me: PLAYER,
    onSave: async (p) => { sent = p; return { status: 200 }; },
  });
  check('a claimed data key populates its own field', field(c, 'sk_stealth').value === '+7');
  const rawBox = field(c, 'data');
  const leftover = JSON.parse(rawBox.value);
  check('the raw JSON box shows only UNCLAIMED keys',
    leftover.familiar === 'owl' && !('sk_stealth' in leftover), rawBox.value);
  check('and unclaimed keys include ones with no field at all', 'gold' in leftover);

  field(c, 'sk_perception').value = '+4';
  await clickSave(c);
  check('changing one data sub-field sends the whole reassembled object', sent && sent.data, JSON.stringify(sent));
  check('the new value is present', sent.data.sk_perception === '+4');
  check('the previously-set sub-field SURVIVES', sent.data.sk_stealth === '+7');
  check('and so do the unclaimed keys — nothing is silently dropped',
    sent.data.familiar === 'owl' && sent.data.gold === 120, JSON.stringify(sent.data));

  // Proficiency ticks are stored only when true, so an unproficient skill costs
  // nothing in the 8 KB budget.
  sent = null;
  field(c, 'sk_stealth_p').checked = true;
  await clickSave(c);
  check('a ticked proficiency is stored as true', sent.data.sk_stealth_p === true);
  check('unticked proficiencies are absent, not false', !('sk_perception_p' in sent.data), JSON.stringify(sent.data));

  // A key that has its own field must not also be settable in the raw box, or
  // the two would fight over it, last-writer-wins.
  sent = null;
  field(c, 'data').value = '{"sk_stealth": "+99"}';
  await clickSave(c);
  check('a raw-JSON key that duplicates a field is refused', sent === null);
  check('and the error names the offending key', /sk_stealth/.test(c.textContent));

  sent = null;
  field(c, 'data').value = '{not json';
  await clickSave(c);
  check('invalid JSON is caught client-side, not sent as a 400', sent === null);

  // ======================================================================
  // 5. the item editor
  // ======================================================================
  const baseItem = {
    id: 'i-1', campaign_id: 'c-1', folder_id: null, name: 'Flame Tongue',
    img_url: null, type: 'weapon', weight: 3, description: 'Bursts into flame.',
    properties: { damage: '2d6', charges: 3, homebrew: true }, identified: false,
    created_at: 1, updated_at: 1,
  };

  let itemSent = null; let wasNew = null;
  c = mount();
  ItemSheet.render(c, { item: null, onSave: async (p, n) => { itemSent = p; wasNew = n; return { status: 201, data: { item: { id: 'x' } } }; } });
  await clickSave(c);
  check('creating an item with no name is refused client-side', itemSent === null);

  itemField(c, 'name').value = 'Rope';
  itemField(c, 'type').value = 'misc';
  await clickSave(c);
  check('a new item is sent as a create', wasNew === true);
  check('and carries the fields that were filled in', itemSent && itemSent.name === 'Rope' && itemSent.type === 'misc', JSON.stringify(itemSent));
  check('identified defaults to false — the non-disclosing default', itemSent.identified === false);

  // The image button opens the shared picker via ctx.onPickImage; the chosen
  // URL flows back into the draft and is sent on save.
  {
    let pickedCurrent = 'sentinel';
    let pickedFrame = null;
    let choose = null;
    const cc = mount();
    let sentImg = null;
    ItemSheet.render(cc, {
      item: { id: 'i-img', campaign_id: 'c-1', name: 'Shield', type: 'armor', img_url: 'old.png', weight: 6, description: '', identified: true, properties: {} },
      onPickImage: (current, cb, curFrame) => { pickedCurrent = current; choose = cb; pickedFrame = curFrame; },
      onSave: async (p) => { sentImg = p; return { status: 200 }; },
    });
    const imgBtn = cc.querySelector('.ie-thumb-btn');
    imgBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('clicking the image opens the picker with the current url', pickedCurrent === 'old.png', String(pickedCurrent));
    check('and offers the current framing to the picker', pickedFrame && pickedFrame.scale === 1, JSON.stringify(pickedFrame));
    check('and no inline URL popover is shown when a picker is wired', cc.querySelector('.ie-imgedit-overlay') === null);
    // Choose a new image WITH a crop.
    choose('new.png', { offsetX: 0.3, offsetY: -0.2, scale: 1.6 });
    const framedThumb = cc.querySelector('.ie-thumb img');
    Object.defineProperties(framedThumb, { naturalWidth: { value: 440 }, naturalHeight: { value: 220 } });
    framedThumb.dispatchEvent(new window.Event('load'));
    check('item thumbnails retain the full wide image',
      framedThumb.style.width === '200%' && framedThumb.style.height === '100%');
    check('item thumbnails apply the saved pan and zoom to the full image',
      framedThumb.style.left === '80%' && framedThumb.style.top === '30%' &&
      framedThumb.style.transform === 'translate(-50%, -50%) scale(1.6)');

    await clickSave(cc);
    check('the chosen image is saved', sentImg && sentImg.img_url === 'new.png', JSON.stringify(sentImg));
    check('the item framing is stored in properties', sentImg && sentImg.properties
      && sentImg.properties.img_offset_x === 0.3 && sentImg.properties.img_scale === 1.6,
      JSON.stringify(sentImg && sentImg.properties));
  }

  itemSent = null;
  c = mount();
  ItemSheet.render(c, { item: baseItem, onSave: async (p, n) => { itemSent = p; wasNew = n; return { status: 200 }; } });
  check('editing loads the column values', itemField(c, 'name').value === 'Flame Tongue');
  check('and the properties sub-keys', itemField(c, 'damage').value === '2d6' && itemField(c, 'charges').value === '3');
  check('the Advanced/JSON editor has been removed', itemField(c, 'properties') === null);
  // The custom Type/Rarity/Armour lists must actually populate when opened — a
  // wrong initDropdown call once left them empty (nothing showed).
  {
    const dd = c.querySelector('.vtt-dd');
    const ddBtn = dd && dd.querySelector('.vtt-dd-btn');
    const ddList = dd && dd.querySelector('.vtt-dd-list');
    if (ddBtn) ddBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('a custom list is used for Type', !!dd && !!ddList);
    check('and it populates its options when opened', ddList && ddList.children.length > 0,
      ddList ? String(ddList.children.length) : 'no list');
  }

  await clickSave(c);
  check('an untouched item sends nothing', itemSent === null, JSON.stringify(itemSent));

  itemField(c, 'identified').checked = true;
  await clickSave(c);
  check('flipping identified sends exactly that', itemSent && itemSent.identified === true, JSON.stringify(itemSent));
  check('and it is an edit, not a create', wasNew === false);

  itemSent = null;
  itemField(c, 'damage_type').value = 'fire';
  await clickSave(c);
  check('a new properties sub-key is sent with the whole object', itemSent && itemSent.properties);
  check('existing sub-keys survive', itemSent.properties.damage === '2d6' && itemSent.properties.charges === 3);
  check('unclaimed properties survive too', itemSent.properties.homebrew === true, JSON.stringify(itemSent.properties));
  check('charges came back as a NUMBER, not a string', typeof itemSent.properties.charges === 'number');

  // ======================================================================
  // 5b. redesign behaviours (single-flow editor)
  // ======================================================================
  // Changing type preserves the now-irrelevant weapon props (never silent loss).
  itemSent = null;
  c = mount();
  ItemSheet.render(c, { item: baseItem, onSave: async (p) => { itemSent = p; return { status: 200 }; } });
  itemField(c, 'type').value = 'armor';
  itemField(c, 'type').dispatchEvent(new window.Event('change'));
  itemField(c, 'armor_class').value = '15';
  itemField(c, 'armor_class').dispatchEvent(new window.Event('input'));
  await clickSave(c);
  check('changing weapon→armour keeps the old weapon damage', itemSent && itemSent.properties.damage === '2d6', JSON.stringify(itemSent && itemSent.properties));
  check('and records the new armour value', itemSent && itemSent.properties.armor_class === '15');

  // Zero is a real charge value and must survive.
  const zeroItem = { id: 'i-z', campaign_id: 'c-1', name: 'Wand', type: 'misc', img_url: null, weight: 0, description: '', identified: true, properties: { charges: 0, charges_max: 7 }, created_at: 1, updated_at: 1 };
  c = mount();
  ItemSheet.render(c, { item: zeroItem, onSave: async () => ({ status: 200 }) });
  check('zero charges load as 0, not blank', itemField(c, 'charges').value === '0', itemField(c, 'charges').value);
  check('the Charges section auto-opens because a value exists (incl. zero)',
    c.querySelector('.ie-disc-charges').classList.contains('open'));

  // The 8 KB properties cap is still enforced on save, now surfaced as a
  // summary error (the Advanced/JSON editor was removed). A very long Effect
  // pushes it over.
  itemSent = null;
  c = mount();
  ItemSheet.render(c, { item: baseItem, onSave: async (p) => { itemSent = p; return { status: 200 }; } });
  itemField(c, 'effect').value = 'x'.repeat(9000);
  itemField(c, 'effect').dispatchEvent(new window.Event('input'));
  await clickSave(c);
  check('an over-budget save is not sent', itemSent === null);
  check('and the size error is surfaced', /\bbytes\b/.test(c.querySelector('.ie-err-summary').textContent));

  // Unknown/custom keys are preserved even though there is no JSON editor.
  itemSent = null;
  c = mount();
  ItemSheet.render(c, { item: baseItem, onSave: async (p) => { itemSent = p; return { status: 200 }; } });
  itemField(c, 'damage').value = '3d6';
  itemField(c, 'damage').dispatchEvent(new window.Event('input'));
  await clickSave(c);
  check('a pre-existing unknown key survives a save with no JSON editor', itemSent && itemSent.properties.homebrew === true, JSON.stringify(itemSent && itemSent.properties));

  // Save failure keeps the draft and allows retry; repeated clicks don't double-submit.
  let attempts = 0;
  c = mount();
  ItemSheet.render(c, { item: null, onSave: async (p, n) => { attempts++; if (attempts === 1) return { status: 400, data: { error: 'name already exists' } }; return { status: 201, data: { item: { id: 'x' } } }; } });
  itemField(c, 'name').value = 'Sword';
  await clickSave(c);
  check('first (failing) save was attempted', attempts === 1);
  check('the name is still in the field after a failure', itemField(c, 'name').value === 'Sword');
  await clickSave(c);
  check('retry succeeds', attempts === 2);

  // Player projection never discloses an unidentified item's private fields.
  // It DOES carry image framing (offset/zoom) — pure geometry, nothing secret —
  // so a deliberately-cropped picture looks the same to everyone.
  const projU = ItemSheet.playerProjection({ identified: false, name: 'Flame Tongue', type: 'weapon', img_url: 'x.png', description: 'secret', weight: 3, properties: { damage: '2d6', img_offset_x: 0.2, img_scale: 1.5 } });
  check('unidentified projection drops the name', projU.name === undefined);
  check('unidentified projection drops description and weight',
    projU.description === undefined && projU.weight === undefined);
  check('unidentified projection exposes ONLY framing in properties (no secret keys)',
    projU.properties && projU.properties.damage === undefined
    && projU.properties.img_offset_x === 0.2 && projU.properties.img_scale === 1.5,
    JSON.stringify(projU.properties));
  check('unidentified projection keeps type + image + identified:false',
    projU.type === 'weapon' && projU.img_url === 'x.png' && projU.identified === false);
  const projI = ItemSheet.playerProjection({ identified: true, name: 'Flame Tongue', type: 'weapon', img_url: 'x.png', description: 'burns', weight: 3, properties: { damage: '2d6' } });
  check('identified projection reveals the name and details', projI.name === 'Flame Tongue' && projI.properties.damage === '2d6');

  // The read view of an unidentified projection leaks nothing into the DOM.
  const rc = mount();
  ItemSheet.renderRead(rc, projU);
  check('read view shows the generic unidentified label', /Unidentified item/.test(rc.textContent));
  check('read view does not leak the real name anywhere in its DOM', !/Flame Tongue/.test(rc.innerHTML));

  // ======================================================================
  // 5.5 the spell editor (VTTSpellSheet) — single-flow, no image, no identified
  // ======================================================================
  const baseSpell = {
    id: 's-1', campaign_id: 'c-1', name: 'Magic Missile', level: 1,
    description: 'Three darts of force.',
    // school owned by a field; homebrew is an UNKNOWN key that must survive.
    properties: { school: 'evocation', casting_time: '1 action', homebrew: true },
    created_at: 1, updated_at: 1,
  };

  let spellSent = null; let spellNew = null;
  c = mount();
  SpellSheet.render(c, { spell: null, onSave: async (p, n) => { spellSent = p; spellNew = n; return { status: 201, data: { spell: { id: 'x' } } }; } });
  await clickSave(c);
  check('creating a spell with no name is refused client-side', spellSent === null);
  check('...and the missing-name error is shown', /name is required/i.test(c.textContent));

  spellField(c, 'name').value = 'Shield';
  spellField(c, 'name').dispatchEvent(new window.Event('input'));
  await clickSave(c);
  check('a new spell is sent as a create', spellNew === true);
  check('...carrying the filled-in name', spellSent && spellSent.name === 'Shield', JSON.stringify(spellSent));
  check('...and level defaults to 0 (Cantrip) as a number', spellSent && spellSent.level === 0 && typeof spellSent.level === 'number', JSON.stringify(spellSent));
  check('a brand-new spell sends no empty properties object', spellSent && !('properties' in spellSent), JSON.stringify(spellSent));

  // Level dropdown is a real vtt-dd driven by common.js — setting the hidden
  // input + firing change is how a click resolves.
  {
    const cc = mount();
    let sent = null;
    SpellSheet.render(cc, { spell: null, onSave: async (p) => { sent = p; return { status: 201, data: { spell: { id: 'y' } } }; } });
    spellField(cc, 'name').value = 'Fireball';
    spellField(cc, 'name').dispatchEvent(new window.Event('input'));
    const lvl = spellField(cc, 'level');
    check('the level control is a hidden input inside a vtt-dd', lvl && lvl.type === 'hidden' && lvl.closest('.vtt-dd'));
    lvl.value = '3';
    lvl.dispatchEvent(new window.Event('change'));
    await clickSave(cc);
    check('the chosen level is sent as an integer', sent && sent.level === 3, JSON.stringify(sent));
  }

  // Editing: only changed fields go, and UNKNOWN properties survive untouched.
  spellSent = null;
  c = mount();
  SpellSheet.render(c, { spell: baseSpell, schoolValues: [], onSave: async (p, n) => { spellSent = p; spellNew = n; return { status: 200 }; } });
  check('an unchanged spell has its save button disabled', saveButton(c).disabled === true);
  spellField(c, 'description').value = 'Now three glowing darts.';
  spellField(c, 'description').dispatchEvent(new window.Event('input'));
  await clickSave(c);
  check('an edit is sent as a PATCH (not a create)', spellNew === false);
  check('only the changed field is in the patch', spellSent && spellSent.description === 'Now three glowing darts.', JSON.stringify(spellSent));
  check('...and the name is not resent when unchanged', spellSent && !('name' in spellSent), JSON.stringify(spellSent));

  // Changing a detail field carries the WHOLE reassembled properties object,
  // and the unknown `homebrew` key rides along untouched.
  spellSent = null;
  c = mount();
  SpellSheet.render(c, { spell: baseSpell, schoolValues: [], onSave: async (p) => { spellSent = p; return { status: 200 }; } });
  spellField(c, 'range').value = '120 feet';
  spellField(c, 'range').dispatchEvent(new window.Event('input'));
  await clickSave(c);
  check('editing a detail field sends the whole properties object', spellSent && spellSent.properties, JSON.stringify(spellSent));
  check('...the new detail value is present', spellSent.properties.range === '120 feet');
  check('...the untouched school is preserved', spellSent.properties.school === 'evocation');
  check('...and the UNKNOWN homebrew key survives the round-trip', spellSent.properties.homebrew === true, JSON.stringify(spellSent.properties));

  // A custom (non-standard) school value is preserved and offered, not dropped.
  {
    const cc = mount();
    let sent = null;
    const customSpell = { id: 's-c', campaign_id: 'c-1', name: 'Chaos Bolt', level: 2, description: '', properties: { school: 'chronomancy' }, created_at: 1, updated_at: 1 };
    SpellSheet.render(cc, { spell: customSpell, schoolValues: ['chronomancy'], onSave: async (p) => { sent = p; return { status: 200 }; } });
    const schoolDd = spellField(cc, 'school').closest('.vtt-dd');
    check('a custom school is shown as the selected value', schoolDd.querySelector('.vtt-dd-btn').textContent === 'chronomancy', schoolDd.querySelector('.vtt-dd-btn').textContent);
    // Editing only the name must NOT drag properties into the patch (nothing in
    // properties changed), so the custom school can't be clobbered.
    spellField(cc, 'name').value = 'Chaos Bolt II';
    spellField(cc, 'name').dispatchEvent(new window.Event('input'));
    await clickSave(cc);
    check('a name-only edit does not resend (and cannot rewrite) properties',
      sent && sent.name === 'Chaos Bolt II' && !('properties' in sent), JSON.stringify(sent));
    // Editing a detail DOES send properties — and the custom school rides along.
    sent = null;
    spellField(cc, 'duration').value = 'instantaneous';
    spellField(cc, 'duration').dispatchEvent(new window.Event('input'));
    await clickSave(cc);
    check('editing a detail preserves the custom school in the sent properties',
      sent && sent.properties && sent.properties.school === 'chronomancy' && sent.properties.duration === 'instantaneous',
      JSON.stringify(sent && sent.properties));
  }

  // A failed save keeps the draft open with an actionable error, and does not
  // resubmit while in flight.
  {
    const cc = mount();
    let calls = 0;
    SpellSheet.render(cc, { spell: null, onSave: async (p) => { calls += 1; return { status: 400, data: { error: 'level must be between 0 and 9' } }; } });
    spellField(cc, 'name').value = 'Bad';
    spellField(cc, 'name').dispatchEvent(new window.Event('input'));
    await clickSave(cc);
    check('a server error is surfaced to the user', /between 0 and 9/.test(cc.textContent));
    check('the draft stays open after a failed save (name field still present)', spellField(cc, 'name') !== null);
    check('the save is not swallowed — exactly one attempt was made', calls === 1, String(calls));
  }

  // The themed discard guard: a clean editor closes freely; a dirty one vetoes
  // and routes through the confirm. (Here we exercise VTTSpellSheet's dirty
  // signalling via ctx.onDirtyChange, which actors.js feeds into _vttCloseGuard.)
  {
    const cc = mount();
    let dirty = false;
    SpellSheet.render(cc, { spell: baseSpell, schoolValues: [], onDirtyChange: (d) => { dirty = d; }, onSave: async () => ({ status: 200 }) });
    check('a freshly-rendered editor is not dirty', dirty === false);
    spellField(cc, 'description').value = 'changed';
    spellField(cc, 'description').dispatchEvent(new window.Event('input'));
    check('editing a field marks the editor dirty (drives the close guard)', dirty === true);
  }

  // Cancel routes through ctx.requestClose (which actors.js wires to the guarded
  // close), rather than closing the dialog directly.
  {
    const cc = mount();
    let closeRequested = false;
    SpellSheet.render(cc, { spell: null, requestClose: () => { closeRequested = true; }, onSave: async () => ({ status: 200 }) });
    const cancel = [...cc.querySelectorAll('button')].find((b) => /^cancel$/i.test(b.textContent.trim()));
    cancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('Cancel asks the host to close (through the guard), not the dialog', closeRequested === true);
  }

  // The read view is complete and free of any learn/prepare controls (it is not
  // the spellbook).
  {
    const rcS = mount();
    SpellSheet.renderRead(rcS, baseSpell);
    check('read view shows the spell name', /Magic Missile/.test(rcS.textContent));
    check('read view shows the level badge', /Level 1/.test(rcS.textContent));
    check('read view shows the school label', /Evocation/.test(rcS.textContent));
    check('read view shows the full description', /Three darts/.test(rcS.textContent));
    check('read view carries NO learn/prepare/forget controls',
      ![...rcS.querySelectorAll('button')].some((b) => /learn|prepare|forget/i.test(b.textContent)));
  }

  // ======================================================================
  // 6. the JSONB byte budgets, which the server enforces at 8192
  // ======================================================================
  const worstData = {};
  for (const f of Sheet.FIELDS.filter((x) => x.path === 'data')) {
    if (f.type === 'bool') worstData[f.key] = true;
    else if (f.type === 'int') worstData[f.key] = 999999;
    else worstData[f.key] = 'x'.repeat(f.max || 8);
  }
  const dataBytes = Buffer.byteLength(JSON.stringify(worstData), 'utf8');
  check('a completely full character sheet fits inside the 8192-byte data cap',
    dataBytes < 8192, `${dataBytes} bytes`);
  check('and inside the 200-key cap', Object.keys(worstData).length < 200, `${Object.keys(worstData).length} keys`);

  const worstProps = {};
  for (const f of ItemSheet.FIELDS.filter((x) => x.path === 'properties')) {
    if (f.type === 'bool') worstProps[f.key] = true;
    else if (f.type === 'int') worstProps[f.key] = 9999;
    else worstProps[f.key] = 'x'.repeat(f.max || 15);
  }
  const propBytes = Buffer.byteLength(JSON.stringify(worstProps), 'utf8');
  check('a completely full item fits inside the 8192-byte properties cap',
    propBytes < 8192, `${propBytes} bytes`);

  // ======================================================================
  // 7. the character creation form (VTTActorSheet) — tiered payloads
  // ======================================================================
  // A GM's create body may carry the privileged fields; a player's must not,
  // because the server FORCES user_id/is_npc and REFUSES any other GM field.
  let gmBody = null;
  let gc = mount();
  ActorSheet.render(gc, {
    isGm: true,
    members: [{ id: 'u-9', label: 'Bob' }],
    onSave: async (body) => { gmBody = body; return { status: 201, data: { actor: { id: 'x' } } }; },
  });
  check('a GM create with no name is refused client-side', (() => {
    gmBody = null; saveButton(gc).dispatchEvent(new window.Event('click')); return gmBody === null;
  })());
  check('...and the missing-name error is shown', /name is required/i.test(gc.textContent));
  gc.querySelector('#actor-name').value = 'Villain';
  gc.querySelector('#actor-name').dispatchEvent(new window.Event('input'));
  await clickSave(gc);
  check('a GM create sends the name', gmBody && gmBody.name === 'Villain', JSON.stringify(gmBody));
  check('...current HP as an integer', gmBody && gmBody.hp_current === 10 && typeof gmBody.hp_current === 'number');
  check('...is_npc (GM-only) is present', gmBody && 'is_npc' in gmBody);
  check('...user_id (GM-only) is present', gmBody && 'user_id' in gmBody);
  check('...size (GM-only) is present', gmBody && 'size' in gmBody, JSON.stringify(gmBody));
  check('...and the GM form exposes a Statistics disclosure', /Statistics/.test(gc.textContent));

  let plBody = null;
  const pc = mount();
  ActorSheet.render(pc, {
    isGm: false,
    onSave: async (body) => { plBody = body; return { status: 201, data: { actor: { id: 'y' } } }; },
  });
  pc.querySelector('#actor-name').value = 'Aria';
  pc.querySelector('#actor-name').dispatchEvent(new window.Event('input'));
  await clickSave(pc);
  check('a player create sends the name', plBody && plBody.name === 'Aria', JSON.stringify(plBody));
  check('...and current HP', plBody && typeof plBody.hp_current === 'number');
  check('...but NO is_npc (the server forces it)', plBody && !('is_npc' in plBody), JSON.stringify(plBody));
  check('...NO user_id (the server forces it to self)', plBody && !('user_id' in plBody));
  check('...NO size or any other GM capability', plBody
    && !('size' in plBody) && !('hp_max' in plBody) && !('level' in plBody) && !('armor_class' in plBody)
    && !('strength' in plBody), JSON.stringify(plBody));
  check('the player form does NOT expose a Statistics disclosure', !/Statistics/.test(pc.textContent));

  // A failed create keeps the draft (name field still present) and surfaces the
  // error — e.g. the 409 cap refusal.
  {
    const fc = mount();
    let calls = 0;
    ActorSheet.render(fc, {
      isGm: false,
      onSave: async () => { calls += 1; return { status: 409, data: { error: 'you may hold at most 3 characters in a campaign' } }; },
    });
    fc.querySelector('#actor-name').value = 'Fourth';
    fc.querySelector('#actor-name').dispatchEvent(new window.Event('input'));
    await clickSave(fc);
    check('a cap refusal is surfaced to the user', /at most 3 characters/.test(fc.textContent));
    check('...the draft stays open (name field still present)', fc.querySelector('#actor-name') !== null);
    check('...and exactly one create attempt was made', calls === 1, String(calls));
  }

  // Portrait + framing ride along in the create body when a portrait was chosen.
  {
    const ic = mount();
    let body = null;
    ActorSheet.render(ic, {
      isGm: false,
      onPickImage: (cur, cb) => cb('https://example.com/p.png', { offsetX: 0.2, offsetY: -0.1, scale: 1.5 }),
      onSave: async (b) => { body = b; return { status: 201, data: { actor: { id: 'z' } } }; },
    });
    ic.querySelector('#actor-name').value = 'Framed';
    ic.querySelector('#actor-name').dispatchEvent(new window.Event('input'));
    ic.querySelector('.ae-portrait').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await clickSave(ic);
    check('a chosen portrait is sent on create', body && body.img_url === 'https://example.com/p.png', JSON.stringify(body));
    check('...with its framing, in the SAME create request', body
      && body.img_offset_x === 0.2 && body.img_offset_y === -0.1 && body.img_scale === 1.5, JSON.stringify(body));
  }

  // ======================================================================
  // 8. the character sheet dirty/close-guard signalling
  // ======================================================================
  // The restyled VTTSheet signals dirtiness through onDirtyChange, which
  // actors.js feeds into the dialog _vttCloseGuard. A fresh sheet is clean; an
  // edit marks it dirty; a successful save clears it again.
  {
    const sc = mount();
    let dirty = false;
    Sheet.render(sc, {
      actor: baseActor(), isGm: true, me: GM,
      onDirtyChange: (d) => { dirty = d; },
      onSave: async () => ({ status: 200 }),
    });
    check('a freshly-rendered sheet is not dirty', dirty === false);
    const nameField = field(sc, 'name');
    nameField.value = 'Aria the Bold';
    nameField.dispatchEvent(new window.Event('input'));
    check('editing a field marks the sheet dirty (drives the close guard)', dirty === true);
    await clickSave(sc);
    check('a successful save clears the dirty flag', dirty === false);
  }

  // Sheet Cancel reverts in-progress edits and clears dirty — it does NOT close
  // the sheet (that is the dialog X's job, guarded by _vttCloseGuard).
  {
    const sc = mount();
    let dirtyState = null;
    let closeRequested = false;
    Sheet.render(sc, {
      actor: baseActor(), isGm: true, me: GM,
      onDirtyChange: (d) => { dirtyState = d; },
      requestClose: () => { closeRequested = true; },
      onSave: async () => ({ status: 200 }),
    });
    field(sc, 'hp_current').value = '3';
    field(sc, 'hp_current').dispatchEvent(new window.Event('input'));
    check('editing marks the sheet dirty', dirtyState === true);
    const cancel = [...sc.querySelectorAll('.fo-footer button')].find((b) => /^cancel$/i.test(b.textContent.trim()));
    cancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('sheet Cancel reverts the edit', field(sc, 'hp_current').value === String(baseActor().hp_current));
    check('...clears the dirty state (close-guard stops prompting)', dirtyState === false);
    check('...and does NOT close the sheet', closeRequested === false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
