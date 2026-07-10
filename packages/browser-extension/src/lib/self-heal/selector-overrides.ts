/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Proprietary and confidential.
 */

// src/lib/self-heal/selector-overrides.ts
// Persists user-confirmed selector overrides to chrome.storage.local.
// Content scripts call getOverridesForPlatform() at init time and prefer
// these over hardcoded defaults. Remote config still takes highest priority
// so server-side fixes can override local ones.

import type { Platform } from "./probe-scripts";
import { WEBAPP_URL } from "@/config/urls";

const STORAGE_KEY = "selectorOverrides_v1";

export interface PlatformSelectorOverride {
  userSelector?: string;
  assistantSelector?: string;
  rootSelector?: string;
  inputSelector?: string;
  savedAt: number;
  sharedAt?: number; // timestamp when user submitted to contextmover.com
}

export type SelectorOverridesMap = Partial<Record<Platform, PlatformSelectorOverride>>;

export async function getAllOverrides(): Promise<SelectorOverridesMap> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return (result[STORAGE_KEY] as SelectorOverridesMap) ?? {};
  } catch {
    return {};
  }
}

export async function getOverridesForPlatform(
  platform: Platform
): Promise<PlatformSelectorOverride | null> {
  const all = await getAllOverrides();
  return all[platform] ?? null;
}

export async function saveOverridesForPlatform(
  platform: Platform,
  overrides: Omit<PlatformSelectorOverride, "savedAt">
): Promise<void> {
  const all = await getAllOverrides();
  all[platform] = { ...overrides, savedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
  console.log(`[CM:self-heal] saved overrides for ${platform}:`, overrides);
}

export async function clearOverridesForPlatform(platform: Platform): Promise<void> {
  const all = await getAllOverrides();
  delete all[platform];
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
  console.log(`[CM:self-heal] cleared overrides for ${platform}`);
}

export async function markShared(platform: Platform): Promise<void> {
  const all = await getAllOverrides();
  if (all[platform]) {
    all[platform]!.sharedAt = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  }
}

/**
 * Submits confirmed selectors to contextmover.com for review and potential
 * rollout to all users via remote config.
 */
export async function shareOverrideWithServer(
  platform: Platform,
  override: PlatformSelectorOverride,
  accessToken: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${WEBAPP_URL}/api/selector-fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        platform,
        selectors: {
          userSelector: override.userSelector,
          assistantSelector: override.assistantSelector,
          rootSelector: override.rootSelector,
          inputSelector: override.inputSelector,
        },
        submittedAt: Date.now(),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    }
    await markShared(platform);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
