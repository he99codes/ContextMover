// packages/web/src/app/api/admin/_guard.ts
// Shared admin auth guard — call at the top of every admin route.
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "").toLowerCase().trim();

export async function requireAdmin(
  req: NextRequest
): Promise<{ userId: string; email: string } | NextResponse> {
  if (!ADMIN_EMAIL) {
    console.error("[CM:admin:guard] ADMIN_EMAIL env var is not set — all admin requests will be rejected. Add it to Vercel environment variables.");
  }

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const admin = createAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  if (!ADMIN_EMAIL || data.user.email?.toLowerCase().trim() !== ADMIN_EMAIL) {
    console.error(`[CM:admin:guard] Forbidden: email="${data.user.email}" ADMIN_EMAIL="${ADMIN_EMAIL || "(not set)"}"`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return { userId: data.user.id, email: data.user.email ?? '' };
}
