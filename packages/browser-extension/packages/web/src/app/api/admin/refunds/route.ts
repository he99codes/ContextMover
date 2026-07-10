// packages/web/src/app/api/admin/refunds/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("refund_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Enrich with email from auth.users
  const enriched = await Promise.all(
    (data ?? []).map(async (row) => {
      if (!row.user_id) return { ...row, email: null };
      const { data: u } = await admin.auth.admin.getUserById(row.user_id as string);
      return { ...row, email: u?.user?.email ?? null };
    })
  );

  return NextResponse.json({ refunds: enriched });
}
