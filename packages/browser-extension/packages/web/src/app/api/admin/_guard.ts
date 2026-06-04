// packages/web/src/app/api/admin/_guard.ts
// Shared admin auth guard — call at the top of every admin route.
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Admin emails list — add your email here to grant admin access
const ADMIN_EMAILS = [
  "priyanshu2164@gmail.com",
  // Add more admin emails as needed
];

export async function requireAdmin(
  req: NextRequest
): Promise<{ userId: string } | NextResponse> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const admin = createAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  
  // Check if user email is in admin list
  const userEmail = data.user.email?.toLowerCase() ?? "";
  const isAdmin = ADMIN_EMAILS.some(email => email.toLowerCase() === userEmail);
  
  if (!isAdmin) {
    console.warn(`[admin] Unauthorized access attempt from ${userEmail}`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return { userId: data.user.id };
}
