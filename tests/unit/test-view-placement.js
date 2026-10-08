const { rootPath } = require('../helpers/paths');
// Fix 8 (2026-10-07): the game map's view and token placement.
//   A. the pan clamp: the map may go far past its edges until 15% of the visible
//      canvas still shows it, at every zoom, and is never lost
//   B. focus pings still centre the pinged point (FOCUS_ZOOM unchanged)
//   C. wheel zoom: at most one step per display frame, same end zoom and limits
//   D. Safari: no fog mask is painted on a scene with nothing covered
//   E. placement: Place arms ghosts that follow the pointer; a click places with
//      the same requests as before; Esc / right-click cancel; errors clean up
const { JSDOM } = require('jsdom'); const fs = require('fs');
const dom = new JSDOM(fs.readFileSync(rootPath('tests/fixtures/pages/scene.html'), 'utf8'), { runScripts: 'outside-only', url: 'http://localhost:3000/scene.html' });
const { window } = dom; const { document } = window;

const calls = [];
window.__uid = 'GM';
window.__fail = null;     // null | number (HTTP status) | 'throw'
let nextId = 0;
window.fetch = async (path, opts) => {
  const method = (opts && opts.method) || 'GET';
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  calls.push({ path, method, body });
  const reply = (status, data) => ({ status, json: async () => data });
  if (path === '/api/auth/me') return reply(200, { user: { id: window.__uid } });
  if (path.endsWith('/actors')) {
    return reply(200, { actors: [
      { id: 'A1', name: 'Ogre', user_id: 'GM', is_npc: true, size: 'large', img_url: 'https://ex/ogre.png', img_offset_x: 0, img_offset_y: 0, img_scale: 1 },
      { id: 'A2', name: 'Aria', user_id: 'OTHER', is_npc: false, size: 'medium', img_url: null },
    ] });
  }
  if (method === 'POST' && /\/tokens(\/copy)?$/.test(path)) {
    if (window.__fail === 'throw') { window.__fail = null; throw new Error('network down'); }
    if (typeof window.__fail === 'number') { const s = window.__fail; window.__fail = null; return reply(s, { error: 'refused' }); }
    const specs = path.endsWith('/copy') ? body.tokens : [body];
    const rows = specs.map((s) => ({ id: 'N' + (++nextId), scene_id: 'S', created_by: window.__uid, actor_id: s.actor_id || null,
      name: s.name || '', img_url: s.img_url || null, x: s.x, y: s.y, width: s.width || 1, height: s.height || 1, hidden: false, locked: false }));
    return path.endsWith('/copy') ? reply(201, { tokens: rows }) : reply(201, { token: rows[0], actor: null });
  }
  return reply(200, {});
};
window.__emits = [];
window.io = () => ({ on() {}, emit(ev, p, cb) { window.__emits.push({ ev, p }); if (cb) cb({ ok: true }); } });
window.CSS = { escape: (s) => s };
window.PointerEvent = class extends window.MouseEvent {
  constructor(t, o = {}) { super(t, o); this.pointerId = o.pointerId || 1; this.pointerType = o.pointerType || 'mouse'; }
};
window.Element.prototype.setPointerCapture = function () {};
window.Element.prototype.releasePointerCapture = function () {};
window.Element.prototype.scrollIntoView = function () {};
let pass = 0, fail = 0;
window.__check = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '  ' + d); } };
window.__done = () => { console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail === 0 ? 0 : 1); };
window.__calls = calls;
window.__css = fs.readFileSync(rootPath('client/css/game.css'), 'utf8');

