import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../_guard";
import { createAdminClient } from "@/lib/supabase/admin";

// GET  /api/admin/user-devices?userId=<uuid>  — list devices for a user
// DELETE /api/admin/user-devices               — body { userId, installId } — remove one device

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_devices")
    .select("id, install_id, last_seen, created_at")
    .eq("user_id", userId)
    .order("last_seen", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ devices: data });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const { userId, installId } = await req.json();
  if (!userId || !installId) return NextResponse.json({ error: "userId and installId required" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("user_devices")
    .delete()
    .eq("user_id", userId)
    .eq("install_id", installId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
