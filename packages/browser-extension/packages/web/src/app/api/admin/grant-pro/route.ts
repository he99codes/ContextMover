// packages/web/src/app/api/admin/grant-pro/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const { userId } = (await req.json()) as { userId: string };
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const admin = createAdminClient();
  const end = new Date();
  end.setFullYear(end.getFullYear() + 10); // 10-year grant

  const { error } = await admin.from("subscriptions").upsert({
    user_id:             userId,
    plan:                "pro",
    status:              "active",
    gateway:             "manual",
    current_period_end:  end.toISOString(),
    updated_at:          new Date().toISOString(),
  }, { onConflict: "user_id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
