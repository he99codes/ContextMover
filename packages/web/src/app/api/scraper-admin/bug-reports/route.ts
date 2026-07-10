// packages/web/src/app/api/scraper-admin/bug-reports/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/api/admin/_guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET all bug reports (admin only)
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const supabase = createAdminClient();
  const { data, error } = await supabase.from("scraper_bug_reports").select("*").order('created_at', { ascending: false });
  if (error) {
    if (error.code === '42P01') return NextResponse.json([]); // table not yet created
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}

// POST a new bug report (public, from extension)
export async function POST(req: NextRequest) {
  const limit = await checkRateLimit(req, undefined, 1);
  if (!limit.ok) return limit.response;
  const { platform_id, error_message, href, user_id, dom_snippet } = (await req.json()) as {
    platform_id: string;
    error_message: string;
    href: string;
    user_id?: string;
    dom_snippet?: string;
  };

  if (!platform_id || !error_message) return NextResponse.json({ error: "platform_id and error_message are required" }, { status: 400 });

  const supabase = createAdminClient();
  const { error } = await supabase.from("scraper_bug_reports").insert({
    platform_id,
    error_message,
    href,
    user_id,
    dom_snippet,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
