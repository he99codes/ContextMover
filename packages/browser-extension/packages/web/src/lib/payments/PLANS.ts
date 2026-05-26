/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/lib/payments/PLANS.ts
// Single source of truth for all plan definitions.
// Every other file imports from here — no hardcoded prices or plan IDs elsewhere.

export type PlanId = "free" | "pro_monthly" | "pro_annual";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  type: "free" | "subscription";
  price: number; // in smallest currency unit (paise for INR, cents for USD)
  displayPrice: string;
  billingPeriod: "forever" | "monthly" | "annual";
  razorpayPlanIdEnv: string | null; // env var name, null for free
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    type: "free",
    price: 0,
    displayPrice: "₹0",
    billingPeriod: "forever",
    razorpayPlanIdEnv: null,
  },
  pro_monthly: {
    id: "pro_monthly",
    name: "Pro Monthly",
    type: "subscription",
    price: 29_900, // ₹299 in paise
    displayPrice: "₹299",
    billingPeriod: "monthly",
    razorpayPlanIdEnv: "RAZORPAY_PRO_MONTHLY_PLAN_ID",
  },
  pro_annual: {
    id: "pro_annual",
    name: "Pro Annual",
    type: "subscription",
    price: 239_900, // ₹2,399 in paise
    displayPrice: "₹2,399",
    billingPeriod: "annual",
    razorpayPlanIdEnv: "RAZORPAY_PRO_ANNUAL_PLAN_ID",
  },
};

// Convenience: all paid plan IDs (for subscription checks).
export const PAID_PLAN_IDS: PlanId[] = ["pro_monthly", "pro_annual"];

// Convenience: resolve a Razorpay plan ID from env at runtime.
export function getRazorpayPlanId(planId: PlanId): string | undefined {
  const envVar = PLANS[planId].razorpayPlanIdEnv;
  if (!envVar) return undefined;
  return process.env[envVar];
}
