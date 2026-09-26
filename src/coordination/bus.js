const { randomUUID } = require('node:crypto');
// Pub/Sub is deliberately non-durable. Any lost subscription, failed heartbeat,
// oversized backlog or command failure terminates this server. Clients reconnect
// and reload authoritative state; historical authorization is never replayed.
const REGISTRY = `
local epoch = redis.call('GET',KEYS[3])
if not epoch then redis.call('SET',KEYS[3],ARGV[3]); epoch = ARGV[3] end
local now = redis.call('TIME')
local ms = tonumber(now[1])*1000 + math.floor(tonumber(now[2])/1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ms-8000)
for _, id in ipairs(expired) do redis.call('HDEL',KEYS[2],id); redis.call('ZREM',KEYS[1],id) end
if redis.call('HEXISTS',KEYS[2],ARGV[1]) == 0 and redis.call('HLEN',KEYS[2]) >= 8 then return redis.error_reply('NODE_LIMIT') end
redis.call('HSET',KEYS[2],ARGV[1],ARGV[2])
redis.call('ZADD',KEYS[1],ms,ARGV[1])
redis.call('PEXPIRE',KEYS[1],16000); redis.call('PEXPIRE',KEYS[2],16000)
local result = redis.call('HVALS',KEYS[2]); table.insert(result,1,epoch); return result`;
// Connection setup (TCP, TLS, AUTH) is bounded separately from commands; see
// CONNECT_TIMEOUT_MS in rateLimit/backend.js for the measured reason. Commands,
// heartbeats and registry refreshes keep the 2.5 s bound that detects failure.
const COMMAND_TIMEOUT_MS = 2500;
const CONNECT_TIMEOUT_MS = 10000;
function createBus({ url, prefix, onFailure, createClient = require('redis').createClient,
  commandTimeoutMs = COMMAND_TIMEOUT_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
  const id = randomUUID(), channel = `${prefix}:events`;
  const options = { url, disableOfflineQueue: true, commandsQueueMaxLength: 128, socket: { connectTimeout: 2000, reconnectStrategy: false } };
  const command = createClient(options), subscriber = createClient(options);
  let ready = false, closed = false, failed = false, timer, handler, snapshot = () => ({});
  let nodes = [], pending = 0, bytes = 0, tail = Promise.resolve(), refreshTail = Promise.resolve();
  let pulse, epoch, queuedRefreshes = 0, publishingBytes = 0, heartbeatTask = Promise.resolve();
  const waits = new Set();
  function fail(reason) {
    const known = new Set(['RECEIVE_BACKLOG', 'PUBLISH_LIMIT', 'REFRESH_BACKLOG', 'TIMEOUT', 'PROTOCOL']);
    const safeReason = known.has(reason) ? reason : 'BACKEND_OR_HANDLER';
    if (closed || failed) return;
    failed = true; ready = false; clearInterval(timer);
    for (const reject of waits) reject(new Error('COORDINATION_UNAVAILABLE'));
    try { command.destroy(); } catch {}
    try { subscriber.destroy(); } catch {}
    onFailure(safeReason);
  }
  function bounded(promise, limitMs = commandTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { fail('TIMEOUT'); reject(new Error('COORDINATION_TIMEOUT')); }, limitMs);
      waits.add(reject);
      Promise.resolve(promise).then(resolve, reject).finally(() => { clearTimeout(timeout); waits.delete(reject); });
    });
  }
  for (const client of [command, subscriber]) {
    client.on('error', fail); client.on('end', () => { if (!closed) fail(); });
  }
  function receive(raw) {
    if (closed || failed) return;
    let message;
    try { message = JSON.parse(raw); } catch { return fail('PROTOCOL'); }
    if (message.type === 'pulse') {
      if (message.node === id && pulse?.nonce === message.nonce) pulse.resolve();
      return;
    }
    const size = Buffer.byteLength(raw);
    if (++pending > 128 || (bytes += size) > 2 * 1024 * 1024) return fail('RECEIVE_BACKLOG');
    tail = tail.then(async () => { if (ready && !closed) await handler(message); })
      .catch(fail).finally(() => { pending--; bytes -= size; });
    return tail;
  }
  async function heartbeat() {
    const nonce = randomUUID();
    const received = new Promise(resolve => { pulse = { nonce, resolve }; });
    await bounded(command.publish(channel, JSON.stringify({ type: 'pulse', node: id, nonce })));
    await bounded(received);
    pulse = null;
  }
  function refresh() {
    if (++queuedRefreshes > 64) { queuedRefreshes--; fail('REFRESH_BACKLOG'); return Promise.reject(new Error('COORDINATION_BACKLOG')); }
    const task = refreshTail.then(async () => {
      if (failed || closed) throw new Error('COORDINATION_UNAVAILABLE');
      const value = JSON.stringify(snapshot());
      if (Buffer.byteLength(value) > 65536) throw new Error('COORDINATION_PRESENCE_LIMIT');
      const values = await bounded(command.eval(REGISTRY, { keys: [`${prefix}:nodes`, `${prefix}:presence`, `${prefix}:epoch`], arguments: [id, value, randomUUID()] }));
      const nextEpoch = values.shift();
      if (epoch && epoch !== nextEpoch) throw new Error('COORDINATION_RESET');
      epoch = nextEpoch;
      nodes = values.map(value => JSON.parse(value));
      return nodes;
    });
    refreshTail = task.catch(fail).finally(() => { queuedRefreshes--; });
    return task;
  }
  async function publish(message) {
    if (!ready || closed || failed) throw new Error('COORDINATION_UNAVAILABLE');
    const raw = JSON.stringify(message);
    const size = Buffer.byteLength(raw);
    if (size > 1024 * 1024 || publishingBytes + size > 2 * 1024 * 1024) { fail('PUBLISH_LIMIT'); throw new Error('COORDINATION_MESSAGE_LIMIT'); }
    publishingBytes += size;
    try { await bounded(command.publish(channel, raw)); }
    catch (error) { fail(); throw error; }
    finally { publishingBytes -= size; }
  }
  async function start(receiver, getSnapshot) {
    handler = receiver; snapshot = getSnapshot;
    try {
      await bounded(Promise.all([command.connect(), subscriber.connect()]), connectTimeoutMs);
      await bounded(subscriber.subscribe(channel, receive));
      await heartbeat();
      await refresh();
      ready = true;
      let running = false;
      timer = setInterval(() => {
        if (running || closed || failed) return;
        running = true;
        heartbeatTask = (async () => {
          try {
            await heartbeat();
            await refresh();
            await receive(JSON.stringify({ type: 'presence-refresh' }));
          } catch { fail(); }
          finally { running = false; }
        })();
      }, 2000);
    } catch (error) { fail(); throw error; }
  }
  async function close() {
    if (closed) return;
    ready = false; closed = true; clearInterval(timer);
    // Never wait for a disconnected backend during shutdown.
    try { command.destroy(); } catch {}
    try { subscriber.destroy(); } catch {}
    for (const reject of waits) reject(new Error('COORDINATION_CLOSED'));
    await Promise.allSettled([tail, refreshTail, heartbeatTask]);
  }
  return { start, publish, refresh, close, fail, get ready() { return ready && !closed && !failed; }, get nodes() { return nodes; } };
}
module.exports = { createBus, COMMAND_TIMEOUT_MS, CONNECT_TIMEOUT_MS };
