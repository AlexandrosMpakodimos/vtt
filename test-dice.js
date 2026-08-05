// Dice grammar + M5 validators — unit suite.
//
// Needs NO server and NO database (same family as test-fog-validators.js):
//     node test-dice.js
//
// Why this is its own file rather than assertions inside test-chat.js: the
// grammar is where malformed input gets exercised, and the functional suite
// sends VALID formulas through HTTP by construction. That is exactly the gap
// that let the M2 canvas type-confusion bug survive 227 functional assertions.
//
// The scope boundary is asserted here as a POSITIVE PROPERTY, not left as a
// comment: every notation this project deliberately does not support has a probe
// proving it is REFUSED. If a later session adds keep-highest, these fail loudly
// rather than the exclusion quietly eroding.

const d = require('./src/services/dice.js');
const v = require('./src/services/validators.js');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

console.log('\n--- dice grammar: what IS supported ---');
const p = (f) => d.parseFormula(f);
// rng that always returns the max, so arithmetic assertions are exact rather
// than depending on random values. (The later `maxRng` is the same function;
// this one is hoisted because the multi-group block runs before it.)
const maxRngEarly = (max) => max;
// [CHANGED 2026-08-03] The parse result is now {groups:[{count,sides}], modifier}
// rather than a flat {count, sides, modifier}, because a formula can hold more
// than one group. These probes were UPDATED, not deleted — a contract change
// invalidates fixtures as well as assertions, and this is what that looks like.
t('2d6+3 parses', p('2d6+3').groups[0].count === 2 && p('2d6+3').groups[0].sides === 6
  && p('2d6+3').modifier === 3);
t('2d6-1 parses a negative modifier', p('2d6-1').modifier === -1);
t('d20 defaults count to 1', p('d20').groups[0].count === 1 && p('d20').groups[0].sides === 20);
t('1d20 explicit count', p('1d20').groups[0].count === 1);
t('bare number is a flat modifier', p('5').groups.length === 0 && p('5').modifier === 5);
t('+2 is a flat modifier', p('+2').modifier === 2);
t('-2 is a flat modifier', p('-2').modifier === -2);
t('whitespace tolerated', p('  2d6 + 3  ').modifier === 3);
t('uppercase D tolerated', p('2D6').groups[0].sides === 6);
t('100d1000 at both bounds accepted', p('100d1000').groups[0].count === 100);

console.log('\n--- dice grammar: the SCOPE BOUNDARY, asserted not assumed ---');
t('keep-highest REFUSED (4d6kh3)', !!p('4d6kh3').error);
t('drop-lowest REFUSED (4d6dl1)', !!p('4d6dl1').error);
t('exploding REFUSED (3d6!)', !!p('3d6!').error);
t('reroll REFUSED (2d6r1)', !!p('2d6r1').error);
t('advantage keyword REFUSED', !!p('adv').error);
// [CHANGED 2026-08-03] This probe previously asserted that multiple groups were
// REFUSED. The boundary moved by explicit decision — see the dice.js header. It
// is inverted here rather than deleted, so the change is visible in the diff
// instead of a probe quietly vanishing.
t('multiple groups NOW ACCEPTED (scope amendment)', !p('2d6+1d4').error);
t('target-number REFUSED (5d10>7)', !!p('5d10>7').error);
t('multiplication REFUSED (2d6*2)', !!p('2d6*2').error);
t('parentheses REFUSED', !!p('(2d6)+3').error);

console.log('\n--- multiple dice groups (the 2026-08-03 amendment) ---');
t('1d20+1d6 parses two groups', p('1d20+1d6').groups.length === 2);
t('...with the right shapes',
  p('1d20+1d6').groups[0].sides === 20 && p('1d20+1d6').groups[1].sides === 6);
t('three groups plus a modifier', p('1d20+1d6+2d4-1').groups.length === 3
  && p('1d20+1d6+2d4-1').modifier === -1);
t('a single group still yields one group', p('2d6').groups.length === 1);
t('a flat formula yields no groups', p('5').groups.length === 0);
t('results are FLAT across groups', d.roll('1d20+2d6', maxRngEarly).results.length === 3);
t('groups carry their own results',
  d.roll('1d20+2d6', maxRngEarly).groups[1].results.length === 2);
t('total sums every group plus the modifier', (() => {
  const r = d.roll('1d20+2d6+3', maxRngEarly);
  return r.total === r.results.reduce((a, b) => a + b, 0) + 3;
})());
t('canonical formula round-trips a multi-group roll',
  d.roll('  1D20 + 2d6 - 1 ', maxRngEarly).formula === '1d20+2d6-1');

console.log('\n--- what multi-group did NOT open up ---');
t('subtracting DICE still refused (2d6-1d4)', !!p('2d6-1d4').error);
t('a group after the modifier refused (2d6+3+1d4)', !!p('2d6+3+1d4').error);
t('groups must be joined with + (2d6 1d4)', !!p('2d6 1d4').error);
t('MAX_DICE bounds the TOTAL, not each group', !!p('50d6+60d6').error);
t('...and a legal total across groups is accepted', !p('50d6+50d6').error);
t('too many kinds of dice refused',
  !!p(Array.from({ length: v.length ? 11 : 11 }, () => '1d6').join('+')).error);
t('ten kinds accepted (at the bound)',
  !p(Array.from({ length: 10 }, () => '1d6').join('+')).error);

console.log('\n--- dice bounds: payload/CPU abuse, the MAX_FOG_POINTS analogue ---');
t('101 dice refused (over MAX_DICE)', !!p('101d6').error);
t('100 dice accepted (at the bound)', !p('100d6').error);
t('1001 sides refused', !!p('2d1001').error);
t('1000 sides accepted (at the bound)', !p('2d1000').error);
t('zero dice refused', !!p('0d6').error);
t('zero-sided die refused', !!p('2d0').error);
t('999999d999999 refused', !!p('999999d999999').error);
t('over-long formula refused', !!p(`2d6+${'9'.repeat(40)}`).error);
t('modifier past bound refused', !!p('2d6+99999').error);

console.log('\n--- dice: type confusion (the BOPLA class from the M2 audit) ---');
t('non-string refused (number)', !!p(20).error);
t('non-string refused (array)', !!p(['2d6']).error);
t('non-string refused (object)', !!p({ formula: '2d6' }).error);
t('null refused', !!p(null).error);
t('undefined refused', !!p(undefined).error);
t('empty string refused', !!p('').error);
t('whitespace-only refused', !!p('   ').error);
t('trailing junk refused (anchored regex)', !!p('2d6; DROP TABLE messages').error);
t('leading junk refused', !!p('x2d6').error);

console.log('\n--- rolling: arithmetic and shape (rng injected, so this is exact) ---');
// rng returns the max every time, so the result is fully determined and `total`
// can be asserted against a computed value rather than a literal guessed here.
const maxRng = (max) => max;
const r1 = d.roll('2d6+3', maxRng);
t('results has one entry per die', r1.results.length === 2);
t('total = sum(results) + modifier',
  r1.total === r1.results.reduce((a, b) => a + b, 0) + 3, JSON.stringify(r1));
// [CHANGED 2026-08-03] roll_data gained `groups`. The three original keys are
// UNCHANGED and still asserted — `groups` is additive, so a row written by the
// earlier build still reads correctly and break-combat.js's roll_data probes
// were untouched by this amendment.
t('roll_data keeps its original three keys',
  'formula' in r1 && 'results' in r1 && 'total' in r1);
t('roll_data adds groups, and nothing else',
  'groups' in r1 && Object.keys(r1).length === 4, Object.keys(r1).join(','));
t('results stays FLAT (the shape audited assertions read)',
  Array.isArray(r1.results) && r1.results.every((x) => typeof x === 'number'));
const r2 = d.roll('4d6', maxRng);
t('no modifier totals the dice alone',
  r2.total === r2.results.reduce((a, b) => a + b, 0));
const r3 = d.roll('1d20-2', maxRng);
t('negative modifier subtracts', r3.total === r3.results[0] - 2);
const r4 = d.roll('5', maxRng);
t('flat formula rolls no dice', r4.results.length === 0 && r4.total === 5);
t('a bad formula returns an error, not a roll', !!d.roll('4d6kh3', maxRng).error);

