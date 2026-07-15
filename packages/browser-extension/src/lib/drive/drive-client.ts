/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// src/lib/drive/drive-client.ts
//
// Thin wrapper around the Google Drive REST API restricted to the
// `drive.appdata` scope. Everything stored here goes into a hidden
// per-app folder that is invisible to the user's normal Drive UI and
// completely inaccessible to any other extension or web app.
//
// IMPORTANT — what this file is and is NOT:
//   - It is the ONLY place that imports/touches Google Drive APIs.
//   - It is completely independent of the existing Supabase user-vault
//     code (see src/lib/cloud-sync.ts). They never coordinate.
//   - It never throws to the caller. Every public method is wrapped in
//     try/catch and returns a sentinel (false / null / [] / void).
//
// Auth model (two parallel paths, transparent to callers):
//   1. chrome.identity.getAuthToken — the primary path. Requires the
//      OAuth client in Google Cloud Console to be of type
//      "Chrome Extension" with the matching extension ID. Caches the
//      token internally; we don't manage caching for this path.
//   2. chrome.identity.launchWebAuthFlow — fallback used when (1) fails
//      interactively. Works with any OAuth client type but requires
//      `https://<extension-id>.chromiumapp.org/` to be added as an
//      authorized redirect URI in the Google Cloud OAuth client.
//      We cache the resulting token ourselves in chrome.storage.local
//      since launchWebAuthFlow does not.
//
// Routine calls use { interactive: false } and never prompt.
// connect() is the ONLY caller that requests interactive auth.

import type { ContextSession } from "@/lib/types";
import type { ChunkEmbedding, SessionHash } from "@/lib/db";

// --- Compression helpers (gzip via CompressionStream) ---
// [FAST-SYNC] Used for bundle upload/download — reduces bandwidth ~60%.
// [FIX-H/P] Chunked base64 conversion — String.fromCharCode(...spread)
// and atob() crash with "Maximum call stack size exceeded" on large buffers
// (>100KB). These chunked versions handle arbitrarily large payloads.
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 8192) {
    const chunk = bin.slice(i, i + 8192);
    for (let j = 0; j < chunk.length; j++) {
      bytes[i + j] = chunk.charCodeAt(j);
    }
  }
  return bytes;
}

