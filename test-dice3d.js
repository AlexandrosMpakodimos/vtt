// 3D dice bridge — unit suite for notationFor().
//
// Needs NO server, NO database and NO browser:
//     node test-dice3d.js
//
// It `eval`s the REAL public/js/dice3d.js with its ES import stripped, the same
// way test-fog-ui.js and test-sheet-ui.js exercise the real client source rather
// than a copy. A copy would pass forever after the original drifted.
//
// WHY THIS FUNCTION IS WORTH A SUITE. notationFor is the only place in the 3D
// layer that makes a decision, and what it decides is what numbers get handed to
// a physics engine. The values arrive from our own server, so the instinct is to
// trust them — but this project's whole discipline is that a boundary is checked
// at the boundary, and this is one. A `roll_data` claiming a d6 landed on 9,999
// must be refused here whether it came from a bug, a forged socket frame, or a
// future change to the server's own bounds.
//
// It is also where the SCOPE BOUNDARY between the server's dice and the
// library's meshes is enforced: the server accepts any die from 1 to 1000 sides,
// the library has meshes for nine of them. That mismatch is permanent and
// deliberate — the server is not narrowed to match a rendering library — so the
// fallback is asserted rather than left to chance.

const fs = require('fs');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// Load the real module source, minus the parts that need a browser.
const src = fs.readFileSync('./public/js/dice3d.js', 'utf8')
  .replace(/^import .*$/m, '')                 // the vendored ES import
  .replace(/^export /gm, '')                   // export keywords
  .replace(/window\.VTTDice[\s\S]*$/m, '');    // the global bridge + dispatchEvent

// eslint-disable-next-line no-eval
const sandbox = eval(`(function () { ${src}; return { notationFor, isRenderable, colorsets, nearestWithin,
    normalizeHex, contrastFor, shade, stableColorFor, colorsetFor }; })()`);
const {
  notationFor, isRenderable, colorsets, nearestWithin,
  normalizeHex, contrastFor, shade, stableColorFor, colorsetFor,
} = sandbox;

// roll_data as the server now writes it: flat results PLUS groups.
const rd = (formula, results, groups) => ({
  formula, results, total: 0,
  groups: groups || [{
    count: results.length,
    sides: Number((/d(\d+)/.exec(formula) || [])[1]),
    results,
  }],
});
// roll_data as the PRE-amendment server wrote it — no groups key at all. These
// rows are already in the messages table and must still animate.
const legacy = (formula, results) => ({ formula, results, total: 0 });

console.log('\n--- the happy path: our roll_data becomes their notation ---');
t('2d6 maps to 2d6@a,b', notationFor(rd('2d6', [4, 2])) === '2d6@4,2');
t('1d20 maps through', notationFor(rd('1d20', [17])) === '1d20@17');
t('4d6 maps through', notationFor(rd('4d6', [1, 2, 3, 4])) === '4d6@1,2,3,4');
t('a modifier in the formula is NOT passed on',
  notationFor(rd('2d6+3', [4, 2])) === '2d6@4,2',
  'the server already folded the modifier into total; passing it again would '
  + 'make the tray disagree with the chat line');
t('a negative modifier is dropped too', notationFor(rd('2d6-1', [4, 2])) === '2d6@4,2');
t('a face at the top of the range is fine', notationFor(rd('1d20', [20])) === '1d20@20');
t('a face at the bottom of the range is fine', notationFor(rd('1d20', [1])) === '1d20@1');

console.log('\n--- renderable shapes: the library\'s nine, asserted not assumed ---');
for (const sides of [2, 3, 4, 6, 8, 10, 12, 20, 100]) {
  t(`d${sides} is renderable`, isRenderable(sides));
  t(`d${sides} produces notation`,
    notationFor(rd(`1d${sides}`, [1])) === `1d${sides}@1`);
}

console.log('\n--- the mismatch between two bounds, handled by falling back ---');
// The server accepts 1..1000 sides. The library has nine meshes. Neither is
// wrong; the fallback is the answer.
for (const sides of [1, 5, 7, 9, 14, 30, 50, 1000]) {
  t(`d${sides} is legal server-side but NOT renderable`, !isRenderable(sides));
  t(`d${sides} returns null so the caller prints instead`,
    notationFor(rd(`1d${sides}`, [1])) === null);
}

