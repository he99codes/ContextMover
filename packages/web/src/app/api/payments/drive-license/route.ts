import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/payments/auth";
import { checkRateLimit } from "@/lib/rate-limiter";
import { resolveProForDrive } from "@/lib/payments/pro-enforcement";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = body?.action as string | undefined;
  const driveEmail = body?.driveEmail as string | undefined;

  if (!driveEmail || typeof driveEmail !== "string") {
    return NextResponse.json({ error: "Missing driveEmail" }, { status: 400, headers: CORS });
  }

  const email = driveEmail.toLowerCase().trim();
  if (!email.includes("@") || email.length > 254) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400, headers: CORS });
  }

  // ── BIND: Link Drive email to authenticated Supabase user ────────────────
  if (action === "bind") {
    const user = await getAuthUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
    }

    const rl = await checkRateLimit(req, user.id, 10, 60);
    if (!rl.ok) return rl.response;

    try {
      const admin = createAdminClient();
      const { error } = await admin
        .from("users")
        .update({ drive_email: email })
        .eq("id", user.id);

      if (error) {
        console.error("[CM:api:drive-license] bind error:", error);
        return NextResponse.json({ error: "Failed to bind Drive email" }, { status: 500, headers: CORS });
      }

      console.log("[CM:api:drive-license] bound drive_email:", email, "to user:", user.id);
      return NextResponse.json({ ok: true, bound: true }, { headers: CORS });
    } catch (err) {
      console.error("[CM:api:drive-license] bind exception:", err);
      return NextResponse.json({ error: "Internal error" }, { status: 500, headers: CORS });
    }
  }

  // ── CHECK: Pro enforcement via master-drive lock + seat roster ───────────
  if (action === "check") {
    // Rate limit by IP — 10 req/min to prevent email enumeration
    const rl = await checkRateLimit(req, undefined, 10, 60);
    if (!rl.ok) return rl.response;

    // Optional: extension sends loginEmail when user is signed in to Supabase
    const loginEmail = (body?.loginEmail as string | undefined)?.toLowerCase().trim() || null;
    // If the extension included a bearer token, resolve the owner id directly so
    // enforcement doesn't rely on the fragile email→user lookup.
    const authedUser = await getAuthUser(req).catch(() => null);

    try {
      const admin = createAdminClient();
      const result = await resolveProForDrive(admin, {
        loginEmail: loginEmail ?? authedUser?.email?.toLowerCase().trim() ?? null,
        driveEmail: email,
        ownerUserId: authedUser?.id ?? null,
      });

      return NextResponse.json({
        isPro: result.isPro,
        plan: result.plan,
        reason: result.reason,
        masterDriveEmail: result.masterDriveEmail ?? null,
      }, { headers: CORS });
    } catch (err) {
      console.error("[CM:api:drive-license] check exception:", err);
      return NextResponse.json({ isPro: false, plan: "free", error: true }, { headers: CORS });
    }
  }

  return NextResponse.json({ error: "Invalid action — expected 'bind' or 'check'" }, { status: 400, headers: CORS });
}
