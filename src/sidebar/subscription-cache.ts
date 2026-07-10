let lastFetch = 0;
const CACHE_MS = 5 * 60 * 1000;

export interface SubscriptionStatus {
  plan?: "free" | "pro" | "team";
  isPro?: boolean;
  usage?: { simpleMigrations: number };
}

export async function fetchSubscriptionStatus(): Promise<SubscriptionStatus | null> {
  const now = Date.now();
  if (now - lastFetch < CACHE_MS) return null;
  lastFetch = now;
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_SUBSCRIPTION_STATUS" }) as SubscriptionStatus;
    return res;
  } catch {
    return null;
  }
}

export function invalidateSubscriptionCache(): void {
  lastFetch = 0;
}
