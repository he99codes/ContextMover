/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/session-id.ts
//
// Source-of-truth session-id resolver for ContextMover.
//
// Design goals:
//   • A given AI conversation URL maps to ONE session id (stable across captures).
//   • Deleting a session forgets that URL → next capture mints a NEW random id,
//     so resuming the same AI conversation is treated as a fresh ContextMover
//     session that re-extracts the full visible history from the DOM.
//   • Backward-compatible with sessions captured under the old hash-based scheme:
//     when a URL has no mapping yet but a legacy-hash session already exists in
//     IndexedDB, we adopt that legacy id so the session is not orphaned.
//
// Storage layout (chrome.storage.local):
//   "cf:urlMap" → Record<urlKey, sessionId>
//   urlKey = `${platform}::${hostname}${pathname}${search}` (no trailing slash)
//
// Both content scripts (ISOLATED world) and the service worker can call into
// this module — chrome.storage.local is shared across both.

import type { Platform } from "./types";

const URL_MAP_KEY = "cf:urlMap";
const SESSION_MAP_KEY = "cf:urlMap:session"; // [ISSUE-18] backup in chrome.storage.session (survives SW restart)

// [FIX-1] In-memory cache for the URL→sessionId map.
// Survives "Extension context invalidated" errors where chrome.storage.local
// becomes inaccessible. Without this, a failed saveMap() wipes the map and
// the next resolveSessionId() mints a new ID for the same URL.
let _memoryCache: Record<string, string> | null = null;

// ── URL helpers ─────────────────────────────────────────────────────────────
export function urlKeyFromHref(platform: Platform, href: string): string {
  let path = "";
  try {
    const u = new URL(href);
    let search = u.search;
    
    // Strip platform-specific tracking/session parameters that don't affect conversation identity
    if (platform === "grok") {
      // Remove ?rid= parameter for Grok — it's a request ID, not conversation ID
      const params = new URLSearchParams(u.search);
      params.delete("rid");
      search = params.toString() ? `?${params.toString()}` : "";
    } else if (platform === "chatgpt") {
      // ChatGPT might have ?model= or other tracking params
      const params = new URLSearchParams(u.search);
      // Keep conversation ID but remove model/tracking params
      const conversationId = params.get("c");
      search = conversationId ? `?c=${conversationId}` : "";
    } else if (platform === "perplexity") {
      // Perplexity URLs are stable by pathname alone
      search = "";
    } else if (platform === "gemini") {
      // Gemini conversation ID is in the pathname (/app/<id>), not hash or search.
      search = "";
    }
    
    path = `${u.hostname}${u.pathname}${search}`.replace(/\/$/, "");
  } catch {
    path = href;
  }
  return `${platform}::${path}`;
}

// Legacy id derivation — must stay byte-identical to the old generateSessionId
// so existing IndexedDB rows match. New captures only use this as a fallback.
export function legacySessionId(platform: Platform, href: string): string {
  let path = "";
  try {
    const u = new URL(href);
    path = `${u.hostname}${u.pathname}${u.search}`.replace(/\/$/, "");
  } catch {
    path = href;
  }
  let hash = 7;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash * 31 + path.charCodeAt(i)) >>> 0);
  }
  return `${platform}-${hash.toString(36)}`;
}