async function compressJSON(data: unknown): Promise<string> {
  const json = JSON.stringify(data);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

async function decompressJSON(b64: string): Promise<unknown> {
  const bytes = base64ToBytes(b64);
  const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

// [OPTION-B] encodeEmbedding/decodeEmbedding removed — embeddings not synced via Drive.

const DRIVE_FILES_BASE = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files";

export interface DriveSessionIndexEntry {
  id: string;
  platform: string;
  title: string;
  customName?: string;
  messageCount: number;
  updatedAt: number;
  driveFileId: string;
}

export interface TombstoneEntry {
  sessionId: string;
  profileId: string;
  deletedAt: number;
  reason?: string;
}

export interface DriveIndex {
  version: number;
  lastSync: number;
  profileId: string;
  sessions: DriveSessionIndexEntry[];
  tombstones?: (string | TombstoneEntry)[];
  bundleVersion?: number;       // [FAST-SYNC] bumped when sessions bundle changes
  // [OPTION-B] embeddingsVersion removed — embeddings not synced via Drive.
}

const INDEX_FILE_NAME = "cm-index.json";
const SESSION_FILE_PREFIX = "session-";
const CHUNKS_FILE_PREFIX = "chunks-";
const HASH_FILE_PREFIX = "hash-";

// [FAST-SYNC] Bundle file names — single API call for all sessions/embeddings
const SESSIONS_BUNDLE_FILE = "cm-sessions-bundle.json";
// [OPTION-B] EMBEDDINGS_BUNDLE_FILE removed.
// [OPTION-B] SINGLE_EMBEDDINGS_PREFIX removed.

// [OPTION-B] EmbeddingsBundle interface removed — embeddings not synced via Drive.

// launchWebAuthFlow does not cache tokens — we do it ourselves here.
// Google access tokens are valid for ~3600s; we refresh slightly early.
const FLOW_TOKEN_KEY = "drive.flowToken";
const FLOW_TOKEN_AT_KEY = "drive.flowTokenAt";
const FLOW_TOKEN_TTL_MS = 55 * 60 * 1000;

class DriveClient {
  // Cache file name → Drive file ID to skip redundant findFile API calls.
  // Invalidated on 404 (file deleted) and on wipeAllRemote.
  private fileIdCache: Map<string, string> = new Map();

  // [PHASE-6-FIX] Persist cache to session storage to survive service worker restarts.
  private _cacheRestorePromise: Promise<void> | null = null;
  private _ensureCacheRestored(): Promise<void> {
    if (typeof chrome === "undefined" || !chrome.storage?.session) return Promise.resolve();
    if (!this._cacheRestorePromise) {
      this._cacheRestorePromise = chrome.storage.session.get("drive.fileIdCache").then(data => {
        const stored = data["drive.fileIdCache"];
        if (stored && typeof stored === "object") {
          for (const [k, v] of Object.entries(stored)) {
            if (!this.fileIdCache.has(k)) this.fileIdCache.set(k, v as string);
          }
        }
      }).catch(() => {});
    }
    return this._cacheRestorePromise;
  }

  private _persistCache() {
    if (typeof chrome === "undefined" || !chrome.storage?.session) return;
    chrome.storage.session.set({ "drive.fileIdCache": Object.fromEntries(this.fileIdCache) }).catch(() => {});
  }

  // Back-off timestamp to prevent rapid silent-refresh retry loops.
  // Set on silent refresh failure; cleared once 60s have elapsed.
  private _refreshFailureAt = 0;

  /**
   * Resolve an OAuth token via launchWebAuthFlow exclusively.
   *
   * chrome.identity.getAuthToken is intentionally skipped. It requires
   * the extension ID to be registered under "Chrome Apps" in Google Cloud
   * Console, which is only possible AFTER Chrome Web Store publish.
   * Pre-publish and sideloaded installs always receive "bad client id".
   *
   * TODO (post-publish): add the production extension ID to the OAuth
   * client in Google Cloud Console, then consider re-enabling getAuthToken
   * as a fast-path for already-signed-in users.
   *
   * Never throws — returns null on any failure.
   */
  private async getToken(interactive = false): Promise<string | null> {
    if (typeof chrome === "undefined" || !chrome.identity) return null;

    // 0. If user explicitly disconnected, never silently reconnect.
    if (!interactive) {
      try {
        const stored = await chrome.storage.local.get("drive.explicitlyDisconnected");
        if (stored["drive.explicitlyDisconnected"]) return null;
      } catch {}
    }

    // 1. chrome.identity.getAuthToken — handles automatic refresh via Chrome's internal token cache
    const authToken = await this.callGetAuthToken(interactive);
    if (authToken) return authToken;

    // 2. Our own launchWebAuthFlow token cache. Valid for ~55 min.
    const cached = await this.readFlowToken();
    if (cached) return cached;

    // 3. Non-interactive: try silent refresh via launchWebAuthFlow with prompt=none.
    //    This keeps Drive connected across Chrome restarts without user prompts.
    //    Google silently re-issues a token if the user is still signed in to Chrome.
    if (!interactive) {
      // Cache refresh failures for 60s to avoid rapid retry loops.
      if (this._refreshFailureAt && Date.now() - this._refreshFailureAt < 60_000) {
        return null;
      }
      const refreshed = await this.callLaunchWebAuthFlowSilent();
      if (refreshed) {
        await this.writeFlowToken(refreshed);
        this._refreshFailureAt = 0; // clear back-off on success
        return refreshed;
      }
      this._refreshFailureAt = Date.now();
      return null;
    }

    // 4. launchWebAuthFlow — interactive fallback path
    const flowToken = await this.callLaunchWebAuthFlow();
    if (flowToken) await this.writeFlowToken(flowToken);
    return flowToken;
  }

  /** Single getAuthToken invocation, normalized to a string|null Promise. */
  private callGetAuthToken(interactive: boolean): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        chrome.identity.getAuthToken({ interactive }, (token) => {
          if (chrome.runtime.lastError || !token) {
            if (interactive) {
              console.error("[CM:drive] getAuthToken failed:",
                chrome.runtime.lastError?.message ?? "no token returned");
            }
            void chrome.runtime.lastError; // silence "Unchecked" warning
            resolve(null);
            return;
          }
          resolve(typeof token === "string"
            ? token
            : (token as { token?: string }).token ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Fallback OAuth via chrome.identity.launchWebAuthFlow. Used when
   * getAuthToken fails interactively — typically because the OAuth client
   * in Google Cloud Console is not of type "Chrome Extension".
   * Requires `https://<extension-id>.chromiumapp.org/` to be registered
   * as an authorized redirect URI on the OAuth client.
   */
  private callLaunchWebAuthFlow(): Promise<string | null> {
    const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
      oauth2?: { client_id?: string; scopes?: string[] };
    };
    const clientId = manifest.oauth2?.client_id;
    const scopes = manifest.oauth2?.scopes ?? [];
    if (!clientId) {
      console.error("[CM:drive] launchWebAuthFlow: missing oauth2.client_id in manifest");
      return Promise.resolve(null);
    }
    if (!chrome.identity?.launchWebAuthFlow) {
      console.error("[CM:drive] launchWebAuthFlow: chrome.identity.launchWebAuthFlow unavailable");
      return Promise.resolve(null);
    }

    const redirectUri = chrome.identity.getRedirectURL();
    // One-time hint so the user can correct Google Cloud config if needed.
    console.warn(
      "[CM:drive] Falling back to launchWebAuthFlow. " +
      "If this fails, ensure this redirect URL is registered on the OAuth client in Google Cloud Console:\n  " +
      redirectUri
    );

    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth" +
      "?client_id=" + encodeURIComponent(clientId) +
      "&response_type=token" +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&scope=" + encodeURIComponent(scopes.join(" ")) +
      "&prompt=consent";

    console.log("[CM:drive] using client_id:", clientId);
    console.log("[CM:drive] full auth URL:", authUrl);

    return new Promise((resolve) => {
      try {
        chrome.identity.launchWebAuthFlow(
          { url: authUrl, interactive: true },
          (responseUrl) => {
            if (chrome.runtime.lastError || !responseUrl) {
              console.error("[CM:drive] launchWebAuthFlow failed:",
                chrome.runtime.lastError?.message ?? "no response");
              void chrome.runtime.lastError;
              resolve(null);
              return;
            }
            const match = responseUrl.match(/[#&]access_token=([^&]+)/);
            const token = match?.[1] ? decodeURIComponent(match[1]) : null;
            if (!token) {
              console.error("[CM:drive] launchWebAuthFlow: no access_token in response");
              resolve(null);
              return;
            }
            resolve(token);
          }
        );
      } catch (e) {
        console.error("[CM:drive] launchWebAuthFlow threw:", e);
        resolve(null);
      }
    });
  }

  /**
   * Silent (non-interactive) token refresh via launchWebAuthFlow with prompt=none.
   * Called automatically on every non-interactive getToken() cache miss to keep
   * Drive connected across Chrome restarts without user prompts.
   *
   * Google re-issues the token silently if the user is still signed into their
   * Google account in Chrome. We pass `login_hint` (the cached driveEmail) so
   * Google skips the account picker and goes directly to the right account.
   *
   * Returns null silently on failure — no console error, no user-visible impact.
   */
  private async callLaunchWebAuthFlowSilent(): Promise<string | null> {
    const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
      oauth2?: { client_id?: string; scopes?: string[] };
    };
    const clientId = manifest.oauth2?.client_id;
    const scopes = manifest.oauth2?.scopes ?? [];
    if (!clientId || !chrome.identity?.launchWebAuthFlow) return null;

    const redirectUri = chrome.identity.getRedirectURL();

    // Pass login_hint so Google skips the account picker — critical for
    // seamless silent re-auth when the user has multiple Google accounts.
    let loginHint = "";
    try {
      const stored = await chrome.storage.local.get("driveEmail");
      if (stored.driveEmail && typeof stored.driveEmail === "string") {
        loginHint = "&login_hint=" + encodeURIComponent(stored.driveEmail);
      }
    } catch { /* non-fatal */ }

    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth" +
      "?client_id=" + encodeURIComponent(clientId) +
      "&response_type=token" +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&scope=" + encodeURIComponent(scopes.join(" ")) +
      "&prompt=none" +
      loginHint;

    return new Promise((resolve) => {
      try {
        chrome.identity.launchWebAuthFlow(
          { url: authUrl, interactive: false },
          (responseUrl) => {
            if (chrome.runtime.lastError || !responseUrl) {
              void chrome.runtime.lastError;
              resolve(null);
              return;
            }
            const match = responseUrl.match(/[#&]access_token=([^&]+)/);
            resolve(match?.[1] ? decodeURIComponent(match[1]) : null);
          }
        );
      } catch {
        resolve(null);
      }
    });
  }

  /** Read our launchWebAuthFlow token cache; returns null if absent or expired. */
  private async readFlowToken(): Promise<string | null> {
    try {
      const stored = await chrome.storage.local.get([FLOW_TOKEN_KEY, FLOW_TOKEN_AT_KEY]);
      const tok = stored[FLOW_TOKEN_KEY] as string | undefined;
      const at = stored[FLOW_TOKEN_AT_KEY] as number | undefined;
      if (tok && typeof at === "number" && Date.now() - at < FLOW_TOKEN_TTL_MS) return tok;
    } catch (err) {
      console.warn("[CM:drive] readFlowToken failed:", err instanceof Error ? err.message : err);
    }
    return null;
  }

  private async writeFlowToken(token: string): Promise<void> {
    try {
      await chrome.storage.local.set({
        [FLOW_TOKEN_KEY]: token,
        [FLOW_TOKEN_AT_KEY]: Date.now(),
      });
    } catch (err) {
      console.warn("[CM:drive] writeFlowToken failed:", err instanceof Error ? err.message : err);
    }
  }

  private async clearFlowToken(): Promise<void> {
    try {
      await chrome.storage.local.remove([FLOW_TOKEN_KEY, FLOW_TOKEN_AT_KEY]);
    } catch (err) {
      console.warn("[CM:drive] clearFlowToken failed:", err instanceof Error ? err.message : err);
    }
  }

  async isTokenValid(): Promise<boolean> {
    // Check both token sources: getAuthToken (primary) and flow token (fallback).
    // Previously only checked flow token cache, returning false for getAuthToken users.
    const t = await this.getToken(false);
    return t !== null;
  }

  /** Proactively refresh token if within 5 min of expiry — prevents gaps during Drive sync. */
  private async maybeRefreshToken(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get([FLOW_TOKEN_KEY, FLOW_TOKEN_AT_KEY]);
      const at = stored[FLOW_TOKEN_AT_KEY] as number | undefined;
      if (!at) return;
      // If token expires in < 5 min, proactively try silent refresh now.
      const remaining = FLOW_TOKEN_TTL_MS - (Date.now() - at);
      if (remaining < 5 * 60 * 1000 && remaining > 0) {
        const refreshed = await this.callLaunchWebAuthFlowSilent();
        if (refreshed) {
          await this.writeFlowToken(refreshed);
          this._refreshFailureAt = 0;
        }
      }
    } catch {
      // Non-fatal — let the token expire naturally.
    }
  }

  /** Pure connection check — never prompts the user. */
  async isConnected(): Promise<boolean> {
    await this.maybeRefreshToken();
    const t = await this.getToken(false);
    return t !== null;
  }

  private _driveEmail: string | null | undefined;

  async getDriveEmail(): Promise<string | null> {
    // [FIX-17] Only cache a SUCCESSFUL lookup. Previously a transient failure
    // (e.g. the OAuth token not yet hydrated right after a service-worker
    // wake) cached `null` permanently for this SW instance's lifetime — every
    // later request then silently omitted x-drive-email, which for a seat
    // account (no subscription of its own) meant Pro could never resolve
    // even after the user's Drive connection succeeded moments later.
    if (this._driveEmail) return this._driveEmail;
    try {
      const token = await this.getToken(false);
      if (!token) return null;
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const email = (data.email as string) ?? null;
      if (email) this._driveEmail = email;
      return email;
    } catch {
      return null;
    }
  }

  private _connectInFlight: Promise<boolean> | null = null;

  async connect(): Promise<boolean> {
    if (this._connectInFlight) return this._connectInFlight;
    this._connectInFlight = (async () => {
      try { 
        await chrome.storage.local.remove("drive.explicitlyDisconnected");
        return (await this.getToken(true)) !== null; 
      }
      finally { this._connectInFlight = null; }
    })();
    return this._connectInFlight;
  }

  /** Revoke cached tokens (both auth paths) + clear local drive state. */
  async disconnect(): Promise<void> {
    // 1. Revoke chrome.identity.getAuthToken cache, if any.
    try {
      const t = await this.callGetAuthToken(false);
      if (t && chrome.identity?.removeCachedAuthToken) {
        await new Promise<void>((resolve) =>
          chrome.identity.removeCachedAuthToken({ token: t }, () => resolve())
        );
      }
    } catch (err) {
      console.warn("[CM:drive] disconnect: revoking getAuthToken failed:", err instanceof Error ? err.message : err);
    }
    // 2. Clear our launchWebAuthFlow token cache.
    await this.clearFlowToken();
    // 3. Clear local-only drive sync metadata and mark as disconnected.
    this._driveEmail = undefined;
    try {
      await chrome.storage.local.remove([
        "drive.lastSyncAt",
        "drive.sourcedIds",
        "drive.profileId",
        "drive.lastSyncCount",
      ]);
      await chrome.storage.local.set({ "drive.explicitlyDisconnected": true });
    } catch (err) {
      console.warn("[CM:drive] disconnect: clearing storage failed:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * Authenticated fetch helper. Adds Authorization header.
   * On 401: invalidates the cached token, requests a fresh one
   * (still non-interactive), and retries once.
   */
  private async apiCall(url: string, options: RequestInit = {}): Promise<Response> {
    let token = await this.getToken(false);
    if (!token) throw new Error("drive: no token");

    const doFetch = (tok: string) => {
      console.debug(`[CM:drive] apiCall ${options.method ?? "GET"} ${url.slice(0, 80)} token.length=${tok.length}`);
      return fetch(url, {
        ...options,
        headers: {
          ...(options.headers ?? {}),
          Authorization: `Bearer ${tok}`,
        },
      }).catch((err: unknown) => {
        console.error("[CM:drive] fetch failed — full error:", err, "url:", url);
        throw err;
      });
    };

    let res: Response;
    try {
      res = await doFetch(token);
    } catch (fetchErr) {
      // [MED-3/SW-3 FIX] Retry with backoff on network errors (TypeError: Failed to fetch).
      // [ISSUE-4] Exponential backoff: 2s → 4s → 8s (3 retries total).
      // Don't retry on 401 — that's a token issue handled below.
      // [BUG-4/13 FIX] Keep SW alive during backoff waits — setTimeout doesn't
      // survive SW termination, so we ping chrome.runtime every 25s.
      const keepAlive = setInterval(() => {
        try { chrome.runtime.getPlatformInfo(() => {}); } catch {}
      }, 25_000);
      try {
        const backoffMs = [2000, 4000, 8000];
        for (let i = 0; i < backoffMs.length; i++) {
          console.warn(`[CM:drive] apiCall retry ${i + 1}/${backoffMs.length} after ${backoffMs[i]}ms`);
          await new Promise((r) => setTimeout(r, backoffMs[i]));
          // Refresh token in case it expired during the wait.
          token = await this.getToken(false);
          if (!token) throw new Error("drive: no token after retry");
          try {
            res = await doFetch(token);
            break;
          } catch (retryErr) {
            if (i === backoffMs.length - 1) throw retryErr;
          }
        }
        // If we get here, res was set by a successful retry
        if (!res!) throw fetchErr;
      } finally {
        clearInterval(keepAlive);
      }
    }

    if (res!.status === 401) {
      // Token expired or revoked — drop both caches and try once more.
      try {
        await new Promise<void>((resolve) =>
          chrome.identity.removeCachedAuthToken({ token: token! }, () => resolve())
        );
      } catch { /* ignore */ }
      await this.clearFlowToken();
      const fresh = await this.getToken(false);
      if (!fresh) return res!; // give up; caller handles
      res = await doFetch(fresh);
    } else if (res!.status === 404) {
      // [MED-3 FIX] Clear fileIdCache on 404 — stale cached IDs cause repeated failures.
      // Extract filename from URL to clear the specific cache entry.
      for (const [name, id] of this.fileIdCache) {
        if (url.includes(encodeURIComponent(id))) {
          this.fileIdCache.delete(name);
          this._persistCache();
          console.debug(`[CM:drive] cleared stale fileIdCache entry for ${name}`);
          break;
        }
      }
    }
    return res!;
  }

  /** Locate a file by exact name within the appDataFolder. */
  private async findFile(name: string): Promise<string | null> {
    try {
      await this._ensureCacheRestored();
      // Check cache first — avoids an API call on every upsert.
      const cached = this.fileIdCache.get(name);
      if (cached) return cached;
      const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and trashed=false`);
      const url =
        `${DRIVE_FILES_BASE}?spaces=appDataFolder&q=${q}` +
        `&fields=files(id,name)&pageSize=1`;
      const res = await this.apiCall(url, { method: "GET" });
      if (!res.ok) return null;
      const json = (await res.json()) as { files?: Array<{ id: string }> };
      const id = json.files?.[0]?.id ?? null;
      if (id) {
        this.fileIdCache.set(name, id);
        this._persistCache();
      }
      return id;
    } catch {
      return null;
    }
  }

  /**
   * Create-or-update a JSON file in the appDataFolder.
   * Uses multipart upload to set both metadata and body in one request.
   */
  private async upsertJsonFile(name: string, body: unknown): Promise<void> {
    try {
      const existingId = await this.findFile(name);
      const boundary = `cm_${Math.random().toString(36).slice(2)}`;
      const metadata = existingId
        ? { name }
        : { name, parents: ["appDataFolder"] };
      const multipart =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(body)}\r\n` +
        `--${boundary}--`;

      const url = existingId
        ? `${DRIVE_UPLOAD_BASE}/${existingId}?uploadType=multipart`
        : `${DRIVE_UPLOAD_BASE}?uploadType=multipart`;

      const res = await this.apiCall(url, {
        method: existingId ? "PATCH" : "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body: multipart,
      });
      if (!res.ok) {
        // If PATCH failed because the cached file ID is stale (file was
        // deleted), clear the cache so the next call re-queries Drive.
        if (existingId && res.status === 404) {
          this.fileIdCache.delete(name);
          this._persistCache();
          console.warn(`[drive] upsert ${name} got 404 — retrying as CREATE`);
          const retryMetadata = { name, parents: ["appDataFolder"] };
          const retryMultipart =
            `--${boundary}\r\n` +
            `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
            `${JSON.stringify(retryMetadata)}\r\n` +
            `--${boundary}\r\n` +
            `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
            `${JSON.stringify(body)}\r\n` +
            `--${boundary}--`;
          
          const retryRes = await this.apiCall(`${DRIVE_UPLOAD_BASE}?uploadType=multipart`, {
            method: "POST",
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
            body: retryMultipart,
          });
          
          if (retryRes.ok) {
            try {
              const respJson = await retryRes.json();
              if (respJson?.id) {
                this.fileIdCache.set(name, respJson.id);
                this._persistCache();
              }
            } catch { /* ignore */ }
            return;
          }
        }
        console.warn(
          `[drive] upsert ${name} failed: ${res.status} ${res.statusText}`
        );
      } else {
        // Cache the file ID from the response to skip findFile next time.
        try {
          const respJson = await res.json();
          if (respJson?.id) {
            this.fileIdCache.set(name, respJson.id);
            this._persistCache();
          }
        } catch { /* response parsing not critical */ }
      }
    } catch (e) {
      console.warn(`[drive] upsert ${name} error:`, e instanceof Error ? e.message : String(e), e);
    }
  }

  /** Upload (or update) a single session. Never throws. */
  async uploadSession(session: ContextSession): Promise<void> {
    if (!session?.id) return;
    const name = `${SESSION_FILE_PREFIX}${session.id}.json`;
    await this.upsertJsonFile(name, session);
  }

  /** Download a session by Drive file id. Returns null on any failure. */
  async downloadSession(fileId: string): Promise<ContextSession | null> {
    try {
      const url = `${DRIVE_FILES_BASE}/${encodeURIComponent(fileId)}?alt=media`;
      const res = await this.apiCall(url, { method: "GET" });
      if (!res.ok) return null;
      const parsed = (await res.json()) as Partial<ContextSession>;
      if (!parsed?.id || !Array.isArray(parsed.messages)) return null;
      return parsed as ContextSession;
    } catch {
      return null;
    }
  }

  /**
   * List session-*.json files in the appdata folder.
   * Returns [] on error.
   */
  async listSessionFiles(): Promise<Array<{ id: string; name: string; modifiedTime: string }>> {
    try {
      const out: Array<{ id: string; name: string; modifiedTime: string }> = [];
      let pageToken: string | undefined;
      // Paginated listing — appdata folders rarely exceed a few hundred files
      // but we paginate defensively to avoid silently dropping entries.
      do {
        const q = encodeURIComponent(`name contains '${SESSION_FILE_PREFIX}' and trashed=false`);
        const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
        const url =
          `${DRIVE_FILES_BASE}?spaces=appDataFolder&q=${q}` +
          `&fields=files(id,name,modifiedTime),nextPageToken&pageSize=200${tokenParam}`;
        const res = await this.apiCall(url, { method: "GET" });
        if (!res.ok) break;
        const json = (await res.json()) as {
          files?: Array<{ id: string; name: string; modifiedTime: string }>;
          nextPageToken?: string;
        };
        if (json.files) out.push(...json.files.filter((f) => f.name.startsWith(SESSION_FILE_PREFIX)));
        pageToken = json.nextPageToken;
      } while (pageToken);
      return out;
    } catch {
      return [];
    }
  }

  async uploadIndex(index: DriveIndex): Promise<void> {
    await this.upsertJsonFile(INDEX_FILE_NAME, index);
  }

  /**
   * Delete a file by Drive file id. Returns true on success.
   * Handles 404 (already deleted) gracefully — returns true.
   * Never throws.
   */
  async deleteFile(fileId: string): Promise<boolean> {
    try {
      const url = `${DRIVE_FILES_BASE}/${encodeURIComponent(fileId)}`;
      const res = await this.apiCall(url, { method: "DELETE" });
      if (res.status === 404) return true; // already gone
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Find a session file by sessionId (not Drive fileId).
   * Returns the Drive fileId if found, null otherwise.
   */
  async findFileBySessionId(sessionId: string): Promise<string | null> {
    const name = `${SESSION_FILE_PREFIX}${sessionId}.json`;
    return this.findFile(name);
  }

  /** Upload chunks for a session as a single JSON file. Never throws. */
  async uploadChunks(sessionId: string, chunks: ChunkEmbedding[]): Promise<void> {
    if (!sessionId || chunks.length === 0) return;
    const name = `${CHUNKS_FILE_PREFIX}${sessionId}.json`;
    await this.upsertJsonFile(name, { sessionId, chunks });
  }

  /** Download chunks by Drive file id. Returns null on failure. */
  async downloadChunks(fileId: string): Promise<ChunkEmbedding[] | null> {
    try {
      const url = `${DRIVE_FILES_BASE}/${encodeURIComponent(fileId)}?alt=media`;
      const res = await this.apiCall(url, { method: "GET" });
      if (!res.ok) return null;
      const parsed = (await res.json()) as { sessionId?: string; chunks?: ChunkEmbedding[] };
      if (!parsed?.chunks || !Array.isArray(parsed.chunks)) return null;
      return parsed.chunks;
    } catch {
      return null;
    }
  }

  /** Upload session hash (indexing state) to Drive. Never throws. */
  async uploadSessionHash(sessionId: string, hash: SessionHash): Promise<void> {
    if (!sessionId) return;
    const name = `${HASH_FILE_PREFIX}${sessionId}.json`;
    await this.upsertJsonFile(name, hash);
  }

  /** Download session hash by Drive file id. Returns null on failure. */
  async downloadSessionHash(fileId: string): Promise<SessionHash | null> {
    try {
      const url = `${DRIVE_FILES_BASE}/${encodeURIComponent(fileId)}?alt=media`;
      const res = await this.apiCall(url, { method: "GET" });
      if (!res.ok) return null;
      const parsed = (await res.json()) as Partial<SessionHash>;
      if (!parsed?.sessionId) return null;
      return parsed as SessionHash;
    } catch {
      return null;
    }
  }

  /** Find a chunks file by sessionId. Returns Drive fileId or null. */
  async findChunksBySessionId(sessionId: string): Promise<string | null> {
    const name = `${CHUNKS_FILE_PREFIX}${sessionId}.json`;
    return this.findFile(name);
  }

  /** Find a hash file by sessionId. Returns Drive fileId or null. */
  async findHashBySessionId(sessionId: string): Promise<string | null> {
    const name = `${HASH_FILE_PREFIX}${sessionId}.json`;
    return this.findFile(name);
  }

  async downloadIndex(): Promise<DriveIndex | null> {
    const id = await this.findFile(INDEX_FILE_NAME);
    if (!id) return null;
    const url = `${DRIVE_FILES_BASE}/${encodeURIComponent(id)}?alt=media`;
    const res = await this.apiCall(url, { method: "GET" });
    if (!res.ok) {
      if (res.status === 404) {
        this.fileIdCache.delete(INDEX_FILE_NAME);
        this._persistCache();
        return null;
      }
      throw new Error(`downloadIndex: HTTP ${res.status}`);
    }
    const parsed = (await res.json()) as Partial<DriveIndex>;
    if (!parsed || typeof parsed.version !== "number" || !Array.isArray(parsed.sessions)) {
      return null;
    }
    return parsed as DriveIndex;
  }

  /**
   * List ALL files in the appDataFolder (sessions, chunks, hashes, index).
   * Returns [] on error.
   */
  async listAllAppDataFiles(): Promise<Array<{ id: string; name: string }>> {
    try {
      const out: Array<{ id: string; name: string }> = [];
      let pageToken: string | undefined;
      do {
        const q = encodeURIComponent('trashed=false');
        const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
        const url =
          `${DRIVE_FILES_BASE}?spaces=appDataFolder&q=${q}` +
          `&fields=files(id,name),nextPageToken&pageSize=200${tokenParam}`;
        const res = await this.apiCall(url, { method: "GET" });
        if (!res.ok) break;
        const json = (await res.json()) as {
          files?: Array<{ id: string; name: string }>;
          nextPageToken?: string;
        };
        if (json.files) out.push(...json.files);
        pageToken = json.nextPageToken;
      } while (pageToken);
      return out;
    } catch {
      return [];
    }
  }

  /**
   * [PRIVACY] Wipe all ContextMover data from Google Drive.
   * Lists all appdata files (sessions, chunks, hashes, index) and deletes each.
   */
  async wipeAllRemote(): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;
    try {
      const files = await this.listAllAppDataFiles();
      console.log(`[CM:drive] wipeAllRemote — found ${files.length} files to delete`);
      // [DEEP FIX C] Parallelize deletions (8 concurrent) — sequential deletion
      // of 70+ files took 60+ seconds. With concurrency, ~10s for 70 files.
      const DELETE_CONCURRENCY = 8;
      let idx = 0;
      const runNextDelete = async (): Promise<void> => {
        while (idx < files.length) {
          const file = files[idx++];
          const ok = await this.deleteFile(file.id).catch(() => false);
          if (ok) deleted++;
          else failed++;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DELETE_CONCURRENCY, files.length) }, runNextDelete)
      );
      console.log(`[CM:drive] wipeAllRemote — deleted: ${deleted}, failed: ${failed}`);
      this.fileIdCache.clear();
      this._persistCache();
    } catch (e) {
      console.warn("[CM:drive] wipeAllRemote failed:", e);
    }
    return { deleted, failed };
  }

  // ─── [FAST-SYNC] Bundle upload/download methods ──────────────────────────

  /**
   * [FAST-SYNC] Upload all sessions as a single compressed bundle.
   * Replaces N individual uploadSession calls with 1 API call.
   */
  async uploadSessionsBundle(sessions: ContextSession[]): Promise<void> {
    if (!sessions || sessions.length === 0) return;
    try {
      const compressed = await compressJSON(sessions);
      await this.upsertJsonFile(SESSIONS_BUNDLE_FILE, { data: compressed });
      console.log(`[CM:drive] sessions bundle uploaded: ${sessions.length} sessions`);
    } catch (e) {
      console.warn("[CM:drive] uploadSessionsBundle failed:", e);
    }
  }

  /**
   * [FAST-SYNC] Download and decompress the sessions bundle.
   * Returns null if the bundle doesn't exist or is corrupted.
   */
  async downloadSessionsBundle(): Promise<ContextSession[] | null> {
    try {
      const id = await this.findFile(SESSIONS_BUNDLE_FILE);
      if (!id) return null;
      const url = `${DRIVE_FILES_BASE}/${encodeURIComponent(id)}?alt=media`;
      const res = await this.apiCall(url, { method: "GET" });
      if (!res.ok) return null;
      const parsed = (await res.json()) as { data?: string };
      if (!parsed?.data) return null;
      const sessions = await decompressJSON(parsed.data) as ContextSession[];
      if (!Array.isArray(sessions)) return null;
      console.log(`[CM:drive] sessions bundle downloaded: ${sessions.length} sessions`);
      return sessions;
    } catch (e) {
      console.warn("[CM:drive] downloadSessionsBundle failed:", e);
      return null;
    }
  }

  // [OPTION-B] All embeddings bundle/single-session upload/download/delete methods removed.
  // Embeddings are not synced via Drive — each profile indexes locally.
}

export const driveClient = new DriveClient();
