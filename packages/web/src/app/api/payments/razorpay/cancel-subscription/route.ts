/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/payments/razorpay/cancel-subscription/route.ts
// Cancels an active Razorpay subscription at the end of the current billing cycle.

import { NextRequest, NextResponse } from "next/server";
import Razorpay from "razorpay";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { logPaymentEvent } from "@/lib/payments/subscription";
import { checkRateLimit } from "@/lib/rate-limiter";
import { sendEmail, SENDERS } from "@/lib/mailer";
import { proCancelledEmail } from "@/lib/emails/templates";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // ── Auth via Bearer token ───────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supaAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supaUrl || !supaAnon) {
      return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
    }
    const supabase = createSupabaseClient(
      supaUrl,
      supaAnon,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // [SECURITY] Rate limit: 5 cancellation attempts per minute per user.
    const rl = await checkRateLimit(req, user.id, 5);
    if (!rl.ok) return rl.response;

    // ── Find active Razorpay subscription ────────────────────────────────────
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("razorpay_subscription_id, gateway_subscription_id, current_period_end, current_end")
      .eq("user_id", user.id)
      .eq("gateway", "razorpay")
      .in("status", ["active", "trialing", "authenticated"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const razorpaySubId = sub?.razorpay_subscription_id ?? sub?.gateway_subscription_id;
    if (!razorpaySubId) {
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
    await razorpay.subscriptions.cancel(razorpaySubId, true);

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

    // Also update users table to reflect cancellation (keep is_pro until period end)
    await admin.from("users").update({
      subscription_status: "cancelled",
    }).eq("id", user.id);

    await logPaymentEvent(
      user.id,
      "razorpay",
      "subscription.cancelled",
      razorpaySubId,
      { cancelled_by: "user" },
      razorpaySubId,
    );

    // ── Send cancellation email with autopay warning (LL) ─────────────
    const periodEnd = sub?.current_period_end ?? sub?.current_end ?? undefined;
    if (process.env.ZEPTO_SMTP_PASSWORD) {
      try {
        const { data: userData } = await admin.auth.admin.getUserById(user.id);
        const userEmail = userData?.user?.email;
        if (userEmail) {
          const tpl = proCancelledEmail(userEmail, periodEnd);
          await Promise.allSettled([
            sendEmail({ ...tpl, to: userEmail, from: SENDERS.support }),
          ]).then((results) => {
            for (const r of results) {
              if (r.status === 'rejected') console.warn("[cancel-subscription] email failed:", r.reason);
            }
          });
        }
      } catch (e) { console.warn("[cancel-subscription] getUserById failed:", e); }
    }

    return NextResponse.json({
      ok:        true,
      cancelled: true,
      message:   "Access continues until end of billing period",
    });
  } catch (err) {
    console.error("[cancel-subscription]", err);
    return NextResponse.json({ error: "Failed to cancel subscription" }, { status: 500 });
  }
}
