/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/payments/cancel/route.ts
// Cancel an active subscription:
//   - Razorpay: subscriptions.cancel({ cancel_at_cycle_end: 1 })
//   - Mock/unconfigured gateway: skip remote call, only flip Supabase
// Always upserts Supabase to status='cancelled' so the UI reflects the change.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/payments/auth";
import { checkRateLimit } from "@/lib/rate-limiter";
import {
  getUserSubscription,
  upsertSubscription,
  logPaymentEvent,
} from "@/lib/payments/subscription";
import { createClient } from "@supabase/supabase-js";
import { sendEmail, SENDERS } from "@/lib/mailer";
import { proCancelledEmail } from "@/lib/emails/templates";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // [SECURITY] Rate limit — prevents cancel-spam against the gateway API.
  const rl = await checkRateLimit(req, user.id);
  if (!rl.ok) return rl.response;

  const subscription = await getUserSubscription(user.id);
  if (subscription.plan === "free" || subscription.status === "cancelled") {
    return NextResponse.json(
      { error: "No active subscription to cancel" },
      { status: 400 }
    );
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  // Look up the gateway subscription id from the raw row (the typed
  // Subscription value doesn't expose it).
  const admin = createClient(
    supaUrl,
    supaKey,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  // Fix 7: Order by created_at desc to get the most recent subscription
  // (avoids returning an old cancelled row when multiple exist)
  const { data: row } = await admin
    .from("subscriptions")
    .select("gateway, gateway_subscription_id, razorpay_subscription_id, current_period_end, current_end")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const gateway: string = row?.gateway ?? subscription.gateway ?? "mock";
  const gatewaySubscriptionId: string | null =
    row?.gateway_subscription_id ?? row?.razorpay_subscription_id ?? null;

  let remoteResult: "razorpay" | "mock" | "skipped" = "skipped";

  // ── Razorpay ──────────────────────────────────────────────────────────────
  if (
    gateway === "razorpay" &&
    gatewaySubscriptionId &&
    process.env.RAZORPAY_KEY_ID &&
    process.env.RAZORPAY_KEY_ID !== "rzp_test_placeholder"
  ) {
    try {
      const Razorpay = (await import("razorpay")).default as unknown as new (opts: {
        key_id:     string;
        key_secret: string;
      }) => {
        subscriptions: {
          cancel: (id: string, options: { cancel_at_cycle_end: 0 | 1 }) => Promise<unknown>;
        };
      };
      const razorpay = new Razorpay({
        key_id:     process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET ?? "",
      });
      await razorpay.subscriptions.cancel(gatewaySubscriptionId, {
        cancel_at_cycle_end: 1,
      });
      remoteResult = "razorpay";
    } catch (err) {
      console.error("[CM:api:cancel:razorpay] error:", err);
      return NextResponse.json(
        { error: "Gateway cancellation failed. Please try again or contact support." },
        { status: 502 }
      );
    }
  }

  if (remoteResult === "skipped") {
    console.log("[CM:payments] MOCK MODE — cancellation local only");
    remoteResult = "mock";
  }

  // ── Local DB update ───────────────────────────────────────────────────────
  // Keep plan='pro' so the user retains Pro features until current_period_end.
  // Only flip status to 'cancelled' — the subscription API checks this + end date.
  await upsertSubscription(user.id, {
    plan:    "pro",
    status:  "cancelled",
    gateway,
    gatewaySubscriptionId: gatewaySubscriptionId ?? undefined,
    cancelledAt: new Date(),
  });

  await logPaymentEvent(
    user.id,
    gateway,
    "subscription.cancelled",
    gatewaySubscriptionId ?? `manual-${Date.now()}`,
    { source: "user", remoteResult },
    gatewaySubscriptionId ?? null,
  );

  // ── Send cancellation email with autopay warning (LL) ───────────────
  const periodEnd = row?.current_period_end ?? row?.current_end ?? undefined;
  if (process.env.ZEPTO_SMTP_PASSWORD) {
    try {
      const { data: userData } = await admin.auth.admin.getUserById(user.id);
      const userEmail = userData?.user?.email;
      if (userEmail) {
        const tpl = proCancelledEmail(userEmail, periodEnd);
        await Promise.allSettled([
          sendEmail({ ...tpl, to: userEmail, from: SENDERS.support }),
        ]).then((results) => {
          for (const r of results) {
            if (r.status === 'rejected') console.warn("[cancel] email failed:", r.reason);
          }
        });
      }
    } catch (e) { console.warn("[cancel] getUserById failed:", e); }
  }

  return NextResponse.json({
    cancelled: true,
    mock:      remoteResult === "mock",
    gateway,
  });
}
