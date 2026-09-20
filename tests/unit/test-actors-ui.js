const { rootPath } = require('../helpers/paths');
// Character page smoke suite. jsdom only — no server, no database:
//   node tests/unit/test-actors-ui.js
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

const dom = new JSDOM(fs.readFileSync(rootPath('public/actors.html'), 'utf8'), {
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
  window.eval(fs.readFileSync(rootPath('public/js/imageframe.js'), 'utf8'));
  window.eval(fs.readFileSync(rootPath('public/js/sheet.js'), 'utf8'));
  window.eval(fs.readFileSync(rootPath('public/js/itemsheet.js'), 'utf8'));
  window.eval(fs.readFileSync(rootPath('public/js/spellsheet.js'), 'utf8'));
  window.eval(fs.readFileSync(rootPath('public/js/actorsheet.js'), 'utf8'));
  window.eval(fs.readFileSync(rootPath('public/js/actors.js'), 'utf8').replace(/\}\)\(\);\s*$/, `window.__inventoryTest = { setRoster(gm, rows) { isGm = gm; me = { id: 'U1' }; campaign = { id: 'C1' }; selectedActor = null; actors = rows; Object.assign(charFilter, { q: '', type: '', control: '', party: '' }); charFiltersWired = false; renderActors(); }, renderInventory, renderSheet, loadSpellbook, renderSpellbook, renderSpellChoices, learnSpell, patchSpellbook, forgetSpell, seedBook(entries) { spellbook = entries; spellbookActorId = selectedActor; spellbookAvailable = true; spellbookLoading = false; spells = [{ id: 'B1', name: 'Light', level: 0 }, { id: 'B2', name: 'Shield', level: 1 }]; renderSpellbook(); renderSpellChoices(); }, set(gm, owner, npc = false) { isGm = gm; me = { id: 'U1' }; campaign = { id: 'C1' }; selectedActor = 'INV-A'; actors = [{ id: 'INV-A', name: 'Test mage', user_id: owner, is_npc: npc, ...(npc ? {} : { hp_max: 10, hp_current: 10, data: {} }) }]; } }; })();`));
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
  'newActor', 'charSearch', 'charFilterToggle', 'charFilterCount',
  'charFilterPanel', 'charFilterType', 'charFilterControl', 'actorCap', 'actorEditor',
  'assetKind', 'assetFile', 'assetUpload', 'assetUrl', 'assetLink', 'assetMsg', 'assetList',
  'newSpell', 'spellSearch', 'spellFilterToggle', 'spellFilterCount',
  'spellFilterPanel', 'spellFilterLevel', 'spellFilterSchool', 'spellList',
  'spellEditor', 'spellWho',
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
  const charCards = () => [...document.querySelectorAll('#actorList .char-card')];
  t('characters rendered as portrait cards', charCards().length === 3, String(charCards().length));
  t('a card shows the character name', /Aria/.test(document.getElementById('actorList').textContent));
  t('a PC card carries a PC badge', /PC/.test(charCards()[0].textContent));
  t('an NPC card carries an NPC badge', /NPC/.test(document.getElementById('actorList').textContent));
  t('a portrait-less character gets an initials fallback',
    !!charCards()[1].querySelector('.char-portrait-fallback'));
  t('a character with a portrait renders the image',
    !!charCards()[0].querySelector('.char-portrait img'));
  t('the HP bar + current/max render where stats exist',
    !!charCards()[0].querySelector('.char-hp-bar') && /12\/20/.test(charCards()[0].textContent));

  t('HP and AC have distinct labelled values', charCards()[0].querySelector('.char-hp-value').textContent === '12/20' && charCards()[0].querySelector('.char-ac-value').textContent === '15');
  t('ownership/type badges have their own row', !!charCards()[0].querySelector('.char-status-row .char-badge'));
  t('Adjust HP uses the app button theme', !!charCards()[0].querySelector('.char-hp-toggle.btn.secondary'));
  const portraitImage = charCards()[0].querySelector('.char-portrait img');
  Object.defineProperties(portraitImage, {
    naturalWidth: { value: 440 }, naturalHeight: { value: 220 },
  });
  portraitImage.dispatchEvent(new window.Event('load'));
  t('character cards keep the complete wide image for framing',
    portraitImage.style.width === '200%' && portraitImage.style.height === '100%');
  t('character cards use the same centring as the framing editor',
    portraitImage.style.transform.startsWith('translate(-50%, -50%)'));
  portraitImage.dispatchEvent(new window.Event('error'));
  t('broken portrait falls back to initials', !charCards()[0].querySelector('.char-portrait img') && !!charCards()[0].querySelector('.char-portrait-fallback'));

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
    assetCards[2].textContent.includes('Avatars'), assetCards[2].textContent);
  const imageToolbar = document.querySelector('.image-toolbar');
  imageToolbar.querySelector('[data-kind="map"]').click();
  t('image category filter shows maps only', document.querySelectorAll('#assetList .asset').length === 1 && document.querySelector('#assetList .asset').textContent.includes('Maps'));
  t('image filter updates count', imageToolbar.querySelector('.image-count').textContent === '1 of 3 images · Maps');
  const imageSearch = imageToolbar.querySelector('input');
  imageSearch.value = 'missing'; imageSearch.dispatchEvent(new window.Event('input'));
  t('image search combines with category', document.querySelectorAll('#assetList .asset').length === 0 && document.getElementById('assetList').textContent.includes('No images match'));
  imageSearch.value = ''; imageSearch.dispatchEvent(new window.Event('input'));
  imageToolbar.querySelector('[data-kind=""]').click();
  t('clearing image filters restores the library', document.querySelectorAll('#assetList .asset').length === 3);
  t('image cards have accessible previews', document.querySelector('#assetList .image-thumb').getAttribute('aria-label').includes('a.png'));
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

  console.log('\n--- the spell catalogue (redesigned: text cards, no inline form) ---');
  const spellCards = () => [...document.querySelectorAll('#spellList .spell-card')];
  t('the catalogue renders as spell cards', spellCards().length === 2, String(spellCards().length));
  t('a spell shows a level badge (Cantrip / Level N)',
    /Cantrip/.test(document.getElementById('spellList').textContent)
      && /Level 1/.test(document.getElementById('spellList').textContent),
    document.getElementById('spellList').textContent.slice(0, 160));
  t('...and its description in full — there is NO unidentified projection',
    /Three darts/.test(document.getElementById('spellList').textContent));
  t('a known school renders its readable label on the card',
    /Evocation/.test(document.getElementById('spellList').textContent),
    document.getElementById('spellList').textContent.slice(0, 200));
  t('the description snippet is line-clamped by class, not truncated in text',
    !!document.querySelector('#spellList .spell-card-desc'));

  console.log('\n--- GM controls: each card carries edit + delete ---');
  {
    const first = spellCards()[0];
    const editBtns = first.querySelectorAll('.item-icon-edit');
    const delBtns = first.querySelectorAll('.item-icon-delete');
    t('a GM card has an edit control', editBtns.length === 1);
    t('a GM card has a delete control', delBtns.length === 1);
  }

  console.log('\n--- the read view opens on activation (complete details) ---');
  {
    // The GM "view" icon opens VTTSpellSheet.openPreview as an overlay.
    const viewBtn = spellCards()[0].querySelector('.item-icon-preview');
    t('a GM card has a view control', !!viewBtn);
    if (viewBtn) {
      viewBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      const read = document.querySelector('.ie-preview-overlay .spell-read');
      t('the read view renders the full description', !!read && /Three darts|force/i.test(read.textContent),
        read ? read.textContent.slice(0, 120) : 'no overlay');
      const overlay = document.querySelector('.ie-preview-overlay');
      if (overlay) overlay.remove();
    }
  }

  console.log('\n--- "+ New spell" opens the spell dialog (game.html wraps it) ---');
  {
    let openedWith = null;
    const dlg = document.createElement('dialog');
    dlg.id = 'spellDialog';
    document.body.appendChild(dlg);
    window.VTTCommon = window.VTTCommon || {};
    const prevOpen = window.VTTCommon.openDialog;
    window.VTTCommon.openDialog = (d) => { openedWith = d; };
    document.getElementById('newSpell').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('"+ New spell" opens the spell dialog', openedWith === dlg,
      openedWith ? 'opened a dialog' : 'no dialog opened');
    window.VTTCommon.openDialog = prevOpen;
    dlg.remove();
  }

  console.log('\n--- search + filters narrow the grid (client-side) ---');
  {
    const search = document.getElementById('spellSearch');
    search.value = 'fire';
    search.dispatchEvent(new window.Event('input'));
    t('search by name narrows to the match',
      spellCards().length === 1 && /Fire Bolt/.test(document.getElementById('spellList').textContent),
      String(spellCards().length));
    search.value = '';
    search.dispatchEvent(new window.Event('input'));
    t('clearing search restores the grid', spellCards().length === 2, String(spellCards().length));

    // Level 0 (Cantrip) is an ACTIVE filter — the guard is on '', not falsiness.
    const levelBox = document.getElementById('spellFilterLevel');
    const cantripChip = [...levelBox.querySelectorAll('.spell-chip')].find((c) => /Cantrip/.test(c.textContent));
    t('a Cantrip level chip exists', !!cantripChip);
    cantripChip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('filtering to Cantrip shows only the cantrip',
      spellCards().length === 1 && /Fire Bolt/.test(document.getElementById('spellList').textContent),
      String(spellCards().length));
    t('the filter count badge shows one active group',
      document.getElementById('spellFilterCount').textContent === '1'
        && !document.getElementById('spellFilterCount').hidden);

    // Combine Cantrip AND the Evocation school (Fire Bolt has both) → still shown.
    const schoolBox = document.getElementById('spellFilterSchool');
    const evoChip = [...schoolBox.querySelectorAll('.spell-chip')].find((c) => /Evocation/.test(c.textContent));
    t('an Evocation school chip exists', !!evoChip);
    evoChip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('Cantrip AND Evocation combine (AND) and still match Fire Bolt',
      spellCards().length === 1 && /Fire Bolt/.test(document.getElementById('spellList').textContent),
      String(spellCards().length));
    t('the badge now counts two active groups',
      document.getElementById('spellFilterCount').textContent === '2');

    // A no-match combination offers a clear affordance distinct from empty.
    const abjChip = [...schoolBox.querySelectorAll('.spell-chip')].find((c) => /Abjuration/.test(c.textContent));
    abjChip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('an impossible combination reports no matches (not empty catalogue)',
      /No spells match/.test(document.getElementById('spellList').textContent),
      document.getElementById('spellList').textContent.slice(0, 120));
    const clearBtn = [...document.querySelectorAll('#spellList .spell-empty button')]
      .find((b) => /Clear search and filters/.test(b.textContent));
    t('...and offers "Clear search and filters"', !!clearBtn);
    if (clearBtn) {
      clearBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      t('clearing restores the full grid', spellCards().length === 2, String(spellCards().length));
      t('...and hides the filter count badge', document.getElementById('spellFilterCount').hidden);
    }
  }

  console.log('\n--- library filters never narrow the learn picker ---');
  {
    // Narrow the GRID to just the cantrip, then confirm the learn picker still
    // offers the WHOLE catalogue. renderSpellChoices() draws from the complete
    // spells array, not the filtered view.
    const search = document.getElementById('spellSearch');
    search.value = 'fire';
    search.dispatchEvent(new window.Event('input'));
    t('grid is narrowed to one card', spellCards().length === 1, String(spellCards().length));
    const pickerNow = [...document.getElementById('sbSpell').options].map((o) => o.textContent);
    t('the learn picker still offers BOTH spells despite the grid filter',
      pickerNow.length === 2, pickerNow.join(' | '));
    // Restore for the assertions that follow.
    search.value = '';
    search.dispatchEvent(new window.Event('input'));
  }

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
  t('...tagged prepared', /prepared/i.test(document.getElementById('sbList').textContent));
  t('...and grouped under its level',
    /level 1/.test(document.getElementById('sbList').textContent));
  const stillLearnable = [...document.getElementById('sbSpell').options].map((o) => o.textContent);
  t('a spell already known drops out of the learn picker',
    !stillLearnable.some((o) => /Magic Missile/.test(o)), stillLearnable.join(' | '));
  t('...while an unknown one stays', stillLearnable.some((o) => /Fire Bolt/.test(o)));

  console.log('\n--- card activation opens the sheet; action controls do not ---');
  {
    const cards = charCards();
    // A1 is owned (writable): carries the quick-HP disclosure + a menu.
    t('a writable card offers an Adjust HP disclosure',
      !!cards[0].querySelector('.char-hp-toggle'));
    t('...and a themed trash button', !!cards[0].querySelector('.char-trash.btn.danger svg'));
    t('no redundant three-dot character menu', !cards[0].querySelector('.char-menu-btn'));

    // selectActor renders into #sheetPanel on the harness; use that as the
    // observable effect. First clear it so we can tell whether it repopulates.
    const panel = document.getElementById('sheetPanel');
    // Preserve the live spellbook block while this test deliberately wipes the sheet.
    panel.parentNode.appendChild(document.getElementById('sheetSpellbookBlock'));
    panel.innerHTML = '<p class="probe">cleared</p>';
    // Expanding Adjust HP must NOT open the sheet (panel stays cleared).
    cards[0].querySelector('.char-hp-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('expanding Adjust HP does not open the sheet', !!panel.querySelector('.probe'));
    t('...and reveals the amount + Damage + Heal controls',
      !cards[0].parentNode.querySelector('.char-hp-panel').hidden
      && /Damage/.test(cards[0].parentNode.textContent) && /Heal/.test(cards[0].parentNode.textContent));
    // Clicking the card body DOES open the sheet (panel repopulated: the folio
    // renders, with the name in the name input).
    cards[0].querySelector('.char-card-main').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const nameInput = panel.querySelector('#sheet-name');
    t('clicking the card body opens the sheet', !panel.querySelector('.probe') && !!panel.querySelector('.fo-root') && !!nameInput && nameInput.value === 'Aria');
  }

  console.log('\n--- quick HP damage/heal PATCH hp_current only ---');
  {
    const cards = charCards();
    const panel = cards[0].parentNode.querySelector('.char-hp-panel');
    const amt = panel.querySelector('input'); amt.value = '3';
    const before = calls.filter((c) => c.method === 'PATCH').length;
    [...panel.querySelectorAll('button')].find((b) => /Damage/.test(b.textContent))
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    const patch = calls.filter((c) => c.method === 'PATCH').pop();
    t('Damage issues one PATCH', calls.filter((c) => c.method === 'PATCH').length === before + 1);
    t('...to the character', /\/actors\/A1$/.test(patch.path), patch.path);
    t('...carrying only hp_current', Object.keys(patch.body).join(',') === 'hp_current', Object.keys(patch.body).join(','));
    t('...decremented (12 - 3 = 9)', patch.body.hp_current === 9, String(patch.body.hp_current));
    let fresh = charCards()[0];
    t('Adjust HP remains open after damage and refresh', !fresh.querySelector('.char-hp-panel').hidden && fresh.querySelector('.char-hp-toggle').getAttribute('aria-expanded') === 'true');
    t('HP amount survives damage refresh', fresh.querySelector('.char-hp-panel input').value === '3');
    [...fresh.querySelectorAll('.char-hp-panel button')].find((b) => b.textContent === 'Heal').click();
    await new Promise((r) => setTimeout(r, 10));
    fresh = charCards()[0];
    t('Adjust HP remains open after heal', !fresh.querySelector('.char-hp-panel').hidden);
    fresh.querySelector('.char-hp-toggle').click();
    t('Adjust HP closes only when toggled closed', fresh.querySelector('.char-hp-panel').hidden);
    window.selectActor({ id: 'A1', name: 'Aria' });
    await new Promise((r) => setTimeout(r, 10));
    t('closed HP panel stays closed through rerender', charCards()[0].querySelector('.char-hp-panel').hidden);

  }

  console.log('\n--- deleting a character is guarded and names the consequences ---');
  {
    const cards = charCards();
    const prevConfirm = window.confirm;
    let asked = null;
    window.confirm = (m) => { asked = m; return false; };
    const delBtn = cards[0].querySelector('.char-trash');
    let deletesBefore = calls.filter((c) => c.method === 'DELETE').length;
    delBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    t('delete asks for confirmation first', asked !== null);
    t('...naming the inventory/spellbook + unlinked-token consequence',
      /inventory/i.test(asked || '') && /spellbook/i.test(asked || '') && /unlinked/i.test(asked || ''), asked || '');
    t('declining issues no DELETE', calls.filter((c) => c.method === 'DELETE').length === deletesBefore);

    window.confirm = () => true;
    cards[0].querySelector('.char-trash')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    t('accepting issues one DELETE to the actor',
      calls.filter((c) => c.method === 'DELETE').length === deletesBefore + 1
      && /\/actors\/A1$/.test((calls.filter((c) => c.method === 'DELETE').pop() || {}).path || ''));
    window.confirm = prevConfirm;
  }

  console.log('\n--- roster search + filters (client-side, source array untouched) ---');
  {
    // The fetch stub returns a fixed roster (A1 Aria PC/mine, A2 Plainling
    // PC/mine, A3 Goblin NPC/unassigned) regardless of the delete above.
    const list = document.getElementById('actorList');
    const cardsNow = () => [...list.querySelectorAll('.char-card')];
    t('roster shows all three characters', cardsNow().length === 3, String(cardsNow().length));

    const search = document.getElementById('charSearch');
    search.value = 'gob';
    search.dispatchEvent(new window.Event('input'));
    t('name search narrows the roster', cardsNow().length === 1 && /Goblin/.test(list.textContent), String(cardsNow().length));
    search.value = '';
    search.dispatchEvent(new window.Event('input'));

    const typeBox = document.getElementById('charFilterType');
    [...typeBox.querySelectorAll('.char-chip')].find((c) => /NPCs/.test(c.textContent))
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('Type=NPC shows only the NPC', cardsNow().length === 1 && /Goblin/.test(list.textContent), String(cardsNow().length));
    t('the filter count badge shows one active group',
      document.getElementById('charFilterCount').textContent === '1'
      && !document.getElementById('charFilterCount').hidden);

    const controlBox = document.getElementById('charFilterControl');
    [...controlBox.querySelectorAll('.char-chip')].find((c) => /Yours/.test(c.textContent))
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('NPC AND Yours combine with AND \u2192 no matches',
      /No characters match/.test(list.textContent), list.textContent.slice(0, 80));
    t('...the badge counts two active groups', document.getElementById('charFilterCount').textContent === '2');
    const clear = [...list.querySelectorAll('.char-empty button')].find((b) => /Clear/.test(b.textContent));
    t('...and a Clear action is offered', !!clear);
    if (clear) clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('clearing restores the full roster', cardsNow().length === 3, String(cardsNow().length));
  }

  console.log('\n--- "+ New character" opens the creation modal ---');
  {
    let openedWith = null;
    const dlg = document.createElement('dialog'); dlg.id = 'actorDialog';
    document.body.appendChild(dlg);
    window.VTTCommon = window.VTTCommon || {};
    const prevOpen = window.VTTCommon.openDialog;
    window.VTTCommon.openDialog = (d) => { openedWith = d; };
    document.getElementById('newActor').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    t('"+ New character" opens the actor dialog', openedWith === dlg);
    t('...and the creation form renders a name field',
      !!document.getElementById('actorEditor').querySelector('#actor-name'));
    window.VTTCommon.openDialog = prevOpen;
    dlg.remove();
  }

  console.log('\n--- GM creation payload carries the allow-listed fields ---');
  {
    const ed = document.getElementById('actorEditor');
    ed.querySelector('#actor-name').value = 'Newbie';
    ed.querySelector('#actor-name').dispatchEvent(new window.Event('input'));
    const before = calls.filter((c) => c.method === 'POST' && /\/actors$/.test(c.path)).length;
    [...ed.querySelectorAll('button')].find((b) => /Create character/.test(b.textContent))
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    const post = calls.filter((c) => c.method === 'POST' && /\/actors$/.test(c.path)).pop();
    t('creating issues a POST to /actors',
      calls.filter((c) => c.method === 'POST' && /\/actors$/.test(c.path)).length === before + 1);
    t('...carrying the name', post && post.body.name === 'Newbie', JSON.stringify(post && post.body));
    t('...and a GM may set is_npc (a player never could)', post && 'is_npc' in post.body);
    t('...and user_id (controller assignment is GM-only)', post && 'user_id' in post.body);
  }

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

  console.log('\n--- deleting an item is guarded by a confirmation ---');
  {
    const grid = document.getElementById('itemList');
    const delBtnFor = (name) => [...grid.querySelectorAll('.item-card')]
      .find((c) => new RegExp(name).test(c.textContent))
      .querySelector('.item-icon-delete');
    const prevConfirm = window.confirm;

    // Declined confirmation: no DELETE is issued.
    let asked = null;
    window.confirm = (msg) => { asked = msg; return false; };
    let deletesBefore = calls.filter((c) => c.method === 'DELETE').length;
    delBtnFor('Longsword').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    t('clicking delete asks for confirmation first', asked !== null);
    t('...and the warning names the inventory consequence',
      /inventory/i.test(asked || ''), asked || '');
    t('declining the confirm issues no DELETE',
      calls.filter((c) => c.method === 'DELETE').length === deletesBefore);

    // Accepted confirmation: the DELETE fires.
    window.confirm = () => true;
    delBtnFor('Longsword').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    t('accepting the confirm issues exactly one DELETE',
      calls.filter((c) => c.method === 'DELETE').length === deletesBefore + 1);
    t('...against the items endpoint',
      /\/items\//.test((calls.filter((c) => c.method === 'DELETE').pop() || {}).path || ''));
    window.confirm = prevConfirm;
  }


  console.log('\n--- inventory actions ---');
  {
    const seam = window.__inventoryTest;
    const entry = { id: 'IR1', quantity: 3, equipped: true, attuned: false,
      item: { identified: true, name: 'Travel cloak', type: 'misc', properties: {} } };
    const originalFetch = window.fetch, originalPreview = window.VTTItemSheet.openPreview;
    const originalGame = window.VTTGame;
    let writes = [], response = 200, preview = null, confirmation = null;
    window.fetch = async (path, opts = {}) => {
      if (opts.method === 'PATCH' || opts.method === 'DELETE') {
        writes.push({ path, method: opts.method, body: opts.body && JSON.parse(opts.body) });
        return { status: response, json: async () => ({ error: 'Attunement limit reached' }) };
      }
      return { status: 200, json: async () => ({ inventory: [entry] }) };
    };
    window.VTTItemSheet.openPreview = (value) => { preview = value; };
    window.VTTGame = { confirm(title, body, danger, accept) { confirmation = { title, body, accept }; } };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const find = (selector) => document.querySelector('#invList ' + selector);
    seam.set(true, null); seam.renderInventory([entry]);
    t('inventory uses themed buttons', [...document.querySelectorAll('#invList button')].every((b) => b.classList.contains('btn')));
    t('inventory trash uses existing icon and theme', !!find('.inv-trash.btn.danger svg'));
    t('inventory has no three-dot menu', !find('.inv-more'));
    t('quantity save is initially hidden', find('.inv-qty-save').hidden);
    t('equipped toggle exposes pressed state', find('.inv-toggle').getAttribute('aria-pressed') === 'true');
    t('no duplicated quantity in item name', find('.inv-item-name').textContent === 'Travel cloak');
    find('.inv-item-name').click();
    t('item name opens read view', preview && preview.name === 'Travel cloak');
    const qty = find('.inv-qty'); qty.value = '4'; qty.dispatchEvent(new window.Event('input'));
    t('quantity save appears after editing', !find('.inv-qty-save').hidden);
    qty.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick();
    t('Enter saves quantity to inventory row', writes.length === 1 && writes[0].body.quantity === 4 && /INV-A\/inventory\/IR1$/.test(writes[0].path));
    const bad = find('.inv-qty'); bad.value = '0'; bad.dispatchEvent(new window.Event('input')); find('.inv-qty-save').click(); await tick();
    t('invalid quantity is not sent', writes.length === 1);
    bad.value = ''; find('.inv-qty-save').click(); await tick();
    t('empty quantity is not sent', writes.length === 1);
    bad.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    t('Escape restores quantity', bad.value === '3' && find('.inv-qty-save').hidden);
    find('.inv-toggle').click(); await tick();
    t('equipped toggles independently', writes[1].body.equipped === false && !('attuned' in writes[1].body));
    response = 409;
    document.querySelectorAll('#invList .inv-toggle')[1].click(); await tick();
    t('failed attunement shows inline error', !find('.inv-error').hidden && /limit/.test(find('.inv-error').textContent));
    t('failed toggle preserves recorded state', document.querySelectorAll('#invList .inv-toggle')[1].getAttribute('aria-pressed') === 'false');
    response = 200;
    find('.inv-trash').click();
    t('removal confirms entire stack', confirmation && /entire stack \(3\)/.test(confirmation.body));
    t('confirmation does not remove before acceptance', !writes.some((w) => w.method === 'DELETE'));
    confirmation.accept(); await tick();
    t('acceptance removes inventory entry', writes.some((w) => w.method === 'DELETE' && /inventory\/IR1$/.test(w.path)));
    seam.set(false, 'U1'); seam.renderInventory([entry]);
    t('owner can edit inventory', !!find('.inv-qty'));
    seam.set(false, 'U2'); seam.renderInventory([entry]);
    t('other players see no mutation controls', !find('input') && !find('.inv-toggle') && !find('.inv-trash'));
    t('read-only quantity and state remain visible', find('.inv-read-qty').textContent === 'Qty 3' && document.getElementById('invList').textContent.includes('Equipped'));
    t('read-only add button hidden', document.getElementById('addToBag').hidden);
    seam.set(false, 'U1', true); seam.renderInventory([entry]);
    t('NPC ownership does not bypass inventory gate', !find('.inv-qty'));
    seam.set(true, null); seam.renderInventory([{ ...entry, item: { ...entry.item, identified: false, name: 'Secret cloak', properties: { secret: true } } }]);
    find('.inv-item-name').click();
    t('unidentified preview preserves secrecy', preview.identified === false && !preview.name && !preview.properties.secret);
    window.fetch = originalFetch; window.VTTItemSheet.openPreview = originalPreview; window.VTTGame = originalGame;
  }


  console.log('\n--- spellbook tab and actions ---');
  {
    const seam = window.__inventoryTest;
    const entry = { spell_id: 'B1', prepared: false, source: 'class', spell: { id: 'B1', name: 'Light', level: 0, description: 'A gentle glow.', properties: { school: 'evocation' } } };
    const originalFetch = window.fetch, originalGame = window.VTTGame, originalPreview = window.VTTSpellSheet.openPreview;
    let entries = [entry], writes = [], response = 200, preview = null, confirm = null;
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    window.fetch = async (path, options = {}) => {
      if (options.method && options.method !== 'GET') {
        const body = options.body && JSON.parse(options.body);
        writes.push({ path, method: options.method, body });
        if (response === 200) {
          if (options.method === 'PATCH') entries = entries.map((e) => ({ ...e, ...body }));
          if (options.method === 'DELETE') entries = [];
          if (options.method === 'POST') entries.push({ spell_id: 'B2', prepared: false, source: body.source, spell: { id: 'B2', name: 'Shield', level: 1 } });
        }
        return { status: response === 200 && options.method === 'POST' ? 201 : response, json: async () => ({ error: 'Save refused' }) };
      }
      return { status: 200, json: async () => ({ spells: entries }) };
    };
    window.VTTGame = { confirm(title, body, danger, accept) { confirm = { body, accept }; } };
    window.VTTSpellSheet.openPreview = (spell) => { preview = spell; };
    seam.set(true, null); seam.renderSheet(); seam.seedBook(entries);
    const block = document.getElementById('sheetSpellbookBlock');
    t('spellbook controls mounted inside sheet tab', !!block.closest('.fo-page-spellbook'));
    t('spellbook controls keep exactly one instance', document.querySelectorAll('#sbSpell').length === 1);
    const bookTab = [...document.querySelectorAll('#sheetPanel .fo-tab')].find((b) => b.textContent === 'Spellbook');
    bookTab.click();
    t('spellbook tab opens', !block.closest('.fo-page-spellbook').hidden);
    seam.renderSheet();
    t('sheet refresh preserves Spellbook tab and live block', !block.closest('.fo-page-spellbook').hidden && document.getElementById('sheetSpellbookBlock') === block);
    t('already learned spell excluded from picker', [...document.getElementById('sbSpell').options].map((o) => o.value).join(',') === 'B2');
    t('spells grouped under Cantrip', /cantrip/i.test(document.querySelector('#sbList .spellbook-level').textContent));
    document.querySelector('#sbList .inv-item-name').click();
    t('spell name opens full read view', preview && preview.description === 'A gentle glow.');
    preview = null;
    document.querySelector('#sbList .spellbook-snippet').click();
    t('spell description opens full read view', preview && preview.id === 'B1');
    preview = null;
    document.querySelector('#sbList .spellbook-entry').click();
    t('spell row background opens full read view', preview && preview.id === 'B1');
    preview = null;
    document.querySelector('#sbList .spellbook-entry').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    t('spell row supports keyboard activation', preview && preview.id === 'B1');
    preview = null;
    t('spellbook trash uses existing icon and theme', !!document.querySelector('#sbList .inv-trash.btn.danger svg'));

    document.querySelector('#sbList .inv-toggle').click(); await tick();
    t('Prepared action does not open spell window', preview === null);
    t('Prepared toggle saves only prepared', writes[0].body.prepared === true && Object.keys(writes[0].body).length === 1);
    t('Prepared toggle reflects refreshed state', document.querySelector('#sbList .inv-toggle').getAttribute('aria-pressed') === 'true');
    document.getElementById('sbSource').value = 'race';
    await seam.learnSpell();
    t('learn uses existing API and source key', writes[1].method === 'POST' && writes[1].body.spell_id === 'B2' && writes[1].body.source === 'race');
    t('learning last available spell disables Learn', document.getElementById('learnSpell').disabled);
    response = 500;
    document.querySelector('#sbList .inv-toggle').click(); await tick();
    t('failed prepare keeps prior state', document.querySelector('#sbList .inv-toggle').getAttribute('aria-pressed') === 'true');
    t('failed mutation shows inline error', !block.querySelector('.spellbook-error').hidden && /Save refused/.test(block.querySelector('.spellbook-error').textContent));
    response = 200;
    document.querySelector('#sbList .inv-trash').click();
    t('trash action does not open spell window', preview === null);
    t('forget asks before DELETE', confirm && !writes.some((w) => w.method === 'DELETE'));
    t('forget wording distinguishes catalogue', /catalogue/.test(confirm.body));
    confirm.accept(); await tick();
    t('confirmed forget deletes from actor spellbook', writes.some((w) => w.method === 'DELETE' && /actors\/INV-A\/spells\/B1$/.test(w.path)));
    t('empty spellbook finishes loading', /No spells learned yet/.test(document.getElementById('sbList').textContent));
    t('forgotten spells return to learn picker', document.getElementById('sbSpell').options.length === 2);
    seam.set(false, 'U2'); seam.seedBook([entry]);
    t('read-only spellbook hides learn row', block.querySelector('.spellbook-learn-row').hidden);
    t('read-only spellbook has no mutation controls', !document.querySelector('#sbList .inv-toggle') && !document.querySelector('#sbList .inv-trash'));
    const before = writes.length; await seam.learnSpell();
    t('read-only calls cannot mutate', writes.length === before);
    seam.set(false, 'U1'); seam.seedBook([entry]);
    t('owning player can prepare spells', !!document.querySelector('#sbList .inv-toggle'));
    seam.set(false, 'U1', true); seam.seedBook([entry]);
    t('NPC spellbook authoring stays GM-only', !document.querySelector('#sbList .inv-toggle'));
    seam.renderSheet();
    t('projected NPC has no spellbook tab or exposed block', block.hidden && !document.querySelector('#sheetPanel .fo-page-spellbook'));
    seam.set(true, null);
    let resolvers = [];
    window.fetch = () => new Promise((resolve) => resolvers.push(resolve));
    const oldLoad = seam.loadSpellbook();
    const newLoad = seam.loadSpellbook();
    resolvers[1]({ status: 200, json: async () => ({ spells: [] }) }); await newLoad;
    resolvers[0]({ status: 200, json: async () => ({ spells: [entry] }) }); await oldLoad;
    t('older load cannot overwrite newer spellbook response', !document.querySelector('#sbList .spellbook-entry'));
    // Exercise the actual themed dropdown implementation, not the earlier editor stub.
    const previousCommon = window.VTTCommon;
    window.Element.prototype.scrollIntoView = function () {};
    window.eval(fs.readFileSync(rootPath('public/js/common.js'), 'utf8'));
    seam.set(true, null); seam.seedBook([entry]);
    t('learn picker uses a themed dropdown', document.getElementById('sbSpell').hidden && !!document.getElementById('sbSpell-button'));
    document.getElementById('sbSource-button').click();
    const sourceOptions = [...document.getElementById('sbSource-button').parentNode.querySelectorAll('[role="option"]')];
    sourceOptions.find((o) => o.textContent === 'Other').click();
    t('themed source picker updates API value', document.getElementById('sbSource').value === 'other');
    t('themed spell picker reflects available spell', document.getElementById('sbSpell-button').textContent.includes('Shield'));
    window.VTTCommon = previousCommon;
    window.fetch = originalFetch; window.VTTGame = originalGame; window.VTTSpellSheet.openPreview = originalPreview;
  }

  console.log('\n--- party roster ---');
  {
    const seam = window.__inventoryTest;
    const rows = [
      { id: 'P1', name: 'Party PC', user_id: 'U1', in_party: true, is_npc: false, hp_max: 10, hp_current: 10 },
      { id: 'N1', name: 'Party guide', user_id: null, in_party: true, is_npc: true, size: 'Medium' },
      { id: 'P2', name: 'Archived PC', user_id: 'U1', in_party: false, is_npc: false, hp_max: 10 },
      { id: 'N2', name: 'Map enemy', in_party: false, is_npc: true, size: 'Small' },
    ];
    seam.setRoster(false, rows);
    const list = document.getElementById('actorList');
    t('player roster includes own non-party characters plus party members', list.querySelectorAll('.char-card').length === 3 && list.textContent.includes('Archived PC') && !list.textContent.includes('Map enemy'));
    const playerChip = (label) => [...document.querySelectorAll('#charFilterParty button')].find((b) => b.textContent === label);
    playerChip('In party').click();
    t('player party filter excludes own non-party characters', list.querySelectorAll('.char-card').length === 2 && !list.textContent.includes('Archived PC'));
    t('player party filter includes party NPC', list.textContent.includes('Party guide'));
    t('player party filter is counted', document.getElementById('charFilterCount').textContent === '1');
    playerChip('All').click();
    t('party NPC stats remain absent', !list.querySelectorAll('.char-card')[1].querySelector('.char-vitals'));
    t('player cannot manage party', !list.querySelector('.char-party-toggle'));
    t('party filter is available to players', !document.getElementById('charFilterParty').hidden);
    seam.setRoster(false, rows.map((a) => ({ ...a, in_party: false })));
    t('own characters remain visible with an empty party', list.querySelectorAll('.char-card').length === 2 && list.textContent.includes('Archived PC'));
    seam.setRoster(false, []);
    t('empty roster has useful explanation', list.textContent.includes('Create your own character'));
    const fullRows = rows.map((a) => ({ ...a, hp_max: 10, hp_current: 10 }));
    seam.setRoster(true, fullRows);
    t('GM still sees full roster', list.querySelectorAll('.char-card').length === 4);
    t('GM can manage PCs and NPCs', list.querySelectorAll('.char-party-toggle').length === 4);
    const chip = (label) => [...document.querySelectorAll('#charFilterParty button')].find((b) => b.textContent === label);
    chip('In party').click();
    t('party filter narrows GM roster', list.querySelectorAll('.char-card').length === 2 && list.textContent.includes('Party guide'));
    t('party filter counts as active filter', document.getElementById('charFilterCount').textContent === '1');
    chip('Not in party').click();
    t('outside party filter excludes party', list.querySelectorAll('.char-card').length === 2 && list.textContent.includes('Archived PC'));
    chip('All').click();
    const originalFetch = window.fetch;
    let patch = null;
    window.fetch = async (path, options) => { patch = { path, body: JSON.parse(options.body) }; return { status: 500, json: async () => ({ error: 'Party update failed' }) }; };
    list.querySelector('.char-party-toggle').click();
    await new Promise((r) => setTimeout(r, 0));
    t('party action writes only membership', patch && patch.body.in_party === false && Object.keys(patch.body).length === 1);
    t('failed party action keeps recorded state and reports error', list.querySelector('.char-party-toggle').getAttribute('aria-pressed') === 'true' && !!list.querySelector('.char-party-error'));
    window.fetch = originalFetch;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
