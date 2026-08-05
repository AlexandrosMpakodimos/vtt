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
    if (/\/items$/.test(path)) return { items: [] };
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
  'frameModal', 'frameStage', 'frameArt', 'frameScale', 'frameX', 'frameY',
  'frameReset', 'frameCancel', 'frameSave', 'frameMsg',
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

  console.log('\n--- the modal loads the saved framing ---');
  const frameBtn = [...cards[0].querySelectorAll('button')].find((b) => b.textContent === 'frame picture');
  frameBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('the modal opens', document.getElementById('frameModal').classList.contains('on'));
  t('scale loaded', document.getElementById('frameScale').value === '1.4',
    document.getElementById('frameScale').value);
  t('offset x loaded', document.getElementById('frameX').value === '0.25');
  t('offset y loaded', document.getElementById('frameY').value === '-0.1');
  t('the art carries the picture',
    /aria\.png/.test(document.getElementById('frameArt').style.backgroundImage));

  console.log('\n--- the transform matches what scene.js will draw ---');
  // scene.js writes `translate(ox*100%, oy*100%) scale(s)`. If the preview used
  // a different order or unit it would agree by coincidence at the identity and
  // disagree everywhere else.
  const tf = document.getElementById('frameArt').style.transform;
  t('translate comes first, in PERCENT', /^translate\(25%, -10%\)/.test(tf), tf);
  t('...and scale second', /scale\(1\.4\)$/.test(tf), tf);

  console.log('\n--- dragging moves by a FRACTION of the frame ---');
  const stage = document.getElementById('frameStage');
  stage.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: 0, clientY: 0, bubbles: true }));
  stage.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 55, clientY: 0, bubbles: true }));
  stage.dispatchEvent(new window.PointerEvent('pointerup', { clientX: 55, clientY: 0, bubbles: true }));
  // 55px across a 220px stage is a quarter of the frame: 0.25 + 0.25 = 0.5
  t('55px on a 220px stage is 0.25 of the frame',
    Math.abs(Number(document.getElementById('frameX').value) - 0.5) < 0.001,
    document.getElementById('frameX').value);
  t('the other axis is untouched',
    Math.abs(Number(document.getElementById('frameY').value) + 0.1) < 0.001);

  console.log('\n--- bounds match the server, so the preview cannot show a refused crop ---');
  const scaleIn = document.getElementById('frameScale');
  scaleIn.value = '99';
  scaleIn.dispatchEvent(new window.Event('input'));
  t('zoom is clamped to 5', Number(scaleIn.value) === 5, scaleIn.value);
  scaleIn.value = '0';
  scaleIn.dispatchEvent(new window.Event('input'));
  t('...and to 0.1', Number(scaleIn.value) === 0.1, scaleIn.value);
  const xIn = document.getElementById('frameX');
  xIn.value = '9';
  xIn.dispatchEvent(new window.Event('input'));
  t('offset is clamped to 2', Number(xIn.value) === 2, xIn.value);

  console.log('\n--- reset, cancel, save ---');
  document.getElementById('frameReset').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('reset returns the identity transform',
    document.getElementById('frameScale').value === '1'
      && document.getElementById('frameX').value === '0'
      && document.getElementById('frameY').value === '0');

  const before = calls.filter((c) => c.method === 'PATCH').length;
  document.getElementById('frameSave').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const patch = calls.filter((c) => c.method === 'PATCH').pop();
  t('a PATCH was issued', calls.filter((c) => c.method === 'PATCH').length === before + 1);
  t('...to the character, not the token', /\/actors\/A1$/.test(patch.path), patch.path);
  t('...carrying exactly the three framing fields',
    Object.keys(patch.body).sort().join(',') === 'img_offset_x,img_offset_y,img_scale',
    Object.keys(patch.body).join(','));
  t('...and nothing else, so it cannot touch hp or a stat',
    !('hp_current' in patch.body) && !('name' in patch.body));
  t('the modal closes after saving',
    !document.getElementById('frameModal').classList.contains('on'));

  frameBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.getElementById('frameCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('cancel closes without a further PATCH',
    !document.getElementById('frameModal').classList.contains('on')
      && calls.filter((c) => c.method === 'PATCH').length === before + 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
