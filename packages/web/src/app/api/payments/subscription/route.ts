/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/payments/subscription/route.ts
// GET: returns current user subscription + usage.
// POST: creates a Razorpay checkout session.

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
import {
  getUserSubscription,
  getUserUsage,
  getCurrentMonth,
} from "@/lib/payments/subscription";
import { getPricingConfig } from "@/lib/payments/geo";
import { FREE_LIMITS, PRO_LIMITS, type PricingConfig } from "@/lib/payments/types";
import { getAuthUser } from "@/lib/payments/auth";
import { checkRateLimit } from "@/lib/rate-limiter";

// ── GET: subscription + usage + limits ──────────────────────────────────────
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // [SECURITY] Per SECURITY.md: rate limit every API route.
  const rl = await checkRateLimit(req, user.id);
  if (!rl.ok) return rl.response;

  try {
    const [subscription, usage] = await Promise.all([
      getUserSubscription(user.id),
      getUserUsage(user.id, getCurrentMonth()),
    ]);

    const isPro = subscription.plan !== "free";
    // Both pro and team get unlimited; free gets capped.
    const limits =
      subscription.plan === "free" ? FREE_LIMITS
      : PRO_LIMITS;

    return NextResponse.json({ subscription, usage, limits, isPro });
  } catch (err) {
    console.error("[CM:api:subscription:GET] error:", err);
    return NextResponse.json(
      { error: "Failed to load subscription" },
      { status: 500 }
    );
  }
}

// ── POST: create checkout session ───────────────────────────────────────────
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // [SECURITY] Rate limit checkout-session creation to deter abuse / fraud
  // (creating many checkout sessions has no per-request cost but DoS surface).
  const rl = await checkRateLimit(req, user.id);
  if (!rl.ok) return rl.response;

  const body = await req.json().catch(() => ({}));
  const plan = "pro";

  const pricing = await getPricingConfig(req);
  return createRazorpaySubscription(user.id, plan, pricing);
}

// ── Razorpay subscription (mock-aware) ──────────────────────────────────────
async function createRazorpaySubscription(
  userId:  string,
  plan:    "pro",
  pricing: PricingConfig
) {
  const planConfig = pricing.pro;

  if (
    !process.env.RAZORPAY_KEY_ID ||
    process.env.RAZORPAY_KEY_ID === "rzp_test_placeholder"
  ) {
    console.log("[CM:payments] MOCK MODE — Razorpay disabled");
    return NextResponse.json({
      mock:           true,
      gateway:        "razorpay",
      message:        "Razorpay not configured yet — mock subscription.",
      plan,
      amount:         planConfig.display,
      subscriptionId: "sub_mock_" + Date.now(),
      orderId:        "order_mock_" + Date.now(),
      currency:       "INR",
      amount_paise:   planConfig.amount,
      keyId:          process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? "rzp_test_placeholder",
    });
  }

  // One-time amounts in paise (used when no subscription plan is configured).
  const ORDER_AMOUNTS: Record<string, number> = { pro: 29900 };

  try {
    // Razorpay v2 SDK has no published types — use a runtime import + any cast.
    const Razorpay = (await import("razorpay")).default as unknown as new (opts: {
      key_id:     string;
      key_secret: string;
    }) => {
      subscriptions: {
        create: (opts: {
          plan_id:         string;
          customer_notify: 0 | 1;
          quantity:        number;
          total_count:     number;
          start_at?:       number;
          notes?:          Record<string, string>;
        }) => Promise<{ id: string }>;
      };
      orders: {
        create: (opts: {
          amount:    number;
          currency:  string;
          receipt:   string;
          notes?:    Record<string, string>;
        }) => Promise<{ id: string; amount: number; currency: string }>;
      };
    };

    const razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    });

    const planId = process.env.RAZORPAY_PRO_MONTHLY_PLAN_ID;

    // ── Fallback: no subscription plan configured → Standard Checkout (one-time order)
    // Create a subscription plan in the Razorpay dashboard and set
    // RAZORPAY_PRO_MONTHLY_PLAN_ID to enable recurring billing.
    if (!planId || planId.startsWith("plan_placeholder")) {
      const order = await razorpay.orders.create({
        amount:   ORDER_AMOUNTS[plan] ?? 29900,
        currency: "INR",
        receipt:  `cf_${plan}_${Date.now()}`,
        notes:    { userId, plan },
      });
      return NextResponse.json({
        gateway:  "razorpay",
        orderId:  order.id,
        amount:   order.amount,
        currency: order.currency,
        keyId:    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      });
    }

    // ── Subscription plan configured → recurring subscription checkout
    // Billing starts immediately — no trial period.
    const subscription = await razorpay.subscriptions.create({
      plan_id:         planId,
      customer_notify: 1,
      quantity:        1,
      total_count:     12,
      notes:           { userId, plan },
    });

    return NextResponse.json({
      gateway:        "razorpay",
      subscriptionId: subscription.id,
      keyId:          process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CM:api:subscription:razorpay] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
