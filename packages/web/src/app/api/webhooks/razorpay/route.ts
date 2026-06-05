import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, SENDERS } from "@/lib/mailer";
import { proActivatedEmail, proCancelledEmail, paymentFailedEmail } from "@/lib/emails/templates";

export const runtime = "nodejs";

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
  } catch { return null; }
}

export async function POST(req: NextRequest) {
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
      console.error("[CM:webhook:razorpay] Invalid signature");
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

  // Log event
  await admin.from("payment_events").insert({
    razorpay_event_id: eventId,
    event_type: event.event,
    razorpay_subscription_id: subId || null,
    razorpay_payment_id: paymentEntity?.id ?? null,
    payload: event,
  });

  try {
    switch (event.event) {
      case "subscription.activated":
      case "subscription.charged": {
        if (!subEntity) break;
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
            updated_at: new Date().toISOString(),
          }, { onConflict: "razorpay_subscription_id" });

          await admin.from("users").update({
            is_pro: true, plan: "pro", subscription_status: "active", razorpay_subscription_id: subId,
          }).eq("id", userId);

          const email = await getUserEmail(userId);
          if (email) {
            const tpl = proActivatedEmail(email, "razorpay");
            await sendEmail({ ...tpl, to: email, from: SENDERS.support });
          }
        }
        break;
      }

      case "subscription.cancelled":
      case "subscription.completed":
      case "subscription.expired": {
        const { data: sub } = await admin.from("subscriptions")
          .select("user_id").eq("razorpay_subscription_id", subId).maybeSingle();

        await admin.from("subscriptions").upsert({
          razorpay_subscription_id: subId,
          status: event.event === "subscription.cancelled" ? "cancelled" : "completed",
          ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "razorpay_subscription_id" });

        if (sub?.user_id) {
          await admin.from("users").update({
            is_pro: false, plan: "free", subscription_status: "cancelled",
          }).eq("id", sub.user_id);

          const email = await getUserEmail(sub.user_id);
          if (email) {
            const tpl = proCancelledEmail(email);
            await sendEmail({ ...tpl, to: email, from: SENDERS.support });
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
    }
  } catch (err) {
    console.error("[CM:webhook:razorpay] handler error:", err);
  }

  return NextResponse.json({ received: true });
}
