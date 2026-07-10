/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/contact/route.ts
// Handles contact form + Build-With-Me + footer email widget submissions.
// Required: email, message. Optional: name, subject.
import { NextRequest, NextResponse } from "next/server";
import { sendEmail, SENDERS, NOTIFY_EMAIL, escapeHtml } from "@/lib/mailer";
import { checkRateLimit } from "@/lib/rate-limiter";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest) {
  // [SECURITY] 1 request per minute per IP — public unauthenticated route (email-sending).
  const rl = await checkRateLimit(req, undefined, 1);
  if (!rl.ok) return rl.response;

  try {
    const body = (await req.json()) as {
      name?:    string;
      email?:   string;
      subject?: string;
      message?: string;
    };

    const { name, email, subject, message } = body;
    if (!email?.trim() || !message?.trim()) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const s = subject?.trim() ?? "";
    const tag = s.includes("Build") ? "[BUILD WITH ME]" : s.includes("Quick") ? "[FOOTER WIDGET]" : "[CONTACT]";
    const emailSubject = `${tag} ${s || name?.trim() || "contextmover.com"}`;

    await sendEmail({
      to:      NOTIFY_EMAIL,
      from:    SENDERS.noreply,
      replyTo: email.trim(),
      subject: emailSubject,
      html: `
        ${name?.trim() ? `<p><strong>Name:</strong> ${escapeHtml(name.trim())}</p>` : ""}
        <p><strong>Email:</strong> ${escapeHtml(email.trim())}</p>
        ${subject?.trim() ? `<p><strong>Subject:</strong> ${escapeHtml(subject.trim())}</p>` : ""}
        <p><strong>Message:</strong></p>
        <p style="white-space:pre-wrap">${escapeHtml(message.trim())}</p>
      `,
    });

    // Fire-and-forget backup insert — never blocks the response.
    Promise.resolve(
      createAdminClient()
        .from("contact_submissions")
        .insert({
          type:    "contact",
          name:    name?.trim() || null,
          email:   email.trim(),
          subject: subject?.trim() || null,
          message: message.trim(),
        })
    )
      .then(({ error }) => { if (error) console.error("[contact] DB backup failed:", error); })
      .catch((err) => console.error("[contact] DB backup error:", err));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[contact]", err);
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}
