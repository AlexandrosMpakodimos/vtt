// Fog geometry validation — unit suite for validateFogType / validateFogPoints.
//
// Needs NO server and NO database (same family as test-shortcuts.js /
// test-bulk-place.js / test-marquee.js, which are pure/jsdom):
//     node test-fog-validators.js
//
// Why this exists as its own file rather than inside the eventual test-fog.js
// functional suite: geometry validation is the layer where the M2 canvas audit
// found its type-confusion vulnerability (Number([[5]]) === 5 smuggling arrays
// into numeric columns). Those probes all pass VALID input through the HTTP
// endpoints, which is exactly why 227 functional assertions missed the bug. A
// direct unit suite on the validator is where malformed input gets exercised
// cheaply, before any of it depends on a running server.

const v = require('./src/services/validators.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};
const P = (type, pts) => v.validateFogPoints(type, pts);

// --- type allow-list (app logic, not a DB CHECK — see the migration header) ---
t('rect accepted', v.validateFogType('rect').value === 'rect');
t('circle accepted', v.validateFogType('circle').value === 'circle');
t('poly accepted', v.validateFogType('poly').value === 'poly');
t('type is case/space tolerant', v.validateFogType('  POLY ').value === 'poly');
t('unknown type rejected', !!v.validateFogType('blob').error);
t('non-string type rejected', !!v.validateFogType(['rect']).error);
t('null type rejected', !!v.validateFogType(null).error);
t('object type rejected', !!v.validateFogType({ type: 'rect' }).error);

// --- structural rules per type ---
t('points must be an array', !!P('rect', { x: 1, y: 1 }).error);
t('rect needs exactly 2', !!P('rect', [{ x: 0, y: 0 }]).error);
t('rect rejects 3', !!P('rect', [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]).error);
t('circle needs exactly 2', !!P('circle', [{ x: 0, y: 0 }]).error);
t('poly needs 3+', !!P('poly', [{ x: 0, y: 0 }, { x: 1, y: 1 }]).error);
t('poly of 3 ok', !!P('poly', [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]).value);
t('over-long poly rejected (payload bound)',
  !!P('poly', Array.from({ length: 501 }, (_, i) => ({ x: i % 100, y: 1 }))).error);
t('500-point poly accepted (at the bound)',
  !!P('poly', Array.from({ length: 500 }, (_, i) => ({ x: i % 100, y: 1 }))).value);

// --- type confusion: the OWASP API3/BOPLA class the M2 canvas audit found ---
t('array-wrapped number rejected', !!P('rect', [{ x: [[5]], y: 0 }, { x: 1, y: 1 }]).error);
t('single-element array rejected', !!P('rect', [{ x: [5], y: 0 }, { x: 1, y: 1 }]).error);
t('boolean rejected', !!P('rect', [{ x: true, y: 0 }, { x: 1, y: 1 }]).error);
t('null coord rejected', !!P('rect', [{ x: null, y: 0 }, { x: 1, y: 1 }]).error);
t('undefined coord rejected', !!P('rect', [{ x: undefined, y: 0 }, { x: 1, y: 1 }]).error);
t('NaN rejected', !!P('rect', [{ x: NaN, y: 0 }, { x: 1, y: 1 }]).error);
t('Infinity rejected', !!P('rect', [{ x: Infinity, y: 0 }, { x: 1, y: 1 }]).error);
t('point as array rejected', !!P('rect', [[0, 0], [1, 1]]).error);
t('point as null rejected', !!P('rect', [null, { x: 1, y: 1 }]).error);
t('numeric string accepted (form inputs arrive as strings)',
  P('rect', [{ x: '0', y: '0' }, { x: '4', y: '3' }]).value[1].x === 4);
t('out-of-bounds coord rejected', !!P('rect', [{ x: 10001, y: 0 }, { x: 1, y: 1 }]).error);
t('boundary coord accepted', !!P('rect', [{ x: -10000, y: -10000 }, { x: 10000, y: 10000 }]).value);

// --- rect normalisation: the same rectangle stores identically either way ---
const back = P('rect', [{ x: 9, y: 7 }, { x: 2, y: 3 }]).value;
t('backwards rect normalised to [min,max]',
  back[0].x === 2 && back[0].y === 3 && back[1].x === 9 && back[1].y === 7, JSON.stringify(back));
const fwd = P('rect', [{ x: 2, y: 3 }, { x: 9, y: 7 }]).value;
t('forwards and backwards drags store identically', JSON.stringify(back) === JSON.stringify(fwd));
t('zero-width rect rejected', !!P('rect', [{ x: 5, y: 0 }, { x: 5, y: 9 }]).error);
t('zero-height rect rejected', !!P('rect', [{ x: 0, y: 5 }, { x: 9, y: 5 }]).error);

// --- circle: [centre, rim]; radius derived, never stored ---
t('circle accepted', !!P('circle', [{ x: 5, y: 5 }, { x: 8, y: 5 }]).value);
t('zero-radius circle rejected', !!P('circle', [{ x: 5, y: 5 }, { x: 5, y: 5 }]).error);
t('circle rim stored as given (not canonicalised)',
  JSON.stringify(P('circle', [{ x: 5, y: 5 }, { x: 5, y: 9 }]).value)
  === JSON.stringify([{ x: 5, y: 5 }, { x: 5, y: 9 }]));
t('circle near a scene edge stays inside the coordinate bound',
  !!P('circle', [{ x: 9999, y: 0 }, { x: 9999, y: 5 }]).value);

// --- output shape: clean numbers, nothing extra reaching jsonb ---
const out = P('poly', [{ x: '1.5', y: 2 }, { x: 3, y: '4' }, { x: 5, y: 6 }]).value;
t('coords coerced to real numbers',
  out.every((p) => typeof p.x === 'number' && typeof p.y === 'number'));
t('no extra keys survive', out.every((p) => Object.keys(p).join(',') === 'x,y'));
const sneaky = P('rect', [{ x: 0, y: 0, evil: 'DROP TABLE' }, { x: 1, y: 1 }]).value;
t('unexpected keys on a point are stripped',
  JSON.stringify(sneaky) === JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: 1 }]), JSON.stringify(sneaky));

console.log(`\nfog validators: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
