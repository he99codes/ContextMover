// packages/web/src/app/api/admin/_guard.ts
// Shared admin auth guard — call at the top of every admin route.
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

const ADMIN_EMAIL = "priyanshu2164@gmail.com";

export async function requireAdmin(
  req: NextRequest
): Promise<{ userId: string; email: string } | NextResponse> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const admin = createAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  if (data.user.email !== ADMIN_EMAIL)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  return { userId: data.user.id, email: data.user.email };
}
