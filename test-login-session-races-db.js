// Run through scripts/test-local.js against the isolated test database.
process.env.LOGIN_RACE_POSTGRES = '1';
require('./test-login-session-races');
