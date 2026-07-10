// packages/web/src/app/api/admin/user-history/route.ts
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

  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const admin = createAdminClient();

  const [usageRes, usageTrackingRes, subRes, eventsRes, userRes, authRes, migrationsRes] = await Promise.all([
    admin
      .from("usage_counters")
      .select("month, tier1_count, tier2_count, tier3_count, created_at, updated_at")
      .eq("user_id", userId)
      .order("month", { ascending: false }),
    admin
      .from("usage_tracking")
      .select("month, simple_migrations, smart_migrations, attention_migrations, sessions_count, created_at, updated_at")
      .eq("user_id", userId)
      .order("month", { ascending: false }),
    admin
      .from("subscriptions")
      .select("plan, status, gateway, interval, amount, currency, current_period_start, current_period_end, cancelled_at, trial_end, created_at, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false }),
    admin
      .from("payment_events")
      .select("event_type, gateway, gateway_event_id, amount, currency, created_at, payload")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    admin
      .from("users")
      .select("is_pro, plan, subscription_status, pro_since, drive_email, created_at")
      .eq("id", userId)
      .maybeSingle(),
    admin.auth.admin.getUserById(userId),
    admin
      .from("migrations")
      .select("tier, source_platform, target_platform, message_count, char_count, migrated_at")
      .eq("user_id", userId)
      .order("migrated_at", { ascending: false })
      .limit(200),
  ]);

  // Merge usage_counters + usage_tracking into a unified monthly view
  const ucMap = Object.fromEntries((usageRes.data ?? []).map(r => [r.month, r]));
  const utMap = Object.fromEntries((usageTrackingRes.data ?? []).map(r => [r.month, r]));
  const allMonths = Array.from(new Set([...Object.keys(ucMap), ...Object.keys(utMap)])).sort().reverse();
  const mergedUsage = allMonths.map(m => ({
    month: m,
    tier1_count: ucMap[m]?.tier1_count ?? 0,
    tier2_count: ucMap[m]?.tier2_count ?? 0,
    tier3_count: ucMap[m]?.tier3_count ?? 0,
    simple_migrations: utMap[m]?.simple_migrations ?? 0,
    smart_migrations: utMap[m]?.smart_migrations ?? 0,
    attention_migrations: utMap[m]?.attention_migrations ?? 0,
    sessions_count: utMap[m]?.sessions_count ?? 0,
    updated_at: ucMap[m]?.updated_at ?? utMap[m]?.updated_at ?? null,
  }));

  // Also merge migrations table data into monthly usage (this is the authoritative
  // source for pro users — usage_counters is only incremented for free users).
  const migRows = (migrationsRes.data ?? []) as Array<{ tier: number; source_platform: string | null; target_platform: string | null; message_count: number; char_count: number; migrated_at: string }>;
  const migByMonth: Record<string, { tier1: number; tier2: number; tier3: number; total: number }> = {};
  for (const m of migRows) {
    const month = (m.migrated_at ?? "").slice(0, 7);
    if (!month) continue;
    if (!migByMonth[month]) migByMonth[month] = { tier1: 0, tier2: 0, tier3: 0, total: 0 };
    if (m.tier === 1) migByMonth[month].tier1++;
    else if (m.tier === 2) migByMonth[month].tier2++;
    else if (m.tier === 3) migByMonth[month].tier3++;
    migByMonth[month].total++;
  }

  // Merge migration counts into the unified usage (take max of usage_counters and migrations table)
  for (const u of mergedUsage) {
    const mig = migByMonth[u.month];
    if (mig) {
      u.tier1_count = Math.max(u.tier1_count, mig.tier1);
      u.tier2_count = Math.max(u.tier2_count, mig.tier2);
      u.tier3_count = Math.max(u.tier3_count, mig.tier3);
    }
  }
  // Add months that only exist in migrations table
  for (const [month, mig] of Object.entries(migByMonth)) {
    if (!mergedUsage.find(u => u.month === month)) {
      mergedUsage.push({
        month,
        tier1_count: mig.tier1,
        tier2_count: mig.tier2,
        tier3_count: mig.tier3,
        simple_migrations: 0,
        smart_migrations: 0,
        attention_migrations: 0,
        sessions_count: 0,
        updated_at: null,
      });
    }
  }
  mergedUsage.sort((a, b) => b.month.localeCompare(a.month));

  return NextResponse.json({
    usage: mergedUsage,
    subscriptions: subRes.data ?? [],
    paymentEvents: eventsRes.data ?? [],
    userMeta: userRes.data ?? null,
    migrations: migRows,
    authUser: authRes.data?.user ? {
      email: authRes.data.user.email ?? null,
      created_at: authRes.data.user.created_at ?? null,
      last_sign_in_at: authRes.data.user.last_sign_in_at ?? null,
      provider: authRes.data.user.app_metadata?.provider ?? null,
    } : null,
  });
}
