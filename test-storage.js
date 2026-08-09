// Storage primitives — unit suite.
//
// No server, no database, no bucket, no credentials:
//     node test-storage.js
//
// The functions that decide whether an uploaded file is an image are pure, and
// that is deliberate: magicMatches is the single check standing between the
// bucket and a file that is not what it claims to be, so it needs to be
// exercisable without a network, an account, or the author's secrets.
//
// The probes below are mostly NEAR MISSES rather than obvious rubbish. A
// validator that rejects the string "hello" tells you very little; one that
// rejects a WAV file claiming to be WebP tells you the container check is real.

const s = require('./src/services/storage.js');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

// Real magic numbers, written out rather than read from fixture files so the
// suite has no I/O and the expected bytes are visible at the point of use.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const GIF87 = Buffer.from('GIF87a', 'ascii');
const GIF89 = Buffer.from('GIF89a', 'ascii');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii'),
]);
// RIFF containers that are NOT WebP. These are the reason the WebP check has
// two signatures rather than one.
const WAV = Buffer.concat([
  Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE', 'ascii'),
]);
const AVI = Buffer.concat([
  Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('AVI ', 'ascii'),
]);

console.log('\n--- the formats that are allowed ---');
t('png accepted', !!s.formatFor('image/png'));
t('jpeg accepted', !!s.formatFor('image/jpeg'));
t('webp accepted', !!s.formatFor('image/webp'));
t('gif accepted', !!s.formatFor('image/gif'));
t('exactly four formats', s.allowedMimes().length === 4, s.allowedMimes().join(','));

console.log('\n--- SVG IS NOT ALLOWED, and that is the whole point ---');
// R2 serves raw bytes: an SVG with an embedded script, served from a domain,
// is stored cross-site scripting. It is excluded from the allow-list rather
// than sanitised, because sanitising markup is a losing game and there is no
// requirement that needs it.
t('image/svg+xml is refused', s.formatFor('image/svg+xml') === null);
t('text/html is refused', s.formatFor('text/html') === null);
t('application/javascript is refused', s.formatFor('application/javascript') === null);
t('image/bmp is refused (not in the allow-list)', s.formatFor('image/bmp') === null);
t('a made-up type is refused', s.formatFor('image/png-but-evil') === null);
t('an empty type is refused', s.formatFor('') === null);
// [FOUND HERE 2026-08-09] An array used as an OBJECT KEY coerces via String(),
// so FORMATS[['image/png']] returned the PNG entry. Fourth appearance of this
// one trap in this project, and the first in a lookup rather than a conversion.
t('an array containing a valid type is refused', s.formatFor(['image/png']) === null);
t('an object is refused', s.formatFor({ toString: () => 'image/png' }) === null);
t('a number is refused', s.formatFor(0) === null);
t('null is refused', s.formatFor(null) === null);
t('an array kind gets no size limit', s.limitFor(['map']) === undefined);

console.log('\n--- magic numbers: the happy path ---');
t('a PNG is a PNG', s.magicMatches('image/png', PNG));
t('a JPEG is a JPEG', s.magicMatches('image/jpeg', JPEG));
t('a WebP is a WebP', s.magicMatches('image/webp', WEBP));
t('GIF87a is a GIF', s.magicMatches('image/gif', GIF87));
t('GIF89a is a GIF', s.magicMatches('image/gif', GIF89));

console.log('\n--- magic numbers: a file lying about its type ---');
t('a PNG claiming to be JPEG is refused', !s.magicMatches('image/jpeg', PNG));
t('a JPEG claiming to be PNG is refused', !s.magicMatches('image/png', JPEG));
t('a GIF claiming to be WebP is refused', !s.magicMatches('image/webp', GIF89));
t('HTML claiming to be PNG is refused',
  !s.magicMatches('image/png', Buffer.from('<!DOCTYPE html><script>', 'ascii')));
t('an SVG claiming to be PNG is refused',
  !s.magicMatches('image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">', 'ascii')));
t('a shell script claiming to be GIF is refused',
  !s.magicMatches('image/gif', Buffer.from('#!/bin/sh\nrm -rf', 'ascii')));

