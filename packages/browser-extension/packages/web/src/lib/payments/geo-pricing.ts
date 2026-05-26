/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/lib/payments/geo-pricing.ts
// Unified pricing — same plans for all users worldwide.
// No geo-detection. One price. One gateway (Razorpay, INR).

export interface PricingPlan {
  currency: "INR";
  gateway:  "razorpay";
  pro: {
    monthly:       number;
    annual:        number;
    display:       string;
    annualDisplay: string;
    annualSavings: string;
  };
}

export const UNIFIED_PRICING: PricingPlan = {
  currency: "INR",
  gateway:  "razorpay",
  pro: {
    monthly:       299,
    annual:        2399,
    display:       "₹299",
    annualDisplay: "₹2,399",
    annualSavings: "Save ₹1,189/year",
  },
};

export function getPricing(): PricingPlan {
  return UNIFIED_PRICING;
}
