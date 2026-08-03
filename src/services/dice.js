// Dice: parse a formula, roll it, report the result. Nothing else.
//
// A leaf module with no route or database knowledge, for the same reason
// atomicCap.js is one: it is a shared primitive, and keeping it out of the
// routers means its whole surface is pure functions that a suite can exercise
// with no server and no Postgres running (the test-fog-validators.js pattern).
//
// ---------------------------------------------------------------------------
// [SCOPE AMENDMENT 2026-08-03] Multiple dice groups are now SUPPORTED
// ---------------------------------------------------------------------------
// The original M5 grammar accepted exactly ONE dice group, and test-dice.js
// carried a probe asserting that `2d6+1d4` was REFUSED. That probe has been
// CHANGED, deliberately and on the record, because a boundary that moves
// quietly is worse than one that moves.
//
// WHY IT MOVED. "Roll a d20 and a d6 together" is not a rules-engine feature.
// It computes nothing, interprets nothing and applies nothing: it is N
// independent groups summed with a constant, which is the same arithmetic the
// single-group case already did. Refusing it made the roller unable to express
// an ordinary throw rather than protecting the project from complexity.
//
// WHAT DID NOT MOVE. The probes asserting each of these are unchanged:
//   - keep-highest / drop-lowest (4d6kh3) — decides which dice COUNT
//   - exploding, penetrating, compounding (3d6!)
//   - reroll / reroll-once (2d6r1)
//   - advantage / disadvantage keywords
//   - success counting against a target number (5d10>7)
//   - multiplication, division, parentheses
//   - anything that knows what the number is FOR
//
// The line is unchanged in principle: this module ROLLS AND REPORTS. It applies
// no damage, resolves no save, compares nothing to an armour class, and writes
// nothing but the message. Summing two groups is addition; keep-highest is a
// rule. Initiative is still TYPED by the GM, never rolled into a column.
//
// SUBTRACTING a dice group (`2d6-1d4`) is REFUSED. Negative dice have no
// physical meaning at a table, the 3D layer cannot show one, and allowing it
// would mean `results` no longer describes what the dice show. A `-` is a flat
// modifier only.
//
// THE GRAMMAR
//     NdM                 2d6
//     dM                  d20            (N defaults to 1)
//     NdM+NdM+...         1d20+1d6+2d4
//     ...+/-K             2d6+3, 1d20+1d6-1
//     K                   5              (a bare flat number)
//
// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------
// crypto.randomInt, never Math.random. Not because a tabletop needs
// cryptographic randomness, but because Math.random is seedable-looking,
// V8-implementation-defined and biased in ways nobody should have to reason
// about for a feature whose entire output is a random number. randomInt also
// rejects modulo bias for free, which a naive floor(random()*sides) does not.
//
// The roll happens HERE, on the server, and the caller stores what this returns.
// A results array from a request body is never trusted: the one thing a player
// must not control is the outcome of their own roll.

const crypto = require('crypto');

// Bounds. CHOSEN, not measured — abuse prevention, in the same spirit as
// MAX_FOG_POINTS. The vertex bound is the precedent: one 50,000-vertex polygon
// is a payload no row cap would catch, and "999999d999999" is the same attack on
// a different axis. MAX_DICE bounds the results array (and the CPU spent filling
// it); MAX_SIDES keeps every value inside int4 with room to spare.
//
// MAX_DICE bounds the TOTAL across every group, not each group. Ten groups of a
// hundred dice would otherwise slip past a per-group check — the same mistake as
// a per-request cap that ignores how many requests there are.
const MAX_DICE = 100;
const MAX_SIDES = 1000;
const MAX_MODIFIER = 9999;
const MAX_GROUPS = 10;
const MAX_FORMULA_LENGTH = 64;

// One dice group with an optional leading sign. Anchored at the START so the
// consuming loop can only ever move forward through the string.
const GROUP_RE = /^([+-]?)(\d{0,3})d(\d{1,4})/i;
// A flat modifier: a signed integer.
const FLAT_RE = /^([+-]?)(\d{1,5})/;

