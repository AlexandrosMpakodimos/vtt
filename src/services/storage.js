// Object storage: server-proxied uploads to Cloudflare R2, verified reads and
// deletes.
//
// A leaf module with no route knowledge, for the same reason atomicCap.js and
// sceneAccess.js are: it is a shared primitive, and keeping it out of the
// routers means its surface can be reasoned about — and largely tested — on its
// own.
//
// R2 is S3-compatible, so this uses the AWS SDK against an R2 endpoint. That is
// not incidental: it means the provider is four environment variables rather
// than a dependency. Amazon S3, Backblaze B2 and a local MinIO container all
// work here unchanged, which matters for a project that must be runnable by
// somebody who does not have these credentials.
//
// ---------------------------------------------------------------------------
// WHY THE BYTES ARE VERIFIED, AND WHY THAT IS OUR JOB HERE
// ---------------------------------------------------------------------------
// An image CDN — Cloudinary, Cloudflare Images — TRANSCODES what it receives.
// R2 does not: it stores the bytes it is given and serves them back unchanged.
// The declared content type is a claim made by the client, and a claim is not
// evidence. Three defences, layered deliberately:
//
//   1. NO SVG. Raster formats only. This removes the stored-cross-site-
//      scripting vector at the source rather than trying to sanitise markup.
//
//   2. THE SERVER HOLDS THE BYTES. Uploads go through POST /api/assets/upload
//      (routes/assets.js): the body is bounded, its magic numbers are checked
//      against the claimed format BEFORE anything is written, and the object is
//      written once by putObject below. No browser ever holds a write grant.
//      [CHANGED 2026-10-05] The legacy presigned-PUT path (presignUpload, the
//      confirm read-back via readHead) was removed in the schema cleanup; it had
//      been disabled in production since cutover (UPLOAD_MODE=strict).
//
//   3. A SEPARATE ORIGIN. Objects are never served from the application's own
//      pages: reads go through the media gateway and the vtt-media Worker, with
//      a sandbox CSP and nosniff.

const crypto = require('crypto');
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  HeadObjectCommand, ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET;
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

// Storage is OPTIONAL. The application must start, and every existing suite
// must pass, on a machine with no bucket configured — a thesis artefact that
// cannot be run without the author's cloud credentials is not reproducible.
// Routes check this and answer 503 rather than throwing.
const configured = process.env.NODE_ENV !== 'test' && !!(ACCOUNT_ID && BUCKET && PUBLIC_BASE
  && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);

const client = configured
  ? new S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    // [FIXED 2026-08-09] Without this the SDK adds a CRC32 checksum to every
    // PUT by default. Found on the (since removed) presigned path, where it was
    // computed at signing time over an empty body. Kept: the checksum would
    // only restate what TLS already guarantees, while the magic-number check
    // verifies what the transport cannot — whether the file is an image.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    // Pinned to 1 so the SDK never retries a write invisibly. A silent internal
    // retry would be an extra Class A operation the account is billed for but the
    // budget never charged — exactly the metering gap the controlled upload path
    // exists to close. Retries are done by the caller, one charged permit each,
    // so the number of billed operations and the number the budget counted are
    // the same number.
    maxAttempts: 1,
  })
  : null;

// Raster only. SVG is absent by design and must stay absent — see defence 1.
//
// Each entry carries the magic numbers that identify the format, which is what
// defence 3 checks against. A `bytes` matcher rather than a string because
// these are binary signatures, and `offset` because RIFF containers put their
// identifier twelve bytes in.
const FORMATS = {
  'image/png': {
    ext: 'png',
    magic: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  'image/jpeg': {
    ext: 'jpg',
    magic: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  },
  'image/webp': {
    // RIFF....WEBP — the container tag is at 0 and the format tag at 8, and
    // BOTH are required: "RIFF" alone is also a WAV file.
    ext: 'webp',
    magic: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
  'image/gif': {
    ext: 'gif',
    // GIF87a and GIF89a. Only the shared prefix is matched, since the version
    // digit is not a security property.
    magic: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }],
  },
};

// What each kind of image is allowed to weigh. CHOSEN, not measured — abuse
// prevention in the spirit of MAX_FOG_POINTS. A battle map is legitimately
// large; a portrait that needs eight megabytes is a portrait nobody resized.
const KIND_LIMITS = {
  map: 12 * 1024 * 1024,
  portrait: 4 * 1024 * 1024,
  token: 4 * 1024 * 1024,
  item: 2 * 1024 * 1024,
  avatar: 2 * 1024 * 1024,
  // A campaign's cover banner on the dashboard. Sized like a portrait: a card
  // image that needs more than a few megabytes is one nobody resized.
  cover: 4 * 1024 * 1024,
};

const KINDS = Object.keys(KIND_LIMITS);

function isConfigured() { return configured; }
// Same guard, same reason — KIND_LIMITS is looked up by key too.
function limitFor(kind) {
  if (typeof kind !== 'string') return undefined;
  return KIND_LIMITS[kind];
}
// typeof BEFORE the lookup. An OBJECT KEY coerces via String(), so
// FORMATS[['image/png']] returns the PNG entry — a single-element array is
// accepted as a valid mime type.
//
// [FOUND BY test-storage.js, 2026-08-09] This is the FOURTH appearance of one
// coercion trap in this project: Number([[5]]) === 5 in the M2 canvas
// validators, String(['2d6']) === '2d6' in the M6 dice bridge,
// String(['#ffffff']) === '#ffffff' in validateColor, and now an array used as
// an object key. Each time it was found by a probe, never by reading, and each
// time in code written by somebody who had recently fixed the previous one.
//
// It was not reachable here — the route checks typeof before calling — but a
// primitive that is only safe because its one caller happens to guard it is a
// primitive that becomes unsafe when a second caller appears.
function formatFor(mime) {
  if (typeof mime !== 'string') return null;
  return FORMATS[mime] || null;
}
function allowedMimes() { return Object.keys(FORMATS); }

