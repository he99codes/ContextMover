import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { checkRateLimit } from "@/lib/rate-limiter";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const rl = await checkRateLimit(req, undefined, 30);
  if (!rl.ok) return rl.response;

  const admin = createAdminClient();

  const { data: authUsers } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const totalUsers = (authUsers as { total?: number } | null)?.total ?? authUsers?.users?.length ?? 0;

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  const nowIso = new Date().toISOString();

  // Use allSettled so a missing global_stats table doesn't 500 the whole endpoint
  const results = await Promise.allSettled([
    admin
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .in("status", ["active", "authenticated", "cancelled"])
      .or(`current_period_end.gt.${nowIso},current_end.gt.${nowIso}`),
    admin
      .from("bug_reports")
      .select("id", { count: "exact", head: true }),
    admin
      .from("migrations")
      .select("id", { count: "exact", head: true }),
    admin
      .from("migrations")
      .select("id", { count: "exact", head: true })
      .gte("migrated_at", monthStart),
    admin
      .from("migrations")
      .select("target_platform"),
    admin
      .from("migrations")
      .select("tier"),
    admin
      .from("global_stats")
      .select("total_migrations")
      .eq("id", 1)
      .maybeSingle(),
  ]);

  const proUsersResult      = results[0].status === 'fulfilled' ? results[0].value : null;
  const bugReportsResult    = results[1].status === 'fulfilled' ? results[1].value : null;
  const totalMigrationsRes  = results[2].status === 'fulfilled' ? results[2].value : null;
  const migrationsMonthRes  = results[3].status === 'fulfilled' ? results[3].value : null;
  const platformResult      = results[4].status === 'fulfilled' ? results[4].value : null;
  const tierResult          = results[5].status === 'fulfilled' ? results[5].value : null;
  const globalStatsResult   = results[6].status === 'fulfilled' ? results[6].value : null;

  const proUsers          = proUsersResult?.count ?? 0;
  const openBugReports    = bugReportsResult?.error?.code === '42P01' ? 0 : (bugReportsResult?.count ?? 0);
  const totalMigrations   = totalMigrationsRes?.count ?? 0;
  const migrationsThisMonth = migrationsMonthRes?.count ?? 0;
  const platformCounts    = platformResult?.data ?? null;
  const tierCounts        = tierResult?.data ?? null;
  const globalStatsData   = globalStatsResult?.data ?? null;

  const tierBreakdown = (tierCounts as { tier: number }[] | null)?.reduce((acc, { tier }) => {
    acc[`tier${tier}`] = (acc[`tier${tier}`] || 0) + 1;
    return acc;
  }, {} as Record<string, number>) ?? {};

  const platformBreakdown = (platformCounts as { target_platform: string }[] | null)?.reduce((acc, { target_platform }) => {
    if (target_platform) acc[target_platform] = (acc[target_platform] || 0) + 1;
    return acc;
  }, {} as Record<string, number>) ?? {};

  return NextResponse.json({
    total_users:           totalUsers,
    pro_users:             proUsers,
    total_migrations:      totalMigrations,
    migrations_this_month: migrationsThisMonth,
    open_bug_reports:      openBugReports,
    tier_breakdown:        tierBreakdown,
    platform_breakdown:    platformBreakdown,
    global_stats_counter:  (globalStatsData as { total_migrations?: number } | null)?.total_migrations ?? 0,
  });
}
