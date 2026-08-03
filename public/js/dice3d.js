// 3D dice overlay (M6 work, landed alongside the M5 harness).
//
// An ES MODULE, loaded with <script type="module">, because the vendored
// library ships as an ES module. Everything else in public/js/ is a classic
// script; this is the one exception and it is why the file exists separately
// rather than living inside combat.js.
//
// ---------------------------------------------------------------------------
// THE ONE THING THAT MATTERS ABOUT THIS FILE
// ---------------------------------------------------------------------------
// THE DICE DO NOT DECIDE ANYTHING. The server rolled with crypto.randomInt
// before this code ever saw the message; `roll_data.results` is the
// authoritative outcome and it is already stored in the messages table and
// broadcast to every recipient. This module's entire job is to make dice land
// on numbers that were chosen elsewhere.
//
// That is not a stylistic preference. If the client generated its own numbers,
// then either they disagree with the stored result — and the client's is the
// one people believe, because they WATCHED IT LAND — or the client becomes the
// source of truth, which is exactly the cheat vector break-combat.js asserts
// against ("dice: a client-supplied roll_data is NOT trusted").
//
// So the visual is a PRESENTATION of an authoritative fact, never its source.
// The same relationship the M3 chapter records for fog: what the client draws
// is downstream of what the server decided, and the honest claim is stated
// rather than implied.
//
// The mechanism is @3d-dice/dice-box-threejs's predetermined-outcome notation.
// Verified in the shipped bundle rather than taken from the README — its
// parseNotation splits on "@" and pushes the right-hand numbers in as the
// forced result:
//
//     let n = e.split("@"), i = n[0], ...
//     !this.error && n[1] && (r = n[1].match(o)) !== null && this.result.push(...r);
//
// So `roll("2d6@4,2")` runs a real physics simulation that settles on 4 and 2.
//
// A PROPERTY THIS GETS FOR FREE, worth naming: because roll_data is broadcast
// in message:created, every client animates THE SAME DICE. Synchronised physics
// across the table with no extra server work. And a whispered or blind GM roll
// animates only for its recipients — non-recipients never receive the message
// at all, so that falls out of the existing confidentiality rule with no code
// here.
//
// ---------------------------------------------------------------------------
// WHY IT IS VENDORED
// ---------------------------------------------------------------------------
// The CSP is `script-src 'self'`, so a CDN import would mean widening the
// policy the authentication chapter defends. The library and its textures live
// under /vendor/dice/ instead. It was chosen over the more popular
// @3d-dice/dice-box for two reasons, both checked rather than assumed:
//   1. dice-box generates its own numbers and has no predetermined mode, which
//      makes it unusable here at any price.
//   2. dice-box needs AmmoJS WASM and web workers, which would require adding
//      'wasm-unsafe-eval' and 'worker-src' to the CSP. This fork uses cannon-es
//      (pure JS): zero .wasm files, zero `new Worker`, zero `eval`, zero
//      `new Function`. IT NEEDS NO CSP CHANGE AT ALL.
//
// Version 0.0.12, MIT, three@0.143.0 + cannon-es@0.20.0. Last upstream push was
// November 2023, so it is roughly 2.7 years stale — pinned and vendored, but
// recorded as a stated dependency risk rather than a silent addition.
//
// Sounds were deliberately NOT vendored (684 KB of the 2.4 MB asset payload).
// Textures alone are 1.7 MB, and this source tree is deposited with the
// university.

import DiceBox from '/vendor/dice/dice-box-threejs.es.js';

// The nine shapes the library actually has meshes for, read out of its own die
// registry rather than guessed. The server accepts ANY sides from 1 to 1000, so
// `1d7` is a perfectly legal roll with nothing to render. That is a
// disagreement between two bounds, not a bug, and it is handled by falling back
// to the text line rather than by narrowing the server to match a rendering
// library.
const RENDERABLE = new Set([2, 3, 4, 6, 8, 10, 12, 20, 100]);

