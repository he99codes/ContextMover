import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, userId } = await req.json();

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature || !userId) {
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
      .select("interval")
      .eq("razorpay_subscription_id", razorpay_subscription_id)
      .single();

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
      .eq("id", userId);

    return NextResponse.json({ success: true, isPro: true, plan: "pro" });
  } catch (err) {
    console.error("[verify-subscription]", err);
    const message = err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
