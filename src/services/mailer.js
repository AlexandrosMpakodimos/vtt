const nodemailer = require('nodemailer');

// Development/test sender only. Production must configure MAIL_FROM with an
// address the SMTP account is authorised to send as (validated at startup).
const DEVELOPMENT_FROM = 'VTT <no-reply@vtt.local>';

let transportPromise = null;

function mailError(code) {
  return Object.assign(new Error(code), { code });
}

function sender() {
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.MAIL_FROM) throw mailError('MAIL_SENDER_UNCONFIGURED');
    return process.env.MAIL_FROM;
  }
  return process.env.MAIL_FROM || DEVELOPMENT_FROM;
}

async function getTransport() {
  if (transportPromise) return transportPromise;
  transportPromise = (async () => {
    const production = process.env.NODE_ENV === 'production';
    if (process.env.NODE_ENV !== 'test' && process.env.SMTP_HOST) {
      const secure = process.env.SMTP_SECURE === 'true';
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure,
        // Production never sends credentials over an unencrypted session:
        // implicit TLS (secure) or mandatory STARTTLS, with normal certificate
        // verification (nodemailer's default; never disabled here).
        ...(production && !secure ? { requireTLS: true } : {}),
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    }
    // Production has no test-account or JSON fallback: a missing transport is
    // a configuration failure, not a silently undelivered message.
    if (production) throw mailError('MAIL_TRANSPORT_UNCONFIGURED');
    if (process.env.NODE_ENV === 'test' || process.env.MAIL_JSON === '1') {
      return nodemailer.createTransport({ jsonTransport: true });
    }
    const test = await nodemailer.createTestAccount();
    return nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: { user: test.user, pass: test.pass },
    });
  })();
  // A failed setup must not be cached forever.
  transportPromise.catch(() => { transportPromise = null; });
  return transportPromise;
}

async function send(message, previewLabel, linkLabel, link) {
  const from = sender();
  const transport = await getTransport();
  const info = await transport.sendMail({ from, ...message });
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log(`${previewLabel}:`, preview);
  if (process.env.NODE_ENV !== 'production' && process.env.MAIL_JSON === '1') console.log(`${linkLabel} (MAIL_JSON):`, link);
  return info;
}

function sendVerificationEmail(to, link) {
  return send({
    to,
    subject: 'Verify your email for VTT',
    text: `Welcome to VTT! Verify your email: ${link}`,
    html: `<p>Welcome to VTT!</p><p><a href="${link}">Click here to verify your email</a></p>`,
  }, 'Verification email preview', 'Verification link', link);
}

function sendPasswordResetEmail(to, link) {
  return send({
    to,
    subject: 'Reset your VTT password',
    text: `Someone requested a password reset for your VTT account. Reset it here (expires in 1 hour): ${link}\n\nIf this wasn't you, you can ignore this email.`,
    html: `<p>Someone requested a password reset for your VTT account.</p><p><a href="${link}">Click here to reset your password</a> (expires in 1 hour).</p><p>If this wasn't you, you can safely ignore this email.</p>`,
  }, 'Password reset email preview', 'Password reset link', link);
}

function sendEmailChangeEmail(to, link) {
  return send({
    to,
    subject: 'Confirm your new VTT email address',
    text: `Confirm this as your new VTT email address (expires in 1 hour): ${link}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>Confirm this as your new VTT email address (expires in 1 hour):</p><p><a href="${link}">Confirm new email</a></p><p>If you didn't request this, you can ignore this email.</p>`,
  }, 'Email change preview', 'Email change link', link);
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendEmailChangeEmail };
