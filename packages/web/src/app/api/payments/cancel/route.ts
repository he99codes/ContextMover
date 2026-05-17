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

  // Look up the gateway subscription id from the raw row (the typed
  // Subscription value doesn't expose it).
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { data: row } = await admin
    .from("subscriptions")
    .select("gateway, gateway_subscription_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const gateway: string = row?.gateway ?? subscription.gateway ?? "mock";
  const gatewaySubscriptionId: string | null = row?.gateway_subscription_id ?? null;

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
        key_secret: process.env.RAZORPAY_KEY_SECRET!,
      });
      await razorpay.subscriptions.cancel(gatewaySubscriptionId, {
        cancel_at_cycle_end: 1,
      });
      remoteResult = "razorpay";
    } catch (err) {
      console.error("[CM:api:cancel:razorpay] error:", err);
    }
  }

  if (remoteResult === "skipped") {
    console.log("[CM:payments] MOCK MODE — cancellation local only");
    remoteResult = "mock";
  }

  // ── Local DB update ───────────────────────────────────────────────────────
  await upsertSubscription(user.id, {
    plan:    "free",
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
    { source: "user", remoteResult }
  );

  return NextResponse.json({
    cancelled: true,
    mock:      remoteResult === "mock",
    gateway,
  });
}
