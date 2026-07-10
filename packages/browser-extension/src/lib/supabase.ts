/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/supabase.ts
//
// Supabase client for the ContextMover browser extension.
//
// MV3 service workers DO NOT have `localStorage`, so we must supply a custom
// storage adapter backed by `chrome.storage.local`. The same client also works
// inside the sidebar / popup pages.

import { createClient, type SupportedStorage } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// ── chrome.storage.local adapter ───────────────────────────────────────────────
const chromeStorageAdapter: SupportedStorage = {
  async getItem(key: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([key], (result) => {
          resolve((result?.[key] as string | undefined) ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  },
  async setItem(key: string, value: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [key]: value }, () => resolve());
      } catch {
        resolve();
      }
    });
  },
  async removeItem(key: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove([key], () => resolve());
      } catch {
        resolve();
      }
    });
  },
};

// Network-aware fetch wrapper — short-circuits when offline so Supabase's
// autoRefreshToken timer doesn't flood the console with 'TypeError: Failed
// to fetch' stack traces every few seconds.  Single quiet warn instead.
const networkAwareFetch: typeof globalThis.fetch = async (input, init) => {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new TypeError("[CM:supabase] offline — skipping fetch");
  }
  return globalThis.fetch(input, init);
};

export const supabase = createClient(
  SUPABASE_URL ?? "http://localhost:54321",
  SUPABASE_ANON_KEY ?? "placeholder",
  {
    auth: {
      storage: chromeStorageAdapter,
      persistSession: true,
      autoRefreshToken: true,
      // Detecting session in URL only makes sense for OAuth redirects — we use
      // email/password, so explicitly disable to avoid noisy warnings.
      detectSessionInUrl: false,
    },
    global: {
      fetch: networkAwareFetch,
    },
    realtime: {
      params: { eventsPerSecond: 1 },
    },
  }
);
