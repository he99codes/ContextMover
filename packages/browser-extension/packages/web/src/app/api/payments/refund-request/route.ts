// packages/web/src/app/api/payments/refund-request/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthUserFromRequest } from "@/lib/usage/helpers";
import { sendEmail, SENDERS } from "@/lib/mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await req.json()) as { payment_id?: string; reason?: string };
    if (!body.reason || body.reason.trim().length < 5)
      return NextResponse.json({ error: "Reason required" }, { status: 400 });

    const admin = createAdminClient();

    // Idempotency: one pending request per user
    const { data: existing } = await admin
      .from("refund_requests")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .maybeSingle();
    if (existing)
      return NextResponse.json({ error: "A refund request is already pending for this account." }, { status: 409 });

    await admin.from("refund_requests").insert({
      user_id:    user.id,
      payment_id: body.payment_id ?? null,
      reason:     body.reason.trim(),
      status:     "pending",
    });

    if (process.env.ZEPTO_SMTP_PASSWORD) {
      const { data: userData } = await admin.auth.admin.getUserById(user.id);
      const email = userData?.user?.email ?? user.id;
      await sendEmail({
        from:    SENDERS.support,
        to:      "support@contextmover.com",
        subject: `[REFUND REQUEST] ${email}`,
        html:    `<p>User: ${email} (${user.id})<br>Payment ID: ${body.payment_id ?? "—"}<br>Reason: ${body.reason}</p>`,
      }).catch((e: unknown) => console.warn("[refund-request] email failed:", e));
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[refund-request] error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
