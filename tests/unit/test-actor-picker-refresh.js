const { rootPath } = require('../helpers/paths');
// Headless DOM tests for the placement character picker staying current.
//
// The picker is loaded with the scene. A character created, renamed, reassigned
// or deleted afterwards used to stay invisible (or stay listed) until the page
// was reloaded, although the server already announces those changes over the
// socket. These probes drive the real scene.js with captured socket handlers
// and count the /actors re-reads: a change the picker can show causes exactly
// one re-read (a burst shares it), and a stat-only update causes none.
const { JSDOM } = require('jsdom'); const fs = require('fs');
const dom = new JSDOM(fs.readFileSync(rootPath('tests/fixtures/pages/scene.html'), 'utf8'), { runScripts: 'outside-only', url: 'http://localhost:3000/scene.html' });
const { window } = dom;

// The /actors endpoint returns whatever the test says the server holds now.
window.__actors = [];
window.__uid = 'GM';
window.__actorReads = 0;
window.fetch = async (path) => {
  if (String(path).slice(-7) === '/actors') window.__actorReads += 1;
  const scene = { id: String(path).split('/').pop(), name: 'Board', width: 1000, height: 800, img_url: null, grid: {} };
  return { status: 200, json: async () => ({ user: { id: window.__uid }, scene, tokens: [], fog: [], actors: window.__actors.slice() }) };
};
// Capture the handlers scene.js registers, so the test can deliver events.
window.__handlers = {};
window.io = () => ({ on(ev, fn) { window.__handlers[ev] = fn; }, emit(ev, p, cb) { if (cb) cb({ ok: true }); } });
window.CSS = { escape: (s) => s };
window.PointerEvent = class extends window.MouseEvent { constructor(t, o = {}) { super(t, o); this.pointerId = o.pointerId || 1; } };
window.Element.prototype.setPointerCapture = function () {}; window.Element.prototype.releasePointerCapture = function () {};
window.Element.prototype.scrollIntoView = function () {};
let pass = 0; let fail = 0;
window.__check = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '  ' + d); } };
window.__done = () => { console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail === 0 ? 0 : 1); };

