// Combat harness smoke suite. jsdom only — no server and no database:
//   node test-combat-ui.js
//
// Loads the REAL public/combat.html + public/js/combat.js, the same way
// test-fog-ui.js loads scene.html + scene.js.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS — a defect it would have caught
// ---------------------------------------------------------------------------
// On 2026-08-03 an edit to combat.js deleted `renderWhisperTargets()` while
// rewriting the function above it. The function was still CALLED in two places,
// so `loadCampaign()` threw a ReferenceError on its first run and the whole page
// died at once: no roster, no chat, no dice.
//
// Nothing caught it. `node --check` passes, because a missing function is a
// RUNTIME error and not a syntax error. The eight no-DB suites never load
// combat.js — they cover scene.js and the actor sheet. The two DB suites drive
// the HTTP API and never open a browser. So an 800-line client file that is the
// only way to actually use M5 had ZERO runtime coverage, and the first thing to
// notice was a person opening the page.
//
// This suite closes exactly that gap and nothing more. It is deliberately a
// SMOKE test, not a behavioural one: it asserts that the file loads, that every
// function it calls exists, that the elements its handlers bind to are present
// in the markup, and that the main entry points run without throwing. Detailed
// behaviour stays in test-combat.js and break-combat.js, which drive the real
// server.
//
// The narrow scope is the point. A wide client suite here would duplicate the
// server suites and rot; this one answers a single question — "is the page
// wired up?" — which is the question that was silently answered "no".

const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM(fs.readFileSync('public/combat.html', 'utf8'), {
  runScripts: 'outside-only',
  url: 'http://localhost:3000/combat.html?campaign=11111111-1111-4111-8111-111111111111',
});
const { window } = dom;
const { document } = window;

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// ---- stubs -----------------------------------------------------------------
const calls = [];
window.__calls = calls;
window.io = () => ({ on() {}, emit(ev, payload, ack) { if (ack) ack({ ok: true }); } });
window.fetch = async (path, opts = {}) => {
  calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  const json = async () => {
    if (path === '/api/auth/me') return { user: { id: 'U1', username: 'gm' } };
    if (/\/messages/.test(path)) return { messages: [] };
    if (/\/combat\/[^/]+$/.test(path)) {
      // A running encounter with one combatant, so the roster actually renders.
      // The drag probes at the end need a real card built by the real renderer
      // — asserting on one this file assembled by hand would prove nothing
      // about the card a person drags.
      return {
        combat: { id: 'CB1', scene_id: 'S1', active: true, name: 'Fight' },
        combatants: [{
          id: 'C1', combat_id: 'CB1', token_id: 'T1', sort_order: 0,
          hp_override: 7, hp_visible: true,
        }],
        actors: [],
      };
    }
    // loadCombat reads the LIST first and filters by scene_id, so an empty list
    // here means the detail stub below is never reached and the roster stays
    // empty — which is exactly how the first version of the drag probes failed.
    if (/\/combat$/.test(path)) {
      return { combats: [{ id: 'CB1', scene_id: 'S1', active: true, name: 'Fight' }] };
    }
    // Characters offered in the "speaking as" picker. The server re-checks
    // ownership on every message; this list is convenience, not authority.
    if (/\/actors$/.test(path)) {
      return {
        actors: [
          { id: 'A1', name: 'Aria', user_id: 'U2', is_npc: false },
          { id: 'A2', name: 'Goblin', user_id: null, is_npc: true },
        ],
      };
    }
    if (/\/scenes\/[^/]+$/.test(path)) {
      return {
        scene: { id: 'S1', name: 'Board', width: 1000, height: 800, grid: {} },
        tokens: [{
          id: 'T1', name: 'Goblin', img_url: 'https://x/g.png',
          actor_id: null, x: 1, y: 1, width: 1, height: 1, hidden: false,
        }],
        fog: [],
        actors: [],
      };
    }
    if (/\/scenes$/.test(path)) return { scenes: [{ id: 'S1', name: 'Board' }] };
    // Campaign detail — the endpoint that carries member colours.
    return {
      campaign: { id: 'C1', name: 'Test', is_gm: true, active_scene_id: 'S1' },
      members: [
        { user_id: 'U1', username: 'gm', color: '#3366cc', is_gm: true },
        { user_id: 'U2', username: 'aria', color: null, is_gm: false },
      ],
    };
  };
  return { status: 200, json };
};
window.PointerEvent = class extends window.MouseEvent {
  constructor(ty, o = {}) { super(ty, o); this.pointerId = o.pointerId || 1; }
};
window.Element.prototype.setPointerCapture = function set() {};
window.Element.prototype.releasePointerCapture = function rel() {};

