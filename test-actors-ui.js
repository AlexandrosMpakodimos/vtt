// Character page smoke suite. jsdom only — no server, no database:
//   node test-actors-ui.js
//
// public/js/actors.js had NO runtime coverage. test-sheet-ui.js loads
// actors.html, sheet.js and itemsheet.js — it never evaluates actors.js — which
// is exactly the blind spot that let an edit delete a function from combat.js
// and kill that whole page on load. Two 500-line client files sharing one gap
// was one too many.
//
// Narrow on purpose, like test-combat-ui.js: does the file load, do the elements
// its handlers bind to exist, do the entry points run, and is the FRAMING
// ARITHMETIC right. That last part earns its place because a mis-scaled crop
// looks plausible in the preview and is wrong on the canvas, where nobody is
// looking for it.

const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM(fs.readFileSync('public/actors.html', 'utf8'), {
  runScripts: 'outside-only',
  url: 'http://localhost:3000/actors.html',
});
const { window } = dom;
const { document } = window;

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

const ME = 'U1';
const calls = [];
window.fetch = async (path, opts = {}) => {
  calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  const json = async () => {
    if (path === '/api/auth/me') return { user: { id: ME, username: 'gm' } };
    if (/\/actors$/.test(path)) {
      return {
        actors: [
          {
            id: 'A1', name: 'Aria', user_id: ME, is_npc: false, level: 3, size: 'Medium',
            hp_current: 12, hp_max: 20, armor_class: 15,
            strength: 10, dexterity: 14, constitution: 12,
            intelligence: 8, wisdom: 11, charisma: 16,
            death_save_successes: 0, death_save_failures: 0,
            img_url: 'https://example.com/aria.png',
            img_offset_x: 0.25, img_offset_y: -0.1, img_scale: 1.4,
          },
          {
            // No picture: must NOT be offered a framing control.
            id: 'A2', name: 'Plainling', user_id: ME, is_npc: false, level: 1, size: 'Medium',
            hp_current: 5, hp_max: 5, armor_class: 10,
            strength: 10, dexterity: 10, constitution: 10,
            intelligence: 10, wisdom: 10, charisma: 10,
            death_save_successes: 0, death_save_failures: 0,
            img_url: null, img_offset_x: 0, img_offset_y: 0, img_scale: 1,
          },
          {
            // A projected NPC: another player's, read-only, no framing control.
            id: 'A3', name: 'Goblin', user_id: null, is_npc: true, size: 'Small',
            img_url: 'https://example.com/goblin.png',
            img_offset_x: 0, img_offset_y: 0, img_scale: 1,
          },
        ],
      };
    }
    if (/\/items$/.test(path)) return { items: [
      { id: 'IT1', campaign_id: 'C1', name: 'Longsword', type: 'weapon', img_url: null, weight: 3, description: 'A blade.', identified: true, properties: { rarity: 'common', damage: '1d8' } },
      { id: 'IT2', campaign_id: 'C1', name: 'Cloak of Stars', type: 'misc', img_url: null, weight: 1, description: 'Shimmers.', identified: true, properties: { rarity: 'rare' } },
      { id: 'IT3', campaign_id: 'C1', name: 'Cursed Helm', type: 'armor', img_url: null, weight: 2, description: 'Ominous.', identified: false, properties: { rarity: 'legendary' } },
    ] };
    // Two SEPARATE scopes, and the client fetches both: campaign images and
    // personal ones (avatars), which have different quotas and different
    // owners. A stub returning the same list for each would have hidden that.
    if (/\/api\/assets\?campaign_id=/.test(path)) {
      return {
        assets: [
          { id: 'AS1', url: 'https://pub-x.r2.dev/c/C1/portrait/a.png', source: 'upload',
            kind: 'portrait', status: 'ready', campaign_id: 'C1' },
          { id: 'AS2', url: 'https://elsewhere.example/map.png', source: 'external',
            kind: 'map', status: 'ready', campaign_id: 'C1' },
        ],
      };
    }
    if (/\/api\/assets$/.test(path)) {
      return {
        assets: [
          { id: 'AS3', url: 'https://pub-x.r2.dev/u/U1/avatar/me.png', source: 'upload',
            kind: 'avatar', status: 'ready', campaign_id: null },
        ],
      };
    }
    if (/\/actors\/[^/]+\/spells$/.test(path)) {
      return {
        spells: [
          { actor_id: 'A1', spell_id: 'S1', prepared: true, source: 'class',
            spell: { id: 'S1', name: 'Magic Missile', level: 1, description: 'Three darts.' } },
        ],
      };
    }
    if (/\/spells(\?|$)/.test(path)) {
      return {
        spells: [
          { id: 'S1', name: 'Magic Missile', level: 1, description: 'Three darts.', properties: {} },
          { id: 'S2', name: 'Fire Bolt', level: 0, description: '', properties: { school: 'evocation' } },
        ],
      };
    }
    if (/\/inventory$/.test(path)) return { inventory: [] };
    if (/\/members$/.test(path)) return { members: [] };
    return { campaign: { id: 'C1', name: 'Test', is_gm: true }, members: [] };
  };
  return { status: 200, json };
};
window.io = () => ({ on() {}, emit(ev, p, ack) { if (ack) ack({ ok: true }); } });
window.PointerEvent = class extends window.MouseEvent {
  constructor(ty, o = {}) { super(ty, o); this.pointerId = o.pointerId || 1; }
};
window.Element.prototype.setPointerCapture = function set() {};
window.Element.prototype.releasePointerCapture = function rel() {};
window.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
// jsdom reports 0x0 for every element; the framing drag divides by these, so a
// real size is needed for the arithmetic probes to mean anything.
window.Element.prototype.getBoundingClientRect = function rect() {
  return { left: 0, top: 0, width: 220, height: 220, right: 220, bottom: 220 };
};

