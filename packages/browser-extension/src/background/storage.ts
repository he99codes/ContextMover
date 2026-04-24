// packages/browser-extension/src/background/storage.ts
export { db } from "@/lib/db";

export async function getSettings(): Promise<AppSettings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { bridgePort: 49152, autoCapture: true, maxTokensForSummary: 6000 },
      (items) => resolve(items as AppSettings)
    );
  });
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  return new Promise((resolve) => chrome.storage.sync.set(settings, resolve));
}

export interface AppSettings {
  bridgePort: number;
  autoCapture: boolean;
  maxTokensForSummary: number;
}
