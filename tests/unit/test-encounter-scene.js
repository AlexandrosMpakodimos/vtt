const { rootPath } = require('../helpers/paths');
// The Encounter button acts on the scene that is ON SCREEN.
//
//   node tests/unit/test-encounter-scene.js
//
// combat.js used to choose its scene once, when the page loaded: the active scene,
// or the first one. A GM who then activated or opened another map and pressed
// Encounter started the fight on the PREVIOUS scene, where players (who only ever
// see the active scene) saw nothing. The canvas now announces every scene it
// opens or closes with a vtt:scene-opened event, and combat.js follows it.
//
// Loads the real combat.js against the combat fixture with a stubbed API that
// records every request, so the probes read the scene_id the create request
// actually carried.

const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM(fs.readFileSync(rootPath('tests/fixtures/pages/combat.html'), 'utf8'), {
  runScripts: 'outside-only',
  url: 'http://localhost:3000/combat.html',
});
const { window } = dom;

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// Two scenes: S1 is active, S2 is another map. No encounter exists anywhere
// until the test creates one.
const calls = [];
const combats = [];
window.io = () => ({ on() {}, emit(ev, payload, ack) { if (ack) ack({ ok: true }); } });
window.fetch = async (path, opts = {}) => {
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ path, method, body });
  let status = 200;
  let data;
  if (path === '/api/auth/me') data = { user: { id: 'U1', username: 'gm' } };
  else if (/\/messages/.test(path)) data = { messages: [] };
  else if (/\/actors$/.test(path)) data = { actors: [] };
  else if (/\/combat$/.test(path) && method === 'POST') {
    const row = { id: `CB${combats.length + 1}`, scene_id: body.scene_id, active: true, name: null, round: 1, turn_index: 0 };
    combats.push(row);
    status = 201; data = { combat: row, combatants: [] };
  } else if (/\/combat$/.test(path)) data = { combats: combats.slice() };
  else if (/\/combat\/[^/]+$/.test(path)) {
    const row = combats.find((c) => path.endsWith(`/${c.id}`));
    data = row ? { combat: row, combatants: [], actors: [] } : { error: 'not found' };
    if (!row) status = 404;
  } else if (/\/scenes\/[^/]+$/.test(path)) {
    const id = path.split('/').pop();
    data = { scene: { id, name: id, width: 1000, height: 800, grid: {} }, tokens: [], fog: [], actors: [] };
  } else if (/\/scenes$/.test(path)) data = { scenes: [{ id: 'S1', name: 'Tavern' }, { id: 'S2', name: 'Forest' }] };
  else {
    data = {
      campaign: { id: 'C1', name: 'Test', is_gm: true, active_scene_id: 'S1' },
      members: [{ user_id: 'U1', username: 'gm', color: null, is_gm: true }],
    };
  }
  return { status, json: async () => data };
};
window.PointerEvent = class extends window.MouseEvent {
  constructor(ty, o = {}) { super(ty, o); this.pointerId = o.pointerId || 1; }
};
window.Element.prototype.setPointerCapture = function set() {};
window.Element.prototype.releasePointerCapture = function rel() {};
window.Element.prototype.scrollIntoView = function () {};
window.VTTDice = {
  initDice: async () => {}, showRoll: () => true, notationFor: () => null, setColorset: () => {},
  clearDice: () => {}, colorsets: () => ['white'], isRenderable: () => true, setInteractive: () => {},
  setFadeSeconds: () => {}, nearestWithin: () => -1, normalizeHex: () => null,
  stableColorFor: () => '#aabbcc', contrastFor: () => '#000000', shade: () => '#112233', colorsetFor: () => ({}),
};

window.eval(fs.readFileSync(rootPath('client/js/ui/imageframe.js'), 'utf8'));
window.eval(fs.readFileSync(rootPath('client/js/shared/common.js'), 'utf8') + '\n'
  + fs.readFileSync(rootPath('client/js/game/combat.js'), 'utf8'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const announce = (sceneId) => window.dispatchEvent(new window.CustomEvent('vtt:scene-opened', { detail: { sceneId } }));
const creates = () => calls.filter((c) => c.method === 'POST' && /\/combat$/.test(c.path));

(async () => {
  // The canvas boots in parallel and may report its scene before combat.js has
  // loaded the campaign. That report must not be lost.
  announce('S2');
  await window.VTTCombat.boot('C1');
  await wait(50);
  await window.VTTCombat.toggleEncounter();
  const first = creates();
  t('a scene reported before the campaign loaded is the one the encounter uses',
    first.length === 1 && first[0].body.scene_id === 'S2', JSON.stringify(first.map((c) => c.body)));

  // The GM activates (or simply opens) the Tavern without reloading. Before the
  // fix this pressed Encounter on the Forest again and ENDED that fight.
  announce('S1');
  await wait(50);
  await window.VTTCombat.toggleEncounter();
  const second = creates();
  t('after switching maps, Encounter starts a fight on the scene on screen, not a toggle of the other one',
    second.length === 2 && second[1].body.scene_id === 'S1', JSON.stringify(second.map((c) => c.body)));

  // The canvas closed the scene: there is nothing to start a fight on.
  announce(null);
  await wait(50);
  const before = creates().length;
  await window.VTTCombat.toggleEncounter();
  t('with no scene on screen the Encounter button creates nothing', creates().length === before);

  // Re-announcing the scene already followed does not reload anything.
  announce('S2');
  await wait(50);
  const n = calls.length;
  announce('S2');
  await wait(50);
  t('announcing the same scene again makes no requests', calls.length === n, `${calls.length - n} extra`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`  FAIL  crashed: ${e && e.stack}`); process.exit(1); });
