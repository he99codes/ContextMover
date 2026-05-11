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

// ── URL helpers ─────────────────────────────────────────────────────────────
export function urlKeyFromHref(platform: Platform, href: string): string {
  let path = "";
  try {
    const u = new URL(href);
    path = `${u.hostname}${u.pathname}${u.search}`.replace(/\/$/, "");
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
  try {
    const stored = await chrome.storage.local.get(URL_MAP_KEY);
    const map = stored?.[URL_MAP_KEY];
    return map && typeof map === "object" ? (map as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function saveMap(map: Record<string, string>): Promise<void> {
  try {
    await chrome.storage.local.set({ [URL_MAP_KEY]: map });
  } catch {
    /* storage quota or context invalidated — non-fatal */
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

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
  legacyChecker?: (legacyId: string) => Promise<boolean>
): Promise<string> {
  const key = urlKeyFromHref(platform, href);
  const map = await loadMap();

  if (map[key]) return map[key];

  let id: string | null = null;

  if (legacyChecker) {
    const candidate = legacySessionId(platform, href);
    try {
      const exists = await legacyChecker(candidate);
      if (exists) id = candidate;
    } catch {
      /* legacy lookup failed — fall through to minting */
    }
  }

  if (!id) id = mintRandomSessionId(platform);

  map[key] = id;
  await saveMap(map);
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
export function makeLegacyChecker(): (legacyId: string) => Promise<boolean> {
  return async (legacyId: string) => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "SESSION_EXISTS",
        sessionId: legacyId,
      });
      return Boolean(response?.exists);
    } catch {
      return false;
    }
  };
}
