// packages/web/src/app/api/admin/refund-action/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { checkRateLimit } from "@/lib/rate-limiter";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const rl = await checkRateLimit(req, undefined, 30);
  if (!rl.ok) return rl.response;

  const { requestId, action } = (await req.json()) as {
    requestId: string;
    action: "approved" | "rejected";
  };
  if (!requestId || !["approved", "rejected"].includes(action))
    return NextResponse.json({ error: "requestId and valid action required" }, { status: 400 });

  const admin = createAdminClient();

  const { data: refund, error: fetchErr } = await admin
    .from("refund_requests")
    .select("user_id")
    .eq("id", requestId)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  const { error } = await admin
    .from("refund_requests")
    .update({ status: action })
    .eq("id", requestId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (action === "approved" && refund?.user_id) {
    const now = new Date().toISOString();
    await admin.from("subscriptions")
      .update({ plan: "free", status: "cancelled", current_period_end: null, current_end: null, cancelled_at: now, updated_at: now })
      .eq("user_id", refund.user_id);
    await admin.from("users")
      .update({ is_pro: false, plan: "free", subscription_status: "cancelled" })
      .eq("id", refund.user_id);
  }

  return NextResponse.json({ success: true });
}
