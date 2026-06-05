/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/lib/rate-limiter.ts
//
// [SECURITY] In-memory sliding window rate limiter for Next.js API routes.
//
// Usage in any /app/api/*/route.ts:
//
//   import { checkRateLimit } from "@/lib/rate-limiter";
//   import { NextRequest, NextResponse } from "next/server";
//
//   export async function POST(req: NextRequest) {
//     const limit = checkRateLimit(req);
//     if (!limit.ok) return limit.response;
//     // ... handler logic
//   }
//
// Limits: 60 requests per 60-second window per unique key (user ID or IP).
// On violation: 429 Too Many Requests with Retry-After header.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 60;  // per window

interface WindowEntry {
  count: number;
  windowStart: number;
}

// [SECURITY] In-process store — resets on every serverless cold start, so an
// attacker can bypass rate limiting by waiting for the instance to scale down.
// For production-grade enforcement, replace with Upstash Redis (@upstash/ratelimit)
// or a similar distributed store that persists across instances and deploys.
const store = new Map<string, WindowEntry>();

// [SECURITY] Loose check that a string looks like an IPv4 or IPv6 address.
// Rejects obviously bogus values (e.g. script injections via X-Forwarded-For)
// while remaining permissive enough for real proxies that may include ports.
const IP_LIKE = /^[\d.:a-fA-F%]+$/;

function getSlidingWindowKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const candidate = forwarded.split(",")[0].trim();
    if (candidate && IP_LIKE.test(candidate)) return candidate;
  }
  return "unknown";
}

export interface RateLimitResult {
  ok: true;
  remaining: number;
  reset: number;
}

export interface RateLimitViolation {
  ok: false;
  response: NextResponse;
}

/**
 * [SECURITY] Check the rate limit for an incoming request.
 * Call this at the top of every API route handler.
 *
 * Optionally pass a `userId` to key the window by user rather than IP
 * (preferred when the user is authenticated, prevents IP-sharing false positives).
 * Optionally pass `maxRequests` to override the default 60/min limit.
 */
export async function checkRateLimit(
  req: NextRequest,
  userId?: string,
  maxRequests: number = MAX_REQUESTS
): Promise<RateLimitResult | RateLimitViolation> {
  // If no userId provided, try to resolve it from the Supabase session.
  let key = userId ?? "";
  if (!key) {
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      key = user?.id ?? getSlidingWindowKey(req);
    } catch {
      key = getSlidingWindowKey(req);
    }
  }

  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    // Start a new window.
    store.set(key, { count: 1, windowStart: now });
    return { ok: true, remaining: maxRequests - 1, reset: now + WINDOW_MS };
  }

  if (entry.count >= maxRequests) {
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Too many requests. Please slow down." },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(maxRequests),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.ceil((entry.windowStart + WINDOW_MS) / 1000)),
          },
        }
      ),
    };
  }

  entry.count += 1;
  store.set(key, entry);

  return {
    ok: true,
    remaining: maxRequests - entry.count,
    reset: entry.windowStart + WINDOW_MS,
  };
}

// [SECURITY] Periodically evict stale entries to prevent unbounded memory growth.
// Runs every 5 minutes in long-running server contexts.
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of Array.from(store)) {
      if (now - entry.windowStart >= WINDOW_MS * 2) {
        store.delete(key);
      }
    }
  }, 5 * 60 * 1000);
}
