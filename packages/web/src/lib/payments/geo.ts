/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/lib/payments/geo.ts
// Geo-detection + pricing config for the v2 payment system.
// All payments routed through Razorpay (INR for South Asia, USD for global).
// SAFE for both server (Next API routes) and client usage:
//   - On server: reads x-vercel-ip-country header (user's real country, set by
//     Vercel edge). Falls back to ipapi.co only when header is absent.
//   - On client: 24h localStorage cache to avoid burning the ipapi.co quota.

import { type NextRequest } from "next/server";
import { type PricingConfig, SOUTH_ASIA_COUNTRIES } from "./types";

const GEO_CACHE_KEY = "cm_geo_country";
const GEO_CACHE_TTL = 86_400_000; // 24 hours

interface GeoCache {
  country:  string;
  cachedAt: number;
}

/**
 * Detect the user's ISO-3166-2 country code.
 * Server: reads x-vercel-ip-country header (user's real country, injected by
 * Vercel edge — no external call needed). Falls back to ipapi.co if absent.
 * Client: localStorage cache (24h) → ipapi.co fetch.
 */
export async function detectCountry(req?: NextRequest): Promise<string> {
  // ── Server-side: Vercel sets x-vercel-ip-country on every request ─────────
  if (typeof window === "undefined" && req) {
    const vercelCountry = req.headers.get("x-vercel-ip-country");
    if (vercelCountry) return vercelCountry;
  }

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
export async function getPricingConfig(req?: NextRequest): Promise<PricingConfig> {
  const country = await detectCountry(req);
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
    gateway:  "razorpay",
    currency: "usd",
    symbol:   "$",
    pro: {
      amount:   500, // $5 in cents
      display:  "$5",
      planId:   process.env.RAZORPAY_PRO_PLAN_ID ?? "plan_placeholder_pro",
      interval: "month",
    },
    team: {
      amount:   2_500, // $25 in cents
      display:  "$25",
      planId:   process.env.RAZORPAY_TEAM_PLAN_ID ?? "plan_placeholder_team",
      interval: "month",
    },
  };
}

