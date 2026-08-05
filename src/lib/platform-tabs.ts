/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import type { Platform } from "./types";

const PLATFORM_TAB_PATTERNS: Record<Platform, string[]> = {
  claude:     ["https://claude.ai/*"],
  chatgpt:    ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  gemini:     ["https://gemini.google.com/*"],
  grok:       ["https://grok.com/*", "https://grok.x.ai/*"],
  perplexity: ["https://www.perplexity.ai/*"],
  deepseek:   ["https://chat.deepseek.com/*"],
};

export async function findTargetPlatformTab(
  platform: Platform
): Promise<chrome.tabs.Tab | undefined> {
  const patterns = PLATFORM_TAB_PATTERNS[platform];
  const currentWindowTabs = await chrome.tabs.query({
    currentWindow: true,
    url: patterns,
  });

  if (currentWindowTabs.length > 0) {
    return currentWindowTabs[0];
  }

  const tabs = await chrome.tabs.query({ url: patterns });
  return tabs[0];
}

export async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);

  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  await chrome.tabs.update(tabId, { active: true });
}

/**
 * [CM-SOLAR-V2] Detect the currently-active AI platform tab in the current window.
 * Returns `{ platform, tab }` if the active tab's URL matches a known AI host,
 * otherwise `null`. Used by the 1-click quick-migrate button on SessionCard.
 */
export async function detectActivePlatformTab(): Promise<{ platform: Platform; tab: chrome.tabs.Tab } | null> {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active?.url) return null;
    for (const [platform, patterns] of Object.entries(PLATFORM_TAB_PATTERNS)) {
      for (const pattern of patterns) {
        // Convert glob (https://claude.ai/*) to regex.
        const re = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : ch === "?" ? "." : "\\" + ch)) + "$");
        if (re.test(active.url)) {
          return { platform: platform as Platform, tab: active };
        }
      }
    }
  } catch {
    /* ignore — best-effort detection */
  }
  return null;
}
