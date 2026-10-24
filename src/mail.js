'use strict';

// Sends email over SMTP. Works with any mail provider that offers SMTP: a Gmail
// account with an app password, Outlook, or a sending service such as Resend,
// Postmark or Mailgun.

const nodemailer = require('nodemailer');

// Returns a mailer configured from the environment, or null when email isn't set up:
//   SMTP_HOST, SMTP_PORT (default 465), SMTP_USER, SMTP_PASS, EMAIL_FROM (default SMTP_USER)
function mailerFromEnv(env = process.env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  const port = Number(env.SMTP_PORT) || 465;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465, // other ports upgrade to TLS with STARTTLS
    requireTLS: port !== 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  const from = env.EMAIL_FROM || `The Caleb Index <${env.SMTP_USER}>`;
  return {
    send: ({ to, subject, text, headers }) => transport.sendMail({ from, to, subject, text, headers }),
  };
}

module.exports = { mailerFromEnv };
