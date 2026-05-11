// packages/web/src/lib/payments/geo-pricing.ts
// Detects user region and returns localised pricing config.
// Result is cached in sessionStorage so ipapi.co is called at most once per tab session.

const SOUTH_ASIA = ["IN", "PK", "BD", "NP", "LK", "MM", "BT"] as const;
type SouthAsiaCode = (typeof SOUTH_ASIA)[number];

const CACHE_KEY = "cf_geo_region";

export type PricingRegion = "india" | "global";

export interface PricingPlan {
  region:   PricingRegion;
  currency: "INR" | "USD";
  gateway:  "razorpay" | "stripe";
  pro: {
    monthly:      number;
    annual:       number;
    display:      string;
    annualDisplay: string;
    annualSavings: string;
  };
  team: {
    monthly:      number;
    annual:       number;
    display:      string;
    annualDisplay: string;
  };
}

export const INDIA_PRICING: PricingPlan = {
  region:   "india",
  currency: "INR",
  gateway:  "razorpay",
  pro: {
    monthly:       199,
    annual:        1499,
    display:       "₹199",
    annualDisplay: "₹1,499",
    annualSavings: "Save ₹889/year",
  },
  team: {
    monthly:       999,
    annual:        9990,
    display:       "₹999/user",
    annualDisplay: "₹9,990/user",
  },
};

export const GLOBAL_PRICING: PricingPlan = {
  region:   "global",
  currency: "USD",
  gateway:  "stripe",
  pro: {
    monthly:       5,
    annual:        39,
    display:       "$5",
    annualDisplay: "$39",
    annualSavings: "Save $21/year",
  },
  team: {
    monthly:       15,
    annual:        144,
    display:       "$15/user",
    annualDisplay: "$144/user",
  },
};

export async function detectPricing(): Promise<PricingPlan> {
  // Return cached result if available (avoids redundant network calls).
  if (typeof window !== "undefined") {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached === "india")  return INDIA_PRICING;
    if (cached === "global") return GLOBAL_PRICING;
  }

  try {
    const res = await fetch("https://ipapi.co/json/", {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error("geo fetch failed");

    const data = (await res.json()) as { country_code?: string };
    const isSOuthAsia = SOUTH_ASIA.includes(
      data.country_code as SouthAsiaCode
    );
    const region: PricingRegion = isSOuthAsia ? "india" : "global";

    if (typeof window !== "undefined") {
      sessionStorage.setItem(CACHE_KEY, region);
    }

    return region === "india" ? INDIA_PRICING : GLOBAL_PRICING;
  } catch {
    // Geo detection failed — default to India pricing for the primary market.
    return INDIA_PRICING;
  }
}
