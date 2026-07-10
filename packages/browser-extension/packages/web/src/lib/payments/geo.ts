/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/lib/payments/geo.ts
// Unified pricing — same plans for all users worldwide.
// All payments routed through Razorpay (INR).

import { type NextRequest } from "next/server";
import { type PricingConfig } from "./types";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getPricingConfig(_req?: NextRequest): Promise<PricingConfig> {
  return {
    gateway:  "razorpay",
    currency: "inr",
    symbol:   "₹",
    pro: {
      amount:   29_900, // ₹299 in paise
      display:  "₹299",
      planId:   process.env.RAZORPAY_PRO_MONTHLY_PLAN_ID ?? "plan_placeholder_pro_monthly",
      interval: "month",
    },
  };
}
