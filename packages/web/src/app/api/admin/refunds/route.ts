// packages/web/src/app/api/admin/refunds/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { checkRateLimit } from "@/lib/rate-limiter";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const rl = await checkRateLimit(req, undefined, 30);
  if (!rl.ok) return rl.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("refund_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Batch-fetch emails from users table instead of N+1 getUserById calls
  const userIds = (data ?? []).map(r => r.user_id).filter(Boolean) as string[];
  const emailMap: Record<string, string | null> = {};

  if (userIds.length > 0) {
    const { data: userRows } = await admin
      .from("users")
      .select("id, email")
      .in("id", userIds);
    for (const u of userRows ?? []) {
      emailMap[u.id] = u.email;
    }
    // For any user_ids not found in users table, fall back to auth.admin
    const missing = userIds.filter(id => !(id in emailMap));
    for (const id of missing) {
      try {
        const { data: u } = await admin.auth.admin.getUserById(id);
        emailMap[id] = u?.user?.email ?? null;
      } catch { emailMap[id] = null; }
    }
  }

  const enriched = (data ?? []).map(row => ({
    ...row,
    email: row.user_id ? (emailMap[row.user_id as string] ?? null) : null,
  }));

  return NextResponse.json({ refunds: enriched });
}
