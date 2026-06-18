const nodemailer = require('nodemailer');

let transportPromise = null;

// Transport selection, by env:
//  - SMTP_HOST set        -> real SMTP (e.g. Gmail) for production/demo
//  - MAIL_JSON=1          -> builds the message, sends nothing (offline/tests)
//  - otherwise (default)  -> Ethereal: a free throwaway inbox with a preview URL (dev)
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

  const preview = nodemailer.getTestMessageUrl(info); // Ethereal only
  if (preview) console.log('Verification email preview:', preview);
  if (process.env.MAIL_JSON === '1') console.log('Verification link (MAIL_JSON):', link);
  return info;
}

module.exports = { sendVerificationEmail };