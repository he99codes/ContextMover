import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
        const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = await req.json();

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

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature || !user) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return NextResponse.json({ error: "Payment gateway not configured" }, { status: 503 });
    }

    const generated = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest("hex");

    if (generated.length !== razorpay_signature.length ||
        !crypto.timingSafeEqual(Buffer.from(generated), Buffer.from(razorpay_signature))) {
      return NextResponse.json({ error: "Invalid payment signature" }, { status: 400 });
    }

    const admin = createAdminClient();
        const { data: sub } = await admin
      .from("subscriptions")
      .select("user_id, interval")
      .eq("razorpay_subscription_id", razorpay_subscription_id)
      .single();

    if (sub?.user_id !== user.id) {
      return NextResponse.json({ error: "Subscription mismatch" }, { status: 403 });
    }

    const interval = sub?.interval ?? "monthly";
    const periodEnd = new Date();
    if (interval === "annual") {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    await admin.from("subscriptions")
      .update({
        status: "active",
        plan: "pro",
        current_start: new Date().toISOString(),
        current_end: periodEnd.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("razorpay_subscription_id", razorpay_subscription_id);

    await admin.from("users")
      .update({
        is_pro: true,
        plan: "pro",
        subscription_status: "active",
        razorpay_subscription_id,
        pro_since: new Date().toISOString(),
      })
      .eq("id", user.id);

    return NextResponse.json({ success: true, isPro: true, plan: "pro" });
  } catch (err) {
    console.error("[verify-subscription]", err);
    return NextResponse.json({ error: "Verification failed" }, { status: 500 });
  }
}
