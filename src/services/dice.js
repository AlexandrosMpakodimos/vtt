// Dice: parse a formula, roll it, report the result. Nothing else.
//
// A leaf module with no route or database knowledge, for the same reason
// atomicCap.js is one: it is a shared primitive, and keeping it out of the
// routers means its whole surface is pure functions that a suite can exercise
// with no server and no Postgres running (the test-fog-validators.js pattern).
//
// ---------------------------------------------------------------------------
// The scope boundary, stated so a later session cannot mistake it for a gap
// ---------------------------------------------------------------------------
// This project's game system is D&D-INSPIRED AND DELIBERATELY SIMPLIFIED. Dice
// ROLL AND REPORT. They do not apply their results to anything: no damage is
// subtracted from hit points, no saving throw is resolved, no attack is compared
// to an armour class, and nothing is written to any row but the message itself.
//
// The grammar is therefore exactly what SCHEMA_REFERENCE's own example needs —
// roll_data = {formula: "2d6+3", results: [4, 2], total: 9} — and no more:
//
//     NdM            2d6
//     NdM+K / NdM-K  2d6+3, 1d20-1
//     dM             d20        (N defaults to 1)
//     K              5          (a flat number, so "+2" style modifiers can be
//                                sent on their own without a special case)
//
// DELIBERATELY NOT SUPPORTED, each of which is a step from a parser toward a
// rules engine:
//   - keep-highest / drop-lowest (4d6kh3) — the closest call, since it is dice
//     notation rather than a 5e rule, but it is the first feature that makes the
//     roller decide which dice COUNT, and ability-score generation is the only
//     thing that wants it.
//   - exploding dice, rerolls, advantage/disadvantage keywords
//   - success counting against a target number
//   - multiple dice groups in one expression (2d6+1d4)
//   - damage types, criticals, any notion of what the number is FOR
//
// Initiative is typed by the GM, never rolled into combatants.sort_order by this
// module. A roll appears in chat; a human reads it and arranges the order. That
// is what keeps "dice do not apply results" true without exceptions.
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
const MAX_DICE = 100;
const MAX_SIDES = 1000;
const MAX_MODIFIER = 9999;
const MAX_FORMULA_LENGTH = 32;

// One optional count, 'd', sides, one optional signed modifier. Anchored at both
// ends so trailing junk is a parse error rather than silently ignored input.
const DICE_RE = /^(\d{0,3})d(\d{1,4})(?:\s*([+-])\s*(\d{1,5}))?$/i;
// A bare signed integer, so "+2" or "5" is a legal formula on its own.
const FLAT_RE = /^([+-]?\d{1,5})$/;

// Parse a formula into { count, sides, modifier } or { error }.
// Pure: no randomness, no I/O. The suite can enumerate the whole grammar.
function parseFormula(raw) {
  if (typeof raw !== 'string') return { error: 'formula must be text' };
  const s = raw.trim();
  if (!s) return { error: 'formula is required' };
  if (s.length > MAX_FORMULA_LENGTH) {
    return { error: `formula is too long (max ${MAX_FORMULA_LENGTH} characters)` };
  }

  const flat = FLAT_RE.exec(s);
  if (flat) {
    const modifier = Number(flat[1]);
    if (Math.abs(modifier) > MAX_MODIFIER) {
      return { error: `modifier must be between -${MAX_MODIFIER} and ${MAX_MODIFIER}` };
    }
    return { count: 0, sides: 0, modifier };
  }

  const m = DICE_RE.exec(s);
  if (!m) return { error: 'formula must look like 2d6+3' };

  // An empty count means "d20" — one die.
  const count = m[1] === '' ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  const modifier = m[3] ? Number(`${m[3]}${m[4]}`) : 0;

  if (count < 1) return { error: 'you must roll at least one die' };
  if (count > MAX_DICE) return { error: `you may roll at most ${MAX_DICE} dice at once` };
  // A one-sided die is legal but pointless; a zero-sided one is not a die.
  if (sides < 1) return { error: 'a die must have at least one side' };
  if (sides > MAX_SIDES) return { error: `a die may have at most ${MAX_SIDES} sides` };
  if (Math.abs(modifier) > MAX_MODIFIER) {
    return { error: `modifier must be between -${MAX_MODIFIER} and ${MAX_MODIFIER}` };
  }

  return { count, sides, modifier };
}

// Roll a parsed formula. Returns the roll_data shape SCHEMA_REFERENCE specifies.
//
// `rng` is injectable ONLY so the suite can assert the arithmetic (that `total`
// really is the sum of `results` plus the modifier) without depending on random
// values. Production always takes the default. It is not a seeding feature and
// no route exposes it.
function roll(formula, rng = (max) => crypto.randomInt(1, max + 1)) {
  const parsed = parseFormula(formula);
  if (parsed.error) return parsed;

  const results = [];
  for (let i = 0; i < parsed.count; i += 1) results.push(rng(parsed.sides));

  const total = results.reduce((a, b) => a + b, 0) + parsed.modifier;

  return {
    // Echo the CANONICAL formula, not the caller's spacing. Storing " 2d6 + 3 "
    // would make two identical rolls look different in the log.
    formula: canonical(parsed),
    results,
    total,
  };
}

function canonical({ count, sides, modifier }) {
  if (count === 0) return modifier >= 0 ? `+${modifier}` : String(modifier);
  const base = `${count}d${sides}`;
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
  MAX_FORMULA_LENGTH,
};
