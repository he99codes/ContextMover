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

export const runtime = "nodejs";

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
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { tier?: number };
  const tier = body.tier;
  if (!tier || tier < 1 || tier > 3) {
    return NextResponse.json({ error: "Invalid tier" }, { status: 400 });
  }

  const userPlan = await getUserPlan(user.id);
  const admin = createAdminClient();
  const { data: planLimits } = await admin
    .from("plan_limits")
    .select("is_unlimited")
    .eq("plan", userPlan)
    .maybeSingle();

  if (planLimits?.is_unlimited) {
    return NextResponse.json({ ok: true, incremented: false, reason: "unlimited" });
  }

  const month = getCurrentMonth();
  const tierKey = getTierKey(tier);

  await admin.rpc("increment_usage", {
    p_user_id: user.id,
    p_month: month,
    p_tier_column: tierKey,
  });

  return NextResponse.json({ ok: true, incremented: true, tier });
}
