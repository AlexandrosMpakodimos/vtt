// Process-local admission and completion accounting. Never retries application work.
function createLifecycle({ shutdownMs = 25000, exit = code => process.exit(code), log = console.error } = {}) {
  let state = 'starting';
  const active = new Set();
  const timers = new Set();
  const pools = [];
  const transports = [];
  const forceTransports = [];
  const stoppers = [];
  let stopping;
  function hold() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    active.add(promise);
    return () => { active.delete(promise); release(); };
  }
  function track(value) {
    if (!value || typeof value.then !== 'function') return value;
    const done = hold();
    Promise.resolve(value).then(done, done);
    return value;
  }
  function schedule(fn, ms) {
    const run = () => {
      if (state !== 'ready') return;
      track(Promise.resolve().then(fn)).catch(() => log('MAINTENANCE_FAILED'));
    };
    timers.add(setInterval(run, ms));
    run();
  }
  function health(req, res) {
    res.set('Cache-Control', 'no-store');
    res.status(state === 'ready' ? 200 : 503).json({ status: state });
  }
  function admit(req, res, next) {
    if (state !== 'ready') return res.status(503).set('Connection', 'close').json({ error: 'unavailable' });
    const done = hold();
    res.once('finish', done);
    res.once('close', done);
    next();
  }
  // Wrap the configured Express 4 stack, including nested routers. Returned
  // promises outlive response close. Callback business work uses middleware()
  // or explicitly returns/registers a promise; transport holds end on close.
  function instrumentExpress(stack) {
    for (const layer of stack || []) {
      if (layer.route) instrumentExpress(layer.route.stack);
      else if (layer.handle.stack) instrumentExpress(layer.handle.stack);
      else {
        const handler = layer.handle;
        if (handler.length === 4) continue;
        layer.handle = function tracked(req, res, next) {
          const release = hold();
          const done = () => {
            res.removeListener('finish', done);
            res.removeListener('close', done);
            release();
          };
          res.once('finish', done);
          res.once('close', done);
          const forward = (...args) => { done(); return next(...args); };
          try {
            const result = handler.call(this, req, res, forward);
            if (result && typeof result.then === 'function') {
              track(result);
              Promise.resolve(result).then(done, error => { done(); next(error); });
            } else if (res.writableEnded || res.destroyed) done();
            return result;
          } catch (error) { done(); throw error; }
        };
      }
    }
  }
  function instrumentSocket(socket) {
    const on = socket.on.bind(socket);
    socket.on = (event, fn) => on(event, function (...args) {
      try {
        const result = track(fn.apply(this, args));
        if (result?.catch) result.catch(() => log('SOCKET_HANDLER_FAILED'));
        return result;
      }
      catch { log('SOCKET_HANDLER_FAILED'); }
    });
    // Socket.IO 4 dispatch completes middleware before scheduling listeners on
    // nextTick. Hold through that tick, including rejected/disconnected packets.
    const run = socket.run.bind(socket);
    socket.run = (packet, callback) => {
      if (state !== 'ready') return callback(new Error('unavailable'));
      const done = hold();
      run(packet, (...args) => { callback(...args); process.nextTick(done); });
    };
    const use = socket.use.bind(socket);
    socket.use = fn => use((packet, next) => {
      const done = hold();
      try { track(fn(packet, (...args) => { done(); next(...args); })); }
      catch (error) { done(); next(error); }
    });
  }
  // Callback-based business middleware is independent of the transport hold.
  // In particular, Passport may finish a DB read after the response is aborted.
  function middleware(fn) {
    return function (req, res, next) {
      const done = hold();
      try { return track(fn(req, res, (...args) => { done(); return next(...args); })); }
      catch (error) { done(); throw error; }
    };
  }
  async function drain() {
    do {
      while (active.size) await Promise.allSettled([...active]);
      // Session adapters dispatch callbacks after their query promise settles.
      await new Promise(resolve => setImmediate(resolve));
    } while (active.size);
  }
  function shutdown(code = 0) {
    if (stopping) return stopping;
    const wasStarting = state === 'starting';
    state = 'stopping';
    const started = Date.now();
    // Absolute phase cutoffs reserve time for transport teardown, its callbacks,
    // and pool closure. There is one total deadline, never one per resource.
    const deadline = setTimeout(() => { log('SHUTDOWN_DEADLINE'); exit(1); }, shutdownMs);
    for (const timer of timers) clearInterval(timer);
    for (const stop of stoppers) {
      try { track(Promise.resolve(stop())).catch(() => log('STOP_FAILED')); }
      catch { log('STOP_FAILED'); }
    }
    async function until(promise, cutoff, message) {
      let timer;
      const expired = new Promise(resolve => {
        timer = setTimeout(() => { code = 1; log(message); resolve(false); },
          Math.max(1, started + cutoff - Date.now()));
      });
      try { return await Promise.race([Promise.resolve(promise).then(() => true), expired]); }
      finally { clearTimeout(timer); }
    }
    async function closeAll(fns) {
      const results = await Promise.allSettled(fns.map(fn => Promise.resolve().then(fn)));
      if (results.some(r => r.status === 'rejected')) { code = 1; log('CLOSE_FAILED'); }
    }
    stopping = (async () => {
      await until(drain(), wasStarting ? 1 : shutdownMs * 0.8, 'DRAIN_DEADLINE');
      const closed = await until(closeAll(transports), wasStarting ? 1000 : shutdownMs * 0.92,
        'TRANSPORT_DEADLINE');
      if (!closed) await closeAll(forceTransports);
      // Disconnect listeners and transport callbacks can enqueue tracked work.
      await until(drain(), wasStarting ? 1500 : shutdownMs * 0.96, 'COMPLETION_DEADLINE');
      await closeAll(pools);
      clearTimeout(deadline);
      state = 'stopped';
      exit(code);
    })();
    return stopping;
  }
  return { track, hold, schedule, health, admit, instrumentExpress, instrumentSocket, middleware, shutdown,
    pools, transports, forceTransports, stoppers, ready() { if (state === 'starting') state = 'ready'; },
    get state() { return state; }, get activeCount() { return active.size; } };
}
module.exports = { createLifecycle };
