// packages/web/src/app/api/admin/find-user/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { checkRateLimit } from "@/lib/rate-limiter";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentMonth } from "@/lib/usage/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const rl = await checkRateLimit(req, undefined, 30);
  if (!rl.ok) return rl.response;

  const email = req.nextUrl.searchParams.get("email");
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const admin = createAdminClient();

  // Try users table first (indexed email lookup, O(1))
  const { data: userRow } = await admin
    .from("users")
    .select("id, email, created_at")
    .ilike("email", email)
    .maybeSingle();

  let userId: string;
  let userEmail: string | null = null;
  let userCreated: string | null = null;

  if (userRow) {
    userId = userRow.id;
    userEmail = userRow.email;
    userCreated = userRow.created_at;
  } else {
    // Fallback: search auth.users via admin API
    const { data: authData, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const user = authData.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    userId = user.id;
    userEmail = user.email ?? null;
    userCreated = user.created_at ?? null;
  }

  const month = getCurrentMonth();
  const [{ data: usage }, { data: sub }] = await Promise.all([
    admin
      .from("usage_counters")
      .select("tier1_count, tier2_count, tier3_count")
      .eq("user_id", userId)
      .eq("month", month)
      .maybeSingle(),
    admin
      .from("subscriptions")
      .select("plan, status")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  return NextResponse.json({
    id:          userId,
    email:       userEmail,
    created_at:  userCreated,
    plan:        (sub?.plan as string) ?? "free",
    status:      (sub?.status as string) ?? null,
    tier1_count: (usage?.tier1_count as number) ?? 0,
    tier2_count: (usage?.tier2_count as number) ?? 0,
    tier3_count: (usage?.tier3_count as number) ?? 0,
  });
}