let loadError = null;
try {
  // actors.js consumes the Sheet and ItemSheet globals these two files define.
  // Loading them here mirrors the real page's <script> order — and the first run
  // of this suite failed on exactly that omission, which is a fair illustration
  // of why an 800-line client file wants a load probe at all.
  window.eval(fs.readFileSync('public/js/sheet.js', 'utf8'));
  window.eval(fs.readFileSync('public/js/itemsheet.js', 'utf8'));
  window.eval(fs.readFileSync('public/js/actors.js', 'utf8'));
} catch (err) {
  loadError = err;
}

console.log('\n--- the file loads at all ---');
t('actors.js evaluates without throwing', loadError === null,
  loadError && `${loadError.name}: ${loadError.message}`);
if (loadError) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

console.log('\n--- every element the handlers bind to exists ---');
for (const id of [
  'whoami', 'campaignId', 'loadCampaign', 'campaignInfo', 'actorList',
  'assetKind', 'assetFile', 'assetUpload', 'assetUrl', 'assetLink', 'assetMsg', 'assetList',
  'spName', 'spLevel', 'spDesc', 'createSpell', 'spFilter', 'spellList',
  'sbSpell', 'sbSource', 'learnSpell', 'sbList', 'sbWho',
]) {
  t(`#${id} is present`, document.getElementById(id) !== null);
}