console.log('\n--- refusals: a payload that does not describe a real roll ---');
t('flat modifier (no dice) is not animated', notationFor(rd('+2', [])) === null);
t('empty results refused', notationFor(rd('2d6', [])) === null);
t('missing results refused', notationFor({ formula: '2d6' }) === null);
t('missing formula refused', notationFor({ results: [1, 2] }) === null);
t('null refused', notationFor(null) === null);
t('undefined refused', notationFor(undefined) === null);
t('non-array results refused', notationFor(rd('2d6', '4,2')) === null);

console.log('\n--- refusals: count/results disagreement (bug or forgery) ---');
// Exercised through the LEGACY path, where the count comes from the formula
// string and can therefore disagree with the results. (With `groups` present
// the same check runs per group — see the multi-group block below.)
t('formula says 2 dice, 3 results -> refused', notationFor(legacy('2d6', [1, 2, 3])) === null);
t('formula says 3 dice, 2 results -> refused', notationFor(legacy('3d6', [1, 2])) === null);
t('formula says 1 die, 5 results -> refused', notationFor(legacy('1d20', [1, 2, 3, 4, 5])) === null);

console.log('\n--- refusals: a face the die does not have ---');
t('d6 landing on 7 refused', notationFor(rd('1d6', [7])) === null);
t('d6 landing on 0 refused', notationFor(rd('1d6', [0])) === null);
t('d6 landing on -1 refused', notationFor(rd('1d6', [-1])) === null);
t('d20 landing on 9999 refused', notationFor(rd('1d20', [9999])) === null);
t('one bad face in a valid set refuses the WHOLE roll',
  notationFor(rd('3d6', [4, 99, 2])) === null,
  'animating two of three dice would be a lie about the third');

console.log('\n--- refusals: type confusion (the BOPLA class, applied outbound) ---');
t('fractional face refused', notationFor(rd('1d6', [3.5])) === null);
t('string face refused', notationFor(rd('1d6', ['3'])) === null);
t('array-wrapped face refused', notationFor(rd('1d6', [[3]])) === null);
t('null face refused', notationFor(rd('1d6', [null])) === null);
t('boolean face refused', notationFor(rd('1d6', [true])) === null);
t('NaN face refused', notationFor(rd('1d6', [NaN])) === null);
t('Infinity face refused', notationFor(rd('1d6', [Infinity])) === null);
t('object formula refused', notationFor({ formula: { d: 6 }, results: [3] }) === null);
t('array formula refused', notationFor({ formula: ['2d6'], results: [1, 2] }) === null);

console.log('\n--- notation injection: the formula string never reaches their parser ---');
// STRONGER PROPERTY since the multi-group change, and worth stating rather than
// leaving implicit: the notation handed to the library is REBUILT from the
// numeric `groups` (count and sides, both checked as integers), so the stored
// formula STRING is never concatenated into it. The library's parseNotation
// splits on "@" itself, and a formula carrying its own "@" or extra groups now
// has no path into that string at all.
const inject = (formula) => notationFor({
  formula,
  results: [1, 1],
  total: 0,
  groups: [{ count: 2, sides: 6, results: [1, 1] }],
});
t('an embedded @ in the formula cannot smuggle faces through',
  inject('2d6@6,6') === '2d6@1,1');
t('an extra dice group in the formula string is ignored',
  inject('2d6+1d4') === '2d6@1,1');
t('trailing junk in the formula string is ignored',
  inject('2d6; DROP TABLE messages') === '2d6@1,1');
t('leading junk in the formula string is ignored',
  inject('x2d6') === '2d6@1,1');
t('an EMPTY formula still yields correct notation from groups',
  inject('') === '2d6@1,1',
  'proof the string is not consulted when groups are present');

console.log('\n--- ...but the LEGACY path still parses the formula, so it stays anchored ---');
t('legacy leading junk refuses outright', notationFor(legacy('x2d6', [1, 2])) === null);
t('legacy embedded @ takes only the anchored NdM',
  notationFor(legacy('2d6@6,6', [1, 1])) === '2d6@1,1');
t('legacy trailing junk takes only the anchored NdM',
  notationFor(legacy('2d6; DROP', [1, 2])) === '2d6@1,2');

console.log('\n--- multiple dice groups (the 2026-08-03 amendment) ---');
const G = (formula, groups) => ({
  formula,
  results: groups.flatMap((g) => g.results),
  total: 0,
  groups,
});
t('1d20+1d6 becomes one notation',
  notationFor(G('1d20+1d6', [
    { count: 1, sides: 20, results: [17] },
    { count: 1, sides: 6, results: [4] },
  ])) === '1d20+1d6@17,4');
