// packages/web/src/app/api/webhooks/razorpay/route.ts
// Razorpay webhook handler — updates subscription on payment events.
// Always returns 200 (even on internal errors) to prevent gateway retry storms,
// EXCEPT when signature verification fails (security boundary).

import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { upsertSubscription, logPaymentEvent, isDuplicateEvent } from "@/lib/payments/subscription";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, SENDERS } from "@/lib/mailer";
import {
  proActivatedEmail,
  proCancelledEmail,
  paymentFailedEmail,
} from "@/lib/emails/templates";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.text();

  // ── Mock mode ─────────────────────────────────────────────────────────────
  if (
    !process.env.RAZORPAY_KEY_ID ||
    process.env.RAZORPAY_KEY_ID === "rzp_test_placeholder"
  ) {
    console.log("[CM:webhook:razorpay] Not configured — ignoring");
    return NextResponse.json({ received: true, mock: true });
  }

  // ── Signature verification ────────────────────────────────────────────────
  // [SECURITY] Use a dedicated webhook secret (NOT the API key secret —
  // Razorpay configures these separately in the dashboard).
  // [SECURITY] Constant-time compare to prevent signature-timing oracle.
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const secret    = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";

  if (!secret) {
    console.error("[CM:webhook:razorpay] RAZORPAY_WEBHOOK_SECRET not configured");
    // Return 200 so Razorpay does not retry; ops will alert on logs.
    return NextResponse.json({ received: true, error: "Misconfigured" });
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected,  "utf8");
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    console.error("[CM:webhook:razorpay] Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subEntity     = event?.payload?.subscription?.entity;
  const paymentEntity = event?.payload?.payment?.entity;
  const userId =
    subEntity?.notes?.userId ??
    paymentEntity?.notes?.userId ??
    null;
  const eventId = paymentEntity?.id ?? subEntity?.id ?? event?.event ?? "razorpay-unknown";

  // [SECURITY] Idempotency — Razorpay retries failed webhooks up to 24h.
  // Short-circuit if this (gateway,event_id) tuple was already processed.
  if (await isDuplicateEvent("razorpay", eventId)) {
    console.log("[CM:webhook:razorpay] Duplicate event ignored:", eventId);
    return NextResponse.json({ received: true, duplicate: true });
  }

  // Audit log first
  try {
    await logPaymentEvent(userId, "razorpay", event.event, eventId, event.payload);
  } catch (err) {
    console.error("[CM:webhook:razorpay] logPaymentEvent failed:", err);
  }

  try {
    switch (event.event) {
      case "subscription.activated":
      case "subscription.charged":
      case "subscription.updated": {
        if (!userId || !subEntity) break;
        const planType = (subEntity.notes?.plan as "pro" | "team") ?? "pro";
        const amount   = planType === "team" ? 99_900 : 19_900;
        await upsertSubscription(userId, {
          plan:                  planType,
          status:                "active",
          gateway:               "razorpay",
          gatewayCustomerId:     subEntity.customer_id,
          gatewaySubscriptionId: subEntity.id,
          currency:              "inr",
          amount,
          currentPeriodStart:    subEntity.current_start
            ? new Date(subEntity.current_start * 1000)
            : undefined,
          currentPeriodEnd:      subEntity.current_end
            ? new Date(subEntity.current_end * 1000)
            : undefined,
        });
        console.log("[CM:webhook:razorpay] Activated:", userId);
        // Send pro-activated email
        const activatedEmail = await getUserEmail(userId);
        if (activatedEmail) {
          const tpl = proActivatedEmail(activatedEmail, "razorpay");
          await sendEmail({ ...tpl, to: activatedEmail, from: SENDERS.support });
        }
        break;
      }

      case "subscription.cancelled":
      case "subscription.completed": {
        if (!userId || !subEntity) break;
        const planType = (subEntity.notes?.plan as "pro" | "team") ?? "pro";
        await upsertSubscription(userId, {
          plan:                  planType,
          status:                "cancelled",
          gateway:               "razorpay",
          gatewayCustomerId:     subEntity.customer_id,
          gatewaySubscriptionId: subEntity.id,
          cancelledAt:           new Date(),
        });
        console.log("[CM:webhook:razorpay] Cancelled:", userId);
        const cancelledEmail = await getUserEmail(userId);
        if (cancelledEmail) {
          const tpl = proCancelledEmail(cancelledEmail);
          await sendEmail({ ...tpl, to: cancelledEmail, from: SENDERS.support });
        }
        break;
      }

      case "subscription.halted": {
        if (!userId || !subEntity) break;
        const planType = (subEntity.notes?.plan as "pro" | "team") ?? "pro";
        await upsertSubscription(userId, {
          plan:                  planType,
          status:                "halted",
          gateway:               "razorpay",
          gatewayCustomerId:     subEntity.customer_id,
          gatewaySubscriptionId: subEntity.id,
        });
        console.log("[CM:webhook:razorpay] Halted:", userId);
        break;
      }

      case "subscription.payment.failed":
      case "payment.failed": {
        if (!userId || !subEntity) break;
        const planType = (subEntity.notes?.plan as "pro" | "team") ?? "pro";
        await upsertSubscription(userId, {
          plan:                  planType,
          status:                "past_due",
          gateway:               "razorpay",
          gatewayCustomerId:     subEntity.customer_id,
          gatewaySubscriptionId: subEntity.id,
        });
        console.log("[CM:webhook:razorpay] Payment failed:", userId);
        const failEmail = paymentEntity?.email ?? await getUserEmail(userId);
        if (failEmail) {
          const tpl = paymentFailedEmail(failEmail);
          await sendEmail({ ...tpl, to: failEmail, from: SENDERS.support });
        }
        break;
      }
    }
  } catch (err) {
    console.error("[CM:webhook:razorpay] handler error:", err);
  }

  return NextResponse.json({ received: true });
}

// ── Helper: fetch user email from Supabase auth ───────────────────────────────
async function getUserEmail(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const admin = createAdminClient();
    const { data } = await admin.auth.admin.getUserById(userId);
    return data?.user?.email ?? null;
  } catch {
    return null;
  }
}
