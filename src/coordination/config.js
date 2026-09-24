function configuration(env) {
  if (!env.COORDINATION_URL) return null;
  try {
    const url = new URL(env.COORDINATION_URL);
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname || url.hash || url.search || /\s/.test(env.COORDINATION_URL)) throw 0;
    if (!['', '/', '/0'].includes(url.pathname)) throw 0;
    if (env.NODE_ENV === 'test' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw 0;
    const prefix = env.COORDINATION_PREFIX || 'vtt:coord:v1';
    if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(prefix)) throw 0;
    return { url: env.COORDINATION_URL, prefix };
  } catch {
    const error = new Error('COORDINATION_CONFIG_INVALID');
    error.configKey = 'COORDINATION_URL';
    throw error;
  }
}
module.exports = { configuration };
