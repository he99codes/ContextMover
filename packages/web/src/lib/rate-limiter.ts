/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/lib/rate-limiter.ts
//
// [SECURITY] Distributed sliding window rate limiter backed by Upstash Redis.
// Falls back to an in-process Map when UPSTASH_REDIS_REST_URL is not set
// (local dev without Redis configured).
//
// Usage in any /app/api/*/route.ts:
//
//   import { checkRateLimit } from "@/lib/rate-limiter";
//   import { NextRequest, NextResponse } from "next/server";
//
//   export async function POST(req: NextRequest) {
//     const rl = await checkRateLimit(req);
//     if (!rl.ok) return rl.response;
//     // ... handler logic
//   }
//
// Limits: 60 requests per 60-second window per unique key (user ID or IP).
// On violation: 429 Too Many Requests with Retry-After header.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const WINDOW_MS  = 60_000; // 1 minute
const MAX_REQUESTS = 60;   // per window

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RateLimitResult {
  ok: true;
  remaining: number;
  reset: number;
}

export interface RateLimitViolation {
  ok: false;
  response: NextResponse;
}

// ── IP extraction ─────────────────────────────────────────────────────────────

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

// ── 429 response builder ──────────────────────────────────────────────────────

function rateLimitExceeded(retryAfterSec: number, maxRequests: number): RateLimitViolation {
  return {
    ok: false,
    response: NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: {
          "Retry-After":          String(retryAfterSec),
          "X-RateLimit-Limit":    String(maxRequests),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset":    String(Math.ceil(Date.now() / 1000) + retryAfterSec),
        },
      }
    ),
  };
}

// ── Upstash Redis (distributed, persists across cold starts) ──────────────────

let _ratelimiter: Ratelimit | null = null;

function getUpstashLimiter(): Ratelimit | null {
  if (_ratelimiter) return _ratelimiter;
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    _ratelimiter = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(MAX_REQUESTS, "60 s"),
      analytics: false,
      prefix: "cm:rl",
    });
    return _ratelimiter;
  } catch (err) {
    console.warn("[CM:rate-limiter] Failed to init Upstash, falling back to in-memory:", err);
    return null;
  }
}

// Fix 10: Cache custom limiters by (maxRequests:windowSeconds) key to avoid
// creating a new Ratelimit + Redis instance on every request.
const _customLimiters = new Map<string, Ratelimit>();

function getCustomLimiter(maxRequests: number, windowSeconds: number): Ratelimit | null {
  const cacheKey = `${maxRequests}:${windowSeconds}`;
  const cached = _customLimiters.get(cacheKey);
  if (cached) return cached;

  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const custom = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(maxRequests, `${windowSeconds} s`),
      analytics: false,
      prefix: "cm:rl",
    });
    _customLimiters.set(cacheKey, custom);
    return custom;
  } catch (err) {
    console.warn("[CM:rate-limiter] Failed to init custom limiter:", err);
    return null;
  }
}

async function checkWithUpstash(
  key: string,
  maxRequests: number,
  windowSeconds: number = 60
): Promise<RateLimitResult | RateLimitViolation | null> {
  const limiter = getUpstashLimiter();
  if (!limiter) return null;
  try {
    let result: Awaited<ReturnType<typeof limiter.limit>>;
    if (maxRequests === MAX_REQUESTS && windowSeconds === 60) {
      result = await limiter.limit(key);
    } else {
      // Use cached custom limiter instead of creating one per request
      const custom = getCustomLimiter(maxRequests, windowSeconds);
      if (!custom) return null; // fall back to in-memory
      result = await custom.limit(key);
    }

    if (!result.success) {
      const retryAfter = Math.ceil((result.reset - Date.now()) / 1000);
      return rateLimitExceeded(Math.max(retryAfter, 1), maxRequests);
    }
    return { ok: true, remaining: result.remaining, reset: result.reset };
  } catch (err) {
    console.warn("[CM:rate-limiter] Upstash check failed, falling back to in-memory:", err);
    return null; // signal: use fallback
  }
}

// ── In-memory fallback (resets on cold start — dev / Redis unavailable) ────────

interface WindowEntry { count: number; windowStart: number; }
const store = new Map<string, WindowEntry>();

function checkInMemory(
  key: string,
  maxRequests: number,
  windowMs: number = WINDOW_MS
): RateLimitResult | RateLimitViolation {
  const now   = Date.now();
  const entry = store.get(key);

  if (!entry || now - entry.windowStart >= windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return { ok: true, remaining: maxRequests - 1, reset: now + windowMs };
  }

  if (entry.count >= maxRequests) {
    const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return rateLimitExceeded(retryAfter, maxRequests);
  }

  entry.count += 1;
  store.set(key, entry);
  return { ok: true, remaining: maxRequests - entry.count, reset: entry.windowStart + windowMs };
}

// Evict stale in-memory entries every 5 minutes.
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of Array.from(store)) {
      if (now - e.windowStart >= WINDOW_MS * 2) store.delete(k);
    }
  }, 5 * 60 * 1000);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * [SECURITY] Check the rate limit for an incoming request.
 * Uses Upstash Redis when configured (distributed, survives cold starts).
 * Falls back to in-process sliding window if Redis is unavailable.
 *
 * @param req         - Incoming Next.js request
 * @param userId      - Optional: key by user ID instead of IP (preferred for auth'd routes)
 * @param maxRequests - Override default 60 req/min limit
 */
export async function checkRateLimit(
  req: NextRequest,
  userId?: string,
  maxRequests: number = MAX_REQUESTS,
  windowSeconds: number = 60
): Promise<RateLimitResult | RateLimitViolation> {
  // Resolve the rate-limit key: prefer caller-supplied userId, then Supabase session, then IP.
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

  // Try Redis first; fall back to in-memory if unavailable.
  const redisResult = await checkWithUpstash(key, maxRequests, windowSeconds);
  if (redisResult !== null) return redisResult;
  return checkInMemory(key, maxRequests, windowSeconds * 1000);
}
