import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const admin = createAdminClient();
    const { count } = await admin
      .from("subscriptions")
      .select("*", { count: "exact", head: true })
      .eq("status", "active");
    return NextResponse.json({ activeCount: count ?? 0 });
  } catch (err) {
    console.error("[CM:api:subscription-count] error:", err);
    return NextResponse.json({ activeCount: 0 });
  }
}
