import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/payments/auth";
import { checkRateLimit } from "@/lib/rate-limiter";
import { resolveProForDrive } from "@/lib/payments/pro-enforcement";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-install-id, x-drive-email",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);

  // [PRO-SEATS] If no Supabase auth, check x-drive-email via master-drive enforcement.
  if (!user) {
    const driveEmail = req.headers.get("x-drive-email");
    if (driveEmail) {
      const email = driveEmail.toLowerCase().trim();
      const rl = await checkRateLimit(req, undefined, 10, 60);
      if (!rl.ok) return rl.response;
      try {
        const admin = createAdminClient();
        const result = await resolveProForDrive(admin, { driveEmail: email });
        return NextResponse.json({
          isPro: result.isPro,
          plan: result.plan,
          status: result.isPro ? "active" : "free",
          source: "drive_license",
          reason: result.reason,
          masterDriveEmail: result.masterDriveEmail ?? null,
        }, { headers: CORS });
      } catch (err) {
        console.error("[CM:api:subscription:GET] drive-license error:", err);
      }
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
  }

  const rl = await checkRateLimit(req, user.id);
  if (!rl.ok) return rl.response;

  try {
    const admin = createAdminClient();
    const driveEmailHeader = req.headers.get("x-drive-email")?.toLowerCase().trim() || null;
    const loginEmail = user.email?.toLowerCase().trim() ?? null;

    // When Drive is connected, run master-drive enforcement. Pass the already
    // authenticated user.id so the owner lookup doesn't depend on resolving the
    // email through public/auth.users (which was silently failing → free).
    if (driveEmailHeader) {
      const driveResult = await resolveProForDrive(admin, {
        loginEmail,
        driveEmail: driveEmailHeader,
        ownerUserId: user.id,
      });

      const { data: subscription } = await admin
        .from("subscriptions")
        .select("current_period_end, current_end, plan, status, interval, cancelled_at")
        .eq("user_id", user.id)
        .in("status", ["active", "authenticated", "cancelled"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: userRow } = await admin
        .from("users")
        .select("is_pro, plan")
        .eq("id", user.id)
        .maybeSingle();

      // The signed-in user's own subscription is the source of truth for Pro.
      // Drive enforcement can only *revoke* on a genuine mismatch — it must not
      // downgrade a real subscriber just because owner resolution came back empty.
      const subEnd = subscription?.current_period_end ?? subscription?.current_end;
      const isCancelledButActive = subscription?.status === "cancelled" && subEnd
        ? new Date(subEnd).getTime() > Date.now()
        : false;
      const hasRealSub = subscription?.status === "active"
        || subscription?.status === "authenticated"
        || isCancelledButActive
        || userRow?.is_pro === true;

      const revoked = driveResult.reason === "drive_mismatch";
      const isPro = revoked ? false : (driveResult.isPro || hasRealSub);

      return NextResponse.json({
        isPro,
        plan: isPro ? (subscription?.plan ?? userRow?.plan ?? "pro") : "free",
        interval: subscription?.interval ?? null,
        status: isPro ? (subscription?.status ?? "active") : (revoked ? "drive_mismatch" : "free"),
        currentEnd: subscription?.current_period_end ?? subscription?.current_end ?? null,
        reason: revoked ? driveResult.reason : (isPro ? "ok" : driveResult.reason),
        masterDriveEmail: driveResult.masterDriveEmail ?? null,
      }, { headers: CORS });
    }

    const { data: subscription } = await admin
      .from("subscriptions")
      .select("current_period_end, current_end, plan, status, interval, cancelled_at")
      .eq("user_id", user.id)
      .in("status", ["active", "authenticated", "cancelled"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: userRow } = await admin
      .from("users")
      .select("is_pro, plan, subscription_status")
      .eq("id", user.id)
      .maybeSingle();

    // A cancelled subscription still grants Pro until current_period_end passes
    const subEnd = subscription?.current_period_end ?? subscription?.current_end;
    const isCancelledButActive = subscription?.status === "cancelled" && subEnd
      ? new Date(subEnd).getTime() > Date.now()
      : false;

    const isPro = subscription?.status === "active" || subscription?.status === "authenticated" || isCancelledButActive || userRow?.is_pro === true;

    // ── Device tracking (analytics only, no limit enforced) ─────────────────
    // Pro users can use unlimited devices / Chrome profiles.
    if (isPro) {
      const installId = req.headers.get("x-install-id");
      if (installId && installId !== "unknown") {
        try {
          await admin.from("user_devices").upsert(
            { user_id: user.id, install_id: installId, last_seen: new Date().toISOString() },
            { onConflict: "user_id,install_id" }
          );
        } catch { /* analytics-only — ignore failures */ }
      }
    }

    return NextResponse.json({
      isPro,
      plan: isPro ? (subscription?.plan ?? "pro") : "free",
      interval: subscription?.interval ?? null,
      status: subscription?.status ?? (userRow?.is_pro ? "active" : "free"),
      currentEnd: subscription?.current_period_end ?? subscription?.current_end ?? null,
    }, { headers: CORS });
  } catch (err) {
    console.error("[CM:api:subscription:GET] error:", err);
    return NextResponse.json({ error: "Failed to load subscription" }, { status: 500, headers: CORS });
  }
}