// The storage key. THE SERVER CHOOSES IT — never the client.
//
// A client-supplied name is a path traversal and an overwrite in one: `../` to
// escape the prefix, or somebody else's key to replace their map with
// something else. A random identifier under a scope prefix has neither
// problem, and the prefix makes bulk cleanup by campaign a prefix listing.
function buildKey({ campaignId, userId, kind, ext }) {
  const scope = campaignId ? `c/${campaignId}` : `u/${userId}`;
  return `${scope}/${kind}/${crypto.randomUUID()}.${ext}`;
}

// The public address of a stored object. Serving happens from the bucket's own
// hostname — a different origin from the application, which is defence 4.
function publicUrl(key) {
  return `${PUBLIC_BASE}/${key}`;
}

// Write bytes to the bucket in ONE attempt, from the server. This is the
// controlled-upload primitive: the object is created by us, from a body we have
// already validated and bounded, so it is written exactly once under our control
// rather than by a replayable browser grant.
//
// maxAttempts is pinned to 1 (see the client config note) so a single call is a
// single billed Class A operation and NOTHING retries invisibly inside the SDK.
// Retries are the CALLER's job, and the caller charges one permit per attempt —
// which is the only way "count every actual SDK attempt, including retries" can
// be true. A PutObject that the SDK silently retried three times would be three
// operations the account is billed for and one the budget saw; pinning attempts
// to 1 collapses that gap.
//
// Resolves on success. Throws on failure; the caller decides whether the
// outcome was clean (release/commit) or ambiguous (preserve the reservation).
async function putObject({ key, mime, body }) {
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: mime,
    ContentLength: body.length,
    Body: body,
  }));
}

// Read a whole object's bytes. Used by the media gateway to serve an image
// through the metered, authorised path. A full GET (Class B) — the caller is
// responsible for charging the operation and for any caching, because whether a
// read should be metered depends on whether it was a cache miss, which is the
// gateway's concern, not this leaf module's.
async function getObject(key) {
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return {
    bytes: Buffer.concat(chunks),
    mime: res.ContentType || null,
    etag: typeof res.ETag === 'string' ? res.ETag.replace(/^"|"$/g, '') : null,
  };
}

// The authoritative size and type of a stored object: a HEAD request.
//
// This is what the byte ledger charges against after an upload. A HEAD
// returns the object's real Content-Length (the WHOLE object, because there is
// no Range on it) and its stored Content-Type. It is a Class B operation, so it
// is metered like any other read.
//
// Returns integers/strings the caller can trust as "what R2 says it is storing
// right now", which after a successful verified write is the truth. It is not
// proof of what the bytes ARE — the upload route checks that before writing —
// but it IS proof of how many bytes there are, which is the number that costs
// money.
async function headSize(key) {
  const res = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = typeof res.ContentLength === 'number' ? res.ContentLength : null;
  return {
    bytes,
    reportedMime: res.ContentType || null,
    etag: typeof res.ETag === 'string' ? res.ETag.replace(/^"|"$/g, '') : null,
  };
}

// One page of a bucket listing. A LIST is a Class A operation, and it returns
// up to `maxKeys` objects plus a continuation token if more remain. The caller
// (the reconciler) charges the operation and pages until the token is empty,
// metering each page — never an unbounded single call. Returns key + size for
// each object, so the reconciler learns the real stored size WITHOUT a HEAD per
// object where the LIST already carries it (R2's LIST includes Size).
async function listPage({ continuationToken = undefined, maxKeys = 1000 } = {}) {
  const res = await client.send(new ListObjectsV2Command({
    Bucket: BUCKET,
    MaxKeys: maxKeys,
    ContinuationToken: continuationToken,
  }));
  const objects = (res.Contents || []).map((o) => ({
    key: o.Key,
    bytes: typeof o.Size === 'number' ? o.Size : null,
    etag: typeof o.ETag === 'string' ? o.ETag.replace(/^"|"$/g, '') : null,
  }));
  return {
    objects,
    nextToken: res.IsTruncated ? res.NextContinuationToken : null,
  };
}

// Does `head` start with the magic numbers of `mime`?
//
// Pure and exported so the suite can exercise every format and every near-miss
// without a bucket, a network or credentials. This is the function that decides
// whether an uploaded file is an image, so it is the one that most needs to be
// testable in isolation.
function magicMatches(mime, head) {
  const fmt = FORMATS[mime];
  if (!fmt || !Buffer.isBuffer(head)) return false;
  for (const sig of fmt.magic) {
    const end = sig.offset + sig.bytes.length;
    if (head.length < end) return false;
    for (let i = 0; i < sig.bytes.length; i += 1) {
      if (head[sig.offset + i] !== sig.bytes[i]) return false;
    }
  }
  return true;
}

// Remove an object. Used when an upload is abandoned and when an asset is
// discarded. Failure is swallowed: an object we could not delete is a storage
// leak, not a correctness problem, and throwing here would turn "this file was
// rejected" into "the request failed".
async function remove(key) {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  isConfigured,
  buildKey,
  publicUrl,
  putObject,
  headSize,
  getObject,
  listPage,
  magicMatches,
  remove,
  formatFor,
  allowedMimes,
  limitFor,
  KINDS,
  KIND_LIMITS,
  FORMATS,
};
