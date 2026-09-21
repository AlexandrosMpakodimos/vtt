const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const environment = process.env.NODE_ENV || 'development';

const shared = {
  client: 'pg',
  migrations: {
    directory: path.join(__dirname, 'src/db/migrations'),
  },
};

if (environment === 'test') {
  let target;

  try {
    let connectionString = process.env.TEST_DATABASE_URL;

    if (!connectionString) {
      const dotenv = require('dotenv');
      const filename = path.join(os.homedir(), 'vtt-test-config.env');
      connectionString = dotenv.parse(
        fs.readFileSync(filename)
      ).TEST_DATABASE_URL;
    }

    target = new URL(connectionString);

    if (
      !['postgres:', 'postgresql:'].includes(target.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
      target.pathname !== '/vtt_test' ||
      decodeURIComponent(target.username) !== 'vtt_test_runner' ||
      !target.password ||
      target.search ||
      target.hash
    ) {
      throw new Error('Invalid test connection');
    }
  } catch {
    throw new Error(
      'Test database configuration refused. Expected the dedicated local ' +
      'vtt_test database and vtt_test_runner account; DATABASE_URL is never used.'
    );
  }

  module.exports = {
    test: {
      ...shared,
      connection: {
        host: target.hostname.replace(/^\[|\]$/g, ''),
        port: Number(target.port || 5432),
        user: decodeURIComponent(target.username),
        password: decodeURIComponent(target.password),
        database: 'vtt_test',
      },
      pool: {
        min: 0,
        max: 10,
        afterCreate(connection, done) {
          connection.query(`
            SELECT current_database() AS database,
                   current_user AS role,
                   rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
            FROM pg_roles
            WHERE rolname = current_user
          `, (error, result) => {
            const row = result && result.rows[0];
            if (
              error ||
              !row ||
              row.database !== 'vtt_test' ||
              row.role !== 'vtt_test_runner' ||
              row.rolsuper ||
              row.rolcreatedb ||
              row.rolcreaterole ||
              row.rolbypassrls
            ) {
              return done(
                new Error('Test database identity or permissions check failed.'),
                connection
              );
            }
            return done(null, connection);
          });
        },
      },
    },
  };
} else {
  require('dotenv').config();

  module.exports = {
    development: {
      ...shared,
      connection: process.env.DATABASE_URL,
    },
  };
}
