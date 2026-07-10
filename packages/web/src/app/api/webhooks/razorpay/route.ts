import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, SENDERS } from "@/lib/mailer";
import { checkRateLimit } from "@/lib/rate-limiter";
import { proActivatedEmail, proCancelledEmail, paymentFailedEmail, subscriptionRenewedEmail } from "@/lib/emails/templates";

export const runtime = "nodejs";
// [CM-RZP-FIX] force-dynamic prevents Next.js from caching/transforming the
// request body, which would corrupt the raw bytes used for HMAC verification.
export const dynamic = "force-dynamic";

interface RazorpayWebhookEvent {
  id: string;
  event: string;
  payload: {
    subscription?: {
      entity: {
        id: string;
        plan_id: string;
        current_start?: number;
        current_end?: number;
        notes?: {
          userId?: string;
        };
      };
    };
    payment?: {
      entity: {
        id: string;
        subscription_id?: string;
        email?: string;
      };
    };
  };
}

async function getUserEmail(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const admin = createAdminClient();
    const { data } = await admin.auth.admin.getUserById(userId);
    return data?.user?.email ?? null;
  } catch (err) {
    console.error("[CM:webhook:razorpay] getUserEmail failed for user:", userId, err);
    return null;
  }
}

export async function POST(req: NextRequest) {
  // [SECURITY] Rate limit: 30/min per IP — prevents webhook flooding with invalid signatures.
  const rl = await checkRateLimit(req, undefined, 30);
  if (!rl.ok) return rl.response;

  const body = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";

  if (!secret) {
    if (process.env.NODE_ENV !== "development") {
      return NextResponse.json({ error: "Misconfigured" }, { status: 503 });
    }
    console.warn("[CM:webhook:razorpay] RAZORPAY_WEBHOOK_SECRET not set — skipping verify (local dev only)");
  }

  if (secret) {
    const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const sigBuf = Buffer.from(signature, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.error("[CM:webhook:razorpay] Invalid signature", {
        receivedSigLen: signature.length,
        expectedSigLen: expected.length,
        bodyLen: body.length,
        secretLen: secret.length,
        hasHeader: Boolean(signature),
      });
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
  }

  let event: RazorpayWebhookEvent;
  try { event = JSON.parse(body); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!event || typeof event !== "object") {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  }

  const admin = createAdminClient();
  const eventId: string = event.id ?? crypto.randomUUID();

  // Idempotency check
  const { data: existing } = await admin.from("payment_events")
    .select("id").eq("razorpay_event_id", eventId).maybeSingle();
  if (existing) {
    return NextResponse.json({ status: "already_processed" });
  }

  const subEntity = event?.payload?.subscription?.entity;
  const paymentEntity = event?.payload?.payment?.entity;
  const subId: string = subEntity?.id ?? paymentEntity?.subscription_id ?? "";

  try {
    switch (event.event) {
      case "subscription.activated":
      case "subscription.charged": {
        if (!subEntity) break;
        const isRenewal = event.event === "subscription.charged";
        const planId = subEntity.plan_id ?? "";
        const interval = planId === process.env.RAZORPAY_PRO_ANNUAL_PLAN_ID ||
                     planId === process.env.RAZORPAY_PRO_ANNUAL_REGULAR_PLAN_ID
          ? "annual" : "monthly";   // [CM-RZP-FIX] plan='pro' always; interval stores billing period
        const currentStart = subEntity.current_start ? new Date(subEntity.current_start * 1000).toISOString() : null;
        const currentEnd = subEntity.current_end ? new Date(subEntity.current_end * 1000).toISOString() : null;

        const { data: sub } = await admin.from("subscriptions")
          .select("user_id").eq("razorpay_subscription_id", subId).maybeSingle();
        const userId = sub?.user_id ?? subEntity.notes?.userId ?? null;

        if (userId) {
          await admin.from("subscriptions").upsert({
            razorpay_subscription_id: subId,
            user_id: userId,
            razorpay_plan_id: planId,
            plan: "pro",              // [CM-RZP-FIX] plan='pro' always; interval stores billing period
            interval,
            status: "active",
            current_start: currentStart,
            current_end: currentEnd,
            current_period_start: currentStart,
            current_period_end: currentEnd,
            updated_at: new Date().toISOString(),
          }, { onConflict: "razorpay_subscription_id" });

          await admin.from("users").update({
            is_pro: true, plan: "pro", subscription_status: "active", razorpay_subscription_id: subId,
          }).eq("id", userId);

          const email = await getUserEmail(userId);
          if (email) {
            const tpl = isRenewal
              ? subscriptionRenewedEmail(email, "razorpay")
              : proActivatedEmail(email, "razorpay");
            await sendEmail({ ...tpl, to: email, from: SENDERS.support });
          }
        }
        break;
      }

      case "subscription.cancelled":
      case "subscription.completed":
      case "subscription.expired": {
        const { data: sub } = await admin.from("subscriptions")
          .select("user_id, current_end, current_period_end")
          .eq("razorpay_subscription_id", subId).maybeSingle();

        const isCancelled = event.event === "subscription.cancelled";
        const subEnd = sub?.current_period_end ?? sub?.current_end;
        const stillWithinPeriod = isCancelled && subEnd
          ? new Date(subEnd).getTime() > Date.now()
          : false;

        await admin.from("subscriptions").upsert({
          razorpay_subscription_id: subId,
          plan: stillWithinPeriod ? "pro" : "free",
          status: isCancelled ? "cancelled" : "completed",
          ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "razorpay_subscription_id" });

        if (sub?.user_id) {
          if (stillWithinPeriod) {
            // Cancel at cycle end — keep Pro until current_period_end passes
            await admin.from("users").update({
              subscription_status: "cancelled",
            }).eq("id", sub.user_id);
          } else {
            // Subscription completed/expired — revoke Pro
            await admin.from("users").update({
              is_pro: false, plan: "free", subscription_status: "cancelled",
            }).eq("id", sub.user_id);

            const email = await getUserEmail(sub.user_id);
            if (email) {
              const tpl = proCancelledEmail(email);
              await sendEmail({ ...tpl, to: email, from: SENDERS.support });
            }
          }
        }
        break;
      }

      case "payment.failed": {
        await admin.from("subscriptions").upsert({
          razorpay_subscription_id: subId,
          status: "paused",
          updated_at: new Date().toISOString(),
        }, { onConflict: "razorpay_subscription_id" });

        const { data: sub } = await admin.from("subscriptions")
          .select("user_id").eq("razorpay_subscription_id", subId).maybeSingle();
        if (sub?.user_id) {
          const email = paymentEntity?.email ?? await getUserEmail(sub.user_id);
          if (email) {
            const tpl = paymentFailedEmail(email);
            await sendEmail({ ...tpl, to: email, from: SENDERS.support });
          }
        }
        break;
      }

      case "refund.created":
      case "refund.processed":
      case "payment.refunded": {
        // [CM-RZP-FIX] Revoke Pro access on confirmed refund and mark any
        // pending refund_requests as approved.
        const refundSubId = subId;
        const { data: sub } = refundSubId
          ? await admin.from("subscriptions")
              .select("user_id").eq("razorpay_subscription_id", refundSubId).maybeSingle()
          : { data: null };

        let userId = sub?.user_id ?? null;

        // Fall back to resolving the user via the payment id when the refund
        // event has no subscription_id.
        if (!userId && paymentEntity?.id) {
          const { data: pe } = await admin.from("payment_events")
            .select("razorpay_subscription_id")
            .eq("razorpay_payment_id", paymentEntity.id)
            .not("razorpay_subscription_id", "is", null)
            .maybeSingle();
          if (pe?.razorpay_subscription_id) {
            const { data: s2 } = await admin.from("subscriptions")
              .select("user_id").eq("razorpay_subscription_id", pe.razorpay_subscription_id).maybeSingle();
            userId = s2?.user_id ?? null;
          }
        }

        if (refundSubId) {
          await admin.from("subscriptions").upsert({
            razorpay_subscription_id: refundSubId,
            plan: "free",
            status: "cancelled",
            ended_at: new Date().toISOString(),
            current_period_end: null,
            current_end: null,
            updated_at: new Date().toISOString(),
          }, { onConflict: "razorpay_subscription_id" });
        }

        if (userId) {
          await admin.from("users").update({
            is_pro: false, plan: "free", subscription_status: "cancelled",
          }).eq("id", userId);

          await admin.from("refund_requests")
            .update({ status: "approved", payment_id: paymentEntity?.id ?? null })
            .eq("user_id", userId).eq("status", "pending");
        }
        break;
      }
    }
  } catch (err) {
    console.error("[CM:webhook:razorpay] handler error:", err);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }

  // Log event AFTER successful processing so that on failure (500 returned
  // above), Razorpay retries hit a clean idempotency check and re-process.
  await admin.from("payment_events").insert({
    razorpay_event_id: eventId,
    event_type: event.event,
    razorpay_subscription_id: subId || null,
    razorpay_payment_id: paymentEntity?.id ?? null,
    payload: event,
  });

  return NextResponse.json({ received: true });
}