window.eval(fs.readFileSync(rootPath('public/js/shared/common.js'), 'utf8') + '\n' + fs.readFileSync(rootPath('public/js/game/scene.js'), 'utf8') + `
;(async function(){
  const h = window.__handlers;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = () => wait(400);                     // longer than the 250 ms coalescing window
  const asUser = (id) => { me = { id }; window.__uid = id; };
  const labels = () => {
    const btn = document.getElementById('tok-actorBtn');
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const out = [...document.querySelectorAll('#tokActorDD .vtt-dd-opt')].map((li) => li.textContent);
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    return out;
  };
  const reads = async (fn) => { await settle(); const before = window.__actorReads; await fn(); await settle(); return window.__actorReads - before; };

  campaignId = 'C'; currentCampaignOwnerId = 'GM'; asUser('GM');
  scene = { id: 'S', width: 1000, height: 800, img_url: null };
  window.__actors = [
    { id: 'PA1', name: 'Aria', user_id: 'P1', is_npc: false },
    { id: 'NPC1', name: 'Goblin', user_id: 'GM', is_npc: true },
  ];
  await loadActorPicker();
  await settle();

  __check('scene.js listens for actor:updated and actor:deleted',
    typeof h['actor:updated'] === 'function' && typeof h['actor:deleted'] === 'function');

  // --- GM ---------------------------------------------------------------------
  window.__actors.push({ id: 'PA2', name: 'Bram', user_id: 'P2', is_npc: false });
  let n = await reads(() => h['actor:updated']({ id: 'PA2', name: 'Bram', user_id: 'P2', is_npc: false }));
  __check('GM: a newly created character causes one re-read', n === 1, 'reads=' + n);
  __check('...and appears in the picker without a reload', labels().includes('Bram'), labels().join(' | '));

  n = await reads(() => h['actor:updated']({ id: 'PA1', name: 'Aria', user_id: 'P1', is_npc: false, hp: 3 }));
  __check('GM: a stat-only update (hit points) causes no re-read', n === 0, 'reads=' + n);

  for (const x of ['X1', 'X2', 'X3']) window.__actors.push({ id: x, name: 'Wolf ' + x, user_id: 'GM', is_npc: true });
  n = await reads(async () => {
    for (const x of ['X1', 'X2', 'X3']) h['actor:updated']({ id: x, name: 'Wolf ' + x, user_id: 'GM', is_npc: true });
  });
  __check('GM: a burst of three new characters shares ONE re-read', n === 1, 'reads=' + n);

  window.__actors[0] = { id: 'PA1', name: 'Aria the Bold', user_id: 'P1', is_npc: false };
  n = await reads(() => h['actor:updated'](window.__actors[0]));
  __check('GM: a rename causes one re-read', n === 1, 'reads=' + n);
  __check('...and the picker shows the new name', labels().includes('Aria the Bold') && !labels().includes('Aria'), labels().join(' | '));

  window.__actors = window.__actors.filter((a) => a.id !== 'PA2');
  n = await reads(() => h['actor:deleted']({ id: 'PA2' }));
  __check('GM: deleting a listed character causes one re-read', n === 1, 'reads=' + n);
  __check('...and it leaves the picker', !labels().includes('Bram'), labels().join(' | '));

  n = await reads(() => h['actor:deleted']({ id: 'NOT-LISTED' }));
  __check('a deletion of something not in the picker causes no re-read', n === 0, 'reads=' + n);

  // --- player ----------------------------------------------------------------
  asUser('P1');
  window.__actors = [
    { id: 'PA1', name: 'Aria the Bold', user_id: 'P1', is_npc: false },
    { id: 'PA3', name: 'Cato', user_id: 'P3', is_npc: false },
  ];
  await loadActorPicker();
  await settle();
  __check('player: the picker lists only their own character',
    labels().includes('Aria the Bold') && !labels().includes('Cato'), labels().join(' | '));

  n = await reads(() => h['actor:updated']({ id: 'PA3', name: 'Cato II', user_id: 'P3', is_npc: false }));
  __check("player: another player's character changing causes no re-read", n === 0, 'reads=' + n);

  window.__actors.push({ id: 'PA4', name: 'Dara', user_id: 'P1', is_npc: false });
  n = await reads(() => h['actor:updated']({ id: 'PA4', name: 'Dara', user_id: 'P1', is_npc: false }));
  __check('player: their own new character causes one re-read', n === 1, 'reads=' + n);
  __check('...and appears in their picker', labels().includes('Dara'), labels().join(' | '));

  window.__actors = window.__actors.map((a) => (a.id === 'PA4' ? { ...a, user_id: 'P3' } : a));
  n = await reads(() => h['actor:updated']({ id: 'PA4', name: 'Dara', user_id: 'P3', is_npc: false }));
  __check('player: a character reassigned away causes one re-read', n === 1, 'reads=' + n);
  __check('...and leaves their picker', !labels().includes('Dara'), labels().join(' | '));

  // --- the canvas announces the scene on screen (combat.js follows it) ----------
  {
    const seen = [];
    window.addEventListener('vtt:scene-opened', (e) => seen.push(e.detail.sceneId));
    await openScene('S2');
    __check('opening a scene announces it', seen[seen.length - 1] === 'S2', JSON.stringify(seen));
    __check('VTTScene.currentSceneId reports the scene on screen', window.VTTScene.currentSceneId() === 'S2');
    closeScene('closed');
    __check('closing the scene announces null', seen[seen.length - 1] === null, JSON.stringify(seen));
    __check('...and currentSceneId is null', window.VTTScene.currentSceneId() === null);
    await openScene('S');
  }

  // --- no scene open ----------------------------------------------------------
  asUser('GM');
  scene = null;
  n = await reads(() => h['actor:deleted']({ id: 'PA1' }));
  __check('with no scene open nothing is re-read', n === 0, 'reads=' + n);

  __done();
})().catch((e) => { __check('probe crashed', false, e && e.stack); __done(); });
`);
