// packages/web/src/lib/mailer.ts
// ZeptoMail SMTP transport via nodemailer.
// Only runs server-side. Never import in client components.

import nodemailer from "nodemailer";

// ── Transport (lazy singleton) ────────────────────────────────────────────────
let _transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (_transporter) return _transporter;

  const pass = process.env.ZEPTO_SMTP_PASSWORD;
  if (!pass) {
    throw new Error("[mailer] ZEPTO_SMTP_PASSWORD is not set.");
  }

  _transporter = nodemailer.createTransport({
    host: "smtp.zeptomail.in",
    port: 587,
    secure: false,
    auth: {
      user: "emailapikey",
      pass,
    },
    tls: { minVersion: "TLSv1.2" },
  });

  return _transporter;
}

// ── Sender addresses ──────────────────────────────────────────────────────────
export const SENDERS = {
  noreply: "ContextMover <noreply@contextmover.com>",
  support: "ContextMover Support <support@contextmover.com>",
} as const;

// ── sendEmail ─────────────────────────────────────────────────────────────────
export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  const from = opts.from ?? SENDERS.noreply;

  if (!process.env.ZEPTO_SMTP_PASSWORD) {
    throw new Error("[mailer] ZEPTO_SMTP_PASSWORD is not set — cannot send email.");
  }

  const info = await getTransporter().sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
  });
  console.log("[mailer] Sent:", opts.subject, "→", opts.to, "| id:", info.messageId);
}
