/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/capture/capture-merge.ts
//
// Pure decision logic for the capture pipeline — extracted from the service
// worker so it can be unit-tested without the chrome.* runtime.
//
// The problem it solves: two independent capture sources can fire for the same
// session within the debounce window —
//   • the fetch-interceptor (authoritative, full API history)
//   • the DOM scraper (lossy — virtual scroll evicts old messages from the DOM)
//
// A naive "last write wins" lets a 2-message DOM snapshot clobber a 30-message
// network capture. These helpers encode the "most complete capture wins" rule.

/** Minimal shape needed for the merge decision — avoids importing full types. */
export interface CaptureLike {
  messages: { length: number };
}

/**
 * Picks the most complete known snapshot for a session, considering both the
 * committed IDB copy (`existing`) and any debounced-but-not-yet-written copy
 * (`pending`). Returns whichever has more messages, or whichever is defined.
 */
export function pickBestKnown<T extends CaptureLike>(
  existing: T | null | undefined,
  pending: T | null | undefined
): T | null {
  if (pending && existing) {
    return pending.messages.length >= existing.messages.length ? pending : existing;
  }
  return pending ?? existing ?? null;
}

/**
 * Decides whether an incoming capture should be REJECTED in favor of a more
 * complete known snapshot.
 *
 * Rules:
 *   • A network capture (source === 'fetch-intercept') is authoritative and is
 *     never rejected — it carries full API history.
 *   • Otherwise, reject the incoming capture when it has STRICTLY FEWER messages
 *     than the best known snapshot (a shrunken DOM scrape).
 *   • Equal or greater counts are always accepted.
 */
export function shouldRejectIncoming(
  incomingCount: number,
  bestKnown: CaptureLike | null,
  isNetworkCapture: boolean
): boolean {
  if (isNetworkCapture) return false;
  if (!bestKnown) return false;
  return incomingCount < bestKnown.messages.length;
}
