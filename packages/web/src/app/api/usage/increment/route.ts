/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/usage/increment/route.ts
// Atomically increment a usage counter after a successful migration.

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

/*
Run this in Supabase SQL Editor:

CREATE OR REPLACE FUNCTION increment_usage(
  p_user_id UUID,
  p_month TEXT,
  p_tier_column TEXT
) RETURNS void AS $$
BEGIN
  INSERT INTO usage_counters (user_id, month, tier1_count, tier2_count, tier3_count)
  VALUES (p_user_id, p_month, 0, 0, 0)
  ON CONFLICT (user_id, month) DO NOTHING;

  IF p_tier_column = 'tier1_count' THEN
    UPDATE usage_counters SET tier1_count = tier1_count + 1,
      updated_at = NOW()
    WHERE user_id = p_user_id AND month = p_month;
  ELSIF p_tier_column = 'tier2_count' THEN
    UPDATE usage_counters SET tier2_count = tier2_count + 1,
      updated_at = NOW()
    WHERE user_id = p_user_id AND month = p_month;
  ELSIF p_tier_column = 'tier3_count' THEN
    UPDATE usage_counters SET tier3_count = tier3_count + 1,
      updated_at = NOW()
    WHERE user_id = p_user_id AND month = p_month;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
*/

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ allowed: false, reason: "unauthorized" }, { status: 401, headers: CORS });
    }

    // [SECURITY] Rate limit: 120/min per user — generous for legitimate use,
    // prevents counter-hammering from a compromised token.
    const rl = await checkRateLimit(req, user.id, 120);
    if (!rl.ok) return rl.response;

    const body = (await req.json()) as {
      tier?: number;
      sourcePlatform?: string;
      targetPlatform?: string;
      messageCount?: number;
      charCount?: number;
    };
    const tier = body.tier;
    if (!tier || tier < 1 || tier > 3) {
      return NextResponse.json({ allowed: false, reason: "invalid_tier" }, { status: 400, headers: CORS });
    }

    const admin = createAdminClient();
    const userPlan = await getUserPlan(user.id);

    // Log migration event for admin analytics (non-blocking, best-effort).
    // Must run for ALL users (including pro/unlimited) before any early return.
    void admin.from("migrations").insert({
      user_id:         user.id,
      tier:            tier,
      source_platform: body.sourcePlatform ?? null,
      target_platform: body.targetPlatform ?? null,
      message_count:   body.messageCount ?? 0,
      char_count:      body.charCount ?? 0,
      migrated_at:     new Date().toISOString(),
    }).then(({ error: mErr }) => {
      if (mErr) console.warn("[CM:usage:increment] migrations insert failed:", mErr.message);
    });

    if (userPlan.isUnlimited) {
      // [ISSUE-7] Log pro usage for admin analytics — non-decrementing counter
      try {
        await admin.from("pro_usage_log").insert({
          user_id: user.id,
          tier,
          migrated_at: new Date().toISOString(),
        });
      } catch { /* table may not exist yet — non-fatal */ }
      return NextResponse.json({ allowed: true, remaining: -1, plan: userPlan.plan }, { headers: CORS });
    }

    const month   = getCurrentMonth();
    const tierKey = getTierKey(tier);
    // [PROMOTION-UNLOCKED] Pass 999999 as p_limit so the RPC always succeeds, even when
    // count >= normal free limit. The counter still increments accurately in the database
    // so the sidebar displays the real usage (e.g. 12/10). Only blocking is disabled.
    const limit   = 999999;

    const { data, error } = await admin.rpc("decrement_migration_safe_v2", {
      p_user_id:     user.id,
      p_month:       month,
      p_tier_column: tierKey,
      p_limit:       limit,
    });

    if (error) {
      console.error("[CM:usage:increment] rpc error:", error);
      return NextResponse.json({ allowed: false, reason: "rpc_error" }, { status: 500, headers: CORS });
    }

    // RPC returns jsonb — pass through with plan appended
    return NextResponse.json({ ...(data as object), plan: userPlan }, { headers: CORS });
  } catch (err) {
    console.error("[CM:usage:increment] unexpected error:", err);
    return NextResponse.json({ allowed: false, reason: "internal_error" }, { status: 500, headers: CORS });
  }
}
