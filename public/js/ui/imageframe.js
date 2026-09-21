// Shared full-image framing. Hidden slots start square; once laid out, their
// measured aspect ratio is used. Only the surrounding slot clips the image.
window.VTTImageFrame = (function () {
  const frames = new WeakMap();

  function paint(image) {
    const frame = frames.get(image);
    if (!frame) return;
    const aspect = frame.slot && frame.slot.clientWidth > 0 && frame.slot.clientHeight > 0
      ? frame.slot.clientWidth / frame.slot.clientHeight : frame.aspect;
    const ratio = image.naturalWidth / image.naturalHeight;
    if (Number.isFinite(ratio) && ratio > 0) {
      image.style.width = (100 * Math.max(1, ratio / aspect)) + '%';
      image.style.height = (100 * Math.max(1, aspect / ratio)) + '%';
    }
    image.style.left = (50 + frame.x * 100) + '%';
    image.style.top = (50 + frame.y * 100) + '%';
    image.style.transform = 'translate(-50%, -50%) scale(' + frame.scale + ')';
  }

  function apply(image, slot, x, y, scale, aspect = 1) {
    let state = frames.get(image);
    if (!state) {
      state = {};
      frames.set(image, state);
      image.addEventListener('load', () => {
        if (state.observer && state.slot) state.observer.observe(state.slot);
        paint(image);
      });
      image.addEventListener('error', () => state.observer?.disconnect());
      if (typeof ResizeObserver !== 'undefined') {
        state.observer = new ResizeObserver(() => {
          if (!state.slot?.isConnected) state.observer.disconnect();
          else paint(image);
        });
      }
    }
    if (state.slot !== slot) state.observer?.disconnect();
    Object.assign(state, {
      slot,
      x: Number(x) || 0, y: Number(y) || 0,
      scale: Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1,
      aspect: Number.isFinite(Number(aspect)) && Number(aspect) > 0 ? Number(aspect) : 1,
    });
    if (slot) state.observer?.observe(slot);
    // The slot clips the picture, rather than cropping the image before panning.
    if (slot) {
      if (!['absolute', 'relative', 'fixed', 'sticky'].includes(getComputedStyle(slot).position)) {
        slot.style.position = 'relative';
      }
      slot.style.overflow = 'hidden';
    }
    Object.assign(image.style, {
      position: 'absolute', inset: 'auto', maxWidth: 'none', maxHeight: 'none',
      margin: '0', padding: '0', border: '0', borderRadius: '0',
      objectFit: 'fill', transformOrigin: 'center',
    });
    paint(image);
    // Renderers may call before appending the slot to the document.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => paint(image));
  }

  return { apply };
})();
