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
  // [CM-RZP-FIX] query by plan='pro' which matches plan_limits table
  const admin = createAdminClient();
  const { data } = await admin
    .from("subscriptions")
    .select("plan, status, interval, current_end")
    .eq("user_id", userId)
    .in("status", ["active", "authenticated"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const planName = data?.plan ?? "free";

  const { data: planLimits } = await admin
    .from("plan_limits")
    .select("tier1_limit, tier2_limit, tier3_limit, is_unlimited")
    .eq("plan", planName)
    .maybeSingle();

  return {
    plan: planName,
    interval: data?.interval ?? null,
    isUnlimited: planLimits?.is_unlimited ?? false,
    tier1Limit: planLimits?.tier1_limit ?? 8,
    tier2Limit: planLimits?.tier2_limit ?? 3,
    tier3Limit: planLimits?.tier3_limit ?? 3,
  };
}

export async function getAuthUserFromRequest(
  req: NextRequest
): Promise<{ id: string } | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");

  if (!token) return null;

  const admin = createAdminClient();
  const { data, error } = await admin.auth.getUser(token);

  if (error || !data?.user) return null;
  return data.user;
}
