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
      .select("current_end, plan, status, interval")
      .eq("user_id", user.id)
      .in("status", ["active", "authenticated"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: userRow } = await admin
      .from("users")
      .select("is_pro, plan, subscription_status")
      .eq("id", user.id)
      .single();

    const isPro = subscription?.status === "active" || subscription?.status === "authenticated" || userRow?.is_pro === true;

    return NextResponse.json({
      isPro,
      plan: isPro ? "pro" : "free",
      interval: subscription?.interval ?? null,
      status: subscription?.status ?? "free",
      currentEnd: subscription?.current_end ?? null,
    });
  } catch (err) {
    console.error("[CM:api:subscription:GET] error:", err);
    return NextResponse.json({ error: "Failed to load subscription" }, { status: 500 });
  }
}
