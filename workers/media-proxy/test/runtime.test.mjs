// Runtime tests: the same Worker source on the real workerd runtime (via Miniflare).
// The upstream is mocked at the network boundary with `outboundService`; nothing
// leaves the machine and no Cloudflare account is involved.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const here = path.dirname(fileURLToPath(import.meta.url));
const ID = '3f9c1c2e-7a44-4a0e-9d51-0b6f2e8a1c77';
const TOKEN = `${'A'.repeat(112)}.${'B'.repeat(43)}`;
const SECRET = 's3cr3t-'.repeat(6);
const ORIGIN = 'https://vtt-app.onrender.com';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
const URL_OK = `https://vtt-media.acct.workers.dev/media/${ID}?t=${TOKEN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Everything workerd writes to stdout/stderr (this is where console.* would appear).
let runtimeOutput = '';
let scenario = () => new Response(null, { status: 500 });
const outbound = [];

let mf;
before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: path.join(here, '..', 'src', 'index.js'),
    compatibilityDate: '2026-01-01',
    bindings: { UPSTREAM_ORIGIN: ORIGIN, MEDIA_PROXY_SECRET: SECRET, UPSTREAM_HEADER_TIMEOUT_MS: '150' },
    handleRuntimeStdio(stdout, stderr) {
      stdout.on('data', (d) => { runtimeOutput += d; });
      stderr.on('data', (d) => { runtimeOutput += d; });
    },
    outboundService: async (request) => {
      outbound.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers) });
      return scenario(request);
    },
  });
  await mf.ready;
});
after(async () => { await mf.dispose(); });

async function call(url = URL_OK, init = {}, make) {
  outbound.length = 0;
  scenario = make || (() => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.byteLength), etag: '"abc123"', 'cache-control': 'private, max-age=300' } }));
  const res = await mf.dispatchFetch(url, init);
  return res;
}

describe('workerd: success paths', () => {
  it('GET streams the image with the fixed headers; outbound call is fixed and clean', async () => {
    const res = await call(URL_OK, { headers: { cookie: 'sid=victim', authorization: 'Bearer x', referer: 'https://app.example/' } });
    assert.equal(res.status, 200);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
    assert.equal(outbound.length, 1, '`cache: no-store` and `redirect: manual` are accepted by workerd');
    assert.equal(outbound[0].url, `${ORIGIN}/media/${ID}?t=${TOKEN}`);
    assert.equal(outbound[0].method, 'GET');
    assert.equal(outbound[0].headers['x-media-proxy-auth'], SECRET);
    for (const h of ['cookie', 'authorization', 'referer', 'origin', 'x-forwarded-for', 'cf-connecting-ip']) {
      assert.equal(outbound[0].headers[h], undefined, `${h} is not forwarded`);
    }
  });
  it('HEAD returns headers and no body, and is sent upstream as HEAD', async () => {
    const res = await call(URL_OK, { method: 'HEAD' }, () => new Response(null, { status: 200, headers: { 'content-type': 'image/png', 'content-length': '10', 'cache-control': 'private, max-age=300' } }));
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(outbound[0].method, 'HEAD');
  });
  it('304 passes through only for a valid conditional request', async () => {
    const make = () => new Response(null, { status: 304, headers: { etag: '"abc123"', 'cache-control': 'private, max-age=300' } });
    const ok = await call(URL_OK, { headers: { 'if-none-match': '"abc123"' } }, make);
    assert.equal(ok.status, 304);
    assert.equal(outbound[0].headers['if-none-match'], '"abc123"');
    const bad = await call(URL_OK, {}, make);
    assert.equal(bad.status, 502);
  });
});

describe('workerd: rejected before any upstream call', () => {
  it('method, path and query', async () => {
    for (const [url, init, status] of [
      [URL_OK, { method: 'POST', body: 'x' }, 405],
      [`https://w.workers.dev/media/${ID}/x?t=${TOKEN}`, {}, 404],
      [`https://w.workers.dev/api/media/${ID}/token`, {}, 404],
      [`https://w.workers.dev/media/${ID}`, {}, 400],
      [`https://w.workers.dev/media/${ID}?t=${TOKEN}&x=1`, {}, 400],
    ]) {
      const res = await call(url, init);
      assert.equal(res.status, status, url);
      assert.equal(outbound.length, 0, url);
    }
  });
});

describe('workerd: distinct answers for distinct upstream outcomes', () => {
  const HTML = '<html>Render: waking up</html>';
  const rows = [
    ['403', () => new Response(null, { status: 403 }), 403, 'forbidden'],
    ['404', () => new Response(HTML, { status: 404, headers: { 'content-type': 'text/html' } }), 404, 'not_found'],
    ['429', () => new Response('{"error":"read_budget_reached"}', { status: 429, headers: { 'retry-after': '3600' } }), 429, 'rate_limited'],
    ['302 to elsewhere', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), 502, 'unexpected_upstream_redirect'],
    ['200 HTML', () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }), 502, 'unexpected_content_type'],
    ['500', () => new Response(null, { status: 500 }), 502, 'upstream_error'],
    ['503', () => new Response(HTML, { status: 503, headers: { 'retry-after': '30' } }), 503, 'upstream_unavailable'],
    ['504', () => new Response(null, { status: 504 }), 504, 'upstream_timeout'],
  ];
  for (const [name, make, status, code] of rows) {
    it(name, async () => {
      const res = await call(URL_OK, {}, make);
      const text = await res.text();
      assert.equal(res.status, status);
      assert.deepEqual(JSON.parse(text), { error: code });
      assert.equal(res.headers.get('location'), null);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.ok(!text.includes('Render') && !text.includes(SECRET));
      assert.equal(outbound.length, 1, 'redirects are not followed');
    });
  }
  it('429 keeps a valid Retry-After', async () => {
    const res = await call(URL_OK, {}, () => new Response(null, { status: 429, headers: { 'retry-after': '3600' } }));
    assert.equal(res.headers.get('retry-after'), '3600');
  });
});

describe('workerd: timeouts and streaming', () => {
  it('504 when the upstream sends no headers within the bound', async () => {
    const res = await call(URL_OK, {}, async () => { await sleep(1_000); return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }); });
    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), { error: 'upstream_timeout' });
  });
  it('delivers the first chunk before the upstream body is complete', async () => {
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
    const res = await call(URL_OK, {}, () => new Response(body, { status: 200, headers: { 'content-type': 'image/png' } }));
    const reader = res.body.getReader();
    const first = await reader.read();
    assert.equal(first.value.byteLength, 4);
    release();
    let total = first.value.byteLength;
    for (let r = await reader.read(); !r.done; r = await reader.read()) total += r.value.byteLength;
    assert.equal(total, PNG.byteLength);
  });
});

describe('workerd: observability', () => {
  it('the runtime wrote nothing to stdout or stderr, and no token or secret anywhere', async () => {
    await sleep(100);
    assert.ok(!runtimeOutput.includes(TOKEN), 'token never logged');
    assert.ok(!runtimeOutput.includes(SECRET), 'secret never logged');
    assert.ok(!runtimeOutput.includes(ID), 'asset id never logged');
  });
});
