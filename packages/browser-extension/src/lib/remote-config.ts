/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/remote-config.ts
//
// Fetches CSS selector overrides from the server so broken platform selectors
// can be patched without a Chrome Store resubmission.
//
// SECURITY CONSTRAINTS:
//   - Only JSON is fetched and parsed — never eval() or new Function()
//   - The parsed object is validated structurally before use
//   - Fetch failures NEVER break capture; hardcoded defaults always remain
//   - No new manifest permissions required (contextmover.com already in host_permissions)

const CONFIG_URL = "https://contextmover.com/config/selectors.json";
const CACHE_KEY = "remoteConfig";
const CACHE_TS_KEY = "remoteConfigTs";
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export interface PlatformSelectors {
  /** Single selector covering all message turns; role read from an attribute. */
  messageSelector?: string;
  /** Selector for the inner content element within a messageSelector turn. */
  /** CSS selector for the overflow-scroll container that holds the conversation.
   *  Used by autoScrollBackToTop to load lazy-rendered history.
   *  Falls back to nearest-scrollable-ancestor detection when absent. */
  scrollContainer?: string;
  contentSelector?: string;
  /** Selector for user turns when roles must be detected separately. */
  userSelector?: string;
  /** Selector for assistant turns when roles must be detected separately. */
  assistantSelector?: string;
  /** Selector for the text input / composer. */
  inputSelector?: string;
  /** Scope element selector — queries are run inside this element. */
  messageScope?: string;
  /** Root selector passed to MutationObserver — overrides the hardcoded observer target. */
  observerTarget?: string;
}

export interface RemoteConfig {
  version: string;
  updatedAt: string;
  platforms: Record<string, PlatformSelectors>;
}

// ── Structural validator ──────────────────────────────────────────────────────
// Only accept plain objects with the expected shape. Never trust raw JSON blindly.
function isValidConfig(v: unknown): v is RemoteConfig {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj["version"] !== "string") return false;
  if (typeof obj["updatedAt"] !== "string") return false;
  if (typeof obj["platforms"] !== "object" || obj["platforms"] === null) return false;
  const platforms = obj["platforms"] as Record<string, unknown>;
  for (const key of Object.keys(platforms)) {
    const p = platforms[key];
    if (typeof p !== "object" || p === null) return false;
    // Each platform value must be a plain object of string | undefined values.
    for (const [, val] of Object.entries(p as object)) {
      if (val !== undefined && typeof val !== "string") return false;
    }
  }
  return true;
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Returns the remote selector config.
 *
 * Cache strategy (chrome.storage.local):
 *   1. Cache present AND < 1 hour old  → return cache immediately (no fetch)
 *   2. Cache missing OR expired        → fetch CONFIG_URL, validate, save, return
 *   3. Fetch fails AND cache exists    → return stale cache (better than null)
 *   4. Fetch fails AND no cache        → return null (callers use hardcoded defaults)
 */
export async function getRemoteConfig(): Promise<RemoteConfig | null> {
  try {
    const stored = await chrome.storage.local.get([CACHE_KEY, CACHE_TS_KEY]);
    const cached = stored[CACHE_KEY] as RemoteConfig | undefined;
    const cachedTs = stored[CACHE_TS_KEY] as number | undefined;
    const age = cachedTs ? Date.now() - cachedTs : Infinity;

    if (cached && isValidConfig(cached) && age < CACHE_TTL) {
      return cached;
    }

    // Cache is missing or expired — try to fetch fresh config.
    const fresh = await fetchConfig();
    if (fresh) {
      await chrome.storage.local.set({ [CACHE_KEY]: fresh, [CACHE_TS_KEY]: Date.now() });
      return fresh;
    }

    // Fetch failed — return stale cache if it exists, else null.
    if (cached && isValidConfig(cached)) {
      console.debug("[CM:config] Fetch failed — returning stale cached config");
      return cached;
    }
    return null;
  } catch (err) {
    console.debug("[CM:config] getRemoteConfig error:", err);
    return null;
  }
}

/**
 * Convenience wrapper — returns the PlatformSelectors for one platform,
 * or null if the config is unavailable or the platform isn't listed.
 */
export async function getPlatformSelectors(
  platform: string
): Promise<PlatformSelectors | null> {
  const config = await getRemoteConfig();
  return config?.platforms[platform] ?? null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function fetchConfig(): Promise<RemoteConfig | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(CONFIG_URL, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.debug(`[CM:config] Fetch returned HTTP ${res.status}`);
      return null;
    }

    // Parse JSON — NEVER eval(). Validate shape before returning.
    const json: unknown = await res.json();
    if (!isValidConfig(json)) {
      console.debug("[CM:config] Remote config failed validation — ignoring");
      return null;
    }

    return json;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // AbortError is expected on timeout — demote to debug.
    console.debug("[CM:config] Fetch failed:", msg);
    return null;
  }
}
