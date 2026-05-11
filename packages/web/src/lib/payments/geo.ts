// packages/web/src/lib/payments/geo.ts
// Geo-detection + pricing config for the v2 payment system.
// SAFE for both server (Next API routes) and client usage:
//   - On server: ipapi.co is hit each call (no localStorage). Cheap fallback.
//   - On client: 24h localStorage cache to avoid burning the ipapi.co quota.

import { type PricingConfig, SOUTH_ASIA_COUNTRIES } from "./types";

const GEO_CACHE_KEY = "cm_geo_country";
const GEO_CACHE_TTL = 86_400_000; // 24 hours

interface GeoCache {
  country:  string;
  cachedAt: number;
}

/**
 * Detect the user's ISO-3166-2 country code.
 * Client: localStorage cache (24h). Server: per-call fetch. Falls back to "US"
 * on any error so the caller still gets a valid PricingConfig.
 */
export async function detectCountry(): Promise<string> {
  // ── Client-side: try cached value first ───────────────────────────────────
  if (typeof window !== "undefined") {
    try {
      const cached = window.localStorage.getItem(GEO_CACHE_KEY);
      if (cached) {
        const { country, cachedAt }: GeoCache = JSON.parse(cached);
        if (Date.now() - cachedAt < GEO_CACHE_TTL) {
          return country;
        }
      }
    } catch {
      /* ignore corrupted cache */
    }
  }

  // ── Network fetch (ipapi.co free tier) ────────────────────────────────────
  try {
    const res = await fetch("https://ipapi.co/json/", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      const country: string = data.country_code ?? "US";

      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            GEO_CACHE_KEY,
            JSON.stringify({ country, cachedAt: Date.now() })
          );
        } catch { /* quota exceeded — ignore */ }
      }

      return country;
    }
  } catch {
    console.warn("[CM:geo] Detection failed, defaulting to US");
  }

  return "US";
}

/**
 * Resolve geo-aware PricingConfig.
 * Uses placeholder plan IDs when env vars are absent so the system still
 * boots in mock mode.
 */
export async function getPricingConfig(): Promise<PricingConfig> {
  const country = await detectCountry();
  const isSouthAsia = SOUTH_ASIA_COUNTRIES.includes(country);

  if (isSouthAsia) {
    return {
      gateway:  "razorpay",
      currency: "inr",
      symbol:   "₹",
      pro: {
        amount:   19_900, // ₹199 in paise
        display:  "₹199",
        planId:   process.env.RAZORPAY_PRO_PLAN_ID ?? "plan_placeholder_pro",
        interval: "month",
      },
      team: {
        amount:   99_900, // ₹999 in paise
        display:  "₹999",
        planId:   process.env.RAZORPAY_TEAM_PLAN_ID ?? "plan_placeholder_team",
        interval: "month",
      },
    };
  }

  return {
    gateway:  "stripe",
    currency: "usd",
    symbol:   "$",
    pro: {
      amount:   500, // $5 in cents
      display:  "$5",
      planId:   process.env.STRIPE_PRO_PRICE_ID ?? "price_placeholder_pro",
      interval: "month",
    },
    team: {
      amount:   2_500, // $25 in cents
      display:  "$25",
      planId:   process.env.STRIPE_TEAM_PRICE_ID ?? "price_placeholder_team",
      interval: "month",
    },
  };
}

