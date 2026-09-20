const { rootPath } = require('../helpers/paths');
// VTTFrameTool component suite — jsdom only:  node tests/unit/test-frametool.js
//
// The framing MECHANICS (drag-by-fraction, wheel/input clamping, the exact
// transform string scene.js draws, reset, and the save callback contract) live
// in one reusable component now. These assertions were ported from
// test-actors-ui.js when the tool was extracted out of actors.js, so the maths
// that must agree with the canvas is still gated on every commit.

const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
global.window = window; global.document = document;
window.HTMLElement.prototype.setPointerCapture = window.HTMLElement.prototype.setPointerCapture || function () {};
window.HTMLElement.prototype.releasePointerCapture = window.HTMLElement.prototype.releasePointerCapture || function () {};
// jsdom gives every element a 0x0 box; the drag maths divides by the stage size,
// so give the stage a real rect.
const STAGE = 220;
window.eval(fs.readFileSync(rootPath('public/js/imageframe.js'), 'utf8'));
window.eval(fs.readFileSync(rootPath('public/js/frametool.js'), 'utf8'));

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + extra : '')); }
}

const FrameTool = window.VTTFrameTool;
function els() {
  return {
    back: document.querySelector('.vttframe-back'),
    stage: document.querySelector('.vttframe-stage'),
    art: document.querySelector('.vttframe-art'),
    scale: document.querySelector('.vttframe-field input[step="0.05"]'),
    x: document.querySelectorAll('.vttframe-field input[step="0.01"]')[0],
    y: document.querySelectorAll('.vttframe-field input[step="0.01"]')[1],
    reset: [...document.querySelectorAll('.vttframe button')].find((b) => b.textContent === 'Reset'),
    cancel: [...document.querySelectorAll('.vttframe button')].find((b) => b.textContent === 'Cancel'),
    save: [...document.querySelectorAll('.vttframe button')].find((b) => /Saving|Save framing/.test(b.textContent)),
  };
}

