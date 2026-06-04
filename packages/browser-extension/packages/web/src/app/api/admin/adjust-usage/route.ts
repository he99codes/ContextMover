// packages/web/src/app/api/admin/adjust-usage/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentMonth } from "@/lib/usage/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AdjustAction = "reset" | "add_tier1" | "add_tier2" | "add_tier3";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const { userId, action, amount = 10 } = (await req.json()) as {
    userId: string;
    action: AdjustAction;
    amount?: number;
  };
  if (!userId || !action) return NextResponse.json({ error: "userId and action required" }, { status: 400 });

  const admin = createAdminClient();
  const month = getCurrentMonth();

  // Ensure row exists
  const { data: existing } = await admin
    .from("usage_counters")
    .select("tier1_count, tier2_count, tier3_count")
    .eq("user_id", userId)
    .eq("month", month)
    .maybeSingle();

  const base = {
    tier1_count: (existing?.tier1_count as number) ?? 0,
    tier2_count: (existing?.tier2_count as number) ?? 0,
    tier3_count: (existing?.tier3_count as number) ?? 0,
  };

  let newCounts = { ...base };

  if (action === "reset") {
    newCounts = { tier1_count: 0, tier2_count: 0, tier3_count: 0 };
  } else if (action === "add_tier1") {
    newCounts.tier1_count = base.tier1_count + amount;
  } else if (action === "add_tier2") {
    newCounts.tier2_count = base.tier2_count + amount;
  } else if (action === "add_tier3") {
    newCounts.tier3_count = base.tier3_count + amount;
  }

  const { error } = await admin.from("usage_counters").upsert({
    user_id: userId,
    month,
    ...newCounts,
  }, { onConflict: "user_id, month" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, newCounts });
}
