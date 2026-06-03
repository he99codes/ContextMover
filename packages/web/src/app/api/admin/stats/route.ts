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

  const { data: authUsers } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const totalUsers = (authUsers as { total?: number } | null)?.total ?? authUsers?.users?.length ?? 0;

  const [
    { count: proUsers },
    { data: migrationData },
    { count: openBugReports },
  ] = await Promise.all([
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

  const { count: totalMigrations, data: platformCounts } = await admin
    .from('migrations')
    .select('target_platform', { count: 'exact' });

  return NextResponse.json({
    total_users:           totalUsers,
    pro_users:             proUsers ?? 0,
    total_migrations:      totalMigrations ?? 0,
    migrations_this_month: migrationsThisMonth,
    open_bug_reports:      openBugReports ?? 0,
    platform_breakdown:    (platformCounts as { target_platform: string }[] | null)?.reduce((acc, { target_platform }) => {
      acc[target_platform] = (acc[target_platform] || 0) + 1;
      return acc;
    }, {} as Record<string, number>) ?? {},
  });
}
