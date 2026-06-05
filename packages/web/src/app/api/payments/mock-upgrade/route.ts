/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

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
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json(
      { error: "Not available outside local development" },
      { status: 403 }
    );
  }

  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const plan: Plan = "pro";

  const now      = new Date();
  const monthEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  try {
    await upsertSubscription(user.id, {
      plan,
      status:                "active",
      gateway:               "mock",
      gatewaySubscriptionId: "sub_mock_" + Date.now(),
      currency:              "usd",
      amount:                500,
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
    console.error("[CM:api:mock-upgrade] error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
