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
    { data: allMigrationData },
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
      .from("usage_counters")
      .select("tier1_count, tier2_count, tier3_count"),
    admin
      .from("bug_reports")
      .select("id", { count: "exact", head: true }),
  ]);

  const sum = (rows: typeof migrationData) => (rows ?? []).reduce(
    (s, row) =>
      s +
      ((row.tier1_count as number) ?? 0) +
      ((row.tier2_count as number) ?? 0) +
      ((row.tier3_count as number) ?? 0),
    0
  );

  return NextResponse.json({
    total_users:           totalUsers,
    pro_users:             proUsers ?? 0,
    total_migrations:      sum(allMigrationData),
    migrations_this_month: sum(migrationData),
    open_bug_reports:      openBugReports ?? 0,
  });
}