function mintRandomSessionId(platform: Platform): string {
  // Prefer crypto.randomUUID, fallback for older runtimes.
  const raw =
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`)
      .replace(/-/g, "");
  return `${platform}-${raw.slice(0, 10)}`;
}

// ── Storage primitives ──────────────────────────────────────────────────────
async function loadMap(): Promise<Record<string, string>> {
  // Try chrome.storage.local first (primary)
  try {
    const stored = await chrome.storage.local.get(URL_MAP_KEY);
    const map = stored?.[URL_MAP_KEY];
    if (map && typeof map === "object") {
      _memoryCache = map as Record<string, string>;
      // Also sync to session storage for SW restart resilience
      try { await chrome.storage.session.set({ [SESSION_MAP_KEY]: map }); } catch {}
      return _memoryCache;
    }
  } catch {
    // chrome.storage.local failed — try session storage, then memory cache
  }
  // Try chrome.storage.session (survives SW context invalidation)
  try {
    const sessionStored = await chrome.storage.session.get(SESSION_MAP_KEY);
    const sessionMap = sessionStored?.[SESSION_MAP_KEY];
    if (sessionMap && typeof sessionMap === "object") {
      _memoryCache = sessionMap as Record<string, string>;
      console.log(`[CM:session-id] loadMap: local failed, using session storage (${Object.keys(_memoryCache).length} entries)`);
      return _memoryCache;
    }
  } catch {}
  // Fall back to memory cache if available
  if (_memoryCache) {
    console.log(`[CM:session-id] loadMap: all storage failed, using memory cache (${Object.keys(_memoryCache).length} entries)`);
    return _memoryCache;
  }
  return {};
}

async function saveMap(map: Record<string, string>): Promise<void> {
  // Always update the in-memory cache first — this survives context invalidation
  _memoryCache = map;
  // Write to both local and session storage in parallel for maximum resilience
  const writes = [
    chrome.storage.local.set({ [URL_MAP_KEY]: map }).catch((err: unknown) => {
      console.error(`[CM:session-id] local storage save error (memory cache preserved):`, err);
    }),
  ];
  // chrome.storage.session survives SW context invalidation/restart
  try {
    writes.push(chrome.storage.session.set({ [SESSION_MAP_KEY]: map }).catch(() => {}));
  } catch {}
  await Promise.all(writes);
}

// ── Public API ──────────────────────────────────────────────────────────────

// Per-key in-flight lock — prevents two concurrent resolveSessionId() calls
// for the same URL from both seeing map[key]===undefined, both minting different
// random IDs, and the second saveMap() silently orphaning the first ID.
// The Map is keyed by urlKey; value is the in-progress promise.
const _resolvingKeys = new Map<string, Promise<string>>();

/**
 * Resolve the session id for a given (platform, href).
 *
 * Lookup order:
 *   1. URL map in chrome.storage.local (fast path).
 *   2. Legacy hash id if a session with that id already exists in IndexedDB
 *      (the SW resolves this via the RESOLVE_LEGACY_ID message).
 *   3. Mint a fresh random id and store it in the URL map.
 *
 * `legacyChecker` is optional so this module works in BOTH:
 *   • Content scripts (pass an async function that asks the SW via
 *     chrome.runtime.sendMessage).
 *   • Service worker (pass a function that calls db.getSession directly).
 */
export async function resolveSessionId(
  platform: Platform,
  href: string,
  legacyChecker?: (legacyId: string, nativeId?: string) => Promise<string | null>,
  forceNew = false
): Promise<string> {
  const key = urlKeyFromHref(platform, href);

  // forceNew bypasses the lock — it intentionally replaces the existing entry.
  if (!forceNew) {
    // Fast path — check map before acquiring lock (avoids lock overhead on hot path).
    const map = await loadMap();
    if (map[key]) {
      console.log(`[CM:session-id] ${platform}: URL key "${key}" → existing sessionId=${map[key]}`);
      return map[key];
    }

    // Coalesce concurrent callers for the same key on the same promise.
    const inflight = _resolvingKeys.get(key);
    if (inflight) {
      console.log(`[CM:session-id] ${platform}: coalescing on in-flight resolve for "${key}"`);
      return inflight;
    }
  }

  const promise = _doResolveSessionId(key, platform, href, legacyChecker, forceNew);
  // CRITICAL: set the key synchronously BEFORE the first await so any concurrent
  // caller that races past the fast-path check above will see the in-flight promise.
  if (!forceNew) _resolvingKeys.set(key, promise);
  try {
    return await promise;
  } finally {
    _resolvingKeys.delete(key);
  }
}

async function _doResolveSessionId(
  key: string,
  platform: Platform,
  href: string,
  legacyChecker?: (legacyId: string, nativeId?: string) => Promise<string | null>,
  forceNew = false
): Promise<string> {
  const map = await loadMap();

  // forceNew: SPA "New chat" detected — URL didn't change but the conversation
  // did. Mint a fresh ID and overwrite the URL map entry.
  if (forceNew) {
    const id = mintRandomSessionId(platform);
    console.log(`[CM:session-id] ${platform}: forceNew — URL key "${key}" → NEW sessionId=${id} (replacing ${map[key] ?? 'none'})`);
    map[key] = id;
    await saveMap(map);
    return id;
  }

  // Re-check after acquiring the lock — a concurrent caller may have just written it.
  if (map[key]) {
    console.log(`[CM:session-id] ${platform}: URL key "${key}" → existing sessionId=${map[key]} (post-lock)`);
    return map[key];
  }

  console.log(`[CM:session-id] ${platform}: URL key "${key}" NOT in map. Current map size: ${Object.keys(map).length}`);

  let id: string | null = null;
  const nativeId = extractNativeId(platform, href);

  // Try legacy hash-based id for backward compatibility, and nativeId for Drive sync restores
  if (legacyChecker) {
    const candidate = legacySessionId(platform, href);
    try {
      const matchedId = await legacyChecker(candidate, nativeId);
      if (matchedId) {
        id = matchedId;
        console.log(`[CM:session-id] ${platform}: URL key "${key}" → matched sessionId=${id}`);
      }
    } catch (err) {
      console.warn(`[CM:session-id] ${platform}: legacy lookup failed:`, err);
    }
  }

  // Mint fresh random sessionId
  if (!id) {
    id = mintRandomSessionId(platform);
    console.log(`[CM:session-id] ${platform}: URL key "${key}" → NEW sessionId=${id}`);
  }

  map[key] = id;
  await saveMap(map);
  console.log(`[CM:session-id] ${platform}: Saved mapping: "${key}" → "${id}"`);
  return id;
}

/** Drop every URL→id entry that points at the given session id. */
export async function forgetSession(sessionId: string): Promise<void> {
  const map = await loadMap();
  let changed = false;
  for (const k of Object.keys(map)) {
    if (map[k] === sessionId) {
      delete map[k];
      changed = true;
    }
  }
  if (changed) await saveMap(map);
}

/** Clear the entire URL map (used when the user signs out / wipes data). */
export async function clearAllSessionMappings(): Promise<void> {
  try {
    await chrome.storage.local.remove(URL_MAP_KEY);
  } catch {
    /* non-fatal */
  }
}

/** Convenience helper for content scripts: ask the SW if a legacy id exists. */
export function makeLegacyChecker(): (legacyId: string, nativeId?: string) => Promise<string | null> {
  return async (legacyId: string, nativeId?: string) => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "SESSION_EXISTS",
        sessionId: legacyId,
        nativeId: nativeId,
      });
      return response?.id || (response?.exists ? legacyId : null);
    } catch {
      return null;
    }
  };
}

export function extractNativeId(platform: Platform, href: string): string | undefined {
  try {
    const u = new URL(href);
    if (platform === "chatgpt") {
      const match = u.pathname.match(/^\/c\/([a-zA-Z0-9-]+)/);
      if (match) return match[1];
    } else if (platform === "claude") {
      const match = u.pathname.match(/^\/chat\/([a-zA-Z0-9-]+)/);
      if (match) return match[1];
    } else if (platform === "grok") {
      const match = u.pathname.match(/^\/(?:chat|conversation)\/([a-zA-Z0-9-]+)/);
      if (match) return match[1];
    } else if (platform === "gemini") {
      const match = u.pathname.match(/^\/app\/([a-zA-Z0-9-]+)/);
      if (match) return match[1];
    } else if (platform === "deepseek") {
      const match = u.pathname.match(/^\/(?:a\/chat\/s|chat)\/([a-zA-Z0-9-]+)/);
      if (match) return match[1];
    }
  } catch {}
  return undefined;
}