console.log('\n--- rolling: canonical formula (two identical rolls log identically) ---');
t('spacing normalised', d.roll('  2d6 + 3 ', maxRng).formula === '2d6+3');
t('implicit count made explicit', d.roll('d20', maxRng).formula === '1d20');
t('zero modifier omitted', d.roll('2d6+0', maxRng).formula === '2d6');
t('negative modifier kept', d.roll('2d6-1', maxRng).formula === '2d6-1');
t('uppercase normalised', d.roll('2D6', maxRng).formula === '2d6');

console.log('\n--- rolling: real randomness stays inside the die ---');
// A measured property over many rolls, not a literal: every value must be a
// whole number in 1..sides. Asserting a specific sequence would be asserting a
// literal guessed in advance, which this project's probe rules reject.
let inRange = true; let allInt = true;
const seen = new Set();
for (let i = 0; i < 500; i += 1) {
  const r = d.roll('1d6');
  const value = r.results[0];
  if (value < 1 || value > 6) inRange = false;
  if (!Number.isInteger(value)) allInt = false;
  seen.add(value);
}
t('500 d6 rolls all within 1..6', inRange);
t('500 d6 rolls all integers', allInt);
// Not a randomness quality test — just proof the roller is not constant, which
// a stubbed or broken implementation would be.
t('500 d6 rolls produced more than one distinct face', seen.size > 1, `saw ${seen.size}`);

console.log('\n--- M5 validators: hp_override ---');
t('null hp_override accepted (means "no per-fight HP")', v.validateHpOverride(null).value === null);
t('empty string treated as null', v.validateHpOverride('').value === null);
t('undefined is distinguishable from null',
  v.validateHpOverride(undefined).value === undefined);
t('0 accepted', v.validateHpOverride(0).value === 0);
t('negative accepted (hp is never clamped in this project)',
  v.validateHpOverride(-5).value === -5);
t('numeric string accepted', v.validateHpOverride('12').value === 12);
t('fractional refused', !!v.validateHpOverride(1.5).error);
t('array-wrapped refused (type confusion)', !!v.validateHpOverride([[5]]).error);
t('boolean refused', !!v.validateHpOverride(true).error);
t('past upper bound refused', !!v.validateHpOverride(10000).error);
t('past lower bound refused', !!v.validateHpOverride(-10000).error);

console.log('\n--- M5 validators: message type (allow-list, NOT a confidentiality gate) ---');
t('chat accepted', v.validateMessageType('chat').value === 'chat');
t('roll accepted', v.validateMessageType('roll').value === 'roll');
t('system accepted', v.validateMessageType('system').value === 'system');
t('whisper accepted', v.validateMessageType('whisper').value === 'whisper');
t('absent defaults to chat', v.validateMessageType(undefined).value === 'chat');
t('case tolerated', v.validateMessageType('WHISPER').value === 'whisper');
t('unknown type refused', !!v.validateMessageType('shout').error);
t('non-string refused', !!v.validateMessageType(['chat']).error);

console.log('\n--- M5 validators: message content ---');
t('ordinary line accepted', v.validateMessageContent('I attack the goblin').value === 'I attack the goblin');
t('trimmed', v.validateMessageContent('  hi  ').value === 'hi');
t('empty refused', !!v.validateMessageContent('').error);
t('whitespace-only refused', !!v.validateMessageContent('   ').error);
t('non-string refused', !!v.validateMessageContent({ content: 'x' }).error);
t('at the bound accepted', !v.validateMessageContent('x'.repeat(v.MAX_MESSAGE_LENGTH)).error);
t('past the bound refused', !!v.validateMessageContent('x'.repeat(v.MAX_MESSAGE_LENGTH + 1)).error);

console.log('\n--- M5 validators: whisper_to (a DISCLOSURE list, so shape is strict) ---');
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
t('absent means everyone (null)', v.validateWhisperTo(undefined).value === null);
t('null means everyone', v.validateWhisperTo(null).value === null);
t('empty array NORMALISED to null (one representation of "public")',
  v.validateWhisperTo([]).value === null);
