const path = require('node:path');

const environment = process.env.NODE_ENV || 'development';
const entrypoint = path.basename(process.argv[1] || '');

if (/^(test-|break-)/.test(entrypoint) && environment !== 'test') {
  throw new Error(
    'Database-backed tests require NODE_ENV=test. ' +
    'The development database connection was refused.'
  );
}

const knex = require('knex');
const config = require('../../knexfile');

if (!config[environment]) {
  throw new Error('No database configuration exists for this NODE_ENV.');
}

module.exports = knex(config[environment]);
