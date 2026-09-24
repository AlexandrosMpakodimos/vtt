// Pure validation: import before any configuration-capturing application module.
const keys = new Set(['NODE_ENV', 'DATABASE_URL', 'SESSION_SECRET', 'PORT', 'BASE_URL',
  'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'R2_MAX_TOTAL_BYTES', 'R2_MAX_CLASS_A', 'R2_MAX_CLASS_B', 'R2_MAINT_CLASS_A', 'R2_MAINT_CLASS_B',
  'MEDIA_ORIGIN', 'MEDIA_PROXY_SECRET', 'COORDINATION_URL']);
function invalid(key) {
  const error = new Error(`STARTUP_CONFIG_INVALID: ${key}`);
  error.configKey = key;
  throw error;
}
function httpsUrl(value, key) {
  try {
    if (typeof value !== 'string' || /\s/.test(value)) throw 0;
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw 0;
    return url;
  } catch { invalid(key); }
}
function validate(env) {
  // Unset retains the historical development default; explicit unknown/blank fails.
  if (env.NODE_ENV !== undefined && !['development', 'test', 'production'].includes(env.NODE_ENV)) invalid('NODE_ENV');
  if (env.NODE_ENV !== 'production') return;
  require('./database').connection(env);
  if (!env.SESSION_SECRET || env.SESSION_SECRET.trim().length < 32 ||
      env.SESSION_SECRET === 'change-this-to-a-random-string') invalid('SESSION_SECRET');
  httpsUrl(env.BASE_URL, 'BASE_URL');
  if (env.PORT !== undefined && (!/^\d+$/.test(env.PORT) || +env.PORT < 1 || +env.PORT > 65535)) invalid('PORT');
  const storage = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  // All absent/empty intentionally disables storage; a partial group is a mistake.
  if (storage.some(key => !!env[key])) {
    for (const key of storage) if (!String(env[key] || '').trim()) invalid(key);
    if (!/^[a-zA-Z0-9-]+$/.test(env.R2_ACCOUNT_ID)) invalid('R2_ACCOUNT_ID');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET)) invalid('R2_BUCKET');
    httpsUrl(env.R2_PUBLIC_BASE_URL, 'R2_PUBLIC_BASE_URL');
  }
  for (const key of ['R2_MAX_TOTAL_BYTES', 'R2_MAX_CLASS_A', 'R2_MAX_CLASS_B', 'R2_MAINT_CLASS_A', 'R2_MAINT_CLASS_B']) {
    if (env[key] && (!Number.isSafeInteger(Number(env[key])) || Number(env[key]) < 0)) invalid(key);
  }
  if (env.MEDIA_HOST && env.MEDIA_ORIGIN) {
    let url;
    try { url = new URL(env.MEDIA_ORIGIN.trim()); } catch { invalid('MEDIA_ORIGIN'); }
    if (!['http:', 'https:'].includes(url.protocol)) invalid('MEDIA_ORIGIN');
  }
  if (!env.COORDINATION_URL) invalid('COORDINATION_URL');
  require('../coordination/config').configuration(env);
  if (env.MEDIA_PROXY_SECRET && (env.MEDIA_PROXY_SECRET.length < 32 ||
      env.MEDIA_PROXY_SECRET === env.SESSION_SECRET || env.MEDIA_PROXY_SECRET === env.MEDIA_TOKEN_SECRET)) invalid('MEDIA_PROXY_SECRET');
}
function diagnostic(error) {
  if (keys.has(error?.configKey)) return `STARTUP_FAILED: STARTUP_CONFIG_INVALID: ${error.configKey}`;
  if (['DB_CONFIG_INVALID', 'DB_ENV_UNSUPPORTED', 'DB_SCHEMA_INVALID', 'DB_SCHEMA_CHECK_FAILED'].includes(error?.code)) {
    return `STARTUP_FAILED: ${error.code}`;
  }
  return 'STARTUP_FAILED';
}
module.exports = { validate, diagnostic };
