/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/testing/chrome-mock.ts
//
// Reusable, dependency-free fake `chrome` + `navigator.gpu` for vitest (node env).
// Covers the surface the extension's libs touch: runtime messaging, storage.local,
// and the offscreen API. Install with installChromeMock(); restore with the
// returned cleanup fn (or call uninstallChromeMock()).

import { vi } from "vitest";

export interface MockChromeOptions {
  /** Initial chrome.storage.local contents. */
  storage?: Record<string, unknown>;
  /**
   * Handler invoked for chrome.runtime.sendMessage. Return the response (or a
   * Promise of it). If omitted, sendMessage resolves to undefined.
   */
  onSendMessage?: (msg: unknown) => unknown | Promise<unknown>;
  /** Whether chrome.offscreen exists (default true). */
  withOffscreen?: boolean;
  /** Whether navigator.gpu.requestAdapter resolves to a fake adapter (default false). */
  gpuAvailable?: boolean;
}

export interface MockChromeHandle {
  chrome: MockChrome;
  /** Spy for offscreen.createDocument — assert call counts in tests. */
  createDocumentSpy: ReturnType<typeof vi.fn>;
  /** Spy for navigator.gpu.requestAdapter — assert it isn't re-probed. */
  requestAdapterSpy: ReturnType<typeof vi.fn>;
  /** Current in-memory storage map (read/assert directly). */
  storage: Record<string, unknown>;
  /** Manually push a runtime message to all registered onMessage listeners. */
  emit: (msg: unknown) => void;
  cleanup: () => void;
}

interface MockChrome {
  runtime: {
    id: string;
    lastError: { message: string } | undefined;
    sendMessage: ReturnType<typeof vi.fn>;
    onMessage: {
      addListener: (fn: (msg: unknown) => void) => void;
      removeListener: (fn: (msg: unknown) => void) => void;
    };
  };
  storage: {
    local: {
      get: (keys?: string | string[] | null) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
    };
  };
  offscreen?: {
    hasDocument: ReturnType<typeof vi.fn>;
    createDocument: ReturnType<typeof vi.fn>;
    closeDocument: ReturnType<typeof vi.fn>;
  };
}

export function installChromeMock(opts: MockChromeOptions = {}): MockChromeHandle {
  const storage: Record<string, unknown> = { ...(opts.storage ?? {}) };
  const listeners = new Set<(msg: unknown) => void>();
  let hasDoc = false;

  const createDocumentSpy = vi.fn(async () => { hasDoc = true; });
  const requestAdapterSpy = vi.fn(async () =>
    opts.gpuAvailable
      ? { requestAdapterInfo: async () => ({ description: "Mock GPU", vendor: "mock" }) }
      : null
  );

  const sendMessage = vi.fn(async (msg: unknown) => {
    return opts.onSendMessage ? await opts.onSendMessage(msg) : undefined;
  });

  const chrome: MockChrome = {
    runtime: {
      id: "mock-extension-id",
      lastError: undefined,
      sendMessage,
      onMessage: {
        addListener: (fn) => { listeners.add(fn); },
        removeListener: (fn) => { listeners.delete(fn); },
      },
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...storage };
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in storage) out[k] = storage[k];
          return out;
        },
        set: async (items) => { Object.assign(storage, items); },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete storage[k];
        },
      },
    },
  };

  if (opts.withOffscreen !== false) {
    chrome.offscreen = {
      hasDocument: vi.fn(async () => hasDoc),
      createDocument: createDocumentSpy,
      closeDocument: vi.fn(async () => { hasDoc = false; }),
    };
  }

  const g = globalThis as Record<string, unknown>;
  const prevChromeDesc = Object.getOwnPropertyDescriptor(g, "chrome");
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(g, "navigator");
  const prevNavigator = g.navigator;

  Object.defineProperty(g, "chrome", { value: chrome, configurable: true, writable: true });
  Object.defineProperty(g, "navigator", {
    value: {
      ...(typeof prevNavigator === "object" && prevNavigator ? prevNavigator : {}),
      hardwareConcurrency: 8,
      gpu: { requestAdapter: requestAdapterSpy },
    },
    configurable: true,
    writable: true,
  });

  const cleanup = () => {
    if (prevChromeDesc) Object.defineProperty(g, "chrome", prevChromeDesc);
    else delete g.chrome;
    if (prevNavigatorDesc) Object.defineProperty(g, "navigator", prevNavigatorDesc);
    else delete g.navigator;
    listeners.clear();
  };

  return {
    chrome: chrome as MockChrome,
    createDocumentSpy,
    requestAdapterSpy,
    storage,
    emit: (msg) => { for (const fn of listeners) fn(msg); },
    cleanup,
  };
}
