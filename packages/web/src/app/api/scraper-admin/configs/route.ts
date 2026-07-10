// packages/web/src/app/api/scraper-admin/configs/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/api/admin/_guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limiter";

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

// GET all platform configs
export async function GET() {
  // NOTE: This endpoint is public for the extension to fetch, so no admin guard here.
  // A separate admin-only endpoint will handle writes.
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.from("scraper_configs").select("*").order("platform_id");
    if (error) {
      console.error("Error fetching scraper_configs:", error);
      if (error.code === '42P01') {
        return NextResponse.json([], { headers: CORS });
      }
      return NextResponse.json({ error: error.message }, { status: 500, headers: CORS });
    }
    // Alias schema columns to the frontend-expected shape
    const mapped = (data ?? []).map(row => ({
      platform_id: row.platform_id,
      is_enabled: row.is_active,
      selectors: row.selectors,
      last_updated_at: row.updated_at,
      updated_by: row.notes ?? '',
    }));
    return NextResponse.json(mapped, { headers: CORS });
  } catch (e) {
    console.error("Unexpected error in /api/scraper-admin/configs:", e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500, headers: CORS });
  }
}

// POST to update a platform config
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const rl = await checkRateLimit(req, undefined, 30);
  if (!rl.ok) return rl.response;

  const { platform_id, selectors, is_enabled } = (await req.json()) as {
    platform_id: string;
    selectors: Record<string, string | undefined>;
    is_enabled: boolean;
  };

  if (!platform_id) return NextResponse.json({ error: "platform_id is required" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin.from("scraper_configs").upsert({
    platform_id,
    selectors,
    is_active: is_enabled,
    updated_at: new Date().toISOString(),
    notes: `Updated by ${guard.email}`,
  }, { onConflict: "platform_id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
