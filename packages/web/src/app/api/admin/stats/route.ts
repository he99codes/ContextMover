// packages/web/src/app/api/admin/stats/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentMonth } from "@/lib/usage/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const admin = createAdminClient();

  const [
    { count: totalUsers },
    { count: proUsers },
    { data: migrationData },
    { count: openBugReports },
  ] = await Promise.all([
    admin.from("profiles").select("id", { count: "exact", head: true }),
    admin
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("status", "active"),
    admin
      .from("usage_counters")
      .select("tier1_count, tier2_count, tier3_count")
      .eq("month", getCurrentMonth()),
    admin
      .from("bug_reports")
      .select("id", { count: "exact", head: true }),
  ]);

  const migrationsThisMonth = (migrationData ?? []).reduce(
    (sum, row) =>
      sum +
      ((row.tier1_count as number) ?? 0) +
      ((row.tier2_count as number) ?? 0) +
      ((row.tier3_count as number) ?? 0),
    0
  );

  return NextResponse.json({
    total_users:          totalUsers ?? 0,
    pro_users:            proUsers ?? 0,
    migrations_this_month: migrationsThisMonth,
    open_bug_reports:     openBugReports ?? 0,
  });
}
