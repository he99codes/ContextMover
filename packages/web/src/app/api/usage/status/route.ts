/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/usage/status/route.ts
// Return full usage status for sidebar / dashboard display.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUserFromRequest, getCurrentMonth, getUserPlan } from "@/lib/usage/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limiter";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
  }

  // [SECURITY] Rate limit: 30/min per user — prevents status endpoint flooding.
  const rl = await checkRateLimit(req, user.id, 30);
  if (!rl.ok) return rl.response;

  const month = getCurrentMonth();
  const userPlan = await getUserPlan(user.id);

  const admin = createAdminClient();

  const { data: usageRow } = await admin
    .from("usage_counters")
    .select("tier1_count, tier2_count, tier3_count")
    .eq("user_id", user.id)
    .eq("month", month)
    .maybeSingle();

  const unlimited = userPlan.isUnlimited;

  const tierUsed = (n: 1 | 2 | 3): number => {
    const key = `tier${n}_count` as "tier1_count" | "tier2_count" | "tier3_count";
    return (usageRow?.[key] as number | undefined) ?? 0;
  };
  const tierLimit = (n: 1 | 2 | 3): number => {
    if (unlimited) return -1;
    return n === 1 ? userPlan.tier1Limit : n === 2 ? userPlan.tier2Limit : userPlan.tier3Limit;
  };
  const tierRemaining = (n: 1 | 2 | 3): number =>
    unlimited ? -1 : Math.max(0, tierLimit(n) - tierUsed(n));

  const now = new Date();
  const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const daysUntilReset = Math.ceil(
    (resetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );

  return NextResponse.json({
    plan: userPlan.plan,
    unlimited,
    month,
    resetDate: resetDate.toISOString(),
    daysUntilReset,
    usage: {
      tier1: {
        used: tierUsed(1),
        limit: tierLimit(1),
        remaining: tierRemaining(1),
        label: "Full Context",
      },
      tier2: {
        used: tierUsed(2),
        limit: tierLimit(2),
        remaining: tierRemaining(2),
        label: "Smart Summary",
      },
      tier3: {
        used: tierUsed(3),
        limit: tierLimit(3),
        remaining: tierRemaining(3),
        label: "Attention Engine",
      },
    },
    upgradeUrl: "https://contextmover.com/pricing",
  }, { headers: CORS });
}