// Colour sets shipped by the library. Exposed so the tray is a toy the GM can
// fiddle with — it changes nothing but the pixels.
const COLORSETS = [
  'white', 'black', 'radiant', 'fire', 'earth', 'air', 'water',
  'ice', 'poison', 'acid', 'thunder', 'necrotic', 'force', 'psychic',
  'bronze', 'rainbow', 'astral', 'breebles',
];

let box = null;
let ready = false;

// A monotonic counter identifying the roll currently on the table. A throw that
// finishes after a newer one has started is STALE and does nothing — see
// throwNow(). This replaced a queue; the reasoning is in that function's header.
let generation = 0;

// One slot, not a queue: a roll that arrives before the 3D scene has finished
// initialising. Latest wins here too, for the same reason it wins everywhere
// else in this file.
let pendingBeforeReady = null;

// Dice can only be picked up once they have stopped moving. While a throw is in
// flight the library's animation loop copies every mesh's position and rotation
// FROM its physics body each frame, so anything we set would be overwritten on
// the next tick — and grabbing a tumbling die is not a thing you can do at a
// real table either.
let settled = false;

// Pixel radius for picking. Picking is done by projecting each die's CENTRE to
// screen space and taking the nearest within this distance, rather than by
// raycasting the actual mesh: the library exposes no Raycaster and three.js is
// bundled inside it rather than importable, so a true mesh intersection would
// mean vendoring a SECOND copy of three (~600 KB) with two THREE instances in
// one page. For convex, roughly-spherical objects lying on a flat table, centre
// proximity is indistinguishable in use and costs nothing.
const PICK_RADIUS_PX = 46;

let drag = null;
let interactive = true;

function config() {
  return {
    assetPath: '/vendor/dice/assets/',
    // Sounds are off because the sound assets were not vendored. Turning this
    // on without copying public/sounds/ produces 404s, not audio.
    sounds: false,
    theme_surface: 'green-felt',
    theme_colorset: localStorage_get('vtt.dice.colorset') || 'white',
    theme_material: 'plastic',
    shadows: true,
    gravity_multiplier: 400,
    light_intensity: 0.9,
    baseScale: 100,
    strength: 1,
    // Deliberately empty. Nothing in this module gates on roll completion any
    // more, so there is no state for this callback to own — see throwNow().
    onRollComplete: () => {},
  };
}

// The artifact rules elsewhere in this project forbid browser storage, but this
// is a real page in a real app rather than an artifact, and a remembered dice
// colour is exactly what localStorage is for. Wrapped so a browser with storage
// disabled degrades to the default instead of throwing.
function localStorage_get(k) {
  try { return window.localStorage.getItem(k); } catch { return null; }
}
function localStorage_set(k, v) {
  try { window.localStorage.setItem(k, v); } catch { /* private mode */ }
}

export async function initDice(selector) {
  if (box) return box;
  const host = document.querySelector(selector);
  if (!host) return null;
  box = new DiceBox(selector, config());
  await box.initialize();
  ready = true;
  attachDragHandlers();
  if (pendingBeforeReady) {
    const n = pendingBeforeReady;
    pendingBeforeReady = null;
    throwNow(n);
  }
  return box;
}