window.eval(fs.readFileSync(rootPath('client/js/shared/common.js'), 'utf8') + '\n' + fs.readFileSync(rootPath('client/js/game/scene.js'), 'utf8') + `
;(function(){
  const calls = window.__calls;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  campaignId = 'C'; scene = { id: 'S', img_url: null }; SCENE_SIZE.w = 1000; SCENE_SIZE.h = 800;   // a 20x16 grid
  currentCampaignOwnerId = 'GM'; me = { id: 'GM' };
  const asUser = (id) => { me = { id }; window.__uid = id; };

  // A 600x400 viewport at the page origin. The stage reports the rect its
  // transform gives it — origin at (view.x, view.y) — as a browser would.
  const wrapEl = document.getElementById('stage-wrap');
  Object.defineProperty(wrapEl, 'clientWidth', { value: 600, configurable: true });
  Object.defineProperty(wrapEl, 'clientHeight', { value: 400, configurable: true });
  wrapEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 });
  const stg = document.getElementById('stage');
  stg.getBoundingClientRect = () => ({ left: view.x, top: view.y, width: SCENE_SIZE.w * view.z, height: SCENE_SIZE.h * view.z });
  const hud = document.getElementById('zoom-hud');
  const VW = 600, VH = 400;
  const P = PAD_PX;
  // How much of the map picture is on screen, per axis, inside the span [a, b].
  const mapX = () => { const m = mapExtent(); return [view.x + m.x0 * view.z, view.x + m.x1 * view.z]; };
  const mapY = () => { const m = mapExtent(); return [view.y + m.y0 * view.z, view.y + m.y1 * view.z]; };
  const overlapX = (a = 0, b = VW) => Math.min(b, mapX()[1]) - Math.max(a, mapX()[0]);
  const overlapY = (a = 0, b = VH) => Math.min(b, mapY()[1]) - Math.max(a, mapY()[0]);
  const setV = (x, y, z) => { view.x = x; view.y = y; view.z = z; applyView(); };
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const ev = (type, x, y, ex = {}) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, ...ex });
  const fireW = (type, x, y, ex = {}) => { const e = ev(type, x, y, ex); wrapEl.dispatchEvent(e); return e; };
  const ZOOMS = [MIN_ZOOM, 0.5, 1, 2, MAX_ZOOM];

  (async () => {
  // ═══ A. the pan clamp ═══════════════════════════════════════════════════════
  console.log('--- A. free panning: 15% of the visible canvas keeps the map ---');
  const bgEl = document.getElementById('stage-bg');
  for (const z of ZOOMS) {
    setV(1e6, 1e6, z);
    __check('at ' + z * 100 + '% the map can be dragged right/down until only 15% of the viewport shows it',
      near(overlapX(), 0.15 * VW) && near(overlapY(), 0.15 * VH), overlapX() + ' x ' + overlapY());
    setV(-1e6, -1e6, z);
    __check('...and left/up until only 15% shows it',
      near(overlapX(), 0.15 * VW) && near(overlapY(), 0.15 * VH), overlapX() + ' x ' + overlapY());
  }

  // The reported problem: zoomed out, the whole grid is smaller than the window,
  // and the old rule pinned it in the middle so a drag did nothing at all.
  view.z = MIN_ZOOM; centerView();
  const x0 = view.x, y0 = view.y;
  fireW('pointerdown', 300, 200); fireW('pointermove', 450, 290); fireW('pointerup', 450, 290);
  __check('a zoomed-out (25%) map moves by exactly the drag (it used to be pinned)',
    near(view.x - x0, 150) && near(view.y - y0, 90), (view.x - x0) + ',' + (view.y - y0));

  // "The map" is the picture: a big uncalibrated image drawn past the scene box
  // (applyGridAlignment grows #stage-bg to it) is reachable to its last corner,
  // and it is 15% of the IMAGE that stays on screen at the limit.
  bgEl.style.width = '1920px'; bgEl.style.height = '1080px';
  setV(-1e6, -1e6, 1);
  // Measured from the numbers, not from mapExtent(): the image's far corner is
  // stage (1920, 1080), so at the limit it sits 15% into the viewport.
  __check('a large image can be panned until only its own far 15% remains',
    near(view.x + 1920, 0.15 * VW) && near(view.y + 1080, 0.15 * VH), view.x + ',' + view.y);
  __check('...so its last corner is reachable (the scene box alone would stop 920px short)',
    view.x + 1000 < 0, String(view.x));
  bgEl.style.left = '-300px'; bgEl.style.top = '-200px';   // an aligned map, offset into the pad
  setV(1e6, 1e6, 1);
  __check('...and an offset (aligned) image counts from its own top-left',
    near(view.x - 300, VW - 0.15 * VW) && near(view.y - 200, VH - 0.15 * VH), view.x + ',' + view.y);
  bgEl.style.width = ''; bgEl.style.height = ''; bgEl.style.left = ''; bgEl.style.top = '';

  // Every view the OLD clamp allowed that still showed at least 15% of the map
  // is left untouched; the new rule refuses only views where the map is lost.
  const oldClamp = (v, z, vw, size) => {
    const sz = size * z, o = P * z;
    return sz <= vw ? (vw - sz) / 2 + o : Math.min(o, Math.max(vw - sz + o, v));
  };
  let changed = 0, refused = 0;
  for (let i = 0; i < 400; i++) {
    const z = MIN_ZOOM + ((i * 37) % 100) / 100 * (MAX_ZOOM - MIN_ZOOM);
    const ox = oldClamp(((i * 7919) % 20000) - 10000, z, VW, SCENE_SIZE.w + 2 * P);
    const oy = oldClamp(((i * 104729) % 20000) - 10000, z, VH, SCENE_SIZE.h + 2 * P);
    view.x = ox; view.y = oy; view.z = z;
    const keptX = overlapX() >= 0.15 * VW - 1e-6, keptY = overlapY() >= 0.15 * VH - 1e-6;
    applyView();
    if (keptX && keptY) { if (!near(view.x, ox) || !near(view.y, oy)) changed++; } else refused++;
  }
  __check('every old view that still showed 15% of the map is still allowed (400 samples)', changed === 0, changed + ' moved');
  __check('...the only views refused are ones that had lost the map', refused > 0, String(refused));
  // The deliberate change, pinned: at 400% the old rule let the view travel to
  // the pad's edge, where the screen showed nothing but empty pad.
  setV(P * MAX_ZOOM, 0, MAX_ZOOM);
  __check('at 400%, a view of nothing but empty pad is now refused (the map stays in sight)',
    near(overlapX(), 0.15 * VW) && view.x < P * MAX_ZOOM, String(view.x));

  // ...and no view at all loses the map.
  let lost = 0;
  for (let i = 0; i < 400; i++) {
    const z = MIN_ZOOM + ((i * 53) % 100) / 100 * (MAX_ZOOM - MIN_ZOOM);
    setV(((i * 7907) % 40000) - 20000, ((i * 6151) % 40000) - 20000, z);
    if (overlapX() < 0.15 * VW - 1e-6 || overlapY() < 0.15 * VH - 1e-6) lost++;
  }
  __check('no pan, at any zoom, leaves less than 15% of the viewport showing map (400 samples)', lost === 0, lost + ' lost');

  // The visible canvas excludes the game's chrome: the top bar, and the right
  // sidebar while it is open — a 15% strip under the sidebar would be lost.
  const bar = document.createElement('div'); bar.id = 'topBar';
  bar.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 64, width: 600, height: 64 });
  const side = document.createElement('div'); side.id = 'sideBar';
  let sideLeft = 400;
  side.getBoundingClientRect = () => ({ left: sideLeft, top: 64, right: sideLeft + 200, bottom: 400, width: 200, height: 336 });
  document.body.appendChild(bar); document.body.appendChild(side);
  for (const z of [MIN_ZOOM, 1, MAX_ZOOM]) {
    setV(1e6, 1e6, z);
    __check('at ' + z * 100 + '%, dragged right, 15% of the canvas LEFT OF THE SIDEBAR still shows map',
      near(overlapX(0, 400), 0.15 * 400), String(overlapX(0, 400)));
    __check('...and dragged down, 15% of the canvas BELOW THE TOP BAR still shows map',
      near(overlapY(64, 400), 0.15 * 336), String(overlapY(64, 400)));
    setV(-1e6, -1e6, z);
    __check('...dragged up, the map stays 15% below the top bar',
      near(overlapY(64, 400), 0.15 * 336), String(overlapY(64, 400)));
  }
  sideLeft = 600;   // collapsed: transformed off the right edge
  setV(1e6, 1e6, 1);
  __check('with the sidebar collapsed the whole width counts again',
    near(overlapX(), 0.15 * VW), String(overlapX()));
  // The dice tray along the bottom counts as a bottom band.
  const tray = document.createElement('div'); tray.id = 'diceTrayBar';
  tray.getBoundingClientRect = () => ({ left: 150, top: 340, right: 450, bottom: 386, width: 300, height: 46 });
  document.body.appendChild(tray);
  setV(1e6, -1e6, 1);
  __check('dragged up, the map stays 15% below the top bar (tray present)',
    near(overlapY(64, 340), 0.15 * 276), String(overlapY(64, 340)));
  setV(1e6, 1e6, 1);
  __check('dragged down, 15% of the map stays ABOVE THE DICE TRAY',
    near(overlapY(64, 340), 0.15 * 276), String(overlapY(64, 340)));
  bar.remove(); side.remove(); tray.remove();

  // ═══ B. focus pings ══════════════════════════════════════════════════════════
  console.log('--- B. focus pings centre the pinged point ---');
  __check('FOCUS_ZOOM, MIN_ZOOM and MAX_ZOOM are unchanged', FOCUS_ZOOM === 2 && MIN_ZOOM === 0.25 && MAX_ZOOM === 4);
  // Any point of the map can be centred exactly, at any zoom: centring even its
  // very edge leaves half the viewport on the map.
  const pts = [[10, 8], [0, 0], [20, 16], [20, 0], [0, 16], [3.5, 12.25]];
  let off = [];
  for (const z of ZOOMS) {
    for (const [gx, gy] of pts) {
      setV(0, 0, 1);
      showPing({ scene_id: 'S', x: gx, y: gy, color: '#fff', focus: true, zoom: z });
      const cx = view.x + gx * GRID_PX * view.z, cy = view.y + gy * GRID_PX * view.z;
      if (!near(view.z, z) || !near(cx, VW / 2) || !near(cy, VH / 2)) off.push(z + '@' + gx + ',' + gy + '->' + cx + ',' + cy);
    }
  }
  __check('a focus ping lands its point exactly at the viewport centre — middle, edges, corners — at every zoom',
    off.length === 0, off.join(' | '));
  // The server accepts pings up to one square outside the scene; at FOCUS_ZOOM
  // those centre exactly too.
  setV(0, 0, 1);
  showPing({ scene_id: 'S', x: -1, y: -1, color: '#fff', focus: true, zoom: FOCUS_ZOOM });
  __check('...including a ping one square outside the scene at FOCUS_ZOOM',
    near(view.x - 1 * GRID_PX * 2, 300) && near(view.y - 1 * GRID_PX * 2, 200), view.x + ',' + view.y);
  // The GM's own ping still carries max(own zoom, FOCUS_ZOOM).
  setV(0, 0, 1); window.__emits.length = 0;
  sendPing(3, 4, true);
  const sent = window.__emits.find((e) => e.ev === 'scene:ping');
  __check('a GM focus ping at 100% still imposes FOCUS_ZOOM', sent && sent.p.zoom === FOCUS_ZOOM, JSON.stringify(sent && sent.p));
  setV(0, 0, 3); window.__emits.length = 0;
  sendPing(3, 4, true);
  __check('...and keeps a closer zoom of the GM own', window.__emits[0] && window.__emits[0].p.zoom === 3);
  // A normal ping still does not move anyone.
  setV(10, 20, 1);
  showPing({ scene_id: 'S', x: 2, y: 2, color: '#fff', focus: false });
  __check('a normal ping does not move the view', view.x === 10 && view.y === 20, view.x + ',' + view.y);

  // ═══ C. wheel zoom: one step per frame ═══════════════════════════════════════
  console.log('--- C. wheel zoom is applied at most once per frame ---');
  await sleep(40);   // let any frame armed above run out
  setV(0, 0, 1);
  let writes = 0;
  const mo = new window.MutationObserver((ms) => { writes += ms.length; });
  mo.observe(stg, { attributes: true, attributeFilter: ['style'] });
  const wheel = (dy, x = 300, y = 200) => wrapEl.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: dy, clientX: x, clientY: y }));
  for (let i = 0; i < 5; i++) wheel(-100);
  await Promise.resolve();
  __check('a burst of 5 wheel events within one frame writes the transform ONCE', writes === 1, String(writes));
  __check('...and that first step is applied at once (a single notch feels the same)', hud.textContent === '112%', hud.textContent);
  await sleep(30);
  __check('the folded steps land at the next frame, in one more write', writes === 2, String(writes));
  __check('...ending exactly where five separate steps end', near(view.z, Math.pow(1.12, 5)), String(view.z));
  await sleep(40);
  __check('an idle frame writes nothing', writes === 2, String(writes));
  mo.disconnect();

  // The MIN/MAX clamp applies at every step, as before: at the maximum, in-in-out
  // ends one step below it (a product of factors would wrongly end at 400%).
  await sleep(40);
  setV(0, 0, MAX_ZOOM);
  wheel(-100); wheel(-100); wheel(100);
  settleWheelZoom();
  __check('per-step clamping is kept: at 400%, in-in-out ends one step below the maximum',
    near(view.z, MAX_ZOOM / 1.12), String(view.z));
  await sleep(40);
  setV(0, 0, 1);
  for (let i = 0; i < 60; i++) wheel(100);
  settleWheelZoom();
  __check('a long burst still stops at MIN_ZOOM', view.z === MIN_ZOOM, String(view.z));
  // Zoom stays anchored at the pointer.
  await sleep(40);
  setV(-200, -150, 1);
  const before = { x: (130 - view.x) / view.z, y: (90 - view.y) / view.z };
  wheel(-100, 130, 90);
  const after = { x: (130 - view.x) / view.z, y: (90 - view.y) / view.z };
  __check('the map point under the pointer stays under it', near(before.x, after.x) && near(before.y, after.y),
    JSON.stringify(before) + ' vs ' + JSON.stringify(after));
  await sleep(40);

  // ═══ D. no fog mask on a scene with nothing covered ══════════════════════════
  console.log('--- D. fog mask only when something is covered ---');
  const layer = document.getElementById('fog-layer');
  fog.clear(); renderFog();
  __check('a scene with no fog paints no mask and no masked rect',
    !layer.querySelector('mask') && !layer.querySelector('rect[mask]'), layer.innerHTML.slice(0, 120));
  fog.set('R', { id: 'R', scene_id: 'S', type: 'rect', points: [{ x: 1, y: 1 }, { x: 3, y: 3 }], revealed: true, created_at: '2026-10-01T00:00:00Z' });
  renderFog();
  __check('...nor one with only revealed regions (nothing to show)', !layer.querySelector('mask'));
  fog.set('C', { id: 'C', scene_id: 'S', type: 'rect', points: [{ x: 0, y: 0 }, { x: 20, y: 16 }], revealed: false, created_at: '2026-10-01T00:01:00Z' });
  renderFog();
  __check('a covered region brings the mask and the painted rect back',
    !!layer.querySelector('mask#fog-mask') && !!layer.querySelector('rect[mask]'));
  fog.clear(); renderFog();

  // ═══ E. placement ════════════════════════════════════════════════════════════
  console.log('--- E. placement follows the pointer ---');
  await loadActorPicker();
  upsertToken({ id: 'T1', scene_id: 'S', created_by: 'GM', name: 'Old', x: 1, y: 1, width: 1, height: 1, hidden: false, locked: false });
  const ghosts = () => [...stg.querySelectorAll('.token.ghost')];
  const shown = () => ghosts().filter((g) => g.style.visibility !== 'hidden');
  const posts = () => calls.filter((c) => c.method === 'POST');
  const form = (name, count, size, actor = '', img = '') => {
    document.getElementById('tok-name').value = name;
    document.getElementById('tok-count').value = String(count);
    document.getElementById('tok-size').value = size;
    document.getElementById('tok-actor').value = actor;
    document.getElementById('tok-img').value = img;
  };
  let started = 0;
  window.addEventListener('vtt:placement-start', () => { started++; });
  const press = () => document.getElementById('place-token').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const clickAt = (x, y, ex = {}) => { fireW('pointerdown', x, y, ex); fireW('pointerup', x, y, ex); };
  const gridOf = (el) => ({ x: parseFloat(el.style.left) / GRID_PX, y: parseFloat(el.style.top) / GRID_PX });

  setV(0, 0, 1);
  setSelection(['T1']);
  calls.length = 0;
  form('Goblin', 1, 'medium');
  // To reach the Place button the pointer leaves the map (the form is not part
  // of the canvas), as a real pointer would.
  wrapEl.dispatchEvent(new window.MouseEvent('pointerleave', { bubbles: false }));
  press();
  __check('Place sends nothing by itself', posts().length === 0, JSON.stringify(posts()));
  __check('...it arms a placement: the canvas is in placing mode', wrapEl.classList.contains('placing'));
  __check('...the shell is told, so it can close the form', started === 1, String(started));
  __check('...one ghost exists, hidden until the pointer is over the map', ghosts().length === 1 && shown().length === 0);
  __check('...hidden with visibility, so it keeps the size its picture is laid out from (never display:none)',
    ghosts().every((g) => g.style.display === '' && g.style.width === '50px'));
  __check('ghosts are half-transparent and never take the pointer (stylesheet)',
    /\\.token\\.ghost\\s*\\{[^}]*opacity:\\s*0\\.5[^}]*pointer-events:\\s*none/.test(window.__css));
  __check('...and the placing cursor is set in the stylesheet', /#stage-wrap\\.placing[^{]*\\{[^}]*cursor:\\s*copy/.test(window.__css));

  fireW('pointermove', 130, 170);
  __check('the ghost follows the pointer, snapped as placement snaps (nearest grid corner)',
    shown().length === 1 && gridOf(ghosts()[0]).x === 3 && gridOf(ghosts()[0]).y === 3, JSON.stringify(gridOf(ghosts()[0])));
  __check('...drawn at the size it will be placed, with its name', ghosts()[0].style.width === '50px' && ghosts()[0].textContent === 'Goblin');
  wrapEl.dispatchEvent(new window.MouseEvent('pointerleave', { bubbles: false }));
  __check('leaving the map hides the ghost', shown().length === 0);
  fireW('pointermove', 130, 170);
  __check('...coming back shows it again', shown().length === 1);

  // Nothing else is selected or dragged while placing.
  const t1 = tokens.get('T1').el;
  const tDown = ev('pointerdown', 70, 70); t1.dispatchEvent(tDown);
  t1.dispatchEvent(ev('pointermove', 110, 70));
  fireW('pointermove', 110, 70); fireW('pointerup', 110, 70);
  __check('pressing and dragging a token while placing neither selects nor drags it',
    selection.size === 1 && selection.has('T1') && !t1.classList.contains('dragging') && tokens.get('T1').row.x === 1,
    [...selection].join(','));
  __check('...that drag panned the map instead, and placed nothing', near(view.x, 40) && posts().length === 0, view.x + ' / ' + posts().length);
  __check('...and the placement is still armed', wrapEl.classList.contains('placing'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
  __check('Ctrl+A selects nothing while placing', selection.size === 1, String(selection.size));
  setV(0, 0, 1);

  // A click places, with the same request as before.
  fireW('pointermove', 130, 170);
  clickAt(130, 170);
  __check('a click sends exactly one placement request', posts().length === 1, String(posts().length));
  const sentBody = posts()[0] && posts()[0].body;
  __check('...to the single-token endpoint, at the clicked square, with the same body as before',
    posts()[0] && posts()[0].path.endsWith('/scenes/S/tokens') &&
    JSON.stringify(sentBody) === JSON.stringify({ x: 3, y: 3, name: 'Goblin', width: 1, height: 1 }), JSON.stringify(sentBody));
  __check('...the placing mode ends at once (a second click cannot place twice)', !wrapEl.classList.contains('placing'));
  __check('...while the ghost waits where it was dropped', shown().length === 1 && gridOf(ghosts()[0]).x === 3);
  await sleep(20);
  __check('when the server answers, the ghost is gone', ghosts().length === 0);
  const made = [...tokens.values()].find((t) => t.row.name === 'Goblin');
  __check('...and the real token is drawn at full opacity (not a ghost)', made && !made.el.classList.contains('ghost') && made.row.x === 3);
  __check('placing did not change the selection', selection.size === 1 && selection.has('T1'));
  clickAt(300, 300);
  await sleep(20);
  __check('a later click on the map places nothing', posts().length === 1, String(posts().length));

  // Multiple tokens: the ghosts are the block that will be sent.
  console.log('--- E2. multiples ---');
  calls.length = 0;
  form('Orc', 6, 'medium');
  press();
  fireW('pointermove', 130, 170);
  const block = ghosts().map(gridOf);
  __check('six ghosts, laid out as the 3x2 block placement packs', block.length === 6 &&
    JSON.stringify(block) === JSON.stringify([{x:3,y:3},{x:4,y:3},{x:5,y:3},{x:3,y:4},{x:4,y:4},{x:5,y:4}]), JSON.stringify(block));
  __check('...numbered exactly as before', ghosts().map((g) => g.textContent).join(',') === 'Orc,Orc 2,Orc 3,Orc 4,Orc 5,Orc 6');
  clickAt(130, 170);
  await sleep(20);
  const bulk = posts()[0];
  __check('the click sends the paste endpoint once', posts().length === 1 && bulk.path.endsWith('/tokens/copy'), bulk && bulk.path);
  __check('...with every token where its ghost was',
    JSON.stringify(bulk.body.tokens.map((t) => ({ x: t.x, y: t.y }))) === JSON.stringify(block));
  __check('...and the same names', bulk.body.tokens.map((t) => t.name).join(',') === 'Orc,Orc 2,Orc 3,Orc 4,Orc 5,Orc 6');
  __check('...and the ghosts become six real tokens', ghosts().length === 0 && [...tokens.values()].filter((t) => /^Orc/.test(t.row.name)).length === 6);

  // Near the far corner the block shifts back inside; the ghosts show the shift.
  calls.length = 0;
  form('Zombie', 9, 'medium');
  press();
  fireW('pointermove', 19 * 50, 15 * 50);
  const shifted = ghosts().map(gridOf);
  __check('a block at the far corner is shown shifted inside the scene',
    Math.max(...shifted.map((g) => g.x + 1)) <= 20 && Math.max(...shifted.map((g) => g.y + 1)) <= 16, JSON.stringify(shifted));
  clickAt(19 * 50, 15 * 50);
  await sleep(20);
  __check('...and placed exactly there', JSON.stringify(posts()[0].body.tokens.map((t) => ({ x: t.x, y: t.y }))) === JSON.stringify(shifted));

  // Esc cancels.
  console.log('--- E3. cancel ---');
  calls.length = 0;
  form('Wolf', 3, 'medium');
  press();
  fireW('pointermove', 200, 200);
  const esc = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(esc);
  __check('Esc removes the ghosts and ends the placement', ghosts().length === 0 && !wrapEl.classList.contains('placing'));
  __check('...and is consumed', esc.defaultPrevented);
  clickAt(200, 200);
  await sleep(20);
  __check('...nothing is created, before or after', posts().length === 0, String(posts().length));

  // Right-click cancels, and neither the browser menu nor the game menu opens.
  form('Wolf', 1, 'medium');
  press();
  fireW('pointermove', 200, 200);
  const rDown = ev('pointerdown', 200, 200, { button: 2 }); bgEl.dispatchEvent(rDown);
  __check('a right press removes the ghosts and ends the placement', ghosts().length === 0 && !wrapEl.classList.contains('placing'));
  const ctxEv = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 });
  wrapEl.dispatchEvent(ctxEv);
  __check('...the browser menu that follows it is suppressed', ctxEv.defaultPrevented);
  bgEl.dispatchEvent(ev('pointerup', 200, 200, { button: 2 }));
  __check('...no marquee starts and no game menu opens',
    document.getElementById('marquee').style.display !== 'block' && document.getElementById('ctx-menu').style.display !== 'block');
  const ctxLater = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  wrapEl.dispatchEvent(ctxLater);
  __check('...and only that one menu is swallowed', !ctxLater.defaultPrevented);
  await sleep(20);
  __check('...nothing is created', posts().length === 0);

  // Panning and zooming keep working; the ghost tracks the square under the pointer.
  console.log('--- E4. pan and zoom while placing ---');
  setV(0, 0, 1);
  form('Bat', 1, 'tiny');
  press();
  fireW('pointermove', 130, 170);
  fireW('pointerdown', 130, 170); fireW('pointermove', 230, 170); fireW('pointerup', 230, 170);
  __check('a drag while placing pans the map', near(view.x, 100), String(view.x));
  __check('...places nothing and stays armed', posts().length === 0 && wrapEl.classList.contains('placing'));
  __check('...and the ghost stays on the square the pointer is over (it moved with the map)',
    near(gridOf(ghosts()[0]).x, 3) && near(gridOf(ghosts()[0]).y, 3), JSON.stringify(gridOf(ghosts()[0])));
  __check('a tiny token is shown at its tiny size', ghosts()[0].style.width === '25px', ghosts()[0].style.width);
  await sleep(40);
  wheel(-100, 230, 170);
  settleWheelZoom();
  const sq = stageGrid({ clientX: 230, clientY: 170 });
  __check('wheel zoom works while placing', near(view.z, 1.12), String(view.z));
  __check('...and the ghost moves to the square now under the pointer',
    near(gridOf(ghosts()[0]).x, sq.x) && near(gridOf(ghosts()[0]).y, sq.y), JSON.stringify(gridOf(ghosts()[0])) + ' vs ' + JSON.stringify(sq));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(40);

  // Touch: a tap places at the tap point; a finger that travels pans.
  console.log('--- E5. touch ---');
  setV(0, 0, 1); calls.length = 0;
  form('Imp', 1, 'medium');
  press();
  fireW('pointerdown', 230, 120, { pointerType: 'touch', pointerId: 5 });
  fireW('pointerup', 236, 124, { pointerType: 'touch', pointerId: 5 });
  await sleep(20);
  __check('a touch tap (a finger wobbles ~10px) places at the tap point',
    posts().length === 1 && posts()[0].body.x === 5 && posts()[0].body.y === 2, JSON.stringify(posts()[0] && posts()[0].body));
  calls.length = 0;
  form('Imp', 1, 'medium');
  press();
  fireW('pointerdown', 230, 120, { pointerType: 'touch', pointerId: 6 });
  fireW('pointermove', 260, 120, { pointerType: 'touch', pointerId: 6 });
  fireW('pointerup', 260, 120, { pointerType: 'touch', pointerId: 6 });
  await sleep(20);
  __check('...a finger that travels pans instead and places nothing', posts().length === 0 && wrapEl.classList.contains('placing'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  // Failure: the error shows as before, and the ghosts go.
  console.log('--- E6. failure clean-up ---');
  setV(0, 0, 1); calls.length = 0;
  const countBefore = tokens.size;
  window.__fail = 403;
  form('Troll', 4, 'medium');
  press();
  fireW('pointermove', 300, 200);
  clickAt(300, 200);
  await sleep(20);
  __check('a server refusal is shown as before (status in the output panel)',
    /place 4 -> 403/.test(document.getElementById('out').textContent), document.getElementById('out').textContent.slice(0, 60));
  __check('...the ghosts are removed and no token appears', ghosts().length === 0 && tokens.size === countBefore);
  __check('...and the placement is over', !wrapEl.classList.contains('placing'));
  window.__fail = 'throw';
  form('Troll', 1, 'medium');
  press();
  clickAt(300, 200);
  await sleep(20);
  __check('a network failure also removes the ghosts', ghosts().length === 0 && tokens.size === countBefore);
  __check('...and is logged', /placement failed: network down/.test(document.getElementById('log').textContent));

  // Permissions and inheritance are unchanged.
  console.log('--- E7. permissions and inheritance ---');
  asUser('OTHER'); calls.length = 0; started = 0;
  form('Sneaky', 5, 'medium');
  press();
  __check('a player asking for several is refused at Place, as before', /Only the GM can place multiple/.test(document.getElementById('out').textContent));
  __check('...no ghost, no placing mode, the form stays open', ghosts().length === 0 && !wrapEl.classList.contains('placing') && started === 0);
  form('Mine', 1, 'medium');
  press();
  clickAt(100, 100);
  await sleep(20);
  __check('a player can still place one, through the normal endpoint',
    posts().length === 1 && posts()[0].path.endsWith('/scenes/S/tokens'), posts()[0] && posts()[0].path);
  asUser('GM');
  calls.length = 0;
  form('', 1, '', 'A1');
  press();
  fireW('pointermove', 100, 100);
  const og = ghosts()[0];
  __check('a character token with size Auto is shown at the character size (Large = 2x2)', og && og.style.width === '100px', og && og.style.width);
  __check('...with the character name and picture', og && og.textContent === 'Ogre' && og.querySelector('img') && og.querySelector('img').getAttribute('src') === 'https://ex/ogre.png');
  clickAt(100, 100);
  await sleep(20);
  __check('...and the request still leaves name, picture and size to inherit',
    JSON.stringify(posts()[0].body) === JSON.stringify({ x: 2, y: 2, actor_id: 'A1' }), JSON.stringify(posts()[0].body));

  // A placement belongs to its scene, and to the canvas mode it started in.
  form('Ghoul', 2, 'medium');
  press();
  const savedScene = scene;
  closeScene('the GM closed the scene');
  __check('closing the scene cancels the placement', ghosts().length === 0 && !wrapEl.classList.contains('placing'));
  scene = savedScene;
  form('Ghoul', 2, 'medium');
  press();
  setFogMode(true);
  __check('turning fog mode on cancels it too', ghosts().length === 0 && !wrapEl.classList.contains('placing'));
  setFogMode(false);

  window.__done();
  })().catch((e) => { __check('suite ran to the end', false, e && e.stack); window.__done(); });
})();
`);
