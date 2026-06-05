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
    const { count } = await admin
      .from("subscriptions")
      .select("*", { count: "exact", head: true })
      .in("status", ["created", "authenticated", "active"]);
    return NextResponse.json({ activeCount: count ?? 0 });
  } catch (err) {
    console.error("[CM:api:subscription-count] error:", err);
    return NextResponse.json({ activeCount: 0 });
  }
}
