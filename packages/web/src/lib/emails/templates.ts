/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/lib/emails/templates.ts
// Transactional email HTML templates for ContextMover.
// Plain HTML — no external CSS, no images (maximises deliverability).

const BASE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: #0A0A0A;
  color: #F5F5F5;
  margin: 0;
  padding: 0;
`;

function layout(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${BASE}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;padding:40px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#111111;border:1px solid #2A2A2A;border-radius:12px;overflow:hidden">

        <!-- Header -->
        <tr>
          <td style="padding:22px 36px;border-bottom:1px solid #1A1A1A;background:#000000">
            <img src="https://contextmover.com/logo.png" alt="ContextMover" width="160" height="56" style="display:block;border:0;outline:none;text-decoration:none" />
          </td>
        </tr>

        <!-- Body -->
        <tr><td style="padding:36px 36px 28px">${body}</td></tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 36px;border-top:1px solid #1A1A1A;background:#0D0D0D">
            <p style="margin:0;font-size:12px;color:#6B6B6B;line-height:1.6">
              ContextMover · Pune, Maharashtra, India<br>
              <a href="https://contextmover.com" style="color:#00D26A;text-decoration:none">contextmover.com</a>
              &nbsp;·&nbsp;
              <a href="https://contextmover.com/privacy" style="color:#6B6B6B;text-decoration:none">Privacy</a>
              &nbsp;·&nbsp;
              <a href="https://contextmover.com/terms" style="color:#6B6B6B;text-decoration:none">Terms</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function h1(text: string) {
  return `<h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#F5F5F5;line-height:1.3">${text}</h1>`;
}
function p(text: string) {
  return `<p style="margin:0 0 14px;font-size:15px;color:#B0B0B0;line-height:1.7">${text}</p>`;
}
function badge(text: string, color = "#00D26A") {
  return `<span style="display:inline-block;padding:4px 10px;border-radius:20px;background:${color}22;color:${color};font-size:12px;font-weight:600;letter-spacing:0.5px">${text}</span>`;
}
function btn(text: string, href: string) {
  return `<a href="${href}" style="display:inline-block;margin-top:20px;padding:12px 28px;background:#00D26A;color:#000;font-size:14px;font-weight:700;border-radius:8px;text-decoration:none">${text}</a>`;
}
function divider() {
  return `<hr style="border:none;border-top:1px solid #1A1A1A;margin:24px 0">`;
}

// ── Templates ─────────────────────────────────────────────────────────────────

export function welcomeEmail(email: string): { subject: string; html: string } {
  return {
    subject: "Welcome to ContextMover",
    html: layout(`
      ${h1("Welcome to ContextMover 👋")}
      ${p(`Hi ${email},`)}
      ${p("You're all set. ContextMover captures your AI chat sessions locally on your device and migrates context across Claude, ChatGPT, Gemini, Grok, Perplexity, and DeepSeek — in one click.")}
      ${divider()}
      ${p("<strong style='color:#F5F5F5'>Getting started:</strong>")}
      ${p("1. Install the Chrome extension<br>2. Chat normally on any supported AI platform<br>3. Open the sidebar → click Migrate")}
      ${btn("Open Dashboard", "https://contextmover.com/dashboard")}
      ${divider()}
      ${p("Questions? Reply to this email or reach us at <a href='mailto:support@contextmover.com' style='color:#00D26A'>support@contextmover.com</a>")}
    `),
  };
}

export function proActivatedEmail(email: string, gateway: "razorpay" | "stripe"): { subject: string; html: string } {
  const currency = gateway === "razorpay" ? "₹199/month" : "$5/month";
  return {
    subject: "You're now on ContextMover Pro ✓",
    html: layout(`
      ${badge("PRO ACTIVATED")}
      <div style="margin-top:16px"></div>
      ${h1("Pro is active. No more limits.")}
      ${p(`Hi ${email},`)}
      ${p("Your Pro subscription is now active. All migration limits have been removed.")}
      ${divider()}
      <table width="100%" cellpadding="0" cellspacing="0">
        ${row("Plan", "Pro")}
        ${row("Billing", currency)}
        ${row("Full Context migrations", "Unlimited")}
        ${row("Smart Summary migrations", "Unlimited")}
        ${row("Attention Engine", "Unlimited")}
        ${row("Sessions stored", "Unlimited")}
      </table>
      ${divider()}
      ${btn("Open Dashboard", "https://contextmover.com/dashboard")}
      ${p(`<span style="font-size:13px;color:#6B6B6B">To manage or cancel your subscription: Dashboard → Settings → Billing. Questions? <a href='mailto:support@contextmover.com' style='color:#00D26A'>support@contextmover.com</a></span>`)}
    `),
  };
}


export function proCancelledEmail(email: string): { subject: string; html: string } {
  return {
    subject: "Your ContextMover Pro subscription has been cancelled",
    html: layout(`
      ${badge("SUBSCRIPTION CANCELLED", "#EF4444")}
      <div style="margin-top:16px"></div>
      ${h1("Pro cancelled")}
      ${p(`Hi ${email},`)}
      ${p("Your Pro subscription has been cancelled. Your account has been moved to the free tier.")}
      ${divider()}
      <table width="100%" cellpadding="0" cellspacing="0">
        ${row("Plan", "Free")}
        ${row("Full Context migrations", "50 / month")}
        ${row("Smart Summary migrations", "50 / month")}
        ${row("Attention Engine", "10 / month")}
      </table>
      ${divider()}
      ${p("Your local session data remains on your device. Nothing has been deleted.")}
      ${btn("Reactivate Pro", "https://contextmover.com/pricing")}
      ${p(`<span style="font-size:13px;color:#6B6B6B">Questions or accidental cancellation? <a href='mailto:support@contextmover.com' style='color:#00D26A'>support@contextmover.com</a></span>`)}
    `),
  };
}

export function paymentFailedEmail(email: string): { subject: string; html: string } {
  return {
    subject: "Action required: ContextMover payment failed",
    html: layout(`
      ${badge("PAYMENT FAILED", "#EF4444")}
      <div style="margin-top:16px"></div>
      ${h1("We couldn't process your payment")}
      ${p(`Hi ${email},`)}
      ${p("We were unable to charge your payment method for your ContextMover Pro subscription.")}
      ${p("Please update your payment details to keep your Pro access active. If no action is taken, your account will be downgraded to the free tier.")}
      ${divider()}
      ${btn("Update Payment Method", "https://contextmover.com/settings")}
      ${p(`<span style="font-size:13px;color:#6B6B6B">Need help? <a href='mailto:support@contextmover.com' style='color:#00D26A'>support@contextmover.com</a> — we respond within 24 hours.</span>`)}
    `),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function row(label: string, value: string): string {
  return `<tr>
    <td style="padding:7px 0;font-size:13px;color:#6B6B6B;width:55%">${label}</td>
    <td style="padding:7px 0;font-size:13px;color:#F5F5F5;font-weight:600;text-align:right">${value}</td>
  </tr>`;
}