(async () => {
  let saved = null;
  FrameTool.open({
    imageUrl: 'aria.png', offsetX: 0.25, offsetY: -0.1, scale: 1.4,
    onSave: (vals) => { saved = vals; return { ok: true }; },
  });
  let e = els();
  // Give the stage a measurable size for the drag maths.
  e.stage.getBoundingClientRect = () => ({ width: STAGE, height: STAGE, left: 0, top: 0, right: STAGE, bottom: STAGE });

  console.log('--- the tool loads the passed framing ---');
  t('open() shows the overlay', e.back.classList.contains('on'));
  t('scale loaded', e.scale.value === '1.4', e.scale.value);
  t('offset x loaded', e.x.value === '0.25', e.x.value);
  t('offset y loaded', e.y.value === '-0.1', e.y.value);
  t('the art carries the picture', /aria\.png/.test(e.art.src || e.art.getAttribute('src') || ''));

  console.log('\n--- the transform matches what scene.js draws ---');
  const tf = e.art.style.transform;
  t('full image is centred before scaling',
    /^translate\(-50%, -50%\)/.test(tf), tf);
  t('horizontal offset is relative to the frame',
    e.art.style.left === '75%', e.art.style.left);
  t('vertical offset is relative to the frame',
    e.art.style.top === '40%', e.art.style.top);

  // jsdom does not load image bytes or calculate layout.
  // Model a 2:1 image inside the square frame, then fire its load event.
  Object.defineProperties(e.stage, {
    clientWidth: { configurable: true, value: STAGE },
    clientHeight: { configurable: true, value: STAGE },
  });
  Object.defineProperties(e.art, {
    naturalWidth: { configurable: true, value: 440 },
    naturalHeight: { configurable: true, value: 220 },
  });
  e.art.dispatchEvent(new window.Event('load'));

  t('wide image retains its full width instead of being cropped to a square',
    e.art.style.width === '200%' && e.art.style.height === '100%',
    e.art.style.width + ' / ' + e.art.style.height);

  Object.defineProperties(e.art, {
    naturalWidth: { configurable: true, value: 220 },
    naturalHeight: { configurable: true, value: 440 },
  });
  e.art.dispatchEvent(new window.Event('load'));

  t('tall image retains its full height',
    e.art.style.width === '100%' && e.art.style.height === '200%',
    e.art.style.width + ' / ' + e.art.style.height);
  t('...and scale second', /scale\(1\.4\)$/.test(tf), tf);

  // Compare visible coverage, including the case that the old pre-cropped
  // renderer left blank: a wide image panned right by a quarter of the frame.
  const slot = document.createElement('div');
  const fullImage = document.createElement('img');
  slot.appendChild(fullImage); document.body.appendChild(slot);
  Object.defineProperties(fullImage, {
    naturalWidth: { configurable: true, value: 440 },
    naturalHeight: { configurable: true, value: 220 },
  });
  window.VTTImageFrame.apply(fullImage, slot, 0.25, 0, 1);
  const width = parseFloat(fullImage.style.width);
  const centre = parseFloat(fullImage.style.left);
  t('a panned wide image still covers the entire frame', centre - width / 2 <= 0 && centre + width / 2 >= 100);
  t('the slot, not the image, owns clipping', slot.style.overflow === 'hidden' && parseFloat(fullImage.style.borderRadius) === 0);
  window.VTTImageFrame.apply(fullImage, slot, -0.2, 0.1, 0.5);
  fullImage.dispatchEvent(new window.Event('load'));
  t('a delayed load uses the most recently saved framing',
    fullImage.style.left === '30%' && fullImage.style.top === '60%' &&
    fullImage.style.transform === 'translate(-50%, -50%) scale(0.5)');
  Object.defineProperties(slot, { clientWidth: { value: 200 }, clientHeight: { value: 100 } });
  window.VTTImageFrame.apply(fullImage, slot, 0, 0, 1);
  t('rectangular slots preserve the image aspect ratio', fullImage.style.width === '100%' && fullImage.style.height === '100%');
  slot.remove();


  console.log('\n--- dragging moves by a FRACTION of the frame ---');
  // The art is an <img>; native image drag / pointer capture on it would steal
  // the pan gesture, so it must be draggable=false and transparent to pointers.
  t('the art image cannot be native-dragged', e.art.draggable === false);
  t('...and is transparent to pointer events (they land on the stage)',
    /pointer-events\s*:\s*none/.test(document.head.querySelector('style').textContent.match(/\.vttframe-art\{[^}]*\}/)[0]));
  e.stage.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: 0, clientY: 0, bubbles: true }));
  e.stage.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 55, clientY: 0, bubbles: true }));
  e.stage.dispatchEvent(new window.PointerEvent('pointerup', { clientX: 55, clientY: 0, bubbles: true }));
  t('55px on a 220px stage is 0.25 of the frame', Math.abs(Number(e.x.value) - 0.5) < 0.001, e.x.value);
  t('the other axis is untouched', Math.abs(Number(e.y.value) + 0.1) < 0.001, e.y.value);

  console.log('\n--- bounds match the server ---');
  e.scale.value = '99'; e.scale.dispatchEvent(new window.Event('input'));
  t('zoom clamped to 5', Number(e.scale.value) === 5, e.scale.value);
  e.scale.value = '0'; e.scale.dispatchEvent(new window.Event('input'));
  t('...and to 0.1', Number(e.scale.value) === 0.1, e.scale.value);
  e.x.value = '9'; e.x.dispatchEvent(new window.Event('input'));
  t('offset clamped to 2', Number(e.x.value) === 2, e.x.value);

  console.log('\n--- reset & save ---');
  e.reset.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('reset returns identity', e.scale.value === '1' && e.x.value === '0' && e.y.value === '0');

  e.save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  t('save fired the callback with rounded values',
    saved && saved.scale === 1 && saved.offsetX === 0 && saved.offsetY === 0, JSON.stringify(saved));
  t('a successful save closes the tool', !els().back.classList.contains('on'));

  console.log('\n--- a rejected save keeps the tool open ---');
  FrameTool.open({ imageUrl: 'x.png', onSave: () => ({ error: 'nope' }) });
  els().save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  t('the tool stays open on error', els().back.classList.contains('on'));
  FrameTool.close();

  console.log('\n--- cancel closes without calling onSave ---');
  let called = false;
  FrameTool.open({ imageUrl: 'x.png', onSave: () => { called = true; } });
  els().cancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('cancel closes', !els().back.classList.contains('on'));
  t('...without saving', called === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
