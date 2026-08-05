// Alignment tool smoke suite. jsdom only — no server, no database:
//   node test-align-ui.js
//
// Same narrow scope and same reason as test-combat-ui.js: public/js/align.js is
// a client file with no runtime coverage from any other suite, and the defect
// that motivated that file — a function deleted by an edit, called twice,
// killing the whole page on load — is invisible to `node --check` and to every
// server suite.
//
// It asserts that the file loads, that every element its handlers bind to
// exists, and that the ALIGNMENT ARITHMETIC is right, because that arithmetic is
// the one thing here a person cannot check by looking: a grid that is subtly
// mis-scaled looks aligned until tokens are placed.

const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM(fs.readFileSync('public/align.html', 'utf8'), {
  runScripts: 'outside-only',
  url: 'http://localhost:3000/align.html',
});
const { window } = dom;
const { document } = window;

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// ---- stubs -----------------------------------------------------------------
const calls = [];
window.fetch = async (path, opts = {}) => {
  calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  const json = async () => {
    if (/\/scenes\/[^/]+$/.test(path)) {
      return {
        scene: {
          id: 'S1', name: 'Bridge', width: 2000, height: 1500,
          img_url: 'https://example.com/map.png',
          grid: { size: 70, offset_x: -12.5, offset_y: 8, type: 'square', color: '#ffaa00', opacity: 0.4 },
        },
        tokens: [{ id: 'T1' }, { id: 'T2' }],
        fog: [],
        actors: [],
      };
    }
    if (/\/scenes$/.test(path)) return { scenes: [{ id: 'S1', name: 'Bridge' }] };
    return { campaign: { id: 'C1', name: 'Test', is_gm: true }, members: [] };
  };
  return { status: 200, json };
};
// Images never load in jsdom; resolve the probe so render() can proceed.
window.Image = class {
  constructor() { this.naturalWidth = 1400; this.naturalHeight = 1000; }
  set src(v) { this._src = v; if (this.onload) setTimeout(() => this.onload(), 0); }
  get src() { return this._src; }
};
window.PointerEvent = class extends window.MouseEvent {
  constructor(ty, o = {}) { super(ty, o); this.pointerId = o.pointerId || 1; }
};
window.Element.prototype.setPointerCapture = function set() {};
window.Element.prototype.releasePointerCapture = function rel() {};
window.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
window.prompt = () => '5';

let loadError = null;
try {
  window.eval(fs.readFileSync('public/js/align.js', 'utf8'));
} catch (err) {
  loadError = err;
}

console.log('\n--- the file loads at all ---');
t('align.js evaluates without throwing', loadError === null,
  loadError && `${loadError.name}: ${loadError.message}`);
if (loadError) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

console.log('\n--- every element the handlers bind to exists ---');
for (const id of [
  'campaignId', 'loadCampaign', 'sceneSel', 'mapUrl', 'setMap', 'info',
  'viewport', 'map', 'overlay', 'ruler',
  'cellSize', 'offX', 'offY', 'gridType', 'gridColor', 'gridOpacity',
  'measure', 'reset', 'save', 'saveMsg', 'hazard', 'out',
]) {
  t(`#${id} is present`, document.getElementById(id) !== null);
}

console.log('\n--- the grid overlay renders at the CANVAS cell size, not the map\'s ---');
// This is the heart of the design and the easiest thing to get backwards. The
// overlay is what tokens will use, so it is always GRID_PX; the MAP is scaled to
// meet it. Drawing the overlay at grid.size instead would look aligned in this
// tool and be wrong on the canvas.
const overlay = document.getElementById('overlay');
t('the overlay is drawn at 50px cells', /50px 50px/.test(overlay.style.backgroundSize),
  overlay.style.backgroundSize);

(async () => {
  // loadCampaign() reads the id from the input and returns early if it is
  // empty — which is what the first run of this suite tripped over.
  document.getElementById('campaignId').value = '11111111-1111-4111-8111-111111111111';
  await window.loadCampaign();
  await new Promise((r) => setTimeout(r, 10));

  console.log('\n--- loading a scene reads its saved alignment ---');
  t('cell size loaded', document.getElementById('cellSize').value === '70',
    document.getElementById('cellSize').value);
  t('offset x loaded', document.getElementById('offX').value === '-12.5',
    document.getElementById('offX').value);
  t('offset y loaded', document.getElementById('offY').value === '8');
  t('grid type loaded', document.getElementById('gridType').value === 'square');
  t('opacity loaded', document.getElementById('gridOpacity').value === '0.4');

  console.log('\n--- the map is SCALED to the grid (the inverted model) ---');
  const map = document.getElementById('map');
  // scale = GRID_PX / size = 50/70. natural 1400x1000 -> 1000 x 714.29
  t('background is sized by 50/size, from the natural dimensions',
    /^1000px 714\.2857/.test(map.style.backgroundSize), map.style.backgroundSize);
  // offset is in IMAGE pixels, applied at the same scale: -12.5 * (50/70) = -8.93
  // and positioned negatively, so +8.93.
  t('background position applies the offset at the same scale',
    /^8\.92857/.test(map.style.backgroundPosition), map.style.backgroundPosition);

  console.log('\n--- the token hazard is stated BEFORE anything is changed ---');
  const hazard = document.getElementById('hazard').textContent;
  t('the hazard names the token count', /2 token/.test(hazard), hazard);
  t('...and says coordinates do not change', /grid coordinates do not change/.test(hazard));
  t('...and it appeared on LOAD, not after saving',
    !calls.some((c) => c.method === 'PATCH'), 'no PATCH has been issued yet');

  console.log('\n--- dragging moves the map in IMAGE pixels ---');
  const vp = document.getElementById('viewport');
  const before = Number(document.getElementById('offX').value);
  vp.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
  vp.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 150, clientY: 100, bubbles: true }));
  vp.dispatchEvent(new window.PointerEvent('pointerup', { clientX: 150, clientY: 100, bubbles: true }));
  const after = Number(document.getElementById('offX').value);
  // 50 screen px at scale 50/70 is 70 image px, and dragging RIGHT decreases the
  // offset because the offset is subtracted when positioning.
  t('50 screen px right = 70 image px of offset', Math.abs((before - after) - 70) < 0.01,
    `${before} -> ${after}`);

  console.log('\n--- the save sends only alignment keys (the server MERGES) ---');
  document.getElementById('save').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const patch = calls.filter((c) => c.method === 'PATCH').pop();
  t('a PATCH was issued', !!patch);
  t('...carrying a grid object', patch && !!patch.body.grid);
  t('...and nothing else, so it cannot clobber name/img/dimensions',
    patch && Object.keys(patch.body).join(',') === 'grid', patch && Object.keys(patch.body).join(','));
  t('...with an integer cell size', patch && Number.isInteger(patch.body.grid.size),
    patch && String(patch.body.grid.size));
  t('...and every alignment key present',
    patch && ['size', 'offset_x', 'offset_y', 'type', 'color', 'opacity']
      .every((k) => k in patch.body.grid),
    patch && Object.keys(patch.body.grid).join(','));

  console.log('\n--- reset returns to the defaults ---');
  document.getElementById('reset').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('reset restores a 70px cell at no offset',
    document.getElementById('cellSize').value === '70'
      && document.getElementById('offX').value === '0'
      && document.getElementById('offY').value === '0');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
