// packages/web/src/app/api/payments/razorpay/cancel-subscription/route.ts
// Cancels an active Razorpay subscription at the end of the current billing cycle.

import { NextRequest, NextResponse } from "next/server";
import Razorpay from "razorpay";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { logPaymentEvent } from "@/lib/payments/subscription";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // ── Auth via Bearer token ───────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── Find active Razorpay subscription ────────────────────────────────────
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("gateway_subscription_id")
      .eq("user_id", user.id)
      .eq("gateway", "razorpay")
      .in("status", ["active", "trialing"])
      .maybeSingle();

    if (!sub?.gateway_subscription_id) {
      return NextResponse.json(
        { error: "No active subscription found" },
        { status: 404 }
      );
    }

    // ── Cancel via Razorpay ──────────────────────────────────────────────────
    const keyId     = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return NextResponse.json(
        { error: "Payment gateway not configured" },
        { status: 503 }
      );
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    await razorpay.subscriptions.cancel(sub.gateway_subscription_id, true);

    // ── Update Supabase ──────────────────────────────────────────────────────
    const now = new Date().toISOString();
    await admin
      .from("subscriptions")
      .update({
        status:       "cancelled",
        cancelled_at: now,
        updated_at:   now,
      })
      .eq("user_id", user.id);

    await logPaymentEvent(
      user.id,
      "razorpay",
      "subscription.cancelled",
      sub.gateway_subscription_id,
      { cancelled_by: "user" }
    );

    return NextResponse.json({
      ok:        true,
      cancelled: true,
      message:   "Access continues until end of billing period",
    });
  } catch (err) {
    console.error("[cancel-subscription]", err);
    const message =
      err instanceof Error ? err.message : "Failed to cancel subscription";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
