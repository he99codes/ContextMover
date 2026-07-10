// packages/web/src/app/api/admin/refund-action/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const { requestId, action } = (await req.json()) as {
    requestId: string;
    action: "approved" | "rejected";
  };
  if (!requestId || !["approved", "rejected"].includes(action))
    return NextResponse.json({ error: "requestId and valid action required" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("refund_requests")
    .update({ status: action, updated_at: new Date().toISOString() })
    .eq("id", requestId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
