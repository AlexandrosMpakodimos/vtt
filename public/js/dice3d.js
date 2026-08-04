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

// [FINDING, fixed 2026-08-03] A ceiling on how many dice one payload may animate.
//
// notationFor validated each group — count against results length, sides against
// the renderable set, every face against its die — and bounded the number of
// GROUPS at 20. It never bounded the TOTAL. A payload of 20 groups x 5,000 dice
// passed every check and produced a 200 KB notation for 100,000 physics bodies,
// which hangs the browser hard.
//
// Not reachable today: roll_data is written only by the server, whose MAX_DICE
// is 100. But the server's bound and this module's implicit one were three
// ORDERS OF MAGNITUDE apart, and this file's own header claims it checks at the
// boundary "the same discipline the server applies to client input, applied in
// the other direction". It was not doing that. Matched to the server's MAX_DICE
// so the two agree; if they ever diverge the animation falls back to text, which
// is the correct failure.
const MAX_ANIMATED_DICE = 100;

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
    const p = pendingBeforeReady;
    pendingBeforeReady = null;
    throwNow(p.notation, p.color);
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
  // ...and the throw must be one a browser can actually render. See
  // MAX_ANIMATED_DICE above.
  if (counted > MAX_ANIMATED_DICE) return null;

  return `${parts.join('+')}@${faces.join(',')}`;
}

