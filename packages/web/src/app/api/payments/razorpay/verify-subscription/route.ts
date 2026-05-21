/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/payments/razorpay/verify-subscription/route.ts
// Called client-side after Razorpay subscription checkout completes.
// [SECURITY] Signature is verified server-side before updating Supabase.

import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logPaymentEvent } from "@/lib/payments/subscription";

export const runtime = "nodejs";

type VerifyBody = {
  razorpay_payment_id:      string;
  razorpay_subscription_id: string;
  razorpay_signature:       string;
  userId:                   string;
  plan:                     string;
  billing:                  string;
};

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function addYears(date: Date, years: number): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as VerifyBody;
    const {
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature,
      userId,
      plan,
      billing,
    } = body;

    if (
      !razorpay_payment_id ||
      !razorpay_subscription_id ||
      !razorpay_signature ||
      !userId ||
      !plan ||
      !billing
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return NextResponse.json(
        { error: "Payment gateway not configured" },
        { status: 503 }
      );
    }

    const generated = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest("hex");

    if (
      generated.length !== razorpay_signature.length ||
      !crypto.timingSafeEqual(
        Buffer.from(generated),
        Buffer.from(razorpay_signature)
      )
    ) {
      console.warn(
        "[verify-subscription] Signature mismatch for payment",
        razorpay_payment_id
      );
      return NextResponse.json(
        { error: "Invalid payment signature" },
        { status: 400 }
      );
    }

    const now       = new Date();
    const periodEnd = billing === "annual" ? addYears(now, 1) : addMonths(now, 1);

    const admin = createAdminClient();
    const { error: upsertError } = await admin.from("subscriptions").upsert(
      {
        user_id:                 userId,
        plan,
        status:                  "active",
        gateway:                 "razorpay",
        gateway_subscription_id: razorpay_subscription_id,
        payment_id:              razorpay_payment_id,
        currency:                "inr",
        amount:                  billing === "annual" ? 239900 : 29900,
        interval:                billing === "annual" ? "year" : "month",
        current_period_start:    now.toISOString(),
        current_period_end:      periodEnd.toISOString(),
        updated_at:              now.toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (upsertError) {
      console.error("[verify-subscription] upsert failed:", upsertError);
    }

    await logPaymentEvent(
      userId,
      "razorpay",
      "subscription.first_payment",
      razorpay_payment_id,
      {
        subscription_id: razorpay_subscription_id,
        payment_id:      razorpay_payment_id,
        plan,
        billing,
      }
    );

    return NextResponse.json({
      ok:             true,
      verified:       true,
      subscriptionId: razorpay_subscription_id,
    });
  } catch (err) {
    console.error("[verify-subscription]", err);
    const message =
      err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
