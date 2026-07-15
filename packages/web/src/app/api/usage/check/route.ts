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
  getUserPlan,
} from "@/lib/usage/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limiter";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

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
      }, { headers: CORS });
    }
    return NextResponse.json({ allowed: false, reason: "not_configured" }, { status: 503, headers: CORS });
  }

  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
  }

  // [SECURITY] Rate limit: 60/min per user — prevents usage-check flooding.
  const rl = await checkRateLimit(req, user.id, 60);
  if (!rl.ok) return rl.response;

  const body = (await req.json()) as { tier?: number };
  const tier = body.tier;
  if (!tier || tier < 1 || tier > 3) {
    return NextResponse.json({ error: "Invalid tier" }, { status: 400, headers: CORS });
  }

  const month = getCurrentMonth();
  const userPlan = await getUserPlan(user.id);
  const admin = createAdminClient();

  if (userPlan.isUnlimited) {
    return NextResponse.json({
      allowed: true,
      plan: userPlan.plan,
      unlimited: true,
      used: 0,
      limit: -1,
      remaining: -1,
    }, { headers: CORS });
  }

  const { data: usageRow } = await admin
    .from("usage_counters")
    .select("tier1_count, tier2_count, tier3_count")
    .eq("user_id", user.id)
    .eq("month", month)
    .maybeSingle();

  const count = (usageRow?.[getTierKey(tier)] as number | undefined) ?? 0;
  const limit =
    tier === 1 ? userPlan.tier1Limit :
    tier === 2 ? userPlan.tier2Limit :
    userPlan.tier3Limit;

  if (count >= limit) {
    const now = new Date();
    const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const daysUntilReset = Math.ceil(
      (resetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    // [PROMOTION-UNLOCKED] Free tier limits are temporarily disabled — allow the migration
    // but still return limit metadata so the sidebar can display accurate usage counts.
    // The "Buy Pro" upsell remains visible in the extension UI for users who want to
    // support the developer and unlock additional features.
    return NextResponse.json({
      allowed: true,
      reason: "limit_reached_promotional_unlocked",
      plan: userPlan.plan,
      tier,
      used: count,
      limit,
      remaining: 999,
      resetDate: resetDate.toISOString(),
      daysUntilReset,
      upgradeUrl: "https://contextmover.com/pricing",
    }, { headers: CORS });
  }

  return NextResponse.json({
    allowed: true,
    plan: userPlan.plan,
    unlimited: false,
    tier,
    used: count,
    limit,
    remaining: limit - count,
  }, { headers: CORS });
  } catch (err: unknown) {
    console.error('[CM:usage] check error:', err);
    return NextResponse.json(
      { allowed: false, reason: "internal_error" },
      { status: 500, headers: CORS }
    );
  }
}