console.log('\n--- the WebP container check needs BOTH signatures ---');
// "RIFF" alone identifies a container family, not a format. A single-signature
// check would accept audio and video as images.
t('a WAV is NOT a WebP', !s.magicMatches('image/webp', WAV),
  'RIFF....WAVE — a one-signature check would pass this');
t('an AVI is NOT a WebP', !s.magicMatches('image/webp', AVI));
t('RIFF with nothing after it is not a WebP',
  !s.magicMatches('image/webp', Buffer.from('RIFF', 'ascii')));

console.log('\n--- truncated and malformed input ---');
t('an empty buffer matches nothing', !s.magicMatches('image/png', Buffer.alloc(0)));
t('a one-byte buffer matches nothing', !s.magicMatches('image/png', Buffer.from([0x89])));
t('a PNG truncated mid-signature is refused',
  !s.magicMatches('image/png', Buffer.from([0x89, 0x50, 0x4e])));
t('a WebP truncated before the format tag is refused',
  !s.magicMatches('image/webp', Buffer.from('RIFF\0\0\0\0WEB', 'ascii')));
t('a non-buffer is refused (type confusion)', !s.magicMatches('image/png', 'not a buffer'));
t('an array of bytes is refused, not coerced',
  !s.magicMatches('image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
t('null is refused', !s.magicMatches('image/png', null));
t('an unknown mime with valid PNG bytes is refused',
  !s.magicMatches('image/svg+xml', PNG),
  'the format must be in the allow-list even when the bytes are a real image');

console.log('\n--- size limits per kind ---');
t('a map may be larger than a portrait', s.limitFor('map') > s.limitFor('portrait'));
t('every kind has a limit', s.KINDS.every((k) => s.limitFor(k) > 0), s.KINDS.join(','));
t('no limit exceeds 16 MB', s.KINDS.every((k) => s.limitFor(k) <= 16 * 1024 * 1024));
t('an unknown kind has no limit', s.limitFor('nonsense') === undefined);
t('avatar is among the kinds', s.KINDS.includes('avatar'));

console.log('\n--- storage keys are built by the SERVER ---');
// A client-supplied name is a path traversal and an overwrite in one. These
// probes assert the shape the server produces rather than any particular value.
const campaignKey = s.buildKey({ campaignId: 'C1', kind: 'map', ext: 'png' });
const userKey = s.buildKey({ userId: 'U1', kind: 'avatar', ext: 'png' });
t('a campaign asset is filed under its campaign', campaignKey.startsWith('c/C1/map/'), campaignKey);
t('a personal asset is filed under its user', userKey.startsWith('u/U1/avatar/'), userKey);
t('the key ends with the format extension', campaignKey.endsWith('.png'));
t('two keys for the same inputs DIFFER', campaignKey !== s.buildKey({ campaignId: 'C1', kind: 'map', ext: 'png' }),
  'a deterministic key would let one upload overwrite another');
t('the key contains no traversal', !campaignKey.includes('..'));
t('the key has exactly four segments', campaignKey.split('/').length === 4, campaignKey);

console.log('\n--- public URLs ---');
// Serving happens from the bucket hostname, never the application origin, so
// that anything which did slip through executes with no access to session
// cookies. With no bucket configured the base is empty, which is why this
// asserts the SHAPE rather than a host.
t('a public url ends with the key', s.publicUrl('c/C1/map/x.png').endsWith('/c/C1/map/x.png'));
t('a public url does not double its separator',
  !s.publicUrl('c/C1/map/x.png').includes('//c/'));

console.log('\n--- configuration is optional ---');
// The application must start, and every suite that does not concern uploads
// must pass, on a machine with no bucket. A thesis artefact that cannot run
// without the author's cloud credentials is not reproducible.
t('isConfigured reports a boolean', typeof s.isConfigured() === 'boolean');
t('the upload URL lifetime is short', s.UPLOAD_URL_TTL_SECONDS <= 900,
  `${s.UPLOAD_URL_TTL_SECONDS}s — it authorises a write into our bucket`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
