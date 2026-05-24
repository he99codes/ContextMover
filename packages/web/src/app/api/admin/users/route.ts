// packages/web/src/app/api/admin/users/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentMonth } from "@/lib/usage/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const admin = createAdminClient();
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? "1"));

  // List users from auth.users via admin API
  const { data: authData, error: authError } = await admin.auth.admin.listUsers({
    page,
    perPage: PAGE_SIZE,
  });
  if (authError) return NextResponse.json({ error: authError.message }, { status: 500 });

  const userIds = authData.users.map((u) => u.id);
  const month = getCurrentMonth();

  const [{ data: usageRows }, { data: subRows }] = await Promise.all([
    admin
      .from("usage_counters")
      .select("user_id, tier1_count, tier2_count, tier3_count")
      .eq("month", month)
      .in("user_id", userIds),
    admin
      .from("subscriptions")
      .select("user_id, plan, status")
      .in("user_id", userIds),
  ]);

  const usageMap = Object.fromEntries((usageRows ?? []).map((r) => [r.user_id, r]));
  const subMap   = Object.fromEntries((subRows   ?? []).map((r) => [r.user_id, r]));

  const users = authData.users.map((u) => ({
    id:                  u.id,
    email:               u.email ?? "",
    created_at:          u.created_at,
    plan:                (subMap[u.id]?.plan as string) ?? "free",
    subscription_status: (subMap[u.id]?.status as string) ?? null,
    tier1_used:          (usageMap[u.id]?.tier1_count as number) ?? 0,
    tier2_used:          (usageMap[u.id]?.tier2_count as number) ?? 0,
    tier3_used:          (usageMap[u.id]?.tier3_count as number) ?? 0,
  }));

  return NextResponse.json({
    users,
    page,
    total: authData.total ?? authData.users.length,
    pageSize: PAGE_SIZE,
  });
}
