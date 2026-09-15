const knex = require('../db');
const gateway = require('./mediaGateway');
const storage = require('./storage');

function refused() {
  const error = new Error('That image is unavailable for this campaign.');
  error.status = 400;
  return error;
}

// Persist a stable reference. Delivery tokens are never storage references.
// Authorise using the current session, even if the supplied token has expired.
async function canonicalImageReference(value, { viewerId, campaignId }) {
  if (!value || typeof value !== 'string') return value;

  let assetId = null;
  let mediaOrigin = null;
  try {
    mediaOrigin = new URL(gateway.MEDIA_ORIGIN).origin;
  } catch {
    // Media delivery may be disabled.
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw refused();
  }

  if (mediaOrigin && parsed.origin === mediaOrigin) {
    const match = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(parsed.pathname);
    if (!match) throw refused();
    assetId = match[1];
  } else {
    const key = gateway.storageKeyFromUrl(value);
    if (!key) return value;

    const row = await knex('assets')
      .where({ storage_key: key, status: 'ready' })
      .select('id')
      .first();
    if (!row) throw refused();
    assetId = row.id;
  }

  const asset = await gateway.resolveVisible(assetId, viewerId);
  if (!asset || !asset.storage_key) throw refused();

  // Viewing another campaign's private image does not authorise sharing it
  // with this campaign. Avatars and covers already have public-media scope.
  const publicMedia = asset.kind === 'avatar' || asset.kind === 'cover';
  if (!publicMedia && asset.campaign_id !== campaignId) throw refused();

  const canonical = storage.publicUrl(asset.storage_key);
  if (!canonical) throw refused();
  return canonical;
}

module.exports = canonicalImageReference;
