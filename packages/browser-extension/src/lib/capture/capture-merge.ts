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
 *   • A network capture (source === 'fetch-intercept') is normally authoritative
 *     and carries full API history — BUT only if it has at least as many messages
 *     as the best known snapshot. A 1-msg auth/JWT intercept is NOT authoritative.
 *   • [PHASE-5-FIX] If isNetworkCapture but incomingCount < bestKnown.messages.length,
 *     reject it — it is a lossy/partial intercept, not a full API history response.
 *   • Otherwise, reject the incoming capture when it has STRICTLY FEWER messages
 *     than the best known snapshot (a shrunken DOM scrape).
 *   • Equal or greater counts are always accepted.
 */
export function shouldRejectIncoming(
  incomingCount: number,
  bestKnown: CaptureLike | null,
  isNetworkCapture: boolean
): boolean {
  if (!bestKnown) return false;
  // [PHASE-5-FIX] Network captures are authoritative only when they have >= messages.
  // A 1-msg auth intercept (JWT title, session-state endpoint) must not clobber
  // a fuller DOM snapshot. Apply the same count guard regardless of source.
  if (isNetworkCapture && incomingCount >= bestKnown.messages.length) return false;
  return incomingCount < bestKnown.messages.length;
}

function _fp(m: { role: string; content: string }): string {
  return `${m.role}::${m.content.slice(0, 80).replace(/\s+/g, " ").trim()}`;
}

/**
 * Merges a partial DOM scrape into the existing snapshot using content
 * fingerprinting (role + first 80 chars). Messages already present are
 * kept at their longer copy; messages NOT in the existing snapshot are
 * appended. This ensures new messages arriving via partial DOM scrapes
 * (after virtual scroll eviction) are not lost.
 */
export function mergePartialScrape<T extends { role: string; content: string }>(
  existing: T[],
  incoming: T[]
): T[] {
  const out = [...existing];
  const used = new Set<number>();
  for (const m of incoming) {
    const fp = _fp(m);
    let idx = -1;
    for (let i = 0; i < out.length; i++) {
      if (!used.has(i) && _fp(out[i]) === fp) { idx = i; break; }
    }
    if (idx >= 0) {
      if (m.content.length >= out[idx].content.length) out[idx] = m;
    } else {
      out.push(m);
    }
  }
  return out;
}
