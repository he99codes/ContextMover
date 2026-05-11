// packages/web/src/app/api/payments/usage/route.ts
// Atomic usage check + increment.
// Called from the extension before every migration.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentMonth } from "@/lib/payments/subscription";
import { getAuthUser } from "@/lib/payments/auth";
import { checkRateLimit } from "@/lib/rate-limiter";

type UsageType = "simple" | "smart" | "attention";

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // [SECURITY] Rate limit — hit on every migration; 60/min/user is generous
  // for real usage and blocks runaway / abusive clients.
  const rl = await checkRateLimit(req, user.id);
  if (!rl.ok) return rl.response;

  const body = await req.json().catch(() => ({}));
  const type: UsageType | undefined = body?.type;

  if (type !== "simple" && type !== "smart" && type !== "attention") {
    return NextResponse.json(
      { error: "Invalid type — expected 'simple' | 'smart' | 'attention'" },
      { status: 400 }
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data, error } = await supabase.rpc("increment_usage", {
    p_user_id: user.id,
    p_type:    type,
    p_month:   getCurrentMonth(),
  });

  if (error) {
    console.error("[CM:api:usage] rpc error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // RPC returns a jsonb object — pass through as-is.
  return NextResponse.json(data);
}
