/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/payments/razorpay/webhook/route.ts
// [SECURITY] Verifies Razorpay webhook signature before processing any event.
// Uses RAZORPAY_WEBHOOK_SECRET (configured separately in Razorpay Dashboard).
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Disable Next.js body parsing — we need the raw text to verify the signature.
export const dynamic = "force-dynamic";

type RazorpayWebhookPayment = {
  id:              string;
  order_id:        string;
  email:           string;
  contact:         string;
  status:          string;
  amount:          number;
  currency:        string;
  notes?:          Record<string, string>;
  subscription_id?: string;
};

type RazorpayWebhookEvent = {
  event:   string;
  payload: {
    payment?: { entity: RazorpayWebhookPayment };
    subscription?: { entity: { id: string; status: string; notes?: Record<string, string> } };
  };
};

export async function POST(req: NextRequest) {
  // ── Signature verification ─────────────────────────────────────────────────
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[webhook] RAZORPAY_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const body      = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";

  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(body)
    .digest("hex");

  // [SECURITY] Length-guard before timingSafeEqual — that API throws on
  // mismatched lengths, which would otherwise surface as a 500 (and reveal
  // that the signature was the wrong shape).
  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected,  "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn("[webhook] Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // ── Parse event ────────────────────────────────────────────────────────────
  let event: RazorpayWebhookEvent;
  try {
    event = JSON.parse(body) as RazorpayWebhookEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── Handle events ──────────────────────────────────────────────────────────
  switch (event.event) {
    case "payment.captured": {
      const payment = event.payload.payment?.entity;
      if (!payment) break;

      const userId = payment.notes?.userId;
      if (!userId) {
        console.warn("[webhook] payment.captured: no userId in notes");
        break;
      }

      // Log payment record.
      await supabase.from("payments").insert({
        user_id:    userId,
        gateway:    "razorpay",
        payment_id: payment.id,
        order_id:   payment.order_id,
        amount:     payment.amount,
        currency:   payment.currency,
        plan:       payment.notes?.plan ?? "pro",
        status:     "captured",
      });

      // Activate Pro.
      await supabase.from("users").upsert({
        id:              userId,
        is_pro:          true,
        plan:            payment.notes?.plan ?? "pro",
        pro_since:       new Date().toISOString(),
        gateway:         "razorpay",
        payment_id:      payment.id,
        subscription_id: payment.subscription_id ?? null,
      }, { onConflict: "id" });

      console.log(`[webhook] Pro activated for user ${userId}`);
      break;
    }

    case "payment.failed": {
      const payment = event.payload.payment?.entity;
      if (!payment) break;

      const userId = payment.notes?.userId;
      if (userId) {
        await supabase.from("payments").insert({
          user_id:    userId,
          gateway:    "razorpay",
          payment_id: payment.id,
          order_id:   payment.order_id,
          amount:     payment.amount,
          currency:   payment.currency,
          plan:       payment.notes?.plan ?? "pro",
          status:     "failed",
        });
      }
      console.warn(`[webhook] Payment failed: ${payment.id}`);
      break;
    }

    case "subscription.activated": {
      const sub    = event.payload.subscription?.entity;
      const userId = sub?.notes?.userId;
      if (!userId || !sub) break;

      await supabase.from("users").upsert({
        id:              userId,
        is_pro:          true,
        plan:            "pro",
        pro_since:       new Date().toISOString(),
        gateway:         "razorpay",
        subscription_id: sub.id,
      }, { onConflict: "id" });

      console.log(`[webhook] Subscription activated for user ${userId}`);
      break;
    }

    case "subscription.cancelled": {
      const sub    = event.payload.subscription?.entity;
      const userId = sub?.notes?.userId;
      if (!userId) break;

      await supabase.from("users").update({
        is_pro: false,
        plan:   "free",
      }).eq("id", userId);

      console.log(`[webhook] Subscription cancelled, downgraded user ${userId}`);
      break;
    }

    default:
      console.log(`[webhook] Unhandled event: ${event.event}`);
  }

  return NextResponse.json({ received: true });
}
