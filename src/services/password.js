const argon2 = require('argon2');

// Password hashing policy, kept in one place so the algorithm and its
// parameters can be changed without touching the routes.
//
// Argon2id with a "balanced" parameter profile: 46 MiB of memory, 3 iterations,
// and 1 degree of parallelism. memoryCost is expressed in KiB, so 47104 KiB =
// 46 MiB. This is deliberately above OWASP's 19 MiB minimum, taking advantage of
// the fact that the target hardware is not memory-constrained; it lands each hash
// at roughly 150 ms. The cost parameters are stored inside each hash, so raising
// or lowering them later does not invalidate existing hashes.
const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 47104,
  timeCost: 3,
  parallelism: 1,
};

async function hashPassword(plain) {
  return argon2.hash(plain, ARGON2_OPTS);
}

// Returns true/false and never throws: a malformed or unrecognised stored hash
// is treated as a failed verification rather than a server error (this mirrors
// the semantics the code relied on previously).
async function verifyPassword(hash, plain) {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, ARGON2_OPTS };