t('three groups map in order',
  notationFor(G('1d20+2d6+1d4', [
    { count: 1, sides: 20, results: [11] },
    { count: 2, sides: 6, results: [3, 5] },
    { count: 1, sides: 4, results: [2] },
  ])) === '1d20+2d6+1d4@11,3,5,2');
t('a modifier in the formula is still not passed on',
  notationFor(G('1d20+1d6+3', [
    { count: 1, sides: 20, results: [9] },
    { count: 1, sides: 6, results: [1] },
  ])) === '1d20+1d6@9,1');
t('ONE non-renderable group refuses the WHOLE roll',
  notationFor(G('1d20+1d7', [
    { count: 1, sides: 20, results: [9] },
    { count: 1, sides: 7, results: [5] },
  ])) === null,
  'animating the d20 and silently dropping the d7 would misreport the throw');
t('a bad face in the second group refuses the whole roll',
  notationFor(G('1d20+1d6', [
    { count: 1, sides: 20, results: [9] },
    { count: 1, sides: 6, results: [99] },
  ])) === null);
t('a group whose count disagrees with its results is refused',
  notationFor(G('1d20+2d6', [
    { count: 1, sides: 20, results: [9] },
    { count: 2, sides: 6, results: [3] },
  ])) === null);
t('flat results disagreeing with the groups is refused',
  notationFor({
    formula: '1d20+1d6',
    results: [9, 1, 7],
    total: 0,
    groups: [
      { count: 1, sides: 20, results: [9] },
      { count: 1, sides: 6, results: [1] },
    ],
  }) === null);
t('non-integer sides refused',
  notationFor(G('1d20', [{ count: 1, sides: 20.5, results: [9] }])) === null);
t('absurd group count refused',
  notationFor(G('x', Array.from({ length: 21 },
    () => ({ count: 1, sides: 6, results: [1] })))) === null);

console.log('\n--- legacy rows written before the amendment still animate ---');
t('a legacy single-group row works', legacy('2d6', [4, 2]) && notationFor(legacy('2d6', [4, 2])) === '2d6@4,2');
t('a legacy row with a modifier drops the modifier',
  notationFor(legacy('2d6+3', [4, 2])) === '2d6@4,2');
t('a legacy row with a bad face is still refused',
  notationFor(legacy('1d6', [9])) === null);
t('a legacy row with a non-renderable die is still refused',
  notationFor(legacy('1d7', [3])) === null);

console.log('\n--- picking a die to drag (pure geometry, no browser needed) ---');
// Dice are picked by projecting each centre to screen space and taking the
// nearest within a radius, because the library exposes no Raycaster and three.js
// is bundled inside it rather than importable. Extracted as a pure function
// precisely so this rule can be probed without WebGL.
const P = [
  { index: 0, x: 100, y: 100 },
  { index: 1, x: 200, y: 100 },
  { index: 2, x: 100, y: 200 },
];
t('a click dead on a die picks it', nearestWithin(P, 100, 100, 40) === 0);
t('a click dead on another picks that one', nearestWithin(P, 200, 100, 40) === 1);
t('a click just inside the radius still picks', nearestWithin(P, 130, 100, 40) === 0);
t('a click just outside the radius picks NOTHING',
  nearestWithin(P, 150, 100, 40) === -1,
  'empty space must fall through to the UI underneath, not grab the nearest die');
t('exactly at the radius is OUTSIDE (strict inequality)',
  nearestWithin(P, 140, 100, 40) === -1);
t('the NEAREST wins when two are in range',
  nearestWithin(P, 160, 100, 100) === 1);
t('...and from the other side', nearestWithin(P, 140, 100, 100) === 0);
t('a tie keeps the FIRST, so picking is deterministic',
  nearestWithin([{ index: 7, x: 0, y: 0 }, { index: 9, x: 0, y: 0 }], 0, 0, 50) === 7);
t('an empty table picks nothing', nearestWithin([], 100, 100, 40) === -1);
t('a zero radius picks nothing even dead-on', nearestWithin(P, 100, 100, 0) === -1);
t('vertical distance counts too', nearestWithin(P, 100, 145, 40) === -1);
t('diagonal distance is euclidean, not a bounding box',
  nearestWithin(P, 130, 130, 40) === -1,
  'dx=30, dy=30 is 42px away — inside a box, outside a circle');
