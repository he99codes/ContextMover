import { NextRequest, NextResponse } from "next/server";
import Razorpay from "razorpay";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { billing, userId, userEmail, earlyBird } = await req.json();
    if (!billing || !userId || !["monthly", "annual"].includes(billing)) {
      return NextResponse.json({ error: "billing (monthly|annual) and userId required" }, { status: 400 });
    }

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
      total_count: billing === "annual" ? 12 : 120,
      notes: { userId, userEmail: userEmail ?? "", billing, earlyBird: String(earlyBird) },
    });

    const admin = createAdminClient();
    await admin.from("subscriptions").upsert({
      user_id: userId,
      razorpay_subscription_id: subscription.id,
      razorpay_plan_id: planId,
      plan: billing,
      status: "created",
    }, { onConflict: "razorpay_subscription_id" });

    return NextResponse.json({
      subscriptionId: subscription.id,
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID!,
    });
  } catch (err) {
    console.error("[create-subscription]", err);
    const message = err instanceof Error ? err.message : "Failed to create subscription";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
