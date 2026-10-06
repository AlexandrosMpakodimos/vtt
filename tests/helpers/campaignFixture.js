// Fixture password for campaigns that tests insert straight into the database.
//
// Since the redundancy cleanup (Fix 3) a campaign is public exactly when its
// password_hash is NULL; there is no is_public column. A fixture that inserted a
// campaign with no hash used to be private by the column's default (false); to
// stay private it now needs a hash. This is a real Argon2id hash of
// FIXTURE_CAMPAIGN_PASSWORD with deliberately tiny cost parameters (verifying it
// takes about a millisecond); the parameters live inside the hash, so
// verifyPassword accepts it. Test fixtures only, never a production value.
const FIXTURE_CAMPAIGN_PASSWORD = 'fixture-campaign-pw';
const FIXTURE_CAMPAIGN_HASH =
  '$argon2id$v=19$m=1024,t=1,p=1$qTJuuDc5ANjGuxK+QL7dpw$w4XnhAD0MPdHf1t4p0KPtgQzvT74qAe0PzXKOkIRXSE';

module.exports = { FIXTURE_CAMPAIGN_PASSWORD, FIXTURE_CAMPAIGN_HASH };
