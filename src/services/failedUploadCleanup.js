const budget = require('./storageBudget');

// Preserve an ambiguous upload's liability and queue deletion atomically.
module.exports = async function queueFailedUpload(assetId) {
  return budget.inSerializable(async (trx) => {
    const asset = await trx('assets').where({ id: assetId }).forUpdate().first();
    if (!asset) throw new Error('Failed upload asset is missing');
    if (asset.status === 'ready') throw new Error('Cannot queue a ready upload');

    const amount = Number(asset.reserved_bytes || 0);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error('Invalid upload reservation');
    }

    const queued = await trx('storage_cleanup')
      .where({ storage_key: asset.storage_key }).first();

    if (queued) {
      if (amount !== 0) throw new Error('Upload already queued with a live reservation');
      return;
    }

    if (amount > 0) {
      const ledger = await budget.readRow(trx);
      const reserved = Number(ledger.reserved_bytes);
      if (reserved < amount) throw new Error('Upload reservation exceeds ledger');

      await trx('storage_budget').where({ id: true }).update({
        reserved_bytes: reserved - amount,
        cleanup_debt_bytes: Number(ledger.cleanup_debt_bytes) + amount,
        updated_at: trx.fn.now(),
      });
    }

    await trx('storage_cleanup').insert({
      storage_key: asset.storage_key,
      bytes: amount || null,
      reason: 'delete_failed',
    });

    await trx('assets').where({ id: assetId }).update({
      status: 'rejected',
      reserved_bytes: null,
      updated_at: trx.fn.now(),
    });
  });
};
