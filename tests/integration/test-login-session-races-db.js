// Run through scripts/test-local.js against the isolated test database.
process.env.LOGIN_RACE_POSTGRES = '1';
require('../unit/test-login-session-races');
