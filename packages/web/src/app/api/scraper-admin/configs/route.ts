// packages/web/src/app/api/scraper-admin/configs/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/api/admin/_guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET all platform configs
export async function GET() {
  // NOTE: This endpoint is public for the extension to fetch, so no admin guard here.
  // A separate admin-only endpoint will handle writes.
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.from("platform_configs").select("*");
    if (error) {
      console.error("Error fetching platform_configs:", error);
      // If the table doesn't exist, return an empty array instead of a 500 error.
      if (error.code === '42P01') {
        return NextResponse.json([]);
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(data);
  } catch (e) {
    console.error("Unexpected error in /api/scraper-admin/configs:", e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// POST to update a platform config
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const { platform_id, selectors, is_enabled } = (await req.json()) as {
    platform_id: string;
    selectors: Record<string, string | undefined>;
    is_enabled: boolean;
  };

  if (!platform_id) return NextResponse.json({ error: "platform_id is required" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin.from("platform_configs").upsert({
    platform_id,
    selectors,
    is_enabled,
    last_updated_at: new Date(),
    updated_by: guard.email,
  }, { onConflict: "platform_id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
