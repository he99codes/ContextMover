// packages/web/src/app/api/support/bug-report/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, SENDERS } from "@/lib/mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      email?: string; description: string; severity?: string;
      version?: string; platform?: string; user_id?: string;
    };
    if (!body.description || body.description.trim().length < 10)
      return NextResponse.json({ error: "Description too short" }, { status: 400 });

    const admin = createAdminClient();
    let userId: string | null = body.user_id ?? null;
    if (!userId) {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (token) { const { data } = await admin.auth.getUser(token); userId = data?.user?.id ?? null; }
    }

    const severity = ["low","medium","high","critical"].includes(body.severity ?? "") ? body.severity! : "medium";
    await admin.from("bug_reports").insert({
      user_id: userId, email: body.email ?? null,
      description: body.description.trim(), severity,
      version: body.version ?? null, platform: body.platform ?? null,
    });

    if (process.env.ZEPTO_SMTP_PASSWORD) {
      await sendEmail({
        from: SENDERS.support, to: "support@contextmover.com",
        subject: `[BUG ${severity.toUpperCase()}] ${body.email ?? userId ?? "anon"}`,
        html: `<pre>${JSON.stringify({ userId, email: body.email, severity, version: body.version, platform: body.platform, description: body.description }, null, 2)}</pre>`,
      }).catch((e: unknown) => console.warn("[bug-report] email failed:", e));
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[bug-report] error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
