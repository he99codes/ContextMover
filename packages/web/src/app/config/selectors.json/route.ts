// packages/web/src/app/config/selectors.json/route.ts
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

// Alias for /api/scraper-admin/configs — reads from scraper_configs table.
// Kept for backward compatibility with older extension versions that fetch from this URL.
export async function GET() {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.from("scraper_configs").select("*").order("platform_id");
    if (error) {
      if (error.code === '42P01') return NextResponse.json([], { headers: CORS });
      return NextResponse.json({ error: error.message }, { status: 500, headers: CORS });
    }
    const mapped = (data ?? []).map(row => ({
      platform_id: row.platform_id,
      is_enabled: row.is_active,
      selectors: row.selectors,
      last_updated_at: row.updated_at,
      updated_by: row.notes ?? '',
    }));
    return NextResponse.json(mapped, { headers: CORS });
  } catch (e) {
    console.error("[Config Route] Internal Server Error:", e);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500, headers: CORS });
  }
}
