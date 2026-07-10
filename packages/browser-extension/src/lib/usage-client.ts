/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/usage-client.ts
// Extension-side client for ContextMover usage-limit API.
// FAILS CLOSED — any API or network error blocks the migration.

const API_BASE = "https://www.contextmover.com";

export interface UsageCheckResult {
  allowed: boolean;
  plan: string;
  unlimited: boolean;
  tier: number;
  used: number;
  limit: number;
  remaining: number;
  reason?: string;
  daysUntilReset?: number;
  resetDate?: string;
  upgradeUrl?: string;
  fallback?: boolean;
}

export interface UsageStatus {
  plan: string;
  unlimited: boolean;
  month: string;
  resetDate: string;
  daysUntilReset: number;
  usage: {
    tier1: { used: number; limit: number; remaining: number; label: string };
    tier2: { used: number; limit: number; remaining: number; label: string };
    tier3: { used: number; limit: number; remaining: number; label: string };
  };
  upgradeUrl: string;
}

export async function checkUsage(
  tier: 1 | 2 | 3,
  accessToken: string
): Promise<UsageCheckResult> {
  // [CM-FIX-SEC] removed token prefix debug log
  try {
    const res = await fetch(`${API_BASE}/api/usage/check`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tier }),
      signal: AbortSignal.timeout(8_000),
    });

    const ct = res.headers.get("content-type") ?? "";

    // Route-level failure (404, 405, redirect-to-HTML) is fundamentally
    // different from a network failure: the API is reachable but is not
    // serving this endpoint. We surface it loudly and flag the sidebar to
    // recheck — never silently treat it as "user is on free plan, allow
    // them through" forever.
    const isRouteFailure =
      res.status === 404 || res.status === 405 || !ct.includes("application/json");

    if (!res.ok || isRouteFailure) {
      const bodyPreview = await res.text().then((t) => t.slice(0, 200)).catch(() => "");
      console.warn(
        `[usage-client] checkUsage API error HTTP ${res.status} — failing OPEN so user is not blocked. ` +
        `content-type: ${ct || "none"}. Body: ${bodyPreview}`
      );
      try {
        await chrome.storage.local.set({
          usageCheckSkipped: true,
          usageCheckSkippedAt: Date.now(),
          usageCheckLastStatus: res.status,
        });
      } catch { /* storage may be unavailable in some contexts */ }
      // Fail OPEN: server errors / route failures must NOT block migrations.
      // 401 here is almost certainly a backend auth bug (the subscription endpoint
      // accepts the same token and returns 200). Blocking with limit:0 would show
      // "Monthly limit reached: 0 free migrations" to legitimate pro users.
      // The service worker additionally verifies subscription status before blocking,
      // so failing open here is safe.
      return {
        allowed: true,
        plan: "unknown",
        unlimited: false,
        tier,
        used: 0,
        limit: 999,
        remaining: 999,
        fallback: true,
        reason: `usage_api_error_${res.status}`,
      };
    }

    const data = (await res.json()) as UsageCheckResult;
    // Successful response — clear any stale "skipped" flag.
    try { await chrome.storage.local.remove(["usageCheckSkipped", "usageCheckSkippedAt", "usageCheckLastStatus"]); } catch { /* noop */ }

    // Broadcast warning badge when running low
    if (typeof data.remaining === "number" && data.remaining >= 0) {
      if (data.remaining <= 3) {
        chrome.runtime.sendMessage({ type: "USAGE_WARNING", remaining: data.remaining }).catch(() => { /* noop — sidebar may not be open */ });
      }
    }
    // Hard block at 0
    if (data.remaining === 0) {
      return { ...data, allowed: false, reason: "limit_reached" };
    }
    return data;
  } catch (err) {
    console.warn("[usage-client] checkUsage network failure, failing OPEN:", err);
    return {
      allowed: true,
      plan: "unknown",
      unlimited: false,
      tier,
      used: 0,
      limit: 999,
      remaining: 999,
      fallback: true,
      reason: "network_error",
    };
  }
}

export async function incrementUsage(
  tier: 1 | 2 | 3,
  accessToken: string,
  metadata?: {
    sourcePlatform?: string;
    targetPlatform?: string;
    messageCount?: number;
    charCount?: number;
  }
): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/usage/increment`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tier, ...metadata }),
    });
  } catch (err) {
    console.warn("[usage-client] incrementUsage failed:", err);
  }
}

export async function getUsageStatus(
  accessToken: string
): Promise<UsageStatus | null> {
  // [CM-FIX-SEC] removed token prefix debug log
  if (typeof navigator !== "undefined" && !navigator.onLine) return null;
  try {
    const res = await fetch(`${API_BASE}/api/usage/status`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) return null;
    return (await res.json()) as UsageStatus;
  } catch (err) {
    console.warn("[usage-client] getUsageStatus failed:", err);
    return null;
  }
}
