// Unit tests: the Worker's handler with an injected, mocked upstream fetch.
// No network, no Cloudflare account. The same behaviours are re-checked on the
// real workerd runtime in runtime.test.mjs.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHandler } from '../src/index.js';

const ID = '3f9c1c2e-7a44-4a0e-9d51-0b6f2e8a1c77';
const TOKEN = `${'A'.repeat(112)}.${'B'.repeat(43)}`;
const SECRET = 's3cr3t-'.repeat(6); // 42 chars
const ORIGIN = 'https://vtt-app.onrender.com';
const ENV = { UPSTREAM_ORIGIN: ORIGIN, MEDIA_PROXY_SECRET: SECRET };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
const GOOD_URL = `https://vtt-media.acct.workers.dev/media/${ID}?t=${TOKEN}`;

// --- console guard: the Worker must never log -------------------------------
const consoleCalls = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  console[k] = (...a) => { consoleCalls.push([k, a]); }; // node:test reporter uses stdout, not console
}

// --- helpers ------------------------------------------------------------------
function upstream(make) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return make(url, init);
  };
  return { fetchImpl, calls };
}
const pngResponse = (extra = {}) =>
  new Response(PNG, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-length': String(PNG.byteLength),
      etag: '"abc123"',
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'cross-origin',
      'set-cookie': 'sid=upstream-secret',
      server: 'Render',
      'x-powered-by': 'Express',
      'access-control-allow-origin': '*',
      link: '<https://evil.example>; rel=preload',
      'content-disposition': 'attachment',
      ...extra,
    },
  });
const okPng = () => pngResponse();
const responses = [];
const req = (url = GOOD_URL, init = {}) => new Request(url, init);
async function run(make, request = req(), env = ENV) {
  const up = upstream(make);
  const res = await createHandler({ fetchImpl: up.fetchImpl })(request, env);
  responses.push(res);
  return { res, calls: up.calls };
}
const bytes = async (res) => new Uint8Array(await res.arrayBuffer());
const json = async (res) => JSON.parse(await res.text());
function assertNoSecret(res, text) {
  assert.ok(!text.includes(SECRET));
  for (const [k, v] of res.headers) assert.ok(!k.includes(SECRET) && !v.includes(SECRET), `header ${k}`);
}

describe('request validation: nothing invalid reaches the upstream', () => {
  it('accepts exactly GET and HEAD; everything else is 405 with Allow', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const { res, calls } = await run(okPng, req(GOOD_URL, { method, body: method === 'OPTIONS' ? undefined : 'x' }));
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
      assert.equal(calls.length, 0);
    }
  });
  it('rejects every other path with 404', async () => {
    const paths = [
      '/', '/media', '/media/', `/media/${ID}/`, `/media/${ID}/extra`, '/media/not-a-uuid',
      `/media/${ID.toUpperCase()}`, `/api/media/${ID}/token`, `/media/${ID}%2F..`, `/media/%2e%2e/${ID}`,
      `//media/${ID}`, `/Media/${ID}`, `/media/${ID}.png`,
    ];
    for (const p of paths) {
      const { res, calls } = await run(okPng, req(`https://w.workers.dev${p}?t=${TOKEN}`));
      assert.equal(res.status, 404, p);
      assert.equal(calls.length, 0, p);
    }
  });
  it('rejects a query that is not exactly one well-formed t parameter with 400', async () => {
    const bad = [
      '', '?', '?t=', `?T=${TOKEN}`, `?t=${TOKEN}&x=1`, `?x=1&t=${TOKEN}`, `?t=${TOKEN}&t=${TOKEN}`,
      `?t=${TOKEN}%20`, `?t=${TOKEN}#frag-is-not-sent`.replace('#frag-is-not-sent', '&'),
      `?t=${'A'.repeat(600)}.${'B'.repeat(43)}`, '?t=short.token', `?t=${'A'.repeat(112)}${'B'.repeat(43)}`,
      `?t=${TOKEN.replace('.', '+')}`, `?t=${TOKEN}\u0000x`,
    ];
    for (const q of bad) {
      const { res, calls } = await run(okPng, req(`https://w.workers.dev/media/${ID}${q}`));
      assert.equal(res.status, 400, JSON.stringify(q));
      assert.equal(calls.length, 0, JSON.stringify(q));
    }
  });
});

