// packages/web/src/app/api/admin/revoke-pro/route.ts
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

  const { userId } = (await req.json()) as { userId: string };
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const admin = createAdminClient();

  // Use update-or-insert pattern (no guaranteed unique constraint on user_id)
  const { data: existing } = await admin
    .from("subscriptions")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  let error;
  if (existing) {
    const result = await admin.from("subscriptions")
      .update({
        plan:                "free",
        status:              "cancelled",
        gateway:             "manual",
        cancelled_at:        new Date().toISOString(),
        current_period_end:  null,
        current_end:         null,
        updated_at:          new Date().toISOString(),
      })
      .eq("id", existing.id);
    error = result.error;
  } else {
    const result = await admin.from("subscriptions").insert({
      user_id:             userId,
      plan:                "free",
      status:              "cancelled",
      gateway:             "manual",
      cancelled_at:        new Date().toISOString(),
      current_period_end:  null,
      current_end:         null,
      updated_at:          new Date().toISOString(),
    });
    error = result.error;
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Keep users.is_pro in sync — use upsert in case no users row exists
  const { data: userExists } = await admin.from("users").select("id").eq("id", userId).maybeSingle();
  if (userExists) {
    await admin.from("users").update({ is_pro: false, plan: "free", subscription_status: "cancelled" }).eq("id", userId);
  } else {
    await admin.from("users").insert({ id: userId, is_pro: false, plan: "free", subscription_status: "cancelled" });
  }

  return NextResponse.json({ success: true });
}