t('index is returned, not array position',
  nearestWithin([{ index: 5, x: 10, y: 10 }], 10, 10, 20) === 5);

console.log('\n--- per-player colour: hex normalisation ---');
t('#RRGGBB accepted', normalizeHex('#A1B2C3') === '#a1b2c3');
t('lowercased', normalizeHex('#FFFFFF') === '#ffffff');
t('trimmed', normalizeHex('  #123456  ') === '#123456');
t('#abc shorthand expanded', normalizeHex('#f00') === '#ff0000');
t('missing hash refused', normalizeHex('a1b2c3') === null);
t('short hex refused', normalizeHex('#12345') === null);
t('long hex refused', normalizeHex('#1234567') === null);
t('non-hex chars refused', normalizeHex('#gggggg') === null);
t('non-string refused', normalizeHex(0xa1b2c3) === null);
t('null refused', normalizeHex(null) === null);
t('array refused (type confusion)', normalizeHex(['#a1b2c3']) === null);

console.log('\n--- per-player colour: legibility is the real failure mode ---');
// Numerals unreadable on a player's dice is worse than no colour at all, so the
// contrast rule uses sRGB relative luminance (WCAG) rather than a naive channel
// average — #00ff00 and #0000ff differ hugely in perceived brightness despite
// identical arithmetic under an average.
t('white face gets black numerals', contrastFor('#ffffff') === '#000000');
t('black face gets white numerals', contrastFor('#000000') === '#ffffff');
t('bright green is a LIGHT colour -> black numerals', contrastFor('#00ff00') === '#000000');
t('pure blue is a DARK colour -> white numerals', contrastFor('#0000ff') === '#ffffff',
  'an average of the channels would wrongly treat these two as equally bright');
// [CORRECTED] This probe originally asserted WHITE on red, on intuition. The
// maths disagrees and the maths is right: pure red has luminance 0.2126, giving
// 5.25:1 against black text versus only 4.00:1 against white. Red sits just
// above the 0.179 crossover, so it is a LIGHT colour for contrast purposes even
// though it does not look like one. Recorded rather than quietly flipped,
// because "the test was wrong" is worth exactly as much scrutiny as "the code
// was wrong" — and here the suite caught the author, not the implementation.
t('pure red -> BLACK numerals (5.25:1 vs 4.00:1, not intuition)',
  contrastFor('#ff0000') === '#000000');
t('a DARK red does get white numerals', contrastFor('#800000') === '#ffffff');
t('bright yellow -> black numerals', contrastFor('#ffff00') === '#000000');
t('mid grey resolves either way, but deterministically',
  contrastFor('#808080') === contrastFor('#808080'));
t('an invalid colour still returns a usable value', contrastFor('nonsense') === '#000000');

