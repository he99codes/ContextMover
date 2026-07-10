import { NextRequest, NextResponse } from "next/server";
import Razorpay from "razorpay";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@supabase/supabase-js";
import { checkRateLimit } from "@/lib/rate-limiter";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
        const { billing, userId, userEmail } = await req.json();

    // Server-side validation for early bird pricing
    const earlyBirdCutoff = new Date('2026-07-01T00:00:00Z');
    const earlyBird = new Date() < earlyBirdCutoff;
        if (!billing || !userId || !["monthly", "annual"].includes(billing)) {
      return NextResponse.json({ error: "billing (monthly|annual) and userId required" }, { status: 400 });
    }

    // ── Auth validation ──────────────────────────────────────────────────
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
    const supabaseAuth = createClient(
      supaUrl,
      supaAnon,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: { user }, error: authErr } = await supabaseAuth.auth.getUser(token);
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (user.id !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // [SECURITY] Rate limit: 10 subscription creation attempts per minute per user.
    const rl = await checkRateLimit(req, user.id, 10);
    if (!rl.ok) return rl.response;

    const planId = billing === "annual"
      ? (earlyBird ? process.env.RAZORPAY_PRO_ANNUAL_PLAN_ID : process.env.RAZORPAY_PRO_ANNUAL_REGULAR_PLAN_ID)
      : (earlyBird ? process.env.RAZORPAY_PRO_MONTHLY_PLAN_ID : process.env.RAZORPAY_PRO_MONTHLY_REGULAR_PLAN_ID);

    if (!planId) {
      return NextResponse.json({ error: "Plan IDs not configured" }, { status: 400 });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return NextResponse.json({ error: "Payment gateway not configured" }, { status: 503 });
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      quantity: 1,
      total_count: billing === "annual" ? 12 : 12,
      notes: { userId, userEmail: userEmail ?? "", billing, earlyBird: String(earlyBird) },
    });

    const admin = createAdminClient();
    await admin.from("subscriptions").upsert({
      user_id: userId,
      razorpay_subscription_id: subscription.id,
      razorpay_plan_id: planId,
      plan: "pro",                    // [CM-RZP-FIX] plan='pro' for plan_limits lookup; interval stores billing period
      interval: billing,
      amount: billing === "annual"
        ? (earlyBird ? 239_900 : 399_900)
        : (earlyBird ? 29_900 : 49_900),
      currency: "inr",
      gateway: "razorpay",
      status: "created",
    }, { onConflict: "user_id" });

    return NextResponse.json({
      subscriptionId: subscription.id,
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? "",
    });
  } catch (err) {
    console.error("[create-subscription]", err);
    return NextResponse.json({ error: "Failed to create subscription" }, { status: 500 });
  }
}
