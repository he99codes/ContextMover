// packages/web/src/app/api/payments/mock-upgrade/route.ts
// DEV-ONLY endpoint that flips the authenticated user to Pro immediately,
// no real gateway call. Lets you exercise the entire payment flow end-to-end
// without configuring Stripe or Razorpay.
//
// Hard-disabled in production via NODE_ENV check.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/payments/auth";
import { upsertSubscription } from "@/lib/payments/subscription";
import type { Plan } from "@/lib/payments/types";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Not available in production" },
      { status: 403 }
    );
  }

  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const plan: Plan = body?.plan === "team" ? "team" : "pro";

  const now      = new Date();
  const monthEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  try {
    await upsertSubscription(user.id, {
      plan,
      status:                "active",
      gateway:               "mock",
      gatewaySubscriptionId: "sub_mock_" + Date.now(),
      currency:              "usd",
      amount:                plan === "team" ? 2_500 : 500,
      currentPeriodStart:    now,
      currentPeriodEnd:      monthEnd,
    });

    console.log(`[CM:payments] MOCK upgrade applied for ${user.id} → ${plan}`);

    return NextResponse.json({
      success: true,
      mock:    true,
      plan,
      message: `Mock ${plan} subscription activated`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CM:api:mock-upgrade] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
