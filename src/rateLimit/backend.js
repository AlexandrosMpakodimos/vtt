const { createHmac } = require('node:crypto');
// Redis owns both the count and expiry. Rejected attempts never extend a window.
const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1])
end
local t = redis.call('TIME')
return {count, tonumber(t[1])*1000 + math.floor(tonumber(t[2])/1000) + ttl}`;
const DECREMENT = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > 0 then return redis.call('DECR', KEYS[1]) end
return 0`;
function unavailable() {
  return Object.assign(new Error('RATE_LIMIT_UNAVAILABLE'), { status: 503 });
}
function createBackend({ url, prefix, secret, onFailure = () => {},
  createClient = require('redis').createClient, timeoutMs = 2500 }) {
  if (typeof secret !== 'string' || secret.length < 32) throw unavailable();
  const client = createClient({ url, disableOfflineQueue: true, commandsQueueMaxLength: 128,
    socket: { connectTimeout: 2000, reconnectStrategy: false } });
  let ready = false, closed = false, failed = false;
  const waits = new Set();
  function fail() {
    if (closed || failed) return;
    failed = true; ready = false;
    for (const reject of waits) reject(unavailable());
    try { client.destroy(); } catch {}
    onFailure();
  }
  client.on('error', fail);
  client.on('end', () => { if (!closed) fail(); });
  async function bounded(fn) {
    if (closed || failed || waits.size >= 128) throw unavailable();
    return new Promise((resolve, reject) => {
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true; clearTimeout(timer); waits.delete(done);
        if (error) reject(error); else resolve(value);
      }
      const done = error => finish(error);
      const timer = setTimeout(fail, timeoutMs);
      waits.add(done);
      Promise.resolve().then(() => {
        if (closed || failed) throw unavailable();
        return fn();
      }).then(value => finish(null, value), () => { fail(); finish(unavailable()); });
    });
  }
  function key(scope, ip) {
    return `${prefix}:http-limit:v1:${scope}:` + createHmac('sha256', secret).update(ip).digest('hex');
  }
  async function command(fn) {
    if (!ready) throw unavailable();
    return bounded(fn);
  }
  return {
    async start() {
      await bounded(() => client.connect());
      await bounded(() => client.ping());
      if (closed || failed) throw unavailable();
      ready = true;
    },
    async increment(scope, ip, windowMs) {
      const result = await command(() => client.eval(INCREMENT,
        { keys: [key(scope, ip)], arguments: [String(windowMs)] }));
      if (!Array.isArray(result) || !Number.isSafeInteger(result[0]) || result[0] < 1 ||
          !Number.isSafeInteger(result[1])) { fail(); throw unavailable(); }
      return { totalHits: result[0], resetTime: new Date(result[1]) };
    },
    decrement: (scope, ip) => command(() => client.eval(DECREMENT, { keys: [key(scope, ip)], arguments: [] })),
    resetKey: (scope, ip) => command(() => client.del(key(scope, ip))),
    stop() {
      if (closed) return;
      closed = true; ready = false;
      for (const reject of waits) reject(unavailable());
      try { client.destroy(); } catch {}
    },
  };
}
module.exports = { createBackend, unavailable, INCREMENT, DECREMENT };
