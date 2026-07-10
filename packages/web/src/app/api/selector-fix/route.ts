// packages/web/src/app/api/selector-fix/route.ts
// Receives user-submitted selector fixes from the Self-Heal Wizard.
// Stores them in the scraper_bug_reports table (reuses existing schema) for
// admin review. Once confirmed, admin can promote them to scraper_configs.
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  const limit = await checkRateLimit(req);
  if (!limit.ok) return limit.response;

  let body: {
    platform?: string;
    selectors?: {
      userSelector?: string;
      assistantSelector?: string;
      rootSelector?: string;
      inputSelector?: string;
    };
    submittedAt?: number;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { platform, selectors, submittedAt } = body;
  if (!platform || !selectors) {
    return NextResponse.json({ error: "platform and selectors are required" }, { status: 400 });
  }

  // Soft auth — extract user_id for traceability; non-blocking if missing
  const admin = createAdminClient();
  let userId: string | null = null;
  try {
    const authHeader = req.headers.get("authorization") ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const { data } = await admin.auth.getUser(token);
      userId = data.user?.id ?? null;
    }
  } catch { /* non-blocking */ }

  const { error } = await admin.from("scraper_bug_reports").insert({
    platform_id: platform,
    error_message: `[self-heal] User submitted selector fix`,
    href: null,
    user_id: userId,
    dom_snippet: JSON.stringify({ selectors, submittedAt }),
  });

  if (error) {
    // Log server-side for debugging; do not fail the request — the selectors
    // are already saved locally in the extension. The DB table may not exist yet.
    console.error("[selector-fix] DB insert failed:", error.message);
  }
  return NextResponse.json({ ok: true }, { headers: CORS });
}