// ---------------------------------------------------------------------------
// PER-PLAYER DICE COLOUR
// ---------------------------------------------------------------------------
//
// Needed NO server change and NO migration, which is worth recording because the
// instinct was to add a column. `campaign_members.color` (VARCHAR(7)) has existed
// since the M2 campaigns migration, is validated by validateColor as #rrggbb, is
// set at join time — and `GET /api/campaigns/:id` already returns every active
// member's colour to ANY member, not just the GM. So the whole feature is a
// client-side join of `message.user_id` against a list the client already holds.
//
// It also introduces no disclosure question. Every recipient of a message can
// already see its `user_id` and `speaker_name`; a colour they could fetch from
// the campaign detail endpoint anyway adds nothing new. Whispers still animate
// only where the message lands, because that is decided upstream in the socket
// fan-out rather than here.
//
// WHY A GLOBAL THEME SWITCH IS ENOUGH. The library themes the whole box, not
// individual dice — but since rolls are latest-wins, only one person's dice are
// ever on the table at a time. Switching the box theme before each throw is
// therefore exactly equivalent to per-die colouring, without fighting the
// library's design.
//
// AND IT IS CHEAP. makeColorSet caches by `name`, so a colour used before is a
// cache hit inside the library; and updateConfig is skipped entirely when the
// incoming colour matches what is already loaded, which is the common case of one
// person rolling repeatedly.

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function normalizeHex(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().toLowerCase();
  // Accept the #abc shorthand a person might type, since validateColor on the
  // server does not — being lenient about INPUT while the server stays strict
  // about what it STORES is the right way round.
  if (/^#[0-9a-f]{3}$/.test(h)) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  return HEX_RE.test(h) ? h : null;
}

// Black or white numerals, whichever stays legible on the given face colour.
// sRGB relative luminance (WCAG), not a naive average: #00ff00 and #0000ff have
// very different perceived brightness despite identical channel arithmetic, and
// getting this wrong makes a player's dice unreadable rather than merely ugly.
export function contrastFor(hex) {
  const h = normalizeHex(hex);
  if (!h) return '#000000';
  const chan = (i) => {
    const c = parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * chan(0) + 0.7152 * chan(1) + 0.0722 * chan(2);
  return L > 0.179 ? '#000000' : '#ffffff';
}

// Lighten (amt > 0) or darken (amt < 0) toward white/black. Used for the outline
// so the edge reads against the face rather than vanishing into it.
export function shade(hex, amt) {
  const h = normalizeHex(hex);
  if (!h) return '#000000';
  const mix = (c) => {
    const target = amt < 0 ? 0 : 255;
    return Math.round(c + (target - c) * Math.abs(amt));
  };
  const out = [0, 1, 2]
    .map((i) => mix(parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('');
  return `#${out}`;
}

// A stable colour for a member who never picked one. `campaign_members.color` is
// nullable and nothing in the join flow forces it, so most members have NULL —
// falling back to grey for everybody would defeat the whole feature. Derived from
// the user id, so it is the same in every browser at the table without any
// server involvement or coordination.
export function stableColorFor(id) {
  const str = String(id || '');
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  // Fixed saturation and lightness so every generated colour is legible and no
  // two players get one that is merely muddy.
  const hue = hash % 360;
  return hslToHex(hue, 0.62, 0.5);
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0; let g = 0; let b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  const hex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// The library's colorset shape. `name` is what makeColorSet caches on, so it must
// be derived from the colour and nothing else — a per-roll unique name would
// defeat that cache and reload the texture on every throw.
export function colorsetFor(hex) {
  const base = normalizeHex(hex) || '#b0b0b0';
  return {
    name: `vtt${base.slice(1)}`,
    background: [base],
    foreground: contrastFor(base),
    outline: shade(base, -0.45),
    texture: 'none',
  };
}

let currentColor = null;

async function applyColor(hex) {
  const wanted = normalizeHex(hex);
  if (!wanted || wanted === currentColor) return;
  try {
    await box.updateConfig({ theme_customColorset: colorsetFor(wanted) });
    currentColor = wanted;
  } catch (err) {
    // A theme that fails to load must not stop the dice appearing. They roll in
    // whatever colour is already loaded, which is wrong but visible — strictly
    // better than a silent nothing.
    console.warn('dice colour failed', err);
  }
}

// Show a roll. Returns true if it will be animated, false if the caller should
// rely on the text line alone.
export function showRoll(rollData, color) {
  const notation = notationFor(rollData);
  if (!notation) return false;
  if (!ready) { pendingBeforeReady = { notation, color }; return true; }
  throwNow(notation, color);
  return true;
}

// ---------------------------------------------------------------------------
// SIMULTANEOUS ROLLS — immediate, never queued
// ---------------------------------------------------------------------------
//
// THIS IS THE THIRD ATTEMPT AT THIS FUNCTION AND THE FIRST TWO FAILED THE SAME
// WAY, so the rule that came out of it is worth stating before the code:
//
//     NOTHING SHARED MAY GATE ON THE LIBRARY'S PROMISE.
//
// Attempt 1 used a `busy` boolean released from an `onRollComplete` callback the
// library does not always fire. Attempt 2 replaced it with a promise chain and a
// `queued` counter, which looked safer — a chain cannot latch — but both still
// `await`ed the promise returned by roll()/add(). When that promise never
// settles, the await never returns: the counter never decrements, the chain
// never advances, and after a few rolls the dice stop appearing while the chat
// log keeps working perfectly. Same symptom, same cause, dressed differently.
//
// So this version does not await it at all. A throw is fire-and-forget; every
// piece of state it needs is captured SYNCHRONOUSLY, and the only thing that
// re-enables dragging is a timer, which always fires. There is no path by which
// one bad throw can affect the next.
//
// HOW SIMULTANEITY WORKS. roll() always sweeps — its rollDice() opens with
// clearDice(). add() does not, and it still applies the "@" predetermined faces.
// Per-player colour survives for free: a mesh's materials are fixed when it is
// created, so a later theme change only affects dice spawned after it.
//
// The one obstacle is that add() calls startClickThrow, which opens with
//
//     this.rolling && (this.clearDice(), this.rolling = !1);
//
// so adding while a throw is still airborne would sweep the table. The previous
// version solved that by WAITING for the previous throw to land, which is
// exactly where the delay came from. Instead, `box.rolling` is set false
// immediately beforehand: the clear is skipped, add() re-simulates every body
// including the ones still moving, and starts one fresh animation loop with a
// new `running` timestamp so the old loop retires itself. Dice already in the
// air are perturbed slightly, which is invisible because they were tumbling
// anyway.
//
// Both spawn paths run synchronously — neither roll() nor add() awaits anything
// before spawning — so diceList is already grown by the time the call returns
// and the batch's start index can be read straight away.

// How long to treat a throw as "in the air" for the purposes of dragging. A
// TIMER rather than the promise, deliberately: a timer cannot fail to fire, so
// dragging can never be permanently disabled by a throw that hangs.
const SETTLE_MS = 2200;
let settleTimer = null;

function throwNow(notation, color) {
  generation += 1;
  settled = false;
  onPointerUp();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { settled = true; }, SETTLE_MS);

  // Colour first, but never block the throw on it. applyColor is cached by the
  // library after first use, so this resolves immediately in the common case;
  // when it does not, the dice still appear on time in whatever colour is
  // already loaded rather than waiting for a texture.
  const go = () => {
    try {
      if (liveDice() + 8 > MAX_TABLE_DICE) sweepOldest();

      const startIndex = box.diceList.length;
      const populated = liveDice() > 0;
      // Defeat add()'s clear-if-rolling. Harmless when nothing is in flight.
      if (populated) box.rolling = false;

      // Fire and forget. The returned promise is deliberately ignored: it is
      // where both previous versions of this function went wrong.
      if (populated) box.add(notation); else box.roll(notation);

      // Recorded AFTER the call, which is safe because spawning is synchronous.
      // A batch owns every die from its start index to the next batch's, so no
      // index arithmetic has to survive an await.
      batches.push({ startIndex, timer: null, fading: false });
      scheduleFade(batches[batches.length - 1]);
    } catch (err) {
      // A rendering failure must never break the chat log, which is the
      // authoritative surface.
      console.warn('dice render failed', err);
    }
  };

  if (color) applyColor(color).then(go, go); else go();
}

// Dice currently on the table, grouped by the throw that created them. Grouping
// is what lets one player's dice fade on their own schedule while another's stay.
let batches = [];

// Total meshes allowed on the table. Beyond this the oldest batch is swept
// immediately rather than waiting out its timer — a table buried in dice is
// worse than a slightly abrupt exit. This is also what bounds a player holding
// the roll button down.
const MAX_TABLE_DICE = 60;

// A batch owns diceList[startIndex .. nextBatch.startIndex), or to the end if it
// is the newest. Derived rather than stored, so it stays correct no matter how
// many dice a throw actually spawned.
function batchRange(batch) {
  const i = batches.indexOf(batch);
  if (i < 0) return [];
  const end = i + 1 < batches.length ? batches[i + 1].startIndex : box.diceList.length;
  const out = [];
  for (let k = batch.startIndex; k < end; k += 1) out.push(k);
  return out;
}

function liveDice() {
  // remove() detaches a mesh from the scene but leaves its slot in diceList, so
  // a null parent is how a removed die is recognised.
  let n = 0;
  for (let i = 0; i < box.diceList.length; i += 1) {
    const d = box.diceList[i];
    if (d && d.parent) n += 1;
  }
  return n;
}

function batchOf(index) {
  for (const b of batches) if (batchRange(b).includes(index)) return b;
  return null;
}

// ---------------------------------------------------------------------------
// AUTO-FADE
// ---------------------------------------------------------------------------
//
// Dice clear themselves a few seconds after they land, which is what makes
// simultaneous rolls sustainable: `add()` never sweeps, so without this the
// table would fill up and stay full.
//
// The fade is driven here rather than by the library, because after a throw
// settles the library sets `running = false` and its animation loop stops — so
// nothing re-renders unless this module asks for a frame. Same reason dragging a
// die needs its own render call.
let fadeAfterMs = 6000;
const FADE_MS = 900;

function setDieOpacity(die, o) {
  const mats = Array.isArray(die.material) ? die.material : [die.material];
  for (const m of mats) {
    if (!m) continue;
    m.transparent = true;
    m.opacity = o;
    m.needsUpdate = true;
  }
  // A solid shadow under a half-invisible die looks like a rendering fault.
  if (o < 1) die.castShadow = false;
}

function scheduleFade(batch) {
  clearTimeout(batch.timer);
  if (!fadeAfterMs) { batch.timer = null; return; }
  batch.timer = setTimeout(() => fadeOut(batch), fadeAfterMs);
}

function fadeOut(batch) {
  if (batch.fading) return;
  batch.fading = true;
  const t0 = (window.performance || Date).now();

  const step = () => {
    // A drag, a clear or a new sweep can retire a batch mid-fade.
    if (!batches.includes(batch)) return;
    const p = Math.min(1, ((window.performance || Date).now() - t0) / FADE_MS);
    for (const i of batchRange(batch)) {
      const d = box.diceList[i];
      if (d && d.parent) setDieOpacity(d, 1 - p);
    }
    render();
    if (p < 1) window.requestAnimationFrame(step);
    else retire(batch);
  };
  window.requestAnimationFrame(step);
}

function retire(batch) {
  // Range FIRST: batchRange is derived from this batch's position in `batches`,
  // so computing it after the filter below would return an empty list and the
  // dice would fade to invisible and then stay on the table forever.
  const live = batchRange(batch).filter((i) => box.diceList[i] && box.diceList[i].parent);
  batches = batches.filter((b) => b !== batch);
  clearTimeout(batch.timer);
  try { if (live.length) box.remove(live); } catch { /* already gone */ }

  // Once the table is empty, reset properly. `remove()` leaves dead slots in
  // diceList forever, so without this a long session would grow it without
  // bound — and the next throw would take the add() path onto an empty table.
  if (!batches.length) {
    try { box.clearDice(); } catch { /* nothing to clear */ }
  }
  render();
}

function sweepOldest() {
  const oldest = batches[0];
  if (oldest) retire(oldest);
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
    // A die removed by the auto-fade keeps its slot in diceList but is detached
    // from the scene, so a null parent means "not on the table any more". Without
    // this check an invisible die would still be grabbable.
    if (!die || !die.position || !die.parent) continue;
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

  // Hold the die's batch open — a result you have picked up to look at should
  // not evaporate in your hand.
  const batch = batchOf(i);
  if (batch) { clearTimeout(batch.timer); batch.timer = null; }

  drag = {
    die,
    batch,
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
  // Release restarts the FULL delay rather than the remainder, so putting a die
  // down does not make it vanish a moment later.
  if (drag.batch && batches.includes(drag.batch) && !drag.batch.fading) {
    scheduleFade(drag.batch);
  }
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

// The manual colour picker. Clearing theme_customColorset is load-bearing:
// loadTheme prefers the custom set whenever one is present, so without this the
// named set would be silently ignored and the picker would look broken.
//
// Also resets currentColor, so the NEXT per-player roll re-applies its colour
// rather than believing it is already loaded.
export function setColorset(name) {
  if (!box || !COLORSETS.includes(name)) return;
  localStorage_set('vtt.dice.colorset', name);
  currentColor = null;
  box.updateConfig({ theme_customColorset: null, theme_colorset: name });
}

export function clearDice() {
  pendingBeforeReady = null;
  settled = false;
  drag = null;
  document.body.style.cursor = '';
  // Bump the generation so an in-flight throw's completion is treated as stale.
  generation += 1;
  for (const b of batches) clearTimeout(b.timer);
  batches = [];
  if (box && ready) { try { box.clearDice(); } catch { /* not rolling */ } }
}

export function colorsets() { return [...COLORSETS]; }

// Seconds a batch sits on the table before fading. 0 disables the fade entirely,
// which is what the harness checkbox does — some tables want the dice to stay.
export function setFadeSeconds(sec) {
  const n = Number(sec);
  fadeAfterMs = Number.isFinite(n) && n > 0 ? n * 1000 : 0;
  for (const b of batches) {
    clearTimeout(b.timer);
    if (fadeAfterMs) scheduleFade(b);
  }
}
export function isRenderable(sides) { return RENDERABLE.has(sides); }

// Hand the module to the classic-script harness. combat.js is not a module and
// cannot `import`, so the bridge is a single well-known global set once, here,
// rather than a scatter of window.* assignments.
window.VTTDice = {
  initDice, showRoll, notationFor, setColorset, clearDice, colorsets, isRenderable,
  setInteractive, nearestWithin, setFadeSeconds,
  normalizeHex, contrastFor, shade, stableColorFor, colorsetFor,
};
document.dispatchEvent(new CustomEvent('vtt-dice-ready'));
