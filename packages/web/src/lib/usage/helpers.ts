/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/lib/usage/helpers.ts
// Server-only usage-limit helpers.

import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export function getCurrentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function getTierKey(
  tier: number
): "tier1_count" | "tier2_count" | "tier3_count" {
  if (tier === 1) return "tier1_count";
  if (tier === 2) return "tier2_count";
  return "tier3_count";
}

export function getLimitKey(
  tier: number
): "tier1_limit" | "tier2_limit" | "tier3_limit" {
  if (tier === 1) return "tier1_limit";
  if (tier === 2) return "tier2_limit";
  return "tier3_limit";
}

export interface UserPlanResult {
  plan: string;
  interval: string | null;
  isUnlimited: boolean;
  tier1Limit: number;
  tier2Limit: number;
  tier3Limit: number;
}

export async function getUserPlan(userId: string): Promise<UserPlanResult> {
  const admin = createAdminClient();

  // Check both sources of truth in parallel — include cancelled to check if still within period
  const [subscriptionResult, userRowResult] = await Promise.all([
    admin
      .from("subscriptions")
      .select("plan, status, interval, current_period_end, current_end")
      .eq("user_id", userId)
      .in("status", ["active", "authenticated", "cancelled"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("users")
      .select("is_pro, plan")
      .eq("id", userId)
      .maybeSingle(),
  ]);

  const data = subscriptionResult.data;
  const userRow = userRowResult.data;

  // A cancelled subscription still grants Pro until current_period_end passes
  const subEnd = data?.current_period_end ?? data?.current_end;
  const isCancelledButActive = data?.status === "cancelled" && subEnd
    ? new Date(subEnd).getTime() > Date.now()
    : false;

  // users.is_pro is the authoritative override — admin-granted pro users have
  // this set even when subscriptions table has no matching plan_limits row.
  const isProByFlag = userRow?.is_pro === true || isCancelledButActive;

  const planName = data?.plan ?? (isProByFlag ? "pro" : "free");

  // If is_pro flag is set or cancelled-but-active, always treat as unlimited
  if (isProByFlag) {
    return {
      plan: "pro",
      interval: data?.interval ?? null,
      isUnlimited: true,
      tier1Limit: 999999,
      tier2Limit: 999999,
      tier3Limit: 999999,
    };
  }

  const { data: planLimits } = await admin
    .from("plan_limits")
    .select("tier1_limit, tier2_limit, tier3_limit, is_unlimited")
    .eq("plan", planName)
    .maybeSingle();

  return {
    plan: planName,
    interval: data?.interval ?? null,
    isUnlimited: planLimits?.is_unlimited ?? false,
    // [ISSUE-31] Changed fallbacks from 8/3/3 to 10/10/10
    tier1Limit: planLimits?.tier1_limit ?? 10,
    tier2Limit: planLimits?.tier2_limit ?? 10,
    tier3Limit: planLimits?.tier3_limit ?? 10,
  };
}

export async function getAuthUserFromRequest(
  req: NextRequest
): Promise<{ id: string } | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");

  if (!token) return null;

  // Use a plain Supabase client (non-SSR, no cookies) to validate the Bearer token.
  // The cookie-based SSR client doesn't reliably handle explicit token params in API
  // routes. A fresh anon client with persistSession:false calls Supabase's /auth/v1/user
  // with the token directly — same approach as the subscription endpoint.
  const { createClient: createAnonClient } = await import("@supabase/supabase-js");
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supaUrl || !supaKey) return null;

  const supabase = createAnonClient(supaUrl, supaKey, { auth: { persistSession: false } });
  const { data: { user } } = await supabase.auth.getUser(token);

  if (!user) return null;
  return user;
}
