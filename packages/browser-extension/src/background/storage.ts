/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/background/storage.ts
export { db } from "@/lib/db";

export async function getSettings(): Promise<AppSettings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { autoCapture: true, maxTokensForSummary: 6000 },
      (items) => resolve(items as AppSettings)
    );
  });
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  return new Promise((resolve) => chrome.storage.sync.set(settings, resolve));
}

export interface AppSettings {
  autoCapture: boolean;
  maxTokensForSummary: number;
}
