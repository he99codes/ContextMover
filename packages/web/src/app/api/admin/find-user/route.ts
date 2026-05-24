// packages/web/src/app/api/admin/find-user/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentMonth } from "@/lib/usage/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const email = req.nextUrl.searchParams.get("email");
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: authData, error } = await admin.auth.admin.listUsers();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const user = authData.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const month = getCurrentMonth();
  const [{ data: usage }, { data: sub }] = await Promise.all([
    admin
      .from("usage_counters")
      .select("tier1_count, tier2_count, tier3_count")
      .eq("user_id", user.id)
      .eq("month", month)
      .maybeSingle(),
    admin
      .from("subscriptions")
      .select("plan, status")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  return NextResponse.json({
    id:          user.id,
    email:       user.email,
    created_at:  user.created_at,
    plan:        (sub?.plan as string) ?? "free",
    status:      (sub?.status as string) ?? null,
    tier1_count: (usage?.tier1_count as number) ?? 0,
    tier2_count: (usage?.tier2_count as number) ?? 0,
    tier3_count: (usage?.tier3_count as number) ?? 0,
  });
}
