const crypto = require('node:crypto');

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.PORT !== '3001' ||
  process.env.UPLOAD_MODE !== 'strict'
) {
  throw new Error('Memory storage requires the isolated strict-mode test launcher.');
}

// Set before loading modules that capture the public storage origin.
process.env.R2_PUBLIC_BASE_URL = 'https://storage.test.invalid';

const db = require('../src/db');
const storage = require('../src/services/storage');

if (storage.isConfigured()) {
  throw new Error('Refusing to replace a configured real storage client.');
}

const objects = new Map();
const failFirstDelete = new Set();
const retryAttempts = new Map();
const retryMarker = Buffer.from('\nVTT_TEST_RETRY_TWICE\n');
const ambiguousMarker = Buffer.from('\nVTT_TEST_AMBIGUOUS\n');
const maxBytes = 64 * 1024 * 1024;
let storedBytes = 0;

function lookup(key) {
  const object = objects.get(key);
  if (!object) {
    const error = new Error('Test object not found');
    error.name = 'NoSuchKey';
    error.$metadata = { httpStatusCode: 404 };
    throw error;
  }
  return object;
}

Object.assign(storage, {
  testBackend: 'memory',
  testStats: { headCalls: 0, putCalls: 0 },
  testInventory: () => ({ count: objects.size, bytes: storedBytes }),
  isConfigured: () => true,
  publicUrl: (key) =>
    'https://storage.test.invalid/' +
    key.split('/').map(encodeURIComponent).join('/'),

  async putObject({ key, mime, body }) {
    storage.testStats.putCalls += 1;
    if (!Buffer.isBuffer(body)) throw new Error('Expected a Buffer');
    if (body.subarray(-retryMarker.length).equals(retryMarker)) {
      const attempt = (retryAttempts.get(key) || 0) + 1;
      retryAttempts.set(key, attempt);
      if (attempt < 3) throw new Error('Simulated transient write failure');
      retryAttempts.delete(key);
    }
    const previous = objects.get(key);
    const nextBytes = storedBytes - (previous ? previous.bytes.length : 0)
      + body.length;

    if (nextBytes > maxBytes) throw new Error('Memory fixture capacity exceeded');

    const bytes = Buffer.from(body);
    const etag = crypto.createHash('sha256').update(bytes).digest('hex');
    objects.set(key, { bytes, mime, etag });
    storedBytes = nextBytes;
    if (body.subarray(-ambiguousMarker.length).equals(ambiguousMarker)) {
      failFirstDelete.add(key);
      throw new Error('Simulated response loss AFTER storing the object');
    }
    return { etag };
  },

  async headSize(key) {
    storage.testStats.headCalls += 1;
    const object = lookup(key);
    return {
      bytes: object.bytes.length,
      mime: object.mime,
      etag: object.etag,
    };
  },

  async getObject(key) {
    const object = lookup(key);
    return { ...object, bytes: Buffer.from(object.bytes) };
  },

  async remove(key) {
    retryAttempts.delete(key);
    if (failFirstDelete.delete(key)) return false;
    const object = objects.get(key);
    if (object) {
      storedBytes -= object.bytes.length;
      objects.delete(key);
    }
    return true;
  },

  async listPage() {
    return {
      objects: [...objects].map(([key, object]) => ({
        key,
        bytes: object.bytes.length,
        etag: object.etag,
      })),
      nextToken: null,
    };
  },

  async presignUpload() {
    throw new Error('Legacy presigning is unavailable in the strict memory fixture.');
  },

  async readHead() {
    throw new Error('Legacy readback is unavailable in the strict memory fixture.');
  },
});

(async () => {
  const result = await db.raw(
    'SELECT current_database() AS database, current_user AS role'
  );
  const identity = result.rows[0];
  if (
    identity.database !== 'vtt_test' ||
    identity.role !== 'vtt_test_runner'
  ) {
    throw new Error('Unexpected test database');
  }

  console.log('Storage backend: memory only; objects disappear when this process stops.');
  require('../src/server');
})().catch(async () => {
  console.error('Memory test server could not start.');
  await db.destroy();
  process.exitCode = 1;
});
