// packages/web/src/app/api/feedback/route.ts
// Receives feedback form submissions and forwards them via ZeptoMail.
// Required: rating (1–5), feedback. Optional: email.
import { NextRequest, NextResponse } from "next/server";
import { sendEmail, SENDERS } from "@/lib/mailer";

export async function POST(req: NextRequest) {
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
        ${email ? `<p><strong>Reply-to:</strong> ${email}</p>` : ""}
        <p><strong>Feedback:</strong></p>
        <p style="white-space:pre-wrap">${feedback.trim()}</p>
      `,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[feedback]", err);
    return NextResponse.json({ error: "Failed to submit feedback" }, { status: 500 });
  }
}
