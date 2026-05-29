import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/payments/auth";
import { checkRateLimit } from "@/lib/rate-limiter";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await checkRateLimit(req, user.id);
  if (!rl.ok) return rl.response;

  try {
    const admin = createAdminClient();
    const { data: subscription } = await admin
      .from("subscriptions")
      .select("plan, status, current_end")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!subscription) {
      return NextResponse.json({
        isPro: false,
        plan: "free",
        status: "free",
        currentEnd: null,
      });
    }

    return NextResponse.json({
      isPro: true,
      plan: subscription.plan,
      status: subscription.status,
      currentEnd: subscription.current_end,
    });
  } catch (err) {
    console.error("[CM:api:subscription:GET] error:", err);
    return NextResponse.json({ error: "Failed to load subscription" }, { status: 500 });
  }
}
