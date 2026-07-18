const rateLimit = require('express-rate-limit');

const tooMany = (req, res) =>
  res.status(429).json({ error: 'Too many requests, please try again later' });

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RL_LOGIN_MAX) || 10,
  standardHeaders: true, legacyHeaders: false, handler: tooMany,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RL_REGISTER_MAX) || 5,
  standardHeaders: true, legacyHeaders: false, handler: tooMany,
});

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RL_RESEND_MAX) || 3,
  standardHeaders: true, legacyHeaders: false, handler: tooMany,
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RL_FORGOT_MAX) || 3,
  standardHeaders: true, legacyHeaders: false, handler: tooMany,
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RL_RESET_MAX) || 10,
  standardHeaders: true, legacyHeaders: false, handler: tooMany,
});

// Authed, but still abusable to email-bomb a target address with "confirm" mails.
const changeEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RL_CHANGE_EMAIL_MAX) || 3,
  standardHeaders: true, legacyHeaders: false, handler: tooMany,
});

// Joining a private campaign verifies a room password, so this endpoint is a
// password-guessing surface exactly like login is — and it is limited like one.
const campaignJoinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RL_CAMPAIGN_JOIN_MAX) || 10,
  standardHeaders: true, legacyHeaders: false, handler: tooMany,
});

// Search is cheap per call but scrapeable in bulk; this bounds enumeration of
// the campaign list rather than protecting a secret.
const campaignSearchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RL_CAMPAIGN_SEARCH_MAX) || 60,
  standardHeaders: true, legacyHeaders: false, handler: tooMany,
});

// Creation is capped per-user in application logic; this bounds the rate at
// which a script can churn through that cap (create/delete/create).
const campaignCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RL_CAMPAIGN_CREATE_MAX) || 20,
  standardHeaders: true, legacyHeaders: false, handler: tooMany,
});

module.exports = {
  loginLimiter, registerLimiter, resendLimiter,
  forgotPasswordLimiter, resetPasswordLimiter, changeEmailLimiter,
  campaignJoinLimiter, campaignSearchLimiter, campaignCreateLimiter,
};