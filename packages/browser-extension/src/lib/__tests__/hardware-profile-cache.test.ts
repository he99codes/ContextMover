/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installChromeMock, type MockChromeHandle } from "../../testing/chrome-mock";

// OFF-3: getHardwareProfile must persist its result to chrome.storage.local so
// the offscreen document (which reloads this module on every recreation) does
// NOT re-run navigator.gpu.requestAdapter() each lifecycle — the source of the
// "No available adapters" spam.
//
// attention-engine.ts pulls in heavy deps (idb, dexie, tree-sitter) at load,
// so we mock the modules it imports at top level. We re-import the module fresh
// in each test (vi.resetModules) to reset its in-memory cachedHardwareProfile.

vi.mock("../db", () => ({ dexieDb: {} }));
vi.mock("../math", () => ({ cosineSimilarity: () => 0, searchContextChunks: () => [] }));
vi.mock("../capability-detector", () => ({
  capabilityDetector: {},
  getTierConfig: () => ({}),
  startHeadroomMonitor: () => () => {},
}));
vi.mock("idb", () => ({ openDB: async () => ({}) }));

let handle: MockChromeHandle;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  handle?.cleanup();
});

describe("getHardwareProfile persistence (OFF-3)", () => {
  it("probes the GPU once, then serves a warm read from chrome.storage", async () => {
    handle = installChromeMock({ gpuAvailable: false });

    const { getHardwareProfile } = await import("../attention-engine");

    // First call → cold: must run detection (which probes the GPU).
    const first = await getHardwareProfile();
    expect(first).toBeTruthy();
    const probesAfterFirst = handle.requestAdapterSpy.mock.calls.length;
    expect(probesAfterFirst).toBeGreaterThanOrEqual(1);

    // Profile must be written to storage under the cache key.
    expect(handle.storage["cm:hwProfileCache"]).toBeTruthy();

    // Second call in the SAME module context → in-memory cache, no new probe.
    await getHardwareProfile();
    expect(handle.requestAdapterSpy.mock.calls.length).toBe(probesAfterFirst);
  });

  it("a fresh module load (simulating offscreen recreation) reads storage and does NOT re-probe", async () => {
    // Seed storage as if a previous lifecycle already detected + persisted.
    const seeded = {
      "cm:hwProfileCache": {
        profile: {
          cores: 8,
          memoryGB: 16,
          hasWebGPU: false,
          gpuRenderer: null,
          tier: "balanced",
          recommendedMigrationTier: 2,
        },
        ts: Date.now(),
      },
    };
    handle = installChromeMock({ storage: seeded, gpuAvailable: false });

    // Fresh import = fresh module scope = cachedHardwareProfile is null,
    // exactly like the offscreen doc reloading the module.
    const { getHardwareProfile } = await import("../attention-engine");

    const profile = await getHardwareProfile();
    expect(profile.tier).toBe("balanced");
    expect(profile.cores).toBe(8);
    // The whole point: storage hit means ZERO GPU probes.
    expect(handle.requestAdapterSpy).not.toHaveBeenCalled();
  });

  it("ignores an expired cache entry and re-detects", async () => {
    const expired = {
      "cm:hwProfileCache": {
        profile: {
          cores: 2, memoryGB: 4, hasWebGPU: false, gpuRenderer: null,
          tier: "minimal", recommendedMigrationTier: 1,
        },
        ts: Date.now() - 25 * 60 * 60 * 1000, // 25h old (> 24h TTL)
      },
    };
    handle = installChromeMock({ storage: expired, gpuAvailable: false });

    const { getHardwareProfile } = await import("../attention-engine");
    await getHardwareProfile();
    // Expired → must re-detect → at least one fresh GPU probe.
    expect(handle.requestAdapterSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
