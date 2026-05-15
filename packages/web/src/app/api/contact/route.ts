// packages/web/src/app/api/contact/route.ts
// Handles contact form + Build-With-Me + footer email widget submissions.
// Required: email, message. Optional: name, subject.
import { NextRequest, NextResponse } from "next/server";
import { sendEmail, SENDERS } from "@/lib/mailer";

export async function POST(req: NextRequest) {
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

    const emailSubject = subject?.trim()
      ? subject.trim()
      : name?.trim()
        ? `Contact — ${name.trim()}`
        : "Contact — contextmover.com";

    await sendEmail({
      to:   "priyanshu@contextmover.com",
      from: SENDERS.noreply,
      subject: emailSubject,
      html: `
        ${name?.trim() ? `<p><strong>Name:</strong> ${name.trim()}</p>` : ""}
        <p><strong>Email:</strong> ${email.trim()}</p>
        ${subject?.trim() ? `<p><strong>Subject:</strong> ${subject.trim()}</p>` : ""}
        <p><strong>Message:</strong></p>
        <p style="white-space:pre-wrap">${message.trim()}</p>
      `,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[contact]", err);
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}
