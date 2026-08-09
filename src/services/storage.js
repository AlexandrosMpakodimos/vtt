// Object storage: presigned uploads to Cloudflare R2, and verification of what
// actually arrived.
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
// An SVG containing a script goes in and a PNG comes out, so the validation is
// done for you by the act of storage.
//
// R2 does neither. It stores the bytes it is given and serves them back
// unchanged, with the content type they were stored with. Choosing it moves
// that responsibility here, which is more work and a more honest position: the
// declared content type is a claim made by the client, and a claim is not
// evidence.
//
// Four defences, layered deliberately:
//
//   1. NO SVG. Raster formats only. This removes the stored-cross-site-
//      scripting vector at the source rather than trying to sanitise markup,
//      which is a losing game.
//
//   2. THE SIGNATURE PINS THE LENGTH. A presigned PUT commits the client to an
//      exact content length, so "upload five gigabytes" is refused by the
//      storage service before any of our code runs.
//
//      [CORRECTED 2026-08-09] An earlier version of this comment claimed the
//      signature pinned the content TYPE as well. It does not: the signed
//      header list is `content-length;host`, and the type travels unsigned.
//      Checked rather than assumed only after the claim had already been
//      written down — which is the reason defence 3 exists and is not
//      redundant with this one.
//
//   3. THE SERVER READS THE BYTES BACK. After the client reports success, the
//      first bytes are fetched from the bucket and checked against the magic
//      numbers for the format claimed. An object whose bytes disagree with its
//      extension is deleted, not stored. This is the step that makes the other
//      three meaningful: without it, everything above is the client's word.
//
//   4. A SEPARATE ORIGIN. Objects are served from the bucket's own hostname,
//      never from the application's. If anything ever did get through, it
//      executes somewhere with no access to session cookies. Cross-origin is
//      the security boundary here, not an inconvenience.

const crypto = require('crypto');
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET;
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

// Storage is OPTIONAL. The application must start, and every existing suite
// must pass, on a machine with no bucket configured — a thesis artefact that
// cannot be run without the author's cloud credentials is not reproducible.
// Routes check this and answer 503 rather than throwing.
const configured = !!(ACCOUNT_ID && BUCKET && PUBLIC_BASE
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
    // PUT by default — and for a PRESIGNED url it computes that checksum at
    // SIGNING time, when there is no body. The result is
    // `x-amz-checksum-crc32=AAAAAA==`, the CRC32 of nothing, baked into the
    // signature. The real bytes never match it, so the storage service rejects
    // an upload that is otherwise perfectly valid.
    //
    // It survived the suite because the failure is silent until a body is
    // actually sent, and the first browser upload is what exposed it. Integrity
    // is not lost: the checksum would only have restated what the transport's
    // own TLS already guarantees, whereas the byte verification at confirm
    // checks something the transport cannot — whether the file is an image.
    requestChecksumCalculation: 'WHEN_REQUIRED',
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
};

const KINDS = Object.keys(KIND_LIMITS);

// How long a presigned URL lives. Short: it is an authorisation to write into
// our bucket, and the client is expected to use it immediately. Long enough to
// survive a slow upload starting, not long enough to be worth passing around.
const UPLOAD_URL_TTL_SECONDS = 300;

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

// Authorise exactly one upload.
//
// The content type and length are part of the SIGNATURE, not merely part of the
// request: R2 rejects a PUT whose headers do not match what was signed. So the
// size limit is enforced by the storage provider before a single byte reaches
// our verification step, and a client cannot sign a small PNG and then send a
// large one.
async function presignUpload({ key, mime, bytes }) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: mime,
    ContentLength: bytes,
  });
  return getSignedUrl(client, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
}

// Read the first bytes of a stored object.
//
// A ranged read, so verifying a twelve-megabyte map costs sixteen bytes of
// transfer rather than twelve megabytes. R2's free tier counts operations
// rather than bytes, but pulling whole files back to look at their first eight
// would be a self-inflicted bandwidth cost and a memory hazard.
async function readHead(key, length = 16) {
  const res = await client.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Range: `bytes=0-${length - 1}`,
  }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return {
    head: Buffer.concat(chunks),
    // R2 echoes back what it was told to store. Recorded for the audit trail,
    // and deliberately NOT trusted — it is the client's claim, round-tripped.
    reportedMime: res.ContentType || null,
    reportedBytes: typeof res.ContentLength === 'number' ? res.ContentLength : null,
  };
}

// Does this buffer actually begin like the format it claims to be?
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

// Remove an object. Used when verification fails and when an asset is
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
  presignUpload,
  readHead,
  magicMatches,
  remove,
  formatFor,
  allowedMimes,
  limitFor,
  KINDS,
  KIND_LIMITS,
  FORMATS,
  UPLOAD_URL_TTL_SECONDS,
};
