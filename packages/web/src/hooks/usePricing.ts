"use client";
// packages/web/src/hooks/usePricing.ts
// Fetches geo-detected pricing from /api/payments/pricing.

import { useEffect, useState } from "react";

// Shape returned by the /api/payments/pricing route — a subset of the full
// PricingConfig (no planId secrets exposed to the client).
export interface PublicPricing {
  gateway:  "stripe" | "razorpay";
  currency: "usd" | "inr";
  symbol:   string;
  pro:  { display: string; amount: number; interval: "month" };
  team: { display: string; amount: number; interval: "month" };
}

export function usePricing(): { pricing: PublicPricing | null; loading: boolean } {
  const [pricing, setPricing] = useState<PublicPricing | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/payments/pricing")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setPricing(data ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { pricing, loading };
}