t('one uuid accepted', v.validateWhisperTo([U1]).value.length === 1);
t('two uuids accepted', v.validateWhisperTo([U1, U2]).value.length === 2);
t('duplicates collapsed', v.validateWhisperTo([U1, U1]).value.length === 1);
t('non-array refused', !!v.validateWhisperTo(U1).error);
t('non-uuid element refused', !!v.validateWhisperTo(['not-a-uuid']).error);
t('non-string element refused', !!v.validateWhisperTo([[U1]]).error);
t('null element refused', !!v.validateWhisperTo([null]).error);
t('object element refused', !!v.validateWhisperTo([{ id: U1 }]).error);
t('over the recipient bound refused',
  !!v.validateWhisperTo(Array.from({ length: v.MAX_WHISPER_RECIPIENTS + 1 },
    (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`)).error);

console.log('\n--- SHARED validators: coercion before testing (finding 2026-08-04) ---');
// A validator that COERCES before testing is defeated by a single-element
// array, because String(['x']) === 'x' and Number([5]) === 5. The M2 canvas
// audit found this in the NUMERIC validators and fixed those; the STRING ones
// were left, and stayed wrong until a probe written for the M6 colour picker
// hit validateColor. Probed here, in the pure suite, so the class cannot come
// back on any of the four.
t('validateColor refuses an array', !!v.validateColor(['#ffffff']).error);
t('validateColor refuses a number', !!v.validateColor(0xffffff).error);
t('validateColor refuses an object', !!v.validateColor({ hex: '#ffffff' }).error);
t('validateColor still accepts a hex string', v.validateColor('#A1B2C3').value === '#a1b2c3');
t('validateColor still treats null as "clear"', v.validateColor(null).value === null);
t('validateColor still treats empty as "clear"', v.validateColor('').value === null);
t('validateImageUrl refuses an array', !!v.validateImageUrl(['https://a.test/x.png'], 'img_url').error);
t('validateImageUrl refuses a number', !!v.validateImageUrl(123, 'img_url').error);
t('validateImageUrl still accepts a url',
  v.validateImageUrl('https://a.test/x.png', 'img_url').value === 'https://a.test/x.png');
t('validateImageUrl still treats null as absent',
  v.validateImageUrl(null, 'img_url').value === null);
// The numeric pair, already fixed in M2 — asserted so a refactor cannot undo it.
t('validateInt refuses a nested array', !!v.validateInt([[5]], { min: 0, max: 10, field: 'x' }).error);
t('validateGridCoord refuses an array', !!v.validateGridCoord([5], 'x').error);

console.log('\n--- M6 validators: the scene grid ---');
t('grid accepts a full descriptor',
  !v.validateGrid({ size: 70, type: 'square', color: '#ABCDEF', opacity: 0.5, offset_x: -3, offset_y: 4 }).error);
t('grid.color array refused (via validateColor)', !!v.validateGrid({ color: ['#ffffff'] }).error);
t('grid refuses an array', !!v.validateGrid([1, 2]).error);
t('grid refuses a string', !!v.validateGrid('square').error);
t('grid strips unknown keys rather than storing them',
  Object.keys(v.validateGrid({ size: 70, junk: 'x' }).value).join(',') === 'size');
t('grid.size bound low', !!v.validateGrid({ size: 4 }).error);
t('grid.size bound high', !!v.validateGrid({ size: 501 }).error);
t('grid.opacity bound', !!v.validateGrid({ opacity: 2 }).error);
t('grid offset bound', !!v.validateGrid({ offset_x: 99999 }).error);
t('grid.type allow-list', !!v.validateGrid({ type: 'octagon' }).error);
t('img frame accepts a fraction', v.validateImgFrame(0.25, 'img_offset_x').value === 0.25);
t('img frame bound', !!v.validateImgFrame(9, 'img_offset_x').error);
t('img frame refuses an array', !!v.validateImgFrame([[1]], 'img_offset_x').error);
t('img scale accepts', v.validateImgScale(1.4).value === 1.4);
t('img scale bound low', !!v.validateImgScale(0.01).error);
t('img scale bound high', !!v.validateImgScale(99).error);

console.log('\n--- M5 validators: combat name ---');
t('name optional', v.validateCombatName(undefined).value === null);
t('name accepted', v.validateCombatName('Ambush at the bridge').value === 'Ambush at the bridge');
t('over-long name refused', !!v.validateCombatName('x'.repeat(101)).error);
t('non-string refused', !!v.validateCombatName(['x']).error);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
