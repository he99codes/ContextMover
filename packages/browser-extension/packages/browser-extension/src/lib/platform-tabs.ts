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