// Parse a formula into { groups: [{count, sides}], modifier } or { error }.
// Pure: no randomness, no I/O. The suite can enumerate the whole grammar.
function parseFormula(raw) {
  if (typeof raw !== 'string') return { error: 'formula must be text' };
  let s = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return { error: 'formula is required' };
  if (s.length > MAX_FORMULA_LENGTH) {
    return { error: `formula is too long (max ${MAX_FORMULA_LENGTH} characters)` };
  }

  const groups = [];
  let modifier = 0;
  let totalDice = 0;
  let sawModifier = false;
  let first = true;

  // Consume left to right. EVERY branch must shorten `s`, so the loop always
  // terminates, and anything left unconsumed is a parse error rather than
  // silently ignored trailing input. That is what makes "2d6; DROP TABLE" a
  // refusal instead of a roll, and it is why the regexes are anchored at the
  // start rather than matched loosely anywhere in the string.
  while (s.length > 0) {
    const g = GROUP_RE.exec(s);
    if (g) {
      const sign = g[1];
      if (sign === '-') {
        return { error: 'dice cannot be subtracted — use a flat modifier instead' };
      }
      if (!first && sign !== '+') {
        return { error: 'dice groups must be joined with +' };
      }
      // A group after the flat modifier ("2d6+3+1d4") reads as arithmetic rather
      // than a throw, and canonical() could not round-trip it. Refused rather
      // than silently reordered.
      if (sawModifier) return { error: 'the modifier must come last' };

      const count = g[2] === '' ? 1 : Number(g[2]);
      const sides = Number(g[3]);

      if (count < 1) return { error: 'you must roll at least one die' };
      // A one-sided die is legal but pointless; a zero-sided one is not a die.
      if (sides < 1) return { error: 'a die must have at least one side' };
      if (sides > MAX_SIDES) return { error: `a die may have at most ${MAX_SIDES} sides` };

      totalDice += count;
      if (totalDice > MAX_DICE) {
        return { error: `you may roll at most ${MAX_DICE} dice at once` };
      }
      groups.push({ count, sides });
      if (groups.length > MAX_GROUPS) {
        return { error: `a roll may combine at most ${MAX_GROUPS} kinds of dice` };
      }

      s = s.slice(g[0].length);
      first = false;
      continue;
    }

    const f = FLAT_RE.exec(s);
    if (f) {
      if (sawModifier) return { error: 'formula must look like 2d6+3' };
      // A bare number is a modifier only if it is the whole formula ("5") or
      // explicitly signed ("2d6+3"). "2d6 3" is not a formula.
      if (!first && f[1] === '') return { error: 'formula must look like 2d6+3' };
      modifier = Number(`${f[1] === '-' ? '-' : ''}${f[2]}`);
      if (Math.abs(modifier) > MAX_MODIFIER) {
        return { error: `modifier must be between -${MAX_MODIFIER} and ${MAX_MODIFIER}` };
      }
      sawModifier = true;
      s = s.slice(f[0].length);
      first = false;
      continue;
    }

    // Unconsumable input. This is where kh3, !, r1, >7, * and ( all land.
    return { error: 'formula must look like 2d6+3' };
  }

  if (!groups.length && !sawModifier) return { error: 'formula must look like 2d6+3' };

  return { groups, modifier };
}

// Roll a parsed formula. Returns the roll_data shape stored in messages.
//
// `results` is FLAT — every die in formula order — and is deliberately kept that
// way rather than nested, because break-combat.js and the chat renderer both
// read it. Changing its shape would have broken an audited assertion for a
// presentational reason. `groups` is ADDITIVE: it records which results belong
// to which die, which is what the 3D layer needs and what a flat array cannot
// say. Old single-group rolls keep exactly the shape they had.
//
// `rng` is injectable ONLY so the suite can assert the arithmetic (that `total`
// really is the sum of `results` plus the modifier) without depending on random
// values. Production always takes the default. It is not a seeding feature and
// no route exposes it.
function roll(formula, rng = (max) => crypto.randomInt(1, max + 1)) {
  const parsed = parseFormula(formula);
  if (parsed.error) return parsed;

  const results = [];
  const groups = [];
  for (const g of parsed.groups) {
    const rolled = [];
    for (let i = 0; i < g.count; i += 1) rolled.push(rng(g.sides));
    results.push(...rolled);
    groups.push({ count: g.count, sides: g.sides, results: rolled });
  }

  const total = results.reduce((a, b) => a + b, 0) + parsed.modifier;

  return {
    // Echo the CANONICAL formula, not the caller's spacing. Storing " 2d6 + 3 "
    // would make two identical rolls look different in the log.
    formula: canonical(parsed),
    results,
    total,
    groups,
  };
}

function canonical({ groups, modifier }) {
  if (!groups.length) return modifier >= 0 ? `+${modifier}` : String(modifier);
  const base = groups.map((g) => `${g.count}d${g.sides}`).join('+');
  if (modifier === 0) return base;
  return modifier > 0 ? `${base}+${modifier}` : `${base}${modifier}`;
}

module.exports = {
  parseFormula,
  roll,
  canonical,
  MAX_DICE,
  MAX_SIDES,
  MAX_MODIFIER,
  MAX_GROUPS,
  MAX_FORMULA_LENGTH,
};