// The 3D module is an ES module the browser loads separately; jsdom does not run
// it. Stub the global bridge it would have set, so the colour join has something
// to call — and so a missing method here fails loudly rather than silently
// producing grey dice.
window.VTTDice = {
  initDice: async () => {},
  showRoll: () => true,
  notationFor: () => null,
  setColorset: () => {},
  clearDice: () => {},
  colorsets: () => ['white', 'fire'],
  isRenderable: () => true,
  setInteractive: () => {},
  setFadeSeconds: () => {},
  nearestWithin: () => -1,
  normalizeHex: (h) => (typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : null),
  stableColorFor: () => '#aabbcc',
  contrastFor: () => '#000000',
  shade: () => '#112233',
  colorsetFor: () => ({}),
};

// ---- load ------------------------------------------------------------------
let loadError = null;
try {
  window.eval(fs.readFileSync('public/js/combat.js', 'utf8'));
} catch (err) {
  loadError = err;
}

console.log('\n--- the file loads at all ---');
t('combat.js evaluates without throwing', loadError === null,
  loadError && `${loadError.name}: ${loadError.message}`);
if (loadError) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

console.log('\n--- every element the handlers bind to exists in the markup ---');
// A getElementById that returns null makes addEventListener throw at load time,
// which is the other half of the same failure class: markup and script drifting
// apart. Asserted by id so renaming one without the other is caught.
const REQUIRED_IDS = [
  'whoami', 'campaignId', 'loadCampaign', 'campaignInfo',
  'sceneSel', 'combatName', 'startCombat', 'endCombat', 'deleteCombat', 'combatInfo',
  'strip', 'scrollLeft', 'scrollRight', 'rosterInfo', 'selected',
  'tokens', 'tokName', 'tokProp', 'placeToken',
  'chat', 'chatText', 'sendChat', 'diceFormula', 'diceLabel', 'sendRoll',
  'whisperTo', 'out', 'log', 'clearLog', 'diceTray',
  'dice3d', 'diceColor', 'diceClear', 'diceGrab', 'diceLegend', 'diceFade',
  'trayMod', 'trayPool', 'trayRoll', 'trayClear',
  'speakAs', 'palette', 'paletteMsg',
];
for (const id of REQUIRED_IDS) {
  t(`#${id} is present`, document.getElementById(id) !== null);
}
t('quick-roll buttons exist', document.querySelectorAll('.quick').length >= 7);
t('every quick button carries a sides value',
  [...document.querySelectorAll('.quick')].every((b) => Number(b.dataset.sides) > 0));