(async () => {
  document.getElementById('campaignId').value = '11111111-1111-4111-8111-111111111111';
  let runError = null;
  try { await window.loadCampaign(); } catch (err) { runError = err; }
  await new Promise((r) => setTimeout(r, 10));

  console.log('\n--- the entry point runs ---');
  t('loadCampaign() completes', runError === null,
    runError && `${runError.name}: ${runError.message}`);
  t('characters rendered', document.querySelectorAll('#actorList .card').length === 3,
    String(document.querySelectorAll('#actorList .card').length));

  console.log('\n--- the item editor opens its dialog (game.html wraps it in one) ---');
  // On game.html the item editor lives inside <dialog id="itemDialog"> which must
  // be opened explicitly (nothing did, so "+ New item" silently did nothing).
  // Simulate that structure: give the page an #itemDialog and a spy openDialog,
  // then click #newItem and assert the dialog was opened.
  {
    let openedWith = null;
    const dlg = document.createElement('dialog');
    dlg.id = 'itemDialog';
    document.body.appendChild(dlg);
    window.VTTCommon = window.VTTCommon || {};
    const prevOpen = window.VTTCommon.openDialog;
    window.VTTCommon.openDialog = (d) => { openedWith = d; };
    document.getElementById('newItem').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('"+ New item" opens the item dialog', openedWith === dlg,
      openedWith ? 'opened a dialog' : 'no dialog opened');
    window.VTTCommon.openDialog = prevOpen;
    dlg.remove();
  }

  console.log('\n--- the image library ---');
  const assetCards = [...document.querySelectorAll("#assetList .asset")];
  t('the library shows campaign images AND personal ones',
    assetCards.length === 3, String(assetCards.length));
  t('...the personal one being the avatar',
    assetCards[2].textContent.includes('avatar'), assetCards[2].textContent);
  t('a hosted image is labelled hosted', /hosted/.test(assetCards[0].textContent), assetCards[0].textContent);
  t('an external link is labelled external', /external link/.test(assetCards[1].textContent),
    assetCards[1].textContent);
  t('...and marked visually, because the two are not the same thing',
    assetCards[1].classList.contains('external'));
  t('an external image suppresses the referrer',
    assetCards[1].querySelector('img').referrerPolicy === 'no-referrer',
    assetCards[1].querySelector('img').referrerPolicy);
  t('a hosted image does not need to', !assetCards[0].querySelector('img').referrerPolicy);
  t('the upload accept list excludes SVG',
    !document.getElementById('assetFile').accept.includes('svg'),
    document.getElementById('assetFile').accept);
  t('...and offers exactly the four allowed types',
    document.getElementById('assetFile').accept.split(',').length === 4);
  t('every kind is offered', [...document.getElementById('assetKind').options].length === 5);

  console.log('\n--- the spell catalogue ---');
  const spellCards = [...document.querySelectorAll('#spellList .card')];
  t('the catalogue renders', spellCards.length === 2, String(spellCards.length));
  t('a spell shows its level as a tag',
    /cantrip/.test(document.getElementById('spellList').textContent),
    document.getElementById('spellList').textContent.slice(0, 120));
  t('...and its description in full — there is NO unidentified projection',
    /Three darts/.test(document.getElementById('spellList').textContent));
  t('a properties blob renders its own keys rather than an assumed shape',
    /school: evocation/.test(document.getElementById('spellList').textContent));

  console.log('\n--- the spellbook ---');
  t('the who-label still says nothing is selected',
    /select a character/.test(document.getElementById('sbWho').textContent));
  const learnable = [...document.getElementById('sbSpell').options].map((o) => o.textContent);
  t('the learn picker offers the catalogue',
    learnable.length === 2, learnable.join(' | '));
  t('...labelled with the level', learnable.some((o) => /Fire Bolt \(cantrip\)/.test(o)),
    learnable.join(' | '));

  console.log('\n--- selecting a character loads their spellbook ---');
  window.selectActor({ id: 'A1', name: 'Aria' });
  await new Promise((r) => setTimeout(r, 10));
  t('the spellbook renders the known spell',
    /Magic Missile/.test(document.getElementById('sbList').textContent),
    document.getElementById('sbList').textContent.slice(0, 120));
  t('...tagged prepared', /prepared/.test(document.getElementById('sbList').textContent));
  t('...and grouped under its level',
    /level 1/.test(document.getElementById('sbList').textContent));
  const stillLearnable = [...document.getElementById('sbSpell').options].map((o) => o.textContent);
  t('a spell already known drops out of the learn picker',
    !stillLearnable.some((o) => /Magic Missile/.test(o)), stillLearnable.join(' | '));
  t('...while an unknown one stays', stillLearnable.some((o) => /Fire Bolt/.test(o)));

  console.log('\n--- the framing control is offered exactly where it applies ---');
  const cards = [...document.querySelectorAll('#actorList .card')];
  const btns = (card) => [...card.querySelectorAll('button')].map((b) => b.textContent);
  t('a writable character WITH a picture is offered framing',
    btns(cards[0]).includes('frame picture'), btns(cards[0]).join(','));
  t('a character with NO picture is not', !btns(cards[1]).includes('frame picture'),
    btns(cards[1]).join(','));
  t('...because framing describes a picture that is not there',
    !btns(cards[1]).includes('frame picture'));

  console.log('\n--- framing opens the reusable tool and PATCHes the character ---');
  // Framing mechanics live in VTTFrameTool (see test-frametool.js). Here we only
  // check the wiring: the button opens the tool for the right image/values, and
  // the save callback PATCHes exactly the three framing fields onto the actor.
  let frameOpen = null;
  window.VTTFrameTool = { open: (opts) => { frameOpen = opts; }, close: () => {}, isOpen: () => false };
  const frameBtn = [...cards[0].querySelectorAll('button')].find((b) => b.textContent === 'frame picture');
  frameBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('the tool is opened', !!frameOpen);
  t('with the saved scale', frameOpen && frameOpen.scale === 1.4, frameOpen && String(frameOpen.scale));
  t('with the saved offsets', frameOpen && frameOpen.offsetX === 0.25 && frameOpen.offsetY === -0.1);
  t('and the character picture', frameOpen && /aria\.png/.test(String(frameOpen.imageUrl)));

  const before = calls.filter((c) => c.method === 'PATCH').length;
  await frameOpen.onSave({ offsetX: 0.5, offsetY: -0.1, scale: 1 });
  const patch = calls.filter((c) => c.method === 'PATCH').pop();
  t('the save callback issues a PATCH', calls.filter((c) => c.method === 'PATCH').length === before + 1);
  t('...to the character, not a token', /\/actors\/A1$/.test(patch.path), patch.path);
  t('...carrying exactly the three framing fields',
    Object.keys(patch.body).sort().join(',') === 'img_offset_x,img_offset_y,img_scale',
    Object.keys(patch.body).join(','));
  t('...and nothing else, so it cannot touch hp or a stat',
    !('hp_current' in patch.body) && !('name' in patch.body));

  console.log('\n--- the item library: image-forward grid, search, filters ---');
  {
    const grid = document.getElementById('itemList');
    const cards = () => [...grid.querySelectorAll('.item-card')];
    t('every item renders as an image-forward card', cards().length === 3, String(cards().length));
    t('the unidentified item is marked and blurred-eligible',
      grid.querySelectorAll('.item-card.unidentified').length === 1);
    t('an identified card shows its name', /Longsword/.test(grid.textContent));
    t('the unidentified card hides the name, showing its category',
      /Unidentified armor/i.test(grid.textContent));

    // Filter chips exist for type and rarity (plus an "All").
    const typeChips = [...document.getElementById('itemFilterType').querySelectorAll('.item-chip')];
    t('type filter chips are built', typeChips.length >= 5, String(typeChips.length));

    // Filters live behind a toggle; the panel starts hidden.
    const panel = document.getElementById('itemFilterPanel');
    const toggle = document.getElementById('itemFilterToggle');
    t('the filter panel starts hidden', panel.hasAttribute('hidden'));
    toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('clicking Filter reveals the panel', !panel.hasAttribute('hidden'));

    // Search narrows the grid.
    const search = document.getElementById('itemSearch');
    search.value = 'longsword';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    t('search narrows to matching items', cards().length === 1 && /Longsword/.test(grid.textContent), String(cards().length));
    search.value = '';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    t('clearing search restores all', cards().length === 3);

    // The GM can find an unidentified item by its true name, even though the card
    // still shows only the category.
    search.value = 'cursed helm';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    t('GM search matches an unidentified item by its hidden name',
      cards().length === 1 && /Unidentified armor/i.test(grid.textContent), String(cards().length));
    search.value = '';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));

    // Type filter: click the "weapon" chip.
    const weaponChip = typeChips.find((c) => /weapon/i.test(c.textContent));
    weaponChip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('type filter shows only that type', cards().length === 1 && /Longsword/.test(grid.textContent), String(cards().length));
    t('the filter count badge reflects one active filter',
      document.getElementById('itemFilterCount').textContent === '1' && !document.getElementById('itemFilterCount').hidden);
    // Toggling it off restores.
    [...document.getElementById('itemFilterType').querySelectorAll('.item-chip')].find((c) => /weapon/i.test(c.textContent))
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('toggling the type filter off restores all', cards().length === 3);

    // Rarity filter: rare shows only the identified rare item.
    const rareChip = [...document.getElementById('itemFilterRarity').querySelectorAll('.item-chip')].find((c) => /^rare$/i.test(c.textContent));
    rareChip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('rarity filter shows only that rarity', cards().length === 1 && /Cloak/.test(grid.textContent), String(cards().length));
    [...document.getElementById('itemFilterRarity').querySelectorAll('.item-chip')].find((c) => /^rare$/i.test(c.textContent))
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    // GM cards carry the action row incl. a preview button.
    const firstCard = cards()[0];
    t('GM cards have an action row with a preview button',
      !!firstCard.querySelector('.item-icon-preview') && !!firstCard.querySelector('.item-icon-edit'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
