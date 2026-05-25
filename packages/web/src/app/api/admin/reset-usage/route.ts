import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentMonth } from "@/lib/usage/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const { userId } = (await req.json()) as { userId: string };
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
  const admin = createAdminClient();
  const { error } = await admin
    .from("usage_counters")
    .update({ tier1_count: 0, tier2_count: 0, tier3_count: 0 })
    .eq("user_id", userId)
    .eq("month", getCurrentMonth());
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
