/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/lib/payments/check-limits.ts
// Server-side freemium limit enforcement.
// Uses the admin client so it works in API routes + webhooks.
import { createAdminClient } from "@/lib/supabase/admin";

export type MigrationTier = 1 | 2 | 3;

export interface LimitResult {
  allowed:   boolean;
  remaining: number;
  limit:     number;
  used:      number;
}

// Free-tier monthly limits per feature.
const FREE_LIMITS: Record<MigrationTier, number> = {
  // [ISSUE-31] Changed to 10 for each tier
  1: 10, // Tier 1: Full Context
  2: 10, // Tier 2: Smart Summary
  3: 10, // Tier 3: Attention Engine
};

// Returns the current UTC month key, e.g. '2026-05'.
function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Check whether `userId` is allowed to use `tier` this month.
 * Pro users bypass all limits.
 */
export async function checkLimit(
  userId:  string,
  tier: MigrationTier
): Promise<LimitResult> {
  const supabase = createAdminClient();
  const limit    = FREE_LIMITS[tier];
  const tierColumn = `tier${tier}_count` as const;

    // Pro users have no limits.
  const { data: profileRaw } = await supabase
    .from("users")
    .select("is_pro")
    .eq("id", userId)
    .single();

  const profile = profileRaw as { is_pro: boolean } | null;
  if (profile?.is_pro) {
    return { allowed: true, remaining: Infinity, limit: Infinity, used: 0 };
  }

  // Read current usage.
  const month = currentMonth();
  const { data: usageRaw } = await supabase
    .from("usage_counters")
    .select(tierColumn)
    .eq("user_id", userId)
    .eq("month",    month)
    .single();

  const usageRow = usageRaw as { [key: string]: number } | null;
  const used     = usageRow?.[tierColumn] ?? 0;
  const remaining = Math.max(0, limit - used);

  return {
    allowed:   used < limit,
    remaining,
    limit,
    used,
  };
}

/**
 * Increment usage count for `userId` + `feature` this month.
 * Call AFTER the feature action completes (not before the check).
 * Uses read-then-upsert — acceptable for usage tracking (low concurrency).
 */
export async function incrementUsage(
  userId:  string,
  tier: 1 | 2 | 3
): Promise<void> {
  const supabase = createAdminClient();
  const month    = currentMonth();
  const tierColumn = `tier${tier}_count` as const;

  // Increment the monthly usage counter for the user
  const { data: existing } = await supabase
    .from("usage_counters")
    .select(tierColumn)
    .eq("user_id", userId)
    .eq("month",    month)
    .single();

  const currentCount = (existing as { [key: string]: number } | null)?.[tierColumn] ?? 0;

  await supabase.from("usage_counters").upsert(
    {
      user_id: userId,
      month,
      [tierColumn]: currentCount + 1
    },
    { onConflict: "user_id,month" }
  );

  // Also increment the global total migrations counter
  await supabase.rpc('increment_total_migrations', { increment_value: 1 });
}
