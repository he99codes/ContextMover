// packages/browser-extension/src/lib/usage-client.ts
// Extension-side client for ContextMover usage-limit API.
// FAILS OPEN on network errors — never blocks the user when the API is down.

const API_BASE = "https://contextmover.com";

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
  try {
    const res = await fetch(`${API_BASE}/api/usage/check`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tier }),
    });

    const data = (await res.json()) as UsageCheckResult;
    return data;
  } catch (err) {
    console.warn("[usage-client] checkUsage failed, failing open:", err);
    // Fail open — never block the user when API is unreachable
    return {
      allowed: true,
      plan: "unknown",
      unlimited: true,
      tier,
      used: 0,
      limit: -1,
      remaining: -1,
      fallback: true,
    };
  }
}

export async function incrementUsage(
  tier: 1 | 2 | 3,
  accessToken: string
): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/usage/increment`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tier }),
    });
  } catch (err) {
    console.warn("[usage-client] incrementUsage failed:", err);
  }
}

export async function getUsageStatus(
  accessToken: string
): Promise<UsageStatus | null> {
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
