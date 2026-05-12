// packages/web/src/app/api/payments/subscription/route.ts
// GET: returns current user subscription + usage.
// POST: creates a checkout session (Stripe) or Razorpay subscription.

import { NextRequest, NextResponse } from "next/server";
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
      : subscription.plan === "pro"  ? PRO_LIMITS
      : subscription.plan === "team" ? PRO_LIMITS
      : FREE_LIMITS;

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
  const plan = body?.plan === "team" ? "team" : "pro"; // default to pro

  const pricing = await getPricingConfig(req);

  if (pricing.gateway === "stripe") {
    return createStripeCheckout(user.id, user.email ?? "", plan, pricing);
  }
  return createRazorpaySubscription(user.id, plan, pricing);
}

// ── Stripe checkout (mock-aware) ────────────────────────────────────────────
async function createStripeCheckout(
  userId:  string,
  email:   string,
  plan:    "pro" | "team",
  pricing: PricingConfig
) {
  const planConfig = plan === "team" ? pricing.team : pricing.pro;

  // Mock mode — return a deterministic mock response so the client UI flow is
  // indistinguishable from a real checkout (just no actual redirect).
  if (
    !process.env.STRIPE_SECRET_KEY ||
    process.env.STRIPE_SECRET_KEY === "sk_test_placeholder"
  ) {
    console.log("[CM:payments] MOCK MODE — no real charge");
    return NextResponse.json({
      mock:            true,
      gateway:         "stripe",
      message:         "Stripe not configured yet — mock checkout.",
      wouldRedirectTo: "https://checkout.stripe.com/c/mock",
      plan,
      amount:          planConfig.display,
      trialDays:       14,
    });
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const priceId =
      plan === "team"
        ? process.env.STRIPE_TEAM_PRICE_ID!
        : process.env.STRIPE_PRO_PRICE_ID!;

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      mode:                 "subscription",
      payment_method_types: ["card"],
      customer_email:       email || undefined,
      line_items:           [{ price: priceId, quantity: 1 }],
      metadata:             { userId, plan },
      // 14-day trial — billed only on day 15.
      subscription_data:    {
        trial_period_days: 14,
        metadata:          { userId, plan },
      },
      success_url:          `${appUrl}/settings?payment=success`,
      cancel_url:           `${appUrl}/pricing?payment=cancelled`,
    });

    return NextResponse.json({ url: session.url, gateway: "stripe" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CM:api:subscription:stripe] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── Razorpay subscription (mock-aware) ──────────────────────────────────────
async function createRazorpaySubscription(
  userId:  string,
  plan:    "pro" | "team",
  pricing: PricingConfig
) {
  const planConfig = plan === "team" ? pricing.team : pricing.pro;

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
      trialDays:      14,
    });
  }

  // One-time amounts in paise (used when no subscription plan is configured).
  const ORDER_AMOUNTS: Record<string, number> = { pro: 19900, team: 99900 };

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

    const planId =
      plan === "team"
        ? process.env.RAZORPAY_TEAM_PLAN_ID
        : process.env.RAZORPAY_PRO_PLAN_ID;

    // ── Fallback: no subscription plan configured → Standard Checkout (one-time order)
    // Create a subscription plan in the Razorpay dashboard and set
    // RAZORPAY_PRO_PLAN_ID / RAZORPAY_TEAM_PLAN_ID to enable recurring billing.
    if (!planId || planId.startsWith("plan_placeholder")) {
      const order = await razorpay.orders.create({
        amount:   ORDER_AMOUNTS[plan] ?? 19900,
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
    // Razorpay has no native trial — emulate 14 days free by deferring the
    // first charge. start_at is unix seconds.
    const startAt = Math.floor((Date.now() + 14 * 24 * 60 * 60 * 1000) / 1000);

    const subscription = await razorpay.subscriptions.create({
      plan_id:         planId,
      customer_notify: 1,
      quantity:        1,
      total_count:     12,
      start_at:        startAt,
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
