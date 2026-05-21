/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/lib/payments/types.ts
// Shared types for the v2 payment infrastructure.
// Used by API routes, hooks, and the pricing page.

export type Plan = "free" | "pro";
export type Gateway = "razorpay";
export type Currency = "usd" | "inr";
export type SubscriptionStatus =
  | "active"
  | "cancelled"
  | "past_due"
  | "halted"
  | "trialing";

export interface PricingConfig {
  gateway:  Gateway;
  currency: Currency;
  symbol:   string;
  pro: {
    amount:   number;           // in smallest unit (cents / paise)
    display:  string;           // '₹299' or '$5'
    planId:   string;           // gateway plan/price ID
    interval: "month";
  };
}

export interface Subscription {
  plan:               Plan;
  status:             SubscriptionStatus;
  gateway:            Gateway | null;
  currentPeriodEnd:   Date | null;
  cancelledAt:        Date | null;
  trialEnd:           Date | null;
}

export interface UsageData {
  month:                  string;
  simpleMigrations:       number;
  smartMigrations:        number;
  attentionMigrations:    number;
  sessionsCount:          number;
}

export interface UsageLimits {
  simpleMigrations:    number | "unlimited";
  smartMigrations:     number | "unlimited";
  attentionMigrations: number | "unlimited";
  sessionsStored:      number | "unlimited";
  promptTemplates:     number | "unlimited";
}

export const FREE_LIMITS: UsageLimits = {
  simpleMigrations:    8,
  smartMigrations:     5,
  attentionMigrations: 3,
  sessionsStored:      10,
  promptTemplates:     6,
};

export const PRO_LIMITS: UsageLimits = {
  simpleMigrations:    "unlimited",
  smartMigrations:     "unlimited",
  attentionMigrations: "unlimited",
  sessionsStored:      "unlimited",
  promptTemplates:     "unlimited",
};

// Countries routed to Razorpay (INR pricing).
export const SOUTH_ASIA_COUNTRIES = [
  "IN", "PK", "BD", "NP", "LK", "MM", "BT", "AF",
];
