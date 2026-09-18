const knex = require('../db');
const { createCampaignAuth } = require('./campaignAuthFactory');

// Existing callers keep the same guards and shared database instance.
module.exports = createCampaignAuth(knex);
