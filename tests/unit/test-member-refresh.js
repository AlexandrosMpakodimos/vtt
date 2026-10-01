const { rootPath } = require('../helpers/paths');
// The game page's member list stays current without a reload.
//
//   node tests/unit/test-member-refresh.js
//
// Found in the production QA pass (2026-09-30): someone who joined the campaign
// after the page loaded had no name, colour or whisper entry until a reload.
// combat.js now re-reads the member list when an unknown user arrives at the
// table or speaks, and on member:updated (sent for joins, leaves, kicks and
// profile changes). A user it already knows triggers nothing.

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
const handlers = {};
window.io = () => ({ on(ev, fn) { handlers[ev] = fn; }, emit(ev, payload, ack) { if (ack) ack({ ok: true }); } });
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
const memberReads = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/campaigns/C1').length;

(async () => {
  await window.VTTCombat.boot('C1');
  await wait(50);
  t('the game page listens for member:updated, user-joined and message:created',
    ['member:updated', 'campaign:user-joined', 'message:created'].every((e) => typeof handlers[e] === 'function'));

  let n = memberReads();
  handlers['campaign:user-joined']({ campaign_id: 'C1', user_id: 'U1' });
  await wait(30);
  t('a known member arriving at the table re-reads nothing', memberReads() === n, `${memberReads() - n} reads`);

  n = memberReads();
  handlers['campaign:user-joined']({ campaign_id: 'C1', user_id: 'NEW' });
  await wait(30);
  t('an unknown user arriving at the table re-reads the member list', memberReads() === n + 1, `${memberReads() - n} reads`);

  n = memberReads();
  handlers['campaign:user-joined']({ campaign_id: 'OTHER', user_id: 'NEW2' });
  await wait(30);
  t('an event for another campaign is ignored', memberReads() === n);

  n = memberReads();
  handlers['message:created']({ id: 'M1', user_id: 'STRANGER', speaker_name: 'Stranger', body: 'hi', created_at: new Date().toISOString() });
  await wait(30);
  t('a message from an unknown sender re-reads the member list', memberReads() === n + 1, `${memberReads() - n} reads`);

  n = memberReads();
  handlers['member:updated']({ campaign_id: 'C1', user_id: 'U1' });
  await wait(30);
  t('member:updated (join, leave, kick, profile change) re-reads the member list', memberReads() === n + 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`  FAIL  crashed: ${e && e.stack}`); process.exit(1); });
