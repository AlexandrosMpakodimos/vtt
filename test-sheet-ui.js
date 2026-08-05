// Character sheet + item editor UI suite. jsdom only — no server, no database:
//   node test-sheet-ui.js
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

const dom = new JSDOM(fs.readFileSync('public/actors.html', 'utf8'), {
  runScripts: 'outside-only',
  url: 'http://localhost:3000/actors.html',
});
const { window } = dom;
const { document } = window;
window.io = () => ({ on() {}, emit() {} });
window.fetch = async () => ({ status: 200, json: async () => ({}) });
if (!window.TextEncoder) window.TextEncoder = require('util').TextEncoder;

window.eval(fs.readFileSync('public/js/sheet.js', 'utf8'));
window.eval(fs.readFileSync('public/js/itemsheet.js', 'utf8'));
const Sheet = window.VTTSheet;
const ItemSheet = window.VTTItemSheet;

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
function saveButton(container) {
  return [...container.querySelectorAll('button')].find((b) => /save|create/.test(b.textContent));
}
async function clickSave(container) {
  const b = saveButton(container);
  b.dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 0));
}

(async () => {
  // ======================================================================
  // 1. the duplicated allow-lists must match the server, field by field
  // ======================================================================
  const server = fs.readFileSync('src/routes/actors.js', 'utf8');
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
  const NOT_SHEET_FIELDS = ['is_npc', 'user_id', 'img_offset_x', 'img_offset_y', 'img_scale'];
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
  check('a player may NOT edit strength', field(c, 'strength').disabled === true);
  check('a player may NOT edit max HP', field(c, 'hp_max').disabled === true);
  check('a player may NOT edit level', field(c, 'level').disabled === true);
  // Shown-but-disabled rather than hidden: a player should be able to READ their
  // own armour class. Hiding it would make the sheet lie about the character.
  check('GM-only fields are rendered, not hidden', field(c, 'armor_class') !== null);
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
  check('and says so plainly', /has not shared/.test(c.textContent));

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
    sent && !Object.keys(sent).some((k) => ['strength', 'hp_max', 'level', 'armor_class', 'speed', 'size', 'class', 'race'].includes(k)),
    JSON.stringify(sent));

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

  itemSent = null;
  c = mount();
  ItemSheet.render(c, { item: baseItem, onSave: async (p, n) => { itemSent = p; wasNew = n; return { status: 200 }; } });
  check('editing loads the column values', itemField(c, 'name').value === 'Flame Tongue');
  check('and the properties sub-keys', itemField(c, 'damage').value === '2d6' && itemField(c, 'charges').value === '3');
  check('the raw box shows only unclaimed properties', JSON.parse(itemField(c, 'properties').value).homebrew === true);

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
