// A hop count is safe only when every ingress path has that many trusted hops.
function proxyHops(env) {
  const value = env.TRUST_PROXY_HOPS;
  if (value === undefined && env.NODE_ENV !== 'production') return 0;
  if (typeof value !== 'string' || !/^[0-5]$/.test(value)) {
    const error = new Error('STARTUP_CONFIG_INVALID: TRUST_PROXY_HOPS');
    error.configKey = 'TRUST_PROXY_HOPS';
    throw error;
  }
  return Number(value);
}
module.exports = { proxyHops };
