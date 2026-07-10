/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/remote-config.ts
// Fetches CSS selector overrides + injection strategy overrides from the server
// so broken platform selectors and injection methods can be patched without a
// Chrome Store resubmission.

const CONFIG_URL = "https://contextmover.com/api/scraper-admin/configs";
const CACHE_KEY = "remoteConfig";
const CACHE_TS_KEY = "remoteConfigTs";
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export interface PlatformSelectors {
  messageSelector?: string;
  scrollContainer?: string;
  contentSelector?: string;
  userSelector?: string;
  assistantSelector?: string;
  inputSelector?: string;
  messageScope?: string;
  observerTarget?: string;
}

export interface InjectionStrategy {
  method?: "contentScript" | "executeScript" | "clipboard" | "disabled";
  inputSelector?: string;
  scrollContainer?: string;
}

export type RemoteConfig = Array<{
  platform_id: string;
  is_enabled: boolean;
  selectors: PlatformSelectors;
  last_updated_at: string;
  updated_by: string;
}>;

function isValidConfig(v: unknown): v is RemoteConfig {
  if (!Array.isArray(v)) return false;
  for (const item of v) {
    if (typeof item !== "object" || item === null) return false;
    if (typeof item.platform_id !== "string") return false;
    if (typeof item.is_enabled !== "boolean") return false;
    if (typeof item.selectors !== "object" || item.selectors === null) return false;
  }
  return true;
}

export async function getRemoteConfig(): Promise<RemoteConfig | null> {
  try {
    const stored = await chrome.storage.local.get([CACHE_KEY, CACHE_TS_KEY]);
    const cached = stored[CACHE_KEY] as RemoteConfig | undefined;
    const cachedTs = stored[CACHE_TS_KEY] as number | undefined;
    const age = cachedTs ? Date.now() - cachedTs : Infinity;

    if (cached && isValidConfig(cached) && age < CACHE_TTL) {
      return cached;
    }

    const fresh = await fetchConfig();
    if (fresh) {
      await chrome.storage.local.set({ [CACHE_KEY]: fresh, [CACHE_TS_KEY]: Date.now() });
      return fresh;
    }

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

export async function getPlatformSelectors(platform: string): Promise<PlatformSelectors | null> {
  const config = await getRemoteConfig();
  const platformConfig = config?.find(p => p.platform_id === platform);
  if (!platformConfig || !platformConfig.is_enabled) return null;
  return platformConfig.selectors;
}

export async function getInjectionStrategy(platform: string): Promise<InjectionStrategy | null> {
  // This function is no longer supported with the new remote config structure.
  return null;
}

// This function is no longer supported with the new remote config structure.
export async function getRemoteUpdateInfo(): Promise<{ forceUpdate: boolean; message?: string; minVersion?: string } | null> {
  return null;
}

async function fetchConfig(): Promise<RemoteConfig | null> {
  // If we're in a content script context (not a service worker / extension page),
  // route through the service worker to avoid CORS blocks from LLM platform origins.
  const isContentScript = typeof window !== "undefined" && typeof chrome?.runtime?.id === "string";
  if (isContentScript) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_REMOTE_CONFIG" });
      if (response?.ok && isValidConfig(response.config)) return response.config;
      console.debug("[CM:config] SW proxy returned:", response);
      return null;
    } catch (err) {
      console.debug("[CM:config] SW proxy failed:", err);
      return null;
    }
  }

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

    const json: unknown = await res.json();
    if (!isValidConfig(json)) {
      console.debug("[CM:config] Remote config failed validation — ignoring");
      return null;
    }

    return json;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.debug("[CM:config] Fetch failed:", msg);
    return null;
  }
}
