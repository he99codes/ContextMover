/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installChromeMock, type MockChromeHandle } from "@/testing/chrome-mock";
import type { ContextSession } from "@/lib/types";

// IDX integration tests — exercise the serialized indexing queue through the
// public SemanticIndex API. Heavy deps (Dexie, attention-engine, summarizer)
// are mocked so we test the QUEUE behavior, not embeddings.

// needsIndexing() short-circuits to `true` when sessionHashes.get() is undefined,
// so a no-op db mock makes every session "needs indexing".
vi.mock("../../db", () => ({
  dexieDb: {
    sessionHashes: { get: vi.fn(async () => undefined) },
    chunkEmbeddings: { where: () => ({ equals: () => ({ count: async () => 0, toArray: async () => [] }) }) },
  },
}));

vi.mock("../../attention-engine", () => ({
  getHardwareProfile: vi.fn(async () => ({
    cores: 8, memoryGB: 16, hasWebGPU: true, gpuRenderer: "mock",
    tier: "balanced", recommendedMigrationTier: 2,
  })),
}));

vi.mock("../../adaptive-timeout", async () => {
  const actual = await vi.importActual<typeof import("../../adaptive-timeout")>("../../adaptive-timeout");
  return {
    ...actual,
    StallDetector: class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private rejectFn: ((e: Error) => void) | null = null;
      start(): Promise<never> {
        return new Promise((_, reject) => {
          this.rejectFn = reject;
          this.timer = setTimeout(() => {
            if (this.rejectFn) this.rejectFn(new Error("stall_detected"));
          }, 100); // Short timeout for tests
        });
      }
      reset(): void {
        // No-op for tests
      }
      stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.rejectFn = null;
      }
    },
  };
});

vi.mock("../../summarizer", () => ({ SUMMARIZER_VERSION: "test" }));

const session = (id: string): ContextSession => ({
  id,
  platform: "chatgpt",
  createdAt: 0,
  updatedAt: 0,
  title: id,
  messages: [{ role: "user", content: "hi", timestamp: 0 }],
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let handle: MockChromeHandle;

afterEach(() => {
  handle?.cleanup();
  vi.useRealTimers();
});

describe("SemanticIndex queue — serialization & ordering", () => {
  it("processes background jobs one at a time in FIFO order", async () => {
    const order: string[] = [];
    let active = 0;
    let maxConcurrent = 0;

    handle = installChromeMock({
      onSendMessage: async (msg: unknown) => {
        const m = msg as { type?: string; session?: { id: string } };
        if (m.type === "OFFSCREEN_INDEX_SESSION") {
          active++;
          maxConcurrent = Math.max(maxConcurrent, active);
          order.push(m.session!.id);
          await new Promise((r) => setTimeout(r, 5)); // simulate embed work
          active--;
          return { ok: true, chunkCount: 3 };
        }
        return { ok: true };
      },
    });

    const { SemanticIndex } = await import("../index");
    const idx = new SemanticIndex();

    await Promise.all([
      idx.indexSession(session("A")),
      idx.indexSession(session("B")),
      idx.indexSession(session("C")),
    ]);

    expect(order).toEqual(["A", "B", "C"]);
    expect(maxConcurrent).toBe(1); // never two embeds at once
  });

  it("runs a priority job ahead of queued background jobs", async () => {
    const order: string[] = [];
    const gateA = deferred<void>();

    handle = installChromeMock({
      onSendMessage: async (msg: unknown) => {
        const m = msg as { type?: string; session?: { id: string } };
        if (m.type === "OFFSCREEN_INDEX_SESSION") {
          order.push(m.session!.id);
          if (m.session!.id === "A") await gateA.promise; // hold A in-flight
          return { ok: true, chunkCount: 3 };
        }
        return { ok: true };
      },
    });

    const { SemanticIndex } = await import("../index");
    const idx = new SemanticIndex();

    // Start A (will block in-flight), then queue B (background) and P (priority).
    const pA = idx.indexSession(session("A"));
    await Promise.resolve(); // let A reach in-flight
    const pB = idx.indexSession(session("B"));
    const pP = idx.indexSessionPriority(session("P"));

    gateA.resolve(); // release A → drain continues
    await Promise.all([pA, pB, pP]);

    // A ran first (already in-flight); P must precede B because priority lane drains first.
    expect(order[0]).toBe("A");
    expect(order.indexOf("P")).toBeLessThan(order.indexOf("B"));
  });
});

describe("SemanticIndex queue — timeout guard (CRITICAL fix)", () => {
  it("rejects a hung offscreen job instead of stalling the queue forever", { timeout: 15000 }, async () => {
    handle = installChromeMock({
      onSendMessage: (msg: unknown) => {
        const m = msg as { type?: string };
        if (m.type === "OFFSCREEN_INDEX_SESSION") {
          // Never resolves — simulates a hung/crashed offscreen doc.
          return new Promise(() => {});
        }
        return Promise.resolve({ ok: true });
      },
    });

    const { SemanticIndex } = await import("../index");
    const idx = new SemanticIndex();

    const p = idx.indexSession(session("HUNG"));
    await expect(p).rejects.toThrow(/stall|timeout/i);

    // Queue must be drainable again: a subsequent normal job completes.
    handle.cleanup();
    handle = installChromeMock({
      onSendMessage: async (msg: unknown) => {
        const m = msg as { type?: string };
        return m.type === "OFFSCREEN_INDEX_SESSION" ? { ok: true, chunkCount: 1 } : { ok: true };
      },
    });
    const { SemanticIndex: SI2 } = await import("../index");
    await expect(new SI2().indexSession(session("NEXT"))).resolves.toBeUndefined();
  });
});
