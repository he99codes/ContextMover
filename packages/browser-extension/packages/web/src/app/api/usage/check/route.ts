/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/usage/check/route.ts
// Check if a migration is allowed under current usage limits.

import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUserFromRequest,
  getCurrentMonth,
  getTierKey,
  getLimitKey,
  getUserPlan,
} from "@/lib/usage/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ allowed: false, reason: "use_POST" }, { status: 405 });
}

export async function POST(req: NextRequest) {
  try {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    if (process.env.NODE_ENV !== "production") {
      const body = await req.json().catch(() => ({})) as { tier?: number };
      return NextResponse.json({
        allowed: true,
        plan: 'free',
        unlimited: false,
        tier: body.tier ?? 1,
        used: 0,
        limit: 50,
        remaining: 50,
        dev: true,
      });
    }
    return NextResponse.json({ allowed: false, reason: "not_configured" }, { status: 503 });
  }

  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { tier?: number };
  const tier = body.tier;
  if (!tier || tier < 1 || tier > 3) {
    return NextResponse.json({ error: "Invalid tier" }, { status: 400 });
  }

  const month = getCurrentMonth();
  const userPlan = await getUserPlan(user.id);

  const admin = createAdminClient();
  const { data: planLimits } = await admin
    .from("plan_limits")
    .select("tier1_limit, tier2_limit, tier3_limit, is_unlimited")
    .eq("plan", userPlan)
    .maybeSingle();

  if (planLimits?.is_unlimited) {
    return NextResponse.json({
      allowed: true,
      plan: userPlan,
      unlimited: true,
      used: 0,
      limit: -1,
      remaining: -1,
    });
  }

  const { data: usageRow } = await admin
    .from("usage_counters")
    .select("tier1_count, tier2_count, tier3_count")
    .eq("user_id", user.id)
    .eq("month", month)
    .maybeSingle();

  const count = (usageRow?.[getTierKey(tier)] as number | undefined) ?? 0;
  const limit =
    (planLimits?.[getLimitKey(tier)] as number | undefined) ?? 0;

  if (count >= limit) {
    const now = new Date();
    const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const daysUntilReset = Math.ceil(
      (resetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    return NextResponse.json({
      allowed: false,
      reason: "limit_reached",
      plan: userPlan,
      tier,
      used: count,
      limit,
      remaining: 0,
      resetDate: resetDate.toISOString(),
      daysUntilReset,
      upgradeUrl: "https://contextmover.com/pricing",
    });
  }

  return NextResponse.json({
    allowed: true,
    plan: userPlan,
    unlimited: false,
    tier,
    used: count,
    limit,
    remaining: limit - count,
  });
  } catch (err: unknown) {
    console.error('[CM:usage] check error:', err);
    return NextResponse.json(
      { allowed: false, reason: "internal_error" },
      { status: 500 }
    );
  }
}
