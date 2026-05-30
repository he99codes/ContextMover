/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/remote-config.ts
// Fetches CSS selector overrides + injection strategy overrides from the server
// so broken platform selectors and injection methods can be patched without a
// Chrome Store resubmission.

const CONFIG_URL = "https://contextmover.com/api/config/selectors";
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

export interface RemoteConfig {
  version: string;
  updatedAt: string;
  platforms: Record<string, PlatformSelectors>;
  injectionStrategies?: Record<string, InjectionStrategy>;
  forceUpdate?: boolean;
  updateMessage?: string;
  minVersion?: string;
}

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
    for (const [, val] of Object.entries(p as object)) {
      if (val !== undefined && typeof val !== "string") return false;
    }
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
  return config?.platforms[platform] ?? null;
}

export async function getInjectionStrategy(platform: string): Promise<InjectionStrategy | null> {
  const config = await getRemoteConfig();
  return config?.injectionStrategies?.[platform] ?? null;
}

export async function getRemoteUpdateInfo(): Promise<{ forceUpdate: boolean; message?: string; minVersion?: string } | null> {
  const config = await getRemoteConfig();
  if (!config) return null;
  return {
    forceUpdate: config.forceUpdate ?? false,
    message: config.updateMessage,
    minVersion: config.minVersion,
  };
}

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
