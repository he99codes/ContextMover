// packages/browser-extension/src/lib/semantic-index/hasher.ts
//
// Fast deterministic hashing utilities for the semantic index.
// djb2 — chosen for raw speed; collision-resistance only needs to be
// good enough to detect content changes between captures.

import type { Message } from "../types";

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // 32-bit truncation
  }
  // toString(36) keeps ids short and URL-safe
  return (hash >>> 0).toString(36);
}

/**
 * Content-based hash of a message array. Catches edits, regenerations,
 * and order changes — anything that would invalidate stored embeddings.
 *
 * Uses role + first 100 chars of content per message: long enough to
 * detect meaningful changes, short enough to keep hashing under 1 ms
 * for sessions with hundreds of messages.
 */
export function hashMessages(messages: Message[]): string {
  const str = messages
    .map((m) => `${m.role}:${m.content.slice(0, 100)}`)
    .join("|");
  return djb2(str);
}

/** Hash a task/query string for retrieval-cache keying. */
export function hashQuery(query: string): string {
  return djb2(query);
}
