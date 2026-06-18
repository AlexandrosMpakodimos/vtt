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

// Verification emails are abusable (email bombing), so keep this tight.
const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RL_RESEND_MAX) || 3,
  standardHeaders: true, legacyHeaders: false, handler: tooMany,
});

module.exports = { loginLimiter, registerLimiter, resendLimiter };