// Build the library's notation from OUR roll_data.
//
// Our stored shape is {formula, results, total, groups}; the library wants
// "<n>d<s>+<n>d<s>@<r1>,<r2>,...". `groups` is what makes multi-die rolls
// renderable at all: a flat results array cannot say which number belongs to
// which shape, so `1d20+1d6` would be unshowable without it.
//
// No modifier is passed on. The server already folded it into `total`, and
// passing it again would make the tray's own arithmetic disagree with the chat
// line — two numbers for one roll, which is the whole thing this layer exists
// not to do.
//
// Rolls stored before the multi-group amendment have no `groups` key, so the
// formula is re-derived from `results` for them. That fallback is not dead code:
// the messages table already holds single-group rolls written by the earlier
// build, and they must still animate.
export function notationFor(rollData) {
  if (!rollData || !Array.isArray(rollData.results) || !rollData.results.length) return null;

  // `typeof` first, and NOT String(formula). This was a real defect caught by
  // test-dice3d.js on its first run: String(['2d6']) === '2d6', so an array
  // coerced straight through the regex and animated. Exactly the type-confusion
  // class the M2 canvas audit found with Number([[5]]) === 5 — the same trap, in
  // new code, written by someone who had just finished reading about it.
  if (typeof rollData.formula !== 'string') return null;

  let groups = rollData.groups;
  if (!Array.isArray(groups)) {
    // Legacy single-group row: rebuild the one group from the formula.
    const m = /^(\d+)d(\d+)/i.exec(rollData.formula);
    if (!m) return null;
    groups = [{ count: Number(m[1]), sides: Number(m[2]), results: rollData.results }];
  }
  if (!groups.length || groups.length > 20) return null;

  const parts = [];
  const faces = [];
  let counted = 0;

  for (const g of groups) {
    if (!g || !Array.isArray(g.results)) return null;
    if (!Number.isInteger(g.count) || !Number.isInteger(g.sides)) return null;
    // A group whose declared count disagrees with its results is either a bug or
    // a forged payload. Either way, do not animate a lie.
    if (g.count !== g.results.length) return null;
    if (!RENDERABLE.has(g.sides)) return null;

    // Every face must be a plain integer inside the die's range. These values
    // come from our own server, but this module hands them to a physics engine
    // that will happily be asked for face 9,999 of a d6 — so they are checked at
    // the boundary, the same discipline the server applies to client input,
    // applied in the other direction.
    for (const r of g.results) {
      if (!Number.isInteger(r) || r < 1 || r > g.sides) return null;
    }

    parts.push(`${g.count}d${g.sides}`);
    faces.push(...g.results);
    counted += g.count;
  }

  // The flat array and the groups must describe the same throw.
  if (counted !== rollData.results.length) return null;

  return `${parts.join('+')}@${faces.join(',')}`;
}

// Show a roll. Returns true if it will be animated, false if the caller should
// rely on the text line alone.
export function showRoll(rollData) {
  const notation = notationFor(rollData);
  if (!notation) return false;
  if (!ready) { pendingBeforeReady = notation; return true; }
  throwNow(notation);
  return true;
}

// ---------------------------------------------------------------------------
// LATEST ROLL WINS — and why this replaced a queue
// ---------------------------------------------------------------------------
// The first version queued rolls and played them one at a time, waiting for each
// to settle. Two problems, one cosmetic and one structural:
//
//   1. Pressing roll three times in quick succession produced three animations
//      played back-to-back, so the dice you were waiting for arrived seconds
//      after you asked, and kept arriving after you had stopped caring. Worse,
//      the backlog looked like the app rolling on its own.
//   2. The queue needed a `busy` latch to serialise it, and that latch WAS the
//      bug fixed earlier today: any path that failed to release it wedged every
//      future roll. A watchdog patched the symptom.
//
// Removing the queue removes the latch, and removing the latch removes that
// entire bug class rather than guarding it. There is now no state that can be
// left in a wrong position, because there is no state: a roll sweeps the table
// and throws immediately, every time.
//
// THE TRADE-OFF, stated rather than discovered: at a fast table, one player's
// dice can be swept away by another's before they have settled. That is what a
// physical table does when someone scoops up the dice to throw their own, and
// the chat log still carries every result in order — the authoritative surface
// is unaffected. Immediacy is worth more here than completeness, because the
// animation is a flourish and the log is the record.
async function throwNow(notation) {
  const gen = ++generation;
  // A tumbling die cannot be picked up: the animation loop copies mesh position
  // and rotation from the physics body every frame, so anything set here would
  // be overwritten on the next tick.
  settled = false;
  onPointerUp();
  try {
    // Sweep the table first. The library also clears inside its own rollDice(),
    // but doing it here means the old dice vanish on the same frame as the
    // click rather than after the notation has been parsed and the physics set
    // up — which is the difference between "instant" and "laggy".
    try { box.clearDice(); } catch { /* nothing on the table yet */ }

    const rolling = box.roll(notation);
    // roll() returns undefined when the library refuses the notation outright,
    // so the `.then` guard is load-bearing rather than defensive noise.
    if (rolling && typeof rolling.then === 'function') await rolling;
  } catch (err) {
    // A rendering failure must never break the chat log, which is the
    // authoritative surface. Fail quiet, fall back to text.
    if (gen === generation) console.warn('dice render failed', err);
  }
  // Only the NEWEST throw may declare the table settled. A stale completion
  // arriving after a newer roll started would otherwise mark dice grabbable
  // while they are still in the air.
  if (gen === generation) settled = true;
}