console.log('\n--- the entry points run without throwing ---');
// This is the probe that would have caught the deleted function: loadCampaign
// calls loadMembers, which called renderWhisperTargets.
(async () => {
  let runError = null;
  try {
    await window.loadCampaign();
  } catch (err) {
    runError = err;
  }
  t('loadCampaign() completes', runError === null,
    runError && `${runError.name}: ${runError.message}`);

  t('it fetched the campaign detail endpoint (member colours live there)',
    calls.some((c) => /\/api\/campaigns\/[^/]+$/.test(c.path) && c.method === 'GET'));
  t('it did NOT use manage-players (requireOwner — empty for a player)',
    !calls.some((c) => /manage-players/.test(c.path)),
    'that endpoint is GM-only, which is why the member list was empty for players');

  console.log('\n--- the colour join produced something usable ---');
  const legend = document.getElementById('diceLegend');
  t('the legend was rendered', legend.textContent !== '—' && legend.children.length >= 2,
    legend.textContent);
  t('a member WITH a colour keeps it',
    [...legend.querySelectorAll('i')].some((i) => /51,\s*102,\s*204|#3366cc/.test(i.style.background)),
    [...legend.querySelectorAll('i')].map((i) => i.style.background).join(' | '));
  t('a member WITHOUT one still gets a colour (the common case)',
    [...legend.querySelectorAll('i')].every((i) => !!i.style.background));

  console.log('\n--- the whisper list is populated for the caller ---');
  const sel = document.getElementById('whisperTo');
  t('whisper targets rendered', sel.options.length >= 1, `${sel.options.length} options`);
  t('the caller is not offered as their own whisper target',
    ![...sel.options].some((o) => o.value === 'U1'));

  console.log('\n--- speaking as: the picker, and the local default ---');
  const spk = document.getElementById('speakAs');
  t('the picker offers "myself" first', spk.options.length > 0 && spk.options[0].value === '');
  t('a GM is offered every character including NPCs',
    [...spk.options].some((o) => o.textContent.includes('Goblin (NPC)')),
    [...spk.options].map((o) => o.textContent).join(' | '));
  t('and a player character', [...spk.options].some((o) => o.textContent === 'Aria'));

  console.log('\n--- the colour palette shows what is claimed ---');
  const pal = document.getElementById('palette');
  t('a swatch is rendered for every palette colour', pal.children.length === 16,
    `${pal.children.length}`);
  // U1 (the caller) holds #3366cc, which is NOT in the palette, so nothing is
  // "mine"; U2 holds no colour at all, so nothing is taken either.
  t('a colour nobody claimed is clickable',
    [...pal.children].every((b) => !b.disabled),
    'no member holds a palette colour in this fixture');
  t('a generated fallback colour does NOT grey out a swatch',
    [...pal.children].filter((b) => b.classList.contains('taken')).length === 0,
    'only an ASSIGNED colour is a claim');

  console.log('\n--- the dice tray builds a formula ---');
  const click = (elm) => elm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const byDie = (n) => [...document.querySelectorAll('.quick')].find((b) => b.dataset.sides === String(n));
  click(byDie(20));
  click(byDie(6));
  click(byDie(6));
  const poolText = document.getElementById('trayPool').textContent;
  t('clicking d20 then d6 twice reads as 1d20 + 2d6',
    /1d20/.test(poolText) && /2d6/.test(poolText), poolText);
  t('the pool shows the formula it will send', /1d20\+2d6/.test(poolText), poolText);

  document.getElementById('trayMod').value = '3';
  document.getElementById('trayMod').dispatchEvent(new window.Event('input'));
  t('a modifier joins the formula', /1d20\+2d6\+3/.test(document.getElementById('trayPool').textContent),
    document.getElementById('trayPool').textContent);

  click(document.getElementById('trayClear'));
  t('clear empties the pool', /empty/.test(document.getElementById('trayPool').textContent));

  console.log('\n--- dragging a combatant card (2026-08-10) ---');
  //
  // Reported: dragging a card by its PORTRAIT showed a floating picture, while
  // dragging it anywhere else showed the whole card. An <img> is natively
  // draggable, so grabbing one made the image the drag source — the same
  // gesture producing two different pieces of feedback depending on which pixel
  // was under the pointer.
  //
  // Driven through the real renderer rather than by hand: the roster is built
  // from combat/combatants/tokens, and asserting on a card this file assembled
  // itself would prove nothing about the one a user drags.
  // Driven through the loaders, not by assignment: combat.js holds its state in
  // `let` bindings, which are not reachable from outside the evaluated script.
  // Feeding the fetch stub is also the more honest route — it exercises the
  // path a real page takes.
  await window.loadScene();
  await window.loadCombat();

  const card = document.querySelector('#strip .card, #strip [data-id]');
  t('a combatant card is rendered', !!card, document.getElementById('strip').textContent.slice(0, 60));
  t('...and is draggable for a GM', !!card && card.draggable === true);

  const portrait = card && card.querySelector('img');
  t('the card carries a portrait', !!portrait);
  t('...which is NOT independently draggable',
    portrait && portrait.draggable === false,
    portrait && String(portrait.draggable));

  // The explicit ghost. Recorded rather than stubbed away, so the probe can
  // assert WHICH element the browser was told to draw — passing the portrait
  // here would reproduce the bug with the fix apparently in place.
  const seen = [];
  const dt = {
    effectAllowed: '',
    setData() {},
    setDragImage(el2, x, y) { seen.push({ el: el2, x, y }); },
  };
  const ev = new window.Event('dragstart', { bubbles: true });
  ev.dataTransfer = dt;
  ev.clientX = 40; ev.clientY = 30;
  card.dispatchEvent(ev);

  t('dragstart sets an explicit drag image', seen.length === 1, String(seen.length));
  t('...and it is the whole CARD, not the portrait',
    seen[0] && seen[0].el === card,
    seen[0] && (seen[0].el === portrait ? 'portrait' : seen[0].el.tagName));
  t('...offset so the card stays under the cursor where it was grabbed',
    seen[0] && Number.isFinite(seen[0].x) && Number.isFinite(seen[0].y),
    seen[0] && `${seen[0].x},${seen[0].y}`);

  // A drag started from the portrait must produce the same ghost: the event
  // bubbles to the card, and the card is what gets drawn.
  seen.length = 0;
  const ev2 = new window.Event('dragstart', { bubbles: true });
  ev2.dataTransfer = dt;
  ev2.clientX = 12; ev2.clientY = 12;
  portrait.dispatchEvent(ev2);
  t('grabbing the PORTRAIT still drags the whole card',
    seen.length === 1 && seen[0].el === card,
    seen[0] && (seen[0].el === portrait ? 'portrait' : 'card'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