describe('outbound request: fixed origin, fresh headers, no redirects', () => {
  it('builds the URL from validated parts on the configured origin only', async () => {
    const { calls } = await run(okPng, req(`https://attacker.example/media/${ID}?t=${TOKEN}`));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ORIGIN}/media/${ID}?t=${TOKEN}`);
    assert.equal(new URL(calls[0].url).protocol, 'https:');
  });
  it('sends exactly the header allowlist and drops every browser header', async () => {
    const hostile = req(GOOD_URL, {
      headers: {
        cookie: 'sid=victim', authorization: 'Bearer x', referer: 'https://app.example/scene',
        origin: 'https://app.example', 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9',
        'x-media-proxy-auth': 'client-supplied-guess', 'user-agent': 'browser', accept: 'text/html',
        'accept-encoding': 'gzip', range: 'bytes=0-5', 'if-modified-since': 'Sat, 01 Jan 2000 00:00:00 GMT',
        'if-none-match': 'not a valid etag',
      },
    });
    const { calls } = await run(okPng, hostile);
    const sent = new Headers(calls[0].init.headers);
    assert.deepEqual([...sent.keys()].sort(), ['accept', 'accept-encoding', 'user-agent', 'x-media-proxy-auth']);
    assert.equal(sent.get('x-media-proxy-auth'), SECRET, 'the client cannot supply the secret');
    assert.equal(sent.get('accept-encoding'), 'identity');
  });
  it('forwards If-None-Match only when it is one valid entity tag', async () => {
    for (const [value, expected] of [['"abc123"', '"abc123"'], ['W/"abc123"', 'W/"abc123"'], ['*', null], ['"a", "b"', null], ['abc', null]]) {
      const { calls } = await run(okPng, req(GOOD_URL, { headers: { 'if-none-match': value } }));
      assert.equal(new Headers(calls[0].init.headers).get('if-none-match'), expected, value);
    }
  });
  it('never follows redirects, never uses a shared cache, always bounds the call', async () => {
    const { calls } = await run(okPng);
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(calls[0].init.cache, 'no-store');
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.equal(calls[0].init.method, 'GET');
  });
  it('passes HEAD upstream as HEAD', async () => {
    const { calls } = await run(okPng, req(GOOD_URL, { method: 'HEAD' }));
    assert.equal(calls[0].init.method, 'HEAD');
  });
});

describe('configuration is validated on every request; bad config never reaches the upstream', () => {
  const cases = {
    'http upstream': { UPSTREAM_ORIGIN: 'http://vtt-app.onrender.com' },
    'credentials in origin': { UPSTREAM_ORIGIN: 'https://u:p@vtt-app.onrender.com' },
    'path in origin': { UPSTREAM_ORIGIN: 'https://vtt-app.onrender.com/media' },
    'query in origin': { UPSTREAM_ORIGIN: 'https://vtt-app.onrender.com/?a=1' },
    'explicit port': { UPSTREAM_ORIGIN: 'https://vtt-app.onrender.com:8443' },
    'ip literal': { UPSTREAM_ORIGIN: 'https://203.0.113.5' },
    'ipv6 literal': { UPSTREAM_ORIGIN: 'https://[::1]' },
    localhost: { UPSTREAM_ORIGIN: 'https://localhost' },
    'dotless host': { UPSTREAM_ORIGIN: 'https://internal' },
    'missing origin': { UPSTREAM_ORIGIN: undefined },
    'missing secret': { MEDIA_PROXY_SECRET: undefined },
    'short secret': { MEDIA_PROXY_SECRET: 'short' },
  };
  for (const [name, patch] of Object.entries(cases)) {
    it(`500 misconfigured: ${name}`, async () => {
      const { res, calls } = await run(okPng, req(), { ...ENV, ...patch });
      assert.equal(res.status, 500);
      assert.deepEqual(await json(res), { error: 'misconfigured' });
      assert.equal(calls.length, 0);
    });
  }
});

describe('successful images', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    it(`passes ${type} byte-for-byte with the fixed security headers`, async () => {
      const { res } = await run(() => pngResponse({ 'content-type': type }));
      assert.equal(res.status, 200);
      assert.deepEqual(await bytes(res), PNG);
      assert.equal(res.headers.get('content-type'), type);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.equal(res.headers.get('etag'), '"abc123"');
      assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
      assert.equal(res.headers.get('content-length'), String(PNG.byteLength));
    });
  }
  it('returns only allowlisted response headers', async () => {
    const { res } = await run(okPng);
    assert.deepEqual(
      [...res.headers.keys()].sort(),
      ['cache-control', 'content-length', 'content-security-policy', 'content-type', 'cross-origin-resource-policy', 'etag', 'x-content-type-options'],
    );
  });
  it('normalises Content-Type parameters', async () => {
    const { res } = await run(() => pngResponse({ 'content-type': 'IMAGE/PNG; charset=binary' }));
    assert.equal(res.headers.get('content-type'), 'image/png');
  });
  it('replaces unsafe or missing Cache-Control with private, no-store', async () => {
    for (const cc of ['public, max-age=31536000', 'private, max-age=99999', 'max-age=300', '']) {
      const { res } = await run(() => pngResponse({ 'cache-control': cc }));
      assert.equal(res.headers.get('cache-control'), 'private, no-store', JSON.stringify(cc));
    }
  });
  it('drops a malformed ETag', async () => {
    const { res } = await run(() => pngResponse({ etag: 'no quotes' }));
    assert.equal(res.headers.get('etag'), null);
  });
});

describe('HEAD', () => {
  it('returns the image headers and no body', async () => {
    const { res, calls } = await run(() => new Response(null, { status: 200, headers: pngResponse().headers }), req(GOOD_URL, { method: 'HEAD' }));
    assert.equal(calls.length, 1);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal((await bytes(res)).byteLength, 0);
  });
  it('returns error statuses without a body', async () => {
    const { res } = await run(() => new Response(null, { status: 404 }), req(GOOD_URL, { method: 'HEAD' }));
    assert.equal(res.status, 404);
    assert.equal((await bytes(res)).byteLength, 0);
  });
});

describe('304 Not Modified', () => {
  const notModified = () => new Response(null, { status: 304, headers: { etag: '"abc123"', 'cache-control': 'private, max-age=300', 'set-cookie': 'x=1' } });
  it('passes through when the client sent a valid conditional header', async () => {
    const { res } = await run(notModified, req(GOOD_URL, { headers: { 'if-none-match': '"abc123"' } }));
    assert.equal(res.status, 304);
    assert.equal(res.headers.get('etag'), '"abc123"');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal((await bytes(res)).byteLength, 0);
  });
  it('is 502 unexpected_upstream_status when nothing conditional was sent', async () => {
    const { res } = await run(notModified);
    assert.equal(res.status, 502);
    assert.deepEqual(await json(res), { error: 'unexpected_upstream_status' });
  });
});

// One row per upstream answer that is not an image.
// [description, upstream status, upstream headers, upstream body, expected status, expected code, expected Retry-After]
const HTML = '<html><body>Render: service waking up</body></html>';
const matrix = [
  ['403 (invalid or expired token)', 403, {}, null, 403, 'forbidden', null],
  ['404 (unknown asset, or app-origin request)', 404, {}, null, 404, 'not_found', null],
  ['403 with an HTML body', 403, { 'content-type': 'text/html' }, HTML, 403, 'forbidden', null],
  ['404 with an HTML body', 404, { 'content-type': 'text/html' }, HTML, 404, 'not_found', null],
  ['429 from the read budget', 429, { 'retry-after': '3600', 'content-type': 'application/json' }, '{"error":"read_budget_reached"}', 429, 'rate_limited', '3600'],
  ['429 with an invalid Retry-After', 429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, null, 429, 'rate_limited', null],
  ['429 with an absurd Retry-After', 429, { 'retry-after': '999999999' }, null, 429, 'rate_limited', null],
  ['301 redirect', 301, { location: 'https://evil.example/x' }, null, 502, 'unexpected_upstream_redirect', null],
  ['302 redirect', 302, { location: 'https://evil.example/x' }, null, 502, 'unexpected_upstream_redirect', null],
  ['307 redirect', 307, { location: 'https://evil.example/x' }, null, 502, 'unexpected_upstream_redirect', null],
  ['308 redirect', 308, { location: 'https://evil.example/x' }, null, 502, 'unexpected_upstream_redirect', null],
  ['500 application error', 500, {}, null, 502, 'upstream_error', null],
  ['502 from the app (R2 read failed)', 502, {}, null, 502, 'upstream_error', null],
  ['503 with Retry-After', 503, { 'retry-after': '30', 'content-type': 'text/html' }, HTML, 503, 'upstream_unavailable', '30'],
  ['503 without Retry-After', 503, { 'content-type': 'text/html' }, HTML, 503, 'upstream_unavailable', null],
  ['504 gateway timeout', 504, {}, null, 504, 'upstream_timeout', null],
  ['599 unknown 5xx', 599, {}, null, 502, 'upstream_error', null],
  ['400', 400, {}, null, 502, 'unexpected_upstream_status', null],
  ['401', 401, {}, null, 502, 'unexpected_upstream_status', null],
  ['405', 405, {}, null, 502, 'unexpected_upstream_status', null],
  ['410', 410, {}, null, 502, 'unexpected_upstream_status', null],
  ['201', 201, {}, null, 502, 'unexpected_upstream_status', null],
  ['204', 204, {}, null, 502, 'unexpected_upstream_status', null],
  ['206 partial content', 206, { 'content-type': 'image/png' }, 'x', 502, 'unexpected_upstream_status', null],
];
describe('non-image upstream answers map to distinct, fixed responses', () => {
  for (const [name, status, headers, body, wantStatus, wantCode, wantRetry] of matrix) {
    it(name, async () => {
      const { res, calls } = await run(() => new Response(status === 204 ? null : body, { status, headers }));
      const text = await res.text();
      assert.equal(res.status, wantStatus);
      assert.deepEqual(JSON.parse(text), { error: wantCode });
      assert.equal(res.headers.get('retry-after'), wantRetry);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(res.headers.get('location'), null, 'a Location header is never forwarded');
      assert.ok(!text.includes('Render'), 'upstream bodies are never forwarded');
      assert.equal(calls.length, 1, 'a redirect is never followed');
      assertNoSecret(res, text);
    });
  }
  it('uses seven different outcomes, not one blanket 503', () => {
    assert.ok(new Set(matrix.map((r) => `${r[4]}:${r[5]}`)).size >= 8);
  });
});

describe('unexpected 200 answers', () => {
  it('HTML on 200 is 502 unexpected_content_type and the body is released', async () => {
    let cancelled = false;
    const body = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode(HTML)); }, cancel() { cancelled = true; } });
    const { res } = await run(() => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }));
    assert.equal(res.status, 502);
    assert.deepEqual(await json(res), { error: 'unexpected_content_type' });
    assert.equal(cancelled, true);
  });
  for (const type of ['image/svg+xml', 'application/octet-stream', 'text/plain', 'image/x-icon', '']) {
    it(`rejects Content-Type ${JSON.stringify(type)}`, async () => {
      const { res } = await run(() => new Response(PNG, { status: 200, headers: type ? { 'content-type': type } : {} }));
      assert.equal(res.status, 502);
      assert.deepEqual(await json(res), { error: 'unexpected_content_type' });
    });
  }
  it('rejects a declared length above the ceiling without reading the body', async () => {
    let cancelled = false;
    const body = new ReadableStream({ pull(c) { c.enqueue(PNG); }, cancel() { cancelled = true; } });
    const { res } = await run(() => new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(20 * 1024 * 1024) } }));
    assert.equal(res.status, 502);
    assert.deepEqual(await json(res), { error: 'upstream_response_too_large' });
    assert.equal(cancelled, true, 'the oversize body is cancelled, never streamed');
  });
  it('rejects a malformed Content-Length', async () => {
    const { res } = await run(() => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': '12abc' } }));
    assert.equal(res.status, 502);
  });
  it('errors the stream when an undeclared length exceeds the ceiling', async () => {
    const chunk = new Uint8Array(6);
    let n = 0;
    const body = new ReadableStream({ pull(c) { if (n++ < 3) c.enqueue(chunk); else c.close(); } });
    const { res } = await run(() => new Response(body, { status: 200, headers: { 'content-type': 'image/png' } }), req(), { ...ENV, MAX_RESPONSE_BYTES: '10' });
    assert.equal(res.status, 200);
    await assert.rejects(async () => { await res.arrayBuffer(); });
  });
});

describe('timeouts and network failure', () => {
  const never = (_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  it('504 upstream_timeout when no headers arrive in time', async () => {
    const { res } = await run(never, req(), { ...ENV, UPSTREAM_HEADER_TIMEOUT_MS: '30' });
    assert.equal(res.status, 504);
    assert.deepEqual(await json(res), { error: 'upstream_timeout' });
  });
  it('502 upstream_unreachable when the connection fails', async () => {
    const { res } = await run(() => { throw new TypeError('network error'); });
    assert.equal(res.status, 502);
    assert.deepEqual(await json(res), { error: 'upstream_unreachable' });
  });
  it('aborts a body that stalls after the headers (total timeout)', async () => {
    const make = (_u, init) => new Response(new ReadableStream({
      start(c) { c.enqueue(PNG.slice(0, 3)); init.signal.addEventListener('abort', () => c.error(new Error('aborted'))); },
    }), { status: 200, headers: { 'content-type': 'image/png' } });
    const { res } = await run(make, req(), { ...ENV, UPSTREAM_TOTAL_TIMEOUT_MS: '40' });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    assert.equal((await reader.read()).value.byteLength, 3);
    await assert.rejects(reader.read());
  });
});

describe('streaming', () => {
  it('delivers the first chunk before the upstream has finished', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let step = 0;
    const body = new ReadableStream({
      async pull(c) {
        if (step++ === 0) { c.enqueue(PNG.slice(0, 4)); return; }
        await gate;
        c.enqueue(PNG.slice(4));
        c.close();
      },
    });
    const { res } = await run(() => new Response(body, { status: 200, headers: { 'content-type': 'image/png' } }));
    const reader = res.body.getReader();
    const first = await reader.read();
    assert.equal(first.value.byteLength, 4, 'first chunk arrived while the upstream is still open');
    release();
    const second = await reader.read();
    assert.equal(second.value.byteLength, PNG.byteLength - 4);
    assert.equal((await reader.read()).done, true);
  });
});

describe('secrecy', () => {
  it('never puts the proxy secret into any response, on any path', async () => {
    const answers = [okPng, () => new Response(null, { status: 403 }), () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
      () => new Response(null, { status: 302, headers: { location: 'https://x.example' } })];
    for (const make of answers) {
      const { res } = await run(make);
      assertNoSecret(res, await res.text());
    }
  });
});

after(async () => {
  // Release any response body a test did not read, so no timer outlives the run.
  await Promise.all(responses.map((r) => (r.body && !r.bodyUsed ? r.body.cancel().catch(() => {}) : null)));
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.equal(/\bconsole\s*\./.test(source), false, 'source contains no console.* call');
  assert.equal(/\bcaches\b|cf\s*:/.test(source), false, 'source uses no Cache API and no cf options');
  assert.equal(consoleCalls.length, 0, `the Worker called console: ${JSON.stringify(consoleCalls)}`);
});