// ---------------------------------------------------------------------------
// PICKING UP AND MOVING SETTLED DICE
// ---------------------------------------------------------------------------
//
// THE CORRECTNESS CONSTRAINT, and it is the whole design: a die's ROTATION IS
// NEVER TOUCHED. Only its position moves.
//
// The face a die shows is the authoritative result the server rolled. If a drag
// were allowed to tumble it — by handing it back to the physics engine, or by
// letting the user spin it — the number on screen could stop matching the number
// in the chat log and in the messages table. That is the precise failure this
// whole layer exists to avoid, and it would arrive dressed as a nice
// interaction. So dragging SLIDES a die across the table. It never re-rolls one,
// and it cannot change what any die shows.
//
// This is also why the drag is safe to do at all: the library stores each die's
// result in `die.result` when it settles, not by reading the mesh's orientation
// later, and this module never reads the library's results anyway — `roll_data`
// from the server is the record. Position is therefore pure decoration, and
// decoration is the only thing a user is allowed to move.
//
// EVENT PLUMBING. The tray is `pointer-events: none` and STAYS that way, so it
// never steals a click from the tracker or the chat panel underneath. Instead
// these listeners sit on `document` in the CAPTURE phase and only swallow an
// event when a die is genuinely under the pointer. Anywhere else, the event
// passes through untouched and the page behaves exactly as if the tray were not
// there.

// Project every settled die to screen space. Returns [{index, x, y}].
function dieScreenPositions() {
  if (!box || !box.diceList || !box.camera) return [];
  const rect = box.container.getBoundingClientRect();
  const out = [];
  for (let i = 0; i < box.diceList.length; i += 1) {
    const die = box.diceList[i];
    if (!die || !die.position) continue;
    // .project() is an instance method on the Vector3 the library already gave
    // us, so no THREE import is needed to reach it.
    const ndc = die.position.clone().project(box.camera);
    out.push({
      index: i,
      x: rect.left + (ndc.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-ndc.y * 0.5 + 0.5) * rect.height,
    });
  }
  return out;
}

// Nearest point within `radius`, or -1. Pure and exported so the suite can
// exercise the picking rule without a browser, a camera or WebGL — the same
// reason notationFor is a separate function rather than inline.
export function nearestWithin(points, x, y, radius) {
  let best = -1;
  let bestDist = radius * radius;
  for (const p of points) {
    const dx = p.x - x;
    const dy = p.y - y;
    const d = dx * dx + dy * dy;
    // Strictly-less-than, so a tie keeps the FIRST match and picking is
    // deterministic rather than dependent on array order changing under it.
    if (d < bestDist) { bestDist = d; best = p.index; }
  }
  return best;
}

function pickDie(clientX, clientY) {
  if (!ready || !settled || !interactive) return -1;
  return nearestWithin(dieScreenPositions(), clientX, clientY, PICK_RADIUS_PX);
}

