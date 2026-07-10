/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

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

// ── HTML escaping ─────────────────────────────────────────────────────────────
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Sender addresses ──────────────────────────────────────────────────────────
export const SENDERS = {
  noreply: "ContextMover <noreply@contextmover.com>",
  support: "ContextMover Support <support@contextmover.com>",
} as const;

export const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL ?? "priyanshu.open4work@gmail.com";

// ── sendEmail ─────────────────────────────────────────────────────────────────
export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
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
    replyTo: opts.replyTo,
  });
  console.log("[mailer] Sent:", opts.subject, "→", opts.to, "| id:", info.messageId);
}
