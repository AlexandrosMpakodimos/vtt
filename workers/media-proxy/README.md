# Media proxy Worker

A Cloudflare Worker that sits in front of the VTT app's `/media/:id` route so that media is served from its own hostname. **It has never been deployed.** It is a separate package: its manifest, lockfile, dependency (Miniflare, which brings workerd) and test commands are independent of the application's.

The Worker authorizes nothing. The app still verifies the signed media token, checks the asset row, meters storage reads and caches. The Worker only accepts one request shape, proves to the app that the request came through it (the `X-Media-Proxy-Auth` header, checked by the app's proxy gate), and translates the app's answer.

## Contract

| Concern | Behaviour |
| --- | --- |
| Upstream | One fixed HTTPS origin from `UPSTREAM_ORIGIN`, re-validated on every request: no credentials, path, port, IP literal or `localhost`. The outbound URL is rebuilt from validated parts, never from the incoming URL |
| Accepted requests | `GET` and `HEAD` on exactly `/media/<lowercase uuid>` with exactly one `t` query parameter of token shape. Everything else is answered locally (405, 404, 400) and never reaches the app |
| Outbound headers | A fresh set: `x-media-proxy-auth`, `accept`, `accept-encoding: identity`, `user-agent`, and a validated `if-none-match`. No client cookie, authorization or forwarding header is copied |
| Redirects and caching | `redirect: 'manual'`; any 3xx becomes 502 and is never followed. `cache: 'no-store'`; no Cache API, no `cf` options |
| Timeouts and size | Header timeout 15 s, total 45 s, 14 MiB ceiling, all configurable within bounds. Responses are streamed, not buffered |
| Responses | Image types only (PNG, JPEG, WebP, GIF), with `nosniff`, `default-src 'none'; sandbox` and `Cross-Origin-Resource-Policy: cross-origin` set by the Worker. Upstream error bodies are never forwarded; each outcome maps to its own status and code (403, 404, 429 with a validated `Retry-After`, 502, 503, 504) |
| Logging | The Worker writes nothing. Workers Logs, tracing, Logpush and Tail Workers must stay off, because the request URL carries a live token |

## Configuration (names only)

| Name | Kind | Meaning |
| --- | --- | --- |
| `UPSTREAM_ORIGIN` | Variable | HTTPS origin of the app |
| `MEDIA_PROXY_SECRET` | Secret | Same value as the app's `MEDIA_PROXY_SECRET`; at least 32 characters. Never in this repository |
| `UPSTREAM_HEADER_TIMEOUT_MS`, `UPSTREAM_TOTAL_TIMEOUT_MS`, `MAX_RESPONSE_BYTES` | Variables, optional | Bounded overrides |

`wrangler.jsonc` is a reference configuration only. It has not been validated by `wrangler`, and its `preview_urls` key is unverified. `.dev.vars` and `.wrangler/` are ignored by the repository.

## Tests

```
npm ci               # in this directory
npm test             # unit (Node, mocked upstream) and runtime (workerd, mocked upstream)
npm run test:integration
```

`npm run test:integration` runs the same Worker code, in Node and in workerd, against the app's real media router with the merged proxy gate. It needs `npm ci` here and at the repository root, and the isolated test database (it forces `NODE_ENV=test`; a missing configuration fails the run). Object storage is stubbed, every secret is synthetic, and the network is a loopback mapping. It then re-runs its own file as child processes with a fault (a configuration rejection, a failure after the pool exists, a failure after the listener and fixtures exist, a failed database cleanup) and requires each to exit nonzero, restore local state and close what it created. That is local evidence only. Nothing has run on Render or Cloudflare.

Details, recovery after an interrupted integration run, and the evidence tiers are in [docs/testing.md](../../docs/testing.md). Configuration and the unresolved deployment-only checks are in [docs/deployment.md](../../docs/deployment.md).

## Dependency overrides

`package.json` overrides two exact pins inside Miniflare, scoped to Miniflare: `sharp` 0.35.4 (Miniflare 4.20260730.0 pins 0.35.2) and `undici` 7.29.0 (it pins 7.28.0). `npm audit` reported advisories against `sharp` below 0.35.4 (libheif) and `undici` below 7.29.0 (five advisories). Miniflare 4.20260730.0 is the newest stable Miniflare 4 release and no stable release pins fixed versions; the only fixed line is a Miniflare 5 alpha, which is not adopted.

Both packages are test tooling only. Miniflare is a devDependency, the Worker has no runtime dependencies, and nothing here is deployed. Checked against Miniflare's actual usage: `sharp` is loaded only by its Images binding, which this project never uses; `undici` is used through its public API (`fetch`, `Headers`, `Request`, `Response`, `FormData`, `Pool`, `MockAgent`, `Dispatcher`) and none of the cache, retry or cookie interfaces the advisories concern. Both packages declare Node requirements no higher than Miniflare's own (`>=22.0.0`), and the tests pass on Node 22.0.0, 22.22.2, 24.21.0 and 26.9.0.

To remove the overrides: when a stable Miniflare release pins `sharp` 0.35.4 or later and `undici` 7.29.0 or later, bump Miniflare, delete the `overrides` block, regenerate the lockfile, and run `npm ci`, `npm audit`, `npm test` and `npm run test:integration`. The lockfile differs from the frozen package's lockfile only in `sharp`, `undici` and the `@img` platform packages.

## Provenance

`src/index.js`, `test/handler.test.mjs`, `test/runtime.test.mjs` and `wrangler.jsonc` are byte-identical to the reviewed and frozen design package (`media-worker-design-package.zip`, SHA-256 `35449c806de1fc9bbc9826842cd7b27a124e30028da1870116dc6d7c52acd5b2`). Changing them changes the reviewed contract and needs a new review.
