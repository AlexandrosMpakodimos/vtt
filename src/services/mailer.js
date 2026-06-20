const nodemailer = require('nodemailer');

let transportPromise = null;

async function getTransport() {
  if (transportPromise) return transportPromise;
  transportPromise = (async () => {
    if (process.env.SMTP_HOST) {
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    }
    if (process.env.MAIL_JSON === '1') {
      return nodemailer.createTransport({ jsonTransport: true });
    }
    const test = await nodemailer.createTestAccount();
    return nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: { user: test.user, pass: test.pass },
    });
  })();
  return transportPromise;
}

async function sendVerificationEmail(to, link) {
  const transport = await getTransport();
  const info = await transport.sendMail({
    from: 'VTT <no-reply@vtt.local>',
    to,
    subject: 'Verify your email for VTT',
    text: `Welcome to VTT! Verify your email: ${link}`,
    html: `<p>Welcome to VTT!</p><p><a href="${link}">Click here to verify your email</a></p>`,
  });
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log('Verification email preview:', preview);
  if (process.env.MAIL_JSON === '1') console.log('Verification link (MAIL_JSON):', link);
  return info;
}

async function sendPasswordResetEmail(to, link) {
  const transport = await getTransport();
  const info = await transport.sendMail({
    from: 'VTT <no-reply@vtt.local>',
    to,
    subject: 'Reset your VTT password',
    text: `Someone requested a password reset for your VTT account. Reset it here (expires in 1 hour): ${link}\n\nIf this wasn't you, you can ignore this email.`,
    html: `<p>Someone requested a password reset for your VTT account.</p><p><a href="${link}">Click here to reset your password</a> (expires in 1 hour).</p><p>If this wasn't you, you can safely ignore this email.</p>`,
  });
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log('Password reset email preview:', preview);
  if (process.env.MAIL_JSON === '1') console.log('Password reset link (MAIL_JSON):', link);
  return info;
}

async function sendEmailChangeEmail(to, link) {
  const transport = await getTransport();
  const info = await transport.sendMail({
    from: 'VTT <no-reply@vtt.local>',
    to,
    subject: 'Confirm your new VTT email address',
    text: `Confirm this as your new VTT email address (expires in 1 hour): ${link}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>Confirm this as your new VTT email address (expires in 1 hour):</p><p><a href="${link}">Confirm new email</a></p><p>If you didn't request this, you can ignore this email.</p>`,
  });
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log('Email change preview:', preview);
  if (process.env.MAIL_JSON === '1') console.log('Email change link (MAIL_JSON):', link);
  return info;
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendEmailChangeEmail };