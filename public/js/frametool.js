// VTTFrameTool — a reusable "position & zoom an image inside a square" modal.
//
// Extracted from the character framing tool in actors.js so any image context
// (character portraits, token art overrides, avatars, item art, …) can reuse
// exactly one implementation instead of copy-pasting the stage/drag/zoom logic.
//
// The shared renderer moves the full image inside the square clipping slot.
// Offsets are fractions of the unscaled frame, so editor and saved images agree.
//
// Bounds mirror the server (scale 0.1–5, offsets -2..2). Defaults (0,0,1) are
// the identity transform, i.e. `object-fit: cover`.
//
//   VTTFrameTool.open({
//     imageUrl,                     // required — the art to frame
//     offsetX, offsetY, scale,      // current values (default 0,0,1)
//     title,                        // optional heading
//     note,                         // optional sub-line
//     onSave(vals) -> Promise|any,  // vals = { offsetX, offsetY, scale }
//                                   // return a falsy/{ok:true} to close; return
//                                   // { error } (or throw) to keep it open and
//                                   // show the message.
//   })

window.VTTFrameTool = (function () {
  var SCALE_MIN = 0.1, SCALE_MAX = 5, OFF_MIN = -2, OFF_MAX = 2;
  var round3 = function (n) { return Math.round(n * 1000) / 1000; };
  var clamp = function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); };

  var root = null;      // { back, stage, art, scale, x, y, msg, save, cancel, reset, title, note }
  var state = null;     // { ox, oy, scale, onSave, saving }
  var pan = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function build() {
    if (root) return;
    // Scoped styles, injected once. Kept close to the game page's #frameModal so
    // it looks the same wherever it opens.
    var style = document.createElement('style');
    style.textContent = [
      '.vttframe-back{position:fixed;inset:0;z-index:90;display:none;align-items:center;justify-content:center;background:rgba(6,7,10,0.7);}',
      '.vttframe-back.on{display:flex;}',
      '.vttframe{background:var(--surface-raised);color:var(--text);border:1px solid var(--rule);border-radius:10px;padding:1.2rem;width:min(34rem,94vw);box-shadow:0 24px 60px rgba(0,0,0,0.5);}',
      '.vttframe h3{margin:0 0 0.2rem;font-size:1rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--accent);}',
      '.vttframe .vttframe-note{color:var(--text-muted);font-size:0.8rem;margin:0 0 0.6rem;}',
      '.vttframe-stagewrap{display:flex;justify-content:center;margin:0.6rem 0;}',
      // The stage is SQUARE and fills with cover — identical geometry to where the
      // image actually renders (token cells, avatars, item thumbs are all square,
      // drawn with object-fit/background cover). If this preview were a different
      // aspect ratio or used contain, the crop chosen here would not match the
      // result. Sized to fit both the card width and the viewport height.
      '.vttframe-stage{position:relative;overflow:hidden;border:1px solid var(--border);background:var(--surface);width:min(30rem,80vw,52vh);height:min(30rem,80vw,52vh);border-radius:8px;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;}',
      '.vttframe-stage.dragging{cursor:grabbing;}',
      // The art is an <img> (cover), matching the avatar/item/token render exactly.
      // Native image drag-and-drop must be OFF or it pre-empts our pointer pan.
      '.vttframe-art{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;transform-origin:center;-webkit-user-drag:none;user-drag:none;pointer-events:none;}',
      '.vttframe-row{display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end;margin-top:0.5rem;}',
      '.vttframe-field{display:flex;flex-direction:column;gap:0.2rem;}',
      '.vttframe-field label{font-size:0.72rem;color:var(--text-muted);font-weight:600;}',
      '.vttframe-field input{font:inherit;padding:0.45rem 0.55rem;min-height:38px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);width:6rem;}',
      '.vttframe-actions{display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-top:0.8rem;}',
      '.vttframe-actions .vttframe-spacer{flex:1 1 auto;}',
      '.vttframe-msg{font-size:0.8rem;color:var(--text-muted);}',
    ].join('');
    document.head.appendChild(style);

    var back = el('div', 'vttframe-back');
    var card = el('div', 'vttframe');
    var title = el('h3'); card.appendChild(title);
    var note = el('p', 'vttframe-note'); card.appendChild(note);
    var stage = el('div', 'vttframe-stage');
    var art = document.createElement('img');
    art.className = 'vttframe-art';
    art.alt = '';
    art.draggable = false;   // stop native image drag from stealing the pan gesture
    stage.appendChild(art);
    var stageWrap = el('div', 'vttframe-stagewrap');
    stageWrap.appendChild(stage);
    card.appendChild(stageWrap);

    var row = el('div', 'vttframe-row');
    function field(labelText) {
      var f = el('div', 'vttframe-field');
      var l = el('label', null, labelText);
      var i = document.createElement('input'); i.type = 'number';
      l.setAttribute('for', ''); f.appendChild(l); f.appendChild(i);
      row.appendChild(f); return i;
    }
    var scaleI = field('Zoom'); scaleI.step = '0.05'; scaleI.min = String(SCALE_MIN); scaleI.max = String(SCALE_MAX);
    var xI = field('Offset X'); xI.step = '0.01'; xI.min = String(OFF_MIN); xI.max = String(OFF_MAX);
    var yI = field('Offset Y'); yI.step = '0.01'; yI.min = String(OFF_MIN); yI.max = String(OFF_MAX);
    card.appendChild(row);

    var actions = el('div', 'vttframe-actions');
    var reset = el('button', 'btn small secondary', 'Reset'); reset.type = 'button';
    var msg = el('span', 'vttframe-msg');
    var spacer = el('span', 'vttframe-spacer');
    var cancel = el('button', 'btn small secondary', 'Cancel'); cancel.type = 'button';
    var save = el('button', 'btn small primary', 'Save framing'); save.type = 'button';
    actions.appendChild(reset); actions.appendChild(msg); actions.appendChild(spacer);
    actions.appendChild(cancel); actions.appendChild(save);
    card.appendChild(actions);
    back.appendChild(card);

    root = { back: back, card: card, stage: stage, art: art, scale: scaleI, x: xI, y: yI, msg: msg, save: save, cancel: cancel, reset: reset, title: title, note: note };
    wire();
  }

  function paint() {
    if (!state) return;
    window.VTTImageFrame.apply(root.art, root.stage, state.ox, state.oy, state.scale);
    root.scale.value = String(round3(state.scale));
    root.x.value = String(round3(state.ox));
    root.y.value = String(round3(state.oy));
  }

  function wire() {
    var stage = root.stage;
    stage.addEventListener('pointerdown', function (e) {
      if (!state) return;
      pan = { x: e.clientX, y: e.clientY, ox: state.ox, oy: state.oy };
      stage.classList.add('dragging');
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!pan || !state) return;
      var rect = stage.getBoundingClientRect();
      state.ox = clamp(pan.ox + (e.clientX - pan.x) / rect.width, OFF_MIN, OFF_MAX);
      state.oy = clamp(pan.oy + (e.clientY - pan.y) / rect.height, OFF_MIN, OFF_MAX);
      paint();
    });
    var end = function (e) {
      if (!pan) return; pan = null; stage.classList.remove('dragging');
      try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* released */ }
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);

    stage.addEventListener('wheel', function (e) {
      if (!state) return;
      e.preventDefault();
      state.scale = clamp(state.scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06), SCALE_MIN, SCALE_MAX);
      paint();
    }, { passive: false });

    [[root.scale, 'scale', SCALE_MIN, SCALE_MAX], [root.x, 'ox', OFF_MIN, OFF_MAX], [root.y, 'oy', OFF_MIN, OFF_MAX]].forEach(function (spec) {
      spec[0].addEventListener('input', function (e) {
        if (!state) return;
        var v = Number(e.target.value);
        if (Number.isFinite(v)) { state[spec[1]] = clamp(v, spec[2], spec[3]); paint(); }
      });
    });

    root.reset.addEventListener('click', function () {
      if (!state) return; state.ox = 0; state.oy = 0; state.scale = 1; paint();
    });
    root.cancel.addEventListener('click', close);
    root.back.addEventListener('click', function (e) { if (e.target === root.back) close(); });
    root.save.addEventListener('click', doSave);
  }

  async function doSave() {
    if (!state || state.saving) return;
    var cb = state.onSave;
    var vals = { offsetX: round3(state.ox), offsetY: round3(state.oy), scale: round3(state.scale) };
    if (!cb) { close(); return; }
    state.saving = true;
    var prev = root.save.textContent; root.save.textContent = 'Saving…'; root.save.disabled = true; root.msg.textContent = '';
    try {
      var r = await cb(vals);
      if (r && r.error) { root.msg.textContent = r.error; }
      else { close(); return; }
    } catch (err) {
      root.msg.textContent = 'Save failed — try again.';
    }
    state.saving = false; root.save.textContent = prev; root.save.disabled = false;
  }

  function open(opts) {
    opts = opts || {};
    build();
    state = {
      ox: clamp(Number(opts.offsetX) || 0, OFF_MIN, OFF_MAX),
      oy: clamp(Number(opts.offsetY) || 0, OFF_MIN, OFF_MAX),
      scale: Number(opts.scale) > 0 ? clamp(Number(opts.scale), SCALE_MIN, SCALE_MAX) : 1,
      onSave: typeof opts.onSave === 'function' ? opts.onSave : null,
      saving: false,
    };
    root.title.textContent = opts.title || 'Frame the picture';
    root.note.textContent = opts.note || 'Drag to move · scroll to zoom. This is the crop that will be used.';
    if (opts.imageUrl) { root.art.src = String(opts.imageUrl); root.art.style.display = 'block'; }
    else { root.art.removeAttribute('src'); }
    root.msg.textContent = '';
    root.save.disabled = false; root.save.textContent = 'Save framing';

    // A <dialog> opened with showModal() is in the browser's top layer; a fixed
    // overlay on <body> would render behind it. So mount inside an open dialog
    // when there is one (mirrors VTTImagePicker), else <body>.
    var host = document.querySelector('dialog[open]') || document.body;
    if (root.back.parentNode !== host) host.appendChild(root.back);
    root.back.classList.add('on');
    paint();
  }

  function close() {
    if (root) root.back.classList.remove('on');
    state = null; pan = null;
  }

  function isOpen() { return !!(root && root.back.classList.contains('on')); }

  return { open: open, close: close, isOpen: isOpen };
})();