// Redraw. After the dice settle the library sets `running = false` and its
// animation loop stops, so nothing re-renders on its own — during a drag this
// module owns the frame. That is also why a drag cannot fight the physics: the
// world is not being stepped.
function render() {
  try { box.renderer.render(box.scene, box.camera); } catch { /* torn down */ }
}

function onPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  const i = pickDie(e.clientX, e.clientY);
  if (i < 0) return;

  const die = box.diceList[i];
  // Only now does the tray consume the event. Everywhere else it stays
  // transparent, which is what keeps the UI underneath fully usable.
  e.preventDefault();
  e.stopPropagation();

  drag = {
    die,
    startX: e.clientX,
    startY: e.clientY,
    // NDC of the die at grab time. Its z (depth) is preserved on every move, so
    // unprojecting keeps the die in the same plane and perspective stays
    // correct instead of the die drifting toward or away from the camera.
    startNDC: die.position.clone().project(box.camera),
  };
  document.body.style.cursor = 'grabbing';
}

function onPointerMove(e) {
  if (!drag) {
    // Hover feedback only — never consumes the event.
    if (!ready || !settled || !interactive) return;
    const over = pickDie(e.clientX, e.clientY) >= 0;
    if (over && document.body.style.cursor !== 'grab') document.body.style.cursor = 'grab';
    else if (!over && document.body.style.cursor === 'grab') document.body.style.cursor = '';
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  const rect = box.container.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  // Work in normalised device coordinates so the conversion is exact under the
  // camera's projection rather than an approximated pixels-per-unit scale.
  const dx = ((e.clientX - drag.startX) / rect.width) * 2;
  const dy = -((e.clientY - drag.startY) / rect.height) * 2;

  const p = drag.startNDC.clone();
  p.set(
    Math.max(-1, Math.min(1, drag.startNDC.x + dx)),
    Math.max(-1, Math.min(1, drag.startNDC.y + dy)),
    drag.startNDC.z,
  );
  p.unproject(box.camera);

  // POSITION ONLY. `drag.die.quaternion` is deliberately never assigned — see
  // this section's header. The face stays exactly as the server rolled it.
  drag.die.position.copy(p);

  // Keep the physics body in step. Not needed for rendering (the world is not
  // being stepped while settled), but if a future change restarts the loop, a
  // body left at the old position would snap the die back and the bug would look
  // like a rendering fault rather than a stale body.
  try {
    if (drag.die.body) {
      drag.die.body.position.copy(p);
      drag.die.body.velocity.set(0, 0, 0);
      drag.die.body.angularVelocity.set(0, 0, 0);
    }
  } catch { /* body already removed */ }

  render();
}

function onPointerUp() {
  if (!drag) return;
  drag = null;
  document.body.style.cursor = '';
}

function attachDragHandlers() {
  // Capture phase, on document: these run BEFORE the page's own handlers, so a
  // grab on a die can stop the event reaching the UI — but only when a die was
  // actually hit.
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerUp, true);
}

export function setInteractive(on) {
  interactive = !!on;
  if (!interactive) onPointerUp();
}

export function setColorset(name) {
  if (!box || !COLORSETS.includes(name)) return;
  localStorage_set('vtt.dice.colorset', name);
  box.updateConfig({ theme_colorset: name });
}

export function clearDice() {
  pendingBeforeReady = null;
  settled = false;
  onPointerUp();
  // Bump the generation so an in-flight throw's completion is treated as stale.
  generation += 1;
  if (box && ready) { try { box.clearDice(); } catch { /* not rolling */ } }
}

export function colorsets() { return [...COLORSETS]; }
export function isRenderable(sides) { return RENDERABLE.has(sides); }

// Hand the module to the classic-script harness. combat.js is not a module and
// cannot `import`, so the bridge is a single well-known global set once, here,
// rather than a scatter of window.* assignments.
window.VTTDice = {
  initDice, showRoll, notationFor, setColorset, clearDice, colorsets, isRenderable,
  setInteractive, nearestWithin,
};
document.dispatchEvent(new CustomEvent('vtt-dice-ready'));