console.log('\n--- per-player colour: outline shading ---');
t('darkening moves toward black', shade('#ffffff', -1) === '#000000');
t('lightening moves toward white', shade('#000000', 1) === '#ffffff');
t('zero is a no-op', shade('#a1b2c3', 0) === '#a1b2c3');
t('a half-darkened mid colour stays in range', /^#[0-9a-f]{6}$/.test(shade('#3366cc', -0.45)));
t('the outline actually DIFFERS from the face',
  shade('#3366cc', -0.45) !== '#3366cc',
  'an outline the same colour as the face is no outline at all');
t('an invalid colour still returns a hex', /^#[0-9a-f]{6}$/.test(shade('nope', -0.4)));

console.log('\n--- per-player colour: the fallback for members with no colour ---');
// campaign_members.color is nullable and nothing forces it at join time, so the
// fallback is the COMMON path, not an edge case.
t('a stable colour is produced', /^#[0-9a-f]{6}$/.test(stableColorFor('abc')));
t('the SAME id gives the SAME colour every time',
  stableColorFor('user-1') === stableColorFor('user-1'),
  'every browser at the table must agree without server coordination');
t('different ids give different colours',
  stableColorFor('user-1') !== stableColorFor('user-2'));
t('a realistic uuid works',
  /^#[0-9a-f]{6}$/.test(stableColorFor('11111111-1111-4111-8111-111111111111')));
t('empty id still returns a colour', /^#[0-9a-f]{6}$/.test(stableColorFor('')));
t('undefined id still returns a colour', /^#[0-9a-f]{6}$/.test(stableColorFor(undefined)));
// Spread matters: a hash that collapsed everyone onto one hue would pass every
// probe above and still defeat the feature.
const spread = new Set(Array.from({ length: 40 }, (_, i) => stableColorFor(`u${i}`)));
t('40 ids produce many distinct colours', spread.size >= 30, `got ${spread.size}`);

console.log('\n--- per-player colour: the library colorset ---');
const cs = colorsetFor('#3366cc');
t('background is the player colour', cs.background[0] === '#3366cc');
t('foreground is a contrast choice', cs.foreground === contrastFor('#3366cc'));
t('outline is a shade of the player colour', cs.outline === shade('#3366cc', -0.45));
t('texture is none (no image to load)', cs.texture === 'none');
t('name is DERIVED from the colour, so the library can cache it',
  colorsetFor('#3366cc').name === colorsetFor('#3366cc').name,
  'a per-roll unique name would reload the texture on every throw');
t('different colours get different cache names',
  colorsetFor('#3366cc').name !== colorsetFor('#cc3366').name);
t('an invalid colour still yields a usable colorset',
  /^#[0-9a-f]{6}$/.test(colorsetFor('nonsense').background[0]));

console.log('\n--- DoS: the total-dice ceiling (finding, 2026-08-03) ---');
// notationFor validated each group and bounded the group COUNT at 20, but never
// the total. 20 groups x 5,000 dice passed everything and produced a 200 KB
// notation for 100,000 physics bodies. Not reachable today — roll_data is
// server-written and the server caps at 100 — but the two bounds were three
// orders of magnitude apart while this file claimed to check at the boundary.
const bulk = (groups, per) => {
  const g = []; const flat = [];
  for (let i = 0; i < groups; i += 1) {
    const res = Array.from({ length: per }, () => 1);
    g.push({ count: per, sides: 6, results: res });
    flat.push(...res);
  }
  return { formula: 'x', results: flat, total: 0, groups: g };
};
t('100 dice in one group is accepted (matches the server MAX_DICE)',
  notationFor(bulk(1, 100)) !== null);
t('101 dice in one group is REFUSED', notationFor(bulk(1, 101)) === null);
t('5,000 dice in one group is REFUSED', notationFor(bulk(1, 5000)) === null);
t('20 groups x 1,000 is REFUSED (the total, not just the group count)',
  notationFor(bulk(20, 1000)) === null);
t('20 groups x 5,000 is REFUSED', notationFor(bulk(20, 5000)) === null);
t('10 groups x 10 = 100 is still fine', notationFor(bulk(10, 10)) !== null);
t('10 groups x 11 = 110 is refused', notationFor(bulk(10, 11)) === null);

console.log('\n--- SOURCE INVARIANT: nothing may gate on the library promise ---');
// This bug has recurred TWICE with different disguises — a `busy` boolean, then
// a promise chain with a counter — and both times the mechanism was identical:
// `await` on the promise returned by box.roll()/box.add(). When that promise
// never settles, the await never returns, shared state is never released, and
// the dice silently stop appearing while the chat log keeps working.
//
// A behavioural probe cannot catch it (it needs WebGL and a hung physics
// simulation), so this is a SOURCE-LEVEL guard instead. Crude, and worth it:
// a rule that has been broken twice needs something that fails loudly when it is
// broken a third time.
const raw = fs.readFileSync('./public/js/dice3d.js', 'utf8');
const code = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
t('no `await box.roll(...)`', !/await\s+box\s*\.\s*roll\s*\(/.test(code));
t('no `await box.add(...)`', !/await\s+box\s*\.\s*add\s*\(/.test(code));
t('no `await rolling` style indirection',
  !/await\s+(rolling|throwing|thrown)\b/.test(code));
t('the throw path is not an async function',
  !/async\s+function\s+throwNow/.test(code),
  'throwNow must be fire-and-forget; making it async invites an await back in');
t('no busy/queued latch variable survives',
  !/\blet\s+(busy|queued)\b/.test(code));
t('drag re-enablement uses a timer, which cannot fail to fire',
  /setTimeout\(\(\)\s*=>\s*\{\s*settled\s*=\s*true/.test(code));
t('box.rolling is cleared before add(), so a mid-air add does not sweep',
  /box\.rolling\s*=\s*false/.test(code));

console.log('\n--- colour sets ---');
t('colorsets returns a non-empty list', colorsets().length > 0);
t('colorsets returns a COPY (caller cannot mutate the module\'s list)',
  (() => { const a = colorsets(); a.push('nope'); return colorsets().length === a.length - 1; })());
t('white is available (the default)', colorsets().includes('white'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
