/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { describe, it, expect } from "vitest";
import { pickBestKnown, shouldRejectIncoming } from "../capture-merge";

const cap = (n: number) => ({ messages: { length: n } });

// ─────────────────────────────────────────────────────────────────────────────
// pickBestKnown — most complete snapshot wins
// ─────────────────────────────────────────────────────────────────────────────

describe("pickBestKnown", () => {
  it("returns null when both are absent", () => {
    expect(pickBestKnown(null, null)).toBeNull();
    expect(pickBestKnown(undefined, undefined)).toBeNull();
  });

  it("returns existing when pending is absent", () => {
    const existing = cap(10);
    expect(pickBestKnown(existing, null)).toBe(existing);
  });

  it("returns pending when existing is absent", () => {
    const pending = cap(10);
    expect(pickBestKnown(null, pending)).toBe(pending);
  });

  it("prefers pending when it has MORE messages", () => {
    const existing = cap(10);
    const pending = cap(30);
    expect(pickBestKnown(existing, pending)).toBe(pending);
  });

  it("prefers existing when it has MORE messages", () => {
    const existing = cap(30);
    const pending = cap(10);
    expect(pickBestKnown(existing, pending)).toBe(existing);
  });

  it("prefers pending on a tie (freshest authoritative copy)", () => {
    const existing = cap(20);
    const pending = cap(20);
    expect(pickBestKnown(existing, pending)).toBe(pending);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldRejectIncoming — DOM scrape must not clobber a fuller capture
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldRejectIncoming", () => {
  it("rejects a smaller network capture vs a fuller known snapshot", () => {
    // [PHASE-5-FIX] fetch-intercept is rejected if it has fewer messages (e.g. auth intercept)
    expect(shouldRejectIncoming(2, cap(30), true)).toBe(true);
  });

  it("rejects a smaller DOM scrape vs a fuller known snapshot", () => {
    // CAP-1: the core data-loss guard — 2-msg DOM scrape vs 30-msg known
    expect(shouldRejectIncoming(2, cap(30), false)).toBe(true);
  });

  it("accepts an equal-count DOM scrape", () => {
    expect(shouldRejectIncoming(30, cap(30), false)).toBe(false);
  });

  it("accepts a larger DOM scrape (genuine new messages)", () => {
    expect(shouldRejectIncoming(31, cap(30), false)).toBe(false);
  });

  it("accepts anything when there is no known snapshot", () => {
    expect(shouldRejectIncoming(1, null, false)).toBe(false);
  });

  it("end-to-end: fetch(30) then DOM(2) within the debounce window keeps 30", () => {
    // Simulate the exact race: fetch-interceptor wrote 30 into pendingWrites,
    // DOM scraper fires 10ms later with 2.
    const pending = cap(30);
    const existing = null;
    const best = pickBestKnown(existing, pending);
    expect(shouldRejectIncoming(2, best, false)).toBe(true); // DOM scrape rejected
  });
});
