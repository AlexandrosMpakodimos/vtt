# Shared HTTP limits and proxy configuration

Existing HTTP limiter windows, limits, paths, 429 body and headers are preserved.
When coordination is configured, all ten limiter scopes use a dedicated Redis
client and atomic fixed-window counters. Separate processes share the allowance.
Each counter expires; blocked attempts do not extend its window. Keys include
the coordination prefix, limiter scope, and HMAC-SHA256 of the normalized IP,
using SESSION_SECRET. Do not mix secrets, prefixes or limit settings across
replicas. Changing the secret/prefix resets the effective allowance.

Production refuses requests if no shared backend is configured. Connection loss,
script errors, malformed replies and timeouts fail closed with sanitized errors
and trigger application shutdown. Saturation of the bounded command queue returns
503. No offline queue, automatic reconnect or memory fallback is used. An extra
Redis connection is required per application instance. Local development without
coordination retains in-process limiting. Redis loss/recreation can erase counters;
persistence and provider capacity remain operational choices. Use noeviction;
monitor memory, rather than allowing active counters to be evicted.

Limits remain IP-based. IPv6 uses express-rate-limit's default /56 grouping;
shared NAT users share an allowance. Authenticated content writes retain their
existing IP-based scope. This does not add WebSocket message limits, a global
traffic budget, account-based throttling, or protection against a distributed botnet.

## Proxy and cookies

TRUST_PROXY_HOPS is required in production, an explicit integer from 0 to 5.
Local default is 0. There is no trust-all mode. Render documents a one-hop Express
example, but do not assume that proves this deployment's ingress topology:
https://render.com/articles/how-render-handles-ddos-attacks
https://expressjs.com/en/guide/behind-proxies/

Use 1 only when the application is reachable exclusively through one trusted
proxy that sanitizes X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host.
Any shorter/direct route would allow spoofing. Verify the actual deployed path
before inviting users, including custom domains and the platform hostname.
A new CDN or different ingress path requires rechecking the configuration.
Do not expose a diagnostic endpoint that echoes headers, cookies or credentials.

Production cookies retain Secure, HttpOnly, SameSite=Lax and the seven-day TTL.
Express proxy trust enables recognition of forwarded HTTPS; session's proxy
option is intentionally not set to unconditional trust. Local HTTP behavior
is unchanged. No redirect URL is constructed from forwarded host values here.

## Tests

npm test includes test-http-limits.js: real HTTP/Express/session middleware with
explicit Redis doubles for fast fault injection. It covers independent middleware
instances, scope/IP separation, IPv6 grouping, cookie attributes, proxy selection,
missing backend, startup timeout, backend loss and pending-command cancellation.
The Redis Lua requires this opt-in test, with local Valkey running:

    NODE_ENV=test TEST_COORDINATION_URL=redis://127.0.0.1:6379/0 node tests/integration/test-http-limits-processes.js

This starts two loopback child processes and uses a random namespace, with no
application database. It tests concurrent admission, scope isolation, spoofed
leftmost IP, restart persistence, actual TTL and decrement/reset operations.
It deletes only its own random-prefixed keys at teardown; never FLUSHDB.
