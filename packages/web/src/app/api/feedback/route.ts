/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/feedback/route.ts
// Receives feedback form submissions and forwards them via ZeptoMail.
// Required: rating (1–5), feedback. Optional: email.
import { NextRequest, NextResponse } from "next/server";
import { sendEmail, SENDERS, escapeHtml } from "@/lib/mailer";
import { checkRateLimit } from "@/lib/rate-limiter";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest) {
  // [SECURITY] 5 requests per minute per IP — public unauthenticated route.
  const rl = await checkRateLimit(req, undefined, 5);
  if (!rl.ok) return rl.response;

  try {
    const body = (await req.json()) as {
      rating?:   number;
      feedback?: string;
      email?:    string;
    };

    const { rating, feedback, email } = body;
    if (!feedback?.trim()) {
      return NextResponse.json({ error: "Missing feedback" }, { status: 400 });
    }
    if (rating !== undefined && (rating < 1 || rating > 5)) {
      return NextResponse.json({ error: "Invalid rating" }, { status: 400 });
    }

    const stars = rating ? "★".repeat(rating) + "☆".repeat(5 - rating) : "not rated";

    await sendEmail({
      to:      "priyanshu@contextmover.com",
      from:    SENDERS.noreply,
      subject: `Feedback ${stars}${email ? ` · ${email}` : ""}`,
      html: `
        <p><strong>Rating:</strong> ${stars} (${rating ?? "—"}/5)</p>
        ${email ? `<p><strong>Reply-to:</strong> ${escapeHtml(email)}</p>` : ""}
        <p><strong>Feedback:</strong></p>
        <p style="white-space:pre-wrap">${escapeHtml(feedback.trim())}</p>
      `,
    });

    // Fire-and-forget backup insert — never blocks the response.
    Promise.resolve(
      createAdminClient()
        .from("contact_submissions")
        .insert({
          type:    "feedback",
          email:   email?.trim() || null,
          message: feedback.trim(),
          rating:  rating ?? null,
        })
    )
      .then(({ error }) => { if (error) console.error("[feedback] DB backup failed:", error); })
      .catch((err) => console.error("[feedback] DB backup error:", err));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[feedback]", err);
    return NextResponse.json({ error: "Failed to submit feedback" }, { status: 500 });
  }
}
