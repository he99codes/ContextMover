/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { describe, it, expect } from "vitest";
import { pruneRetrieveCache } from "../index";

// pruneRetrieveCache is the leak guard for the in-memory retrieval cache:
// entries for sessions that are never re-queried would otherwise live forever
// because the read-time TTL check only fires on a cache HIT.

const entry = (ts: number) => ({ ts });

describe("pruneRetrieveCache", () => {
  it("drops entries older than the TTL", () => {
    const cache = new Map<string, { ts: number }>();
    const now = 1_000_000;
    cache.set("fresh", entry(now - 5_000));   // within 30s
    cache.set("stale", entry(now - 31_000));  // expired
    pruneRetrieveCache(cache, now, 30_000, 100);
    expect(cache.has("fresh")).toBe(true);
    expect(cache.has("stale")).toBe(false);
  });

  it("treats exactly-TTL-old entries as expired", () => {
    const cache = new Map<string, { ts: number }>();
    const now = 1_000_000;
    cache.set("edge", entry(now - 30_000));
    pruneRetrieveCache(cache, now, 30_000, 100);
    expect(cache.has("edge")).toBe(false);
  });

  it("enforces the size cap by evicting the oldest entries first", () => {
    const cache = new Map<string, { ts: number }>();
    const now = 1_000_000;
    // 5 fresh entries, cap of 3 → 2 oldest evicted
    cache.set("t1", entry(now - 4_000));
    cache.set("t2", entry(now - 3_000));
    cache.set("t3", entry(now - 2_000));
    cache.set("t4", entry(now - 1_000));
    cache.set("t5", entry(now - 500));
    pruneRetrieveCache(cache, now, 30_000, 3);
    expect(cache.size).toBe(3);
    expect(cache.has("t1")).toBe(false); // oldest evicted
    expect(cache.has("t2")).toBe(false);
    expect(cache.has("t5")).toBe(true);  // newest kept
  });

  it("is a no-op when under the cap and all fresh", () => {
    const cache = new Map<string, { ts: number }>();
    const now = 1_000_000;
    cache.set("a", entry(now));
    cache.set("b", entry(now));
    pruneRetrieveCache(cache, now, 30_000, 100);
    expect(cache.size).toBe(2);
  });

  it("does not accumulate unbounded entries for never-requeried sessions", () => {
    const cache = new Map<string, { ts: number }>();
    const now = 1_000_000;
    // Simulate 500 one-off retrievals, each pruned on write.
    for (let i = 0; i < 500; i++) {
      cache.set(`session-${i}`, entry(now));
      pruneRetrieveCache(cache, now, 30_000, 100);
    }
    expect(cache.size).toBeLessThanOrEqual(100);
  });
});
