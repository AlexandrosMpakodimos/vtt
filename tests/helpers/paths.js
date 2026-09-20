const path = require('node:path');

// Resolve from this module, never from the caller's working directory.
const root = path.resolve(__dirname, '../..');
const rootPath = (...parts) => path.resolve(root, ...parts);

module.exports = { root, rootPath };
