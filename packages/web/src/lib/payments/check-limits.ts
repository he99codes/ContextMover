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

export type LimitedFeature = "migrations" | "summarizations" | "attention_engine";

export interface LimitResult {
  allowed:   boolean;
  remaining: number;
  limit:     number;
  used:      number;
}

// Free-tier monthly limits per feature.
const FREE_LIMITS: Record<LimitedFeature, number> = {
  migrations:       50,
  summarizations:   50,
  attention_engine: 10,
};

// Returns the current UTC month key, e.g. '2026-05'.
function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Check whether `userId` is allowed to use `feature` this month.
 * Pro users bypass all limits.
 */
export async function checkLimit(
  userId:  string,
  feature: LimitedFeature
): Promise<LimitResult> {
  const supabase = createAdminClient();
  const limit    = FREE_LIMITS[feature];

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
    .from("usage")
    .select("count")
    .eq("user_id", userId)
    .eq("feature",  feature)
    .eq("month",    month)
    .single();

  const usageRow = usageRaw as { count: number } | null;
  const used     = usageRow?.count ?? 0;
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
  feature: LimitedFeature
): Promise<void> {
  const supabase = createAdminClient();
  const month    = currentMonth();

  const { data: existing } = await supabase
    .from("usage")
    .select("count")
    .eq("user_id", userId)
    .eq("feature",  feature)
    .eq("month",    month)
    .single();

  const currentCount = (existing as { count: number } | null)?.count ?? 0;

  await supabase.from("usage").upsert(
    { user_id: userId, feature, month, count: currentCount + 1 },
    { onConflict: "user_id,feature,month" }
  );
}
