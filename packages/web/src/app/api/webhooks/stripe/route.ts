// packages/web/src/app/api/webhooks/stripe/route.ts
// Stripe webhook handler — updates subscription on payment events.
// Always returns 200 (even on errors) to prevent gateway retry storms,
// EXCEPT when signature verification fails (security boundary).

import { NextRequest, NextResponse } from "next/server";
import { upsertSubscription, logPaymentEvent, isDuplicateEvent } from "@/lib/payments/subscription";

// Required: opt out of body parsing so we can verify the raw signature.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body      = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";

  // ── Mock mode: not configured → 200 OK, no side effects ──────────────────
  if (
    !process.env.STRIPE_SECRET_KEY ||
    process.env.STRIPE_SECRET_KEY === "sk_test_placeholder"
  ) {
    console.log("[CM:webhook:stripe] Not configured — ignoring");
    return NextResponse.json({ received: true, mock: true });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let event: any;
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET ?? ""
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CM:webhook:stripe] Signature failed:", msg);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const dataObject = event.data?.object ?? {};
  // Stripe places our `userId` in `metadata` on both Sessions and Subscriptions
  // (we set it via `metadata` and `subscription_data.metadata` at create time;
  // both resolve to `metadata` on the response object).
  const userId = dataObject?.metadata?.userId ?? null;

  // [SECURITY] Idempotency — short-circuit if this event id was already
  // processed (Stripe retries on any non-2xx for up to 3 days).
  if (event.id && await isDuplicateEvent("stripe", event.id)) {
    console.log("[CM:webhook:stripe] Duplicate event ignored:", event.id);
    return NextResponse.json({ received: true, duplicate: true });
  }

  // Audit-log every event before mutating subscription state.
  try {
    await logPaymentEvent(userId, "stripe", event.type, event.id, dataObject);
  } catch (err) {
    console.error("[CM:webhook:stripe] logPaymentEvent failed:", err);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        if (!userId) break;
        const sub = dataObject;
        await upsertSubscription(userId, {
          plan:                  (sub.metadata?.plan as "pro" | "team") ?? "pro",
          status:                sub.status ?? "active",
          gateway:               "stripe",
          gatewayCustomerId:     sub.customer,
          gatewaySubscriptionId: sub.id,
          currency:              "usd",
          amount:                sub.items?.data?.[0]?.price?.unit_amount ?? 500,
          currentPeriodStart:    sub.current_period_start
            ? new Date(sub.current_period_start * 1000)
            : undefined,
          currentPeriodEnd:      sub.current_period_end
            ? new Date(sub.current_period_end * 1000)
            : undefined,
          trialEnd:              sub.trial_end ? new Date(sub.trial_end * 1000) : null,
        });
        console.log("[CM:webhook:stripe] Subscription updated:", userId);
        break;
      }

      case "customer.subscription.deleted": {
        if (!userId) break;
        const sub = dataObject;
        await upsertSubscription(userId, {
          plan:                  "free",
          status:                "cancelled",
          gateway:               "stripe",
          gatewayCustomerId:     sub.customer,
          gatewaySubscriptionId: sub.id,
          cancelledAt:           new Date(),
        });
        console.log("[CM:webhook:stripe] Cancelled:", userId);
        break;
      }

      case "invoice.payment_failed": {
        if (!userId) break;
        const invoice = dataObject;
        await upsertSubscription(userId, {
          plan:                  "pro",
          status:                "past_due",
          gateway:               "stripe",
          gatewayCustomerId:     invoice.customer,
          gatewaySubscriptionId: invoice.subscription,
        });
        console.log("[CM:webhook:stripe] Payment failed:", userId);
        break;
      }
    }
  } catch (err) {
    // Swallow processing errors to prevent retry storms (audit log already wrote).
    console.error("[CM:webhook:stripe] handler error:", err);
  }

  return NextResponse.json({ received: true });
}
