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

export interface DriveIndex {
  version: number;
  lastSync: number;
  profileId: string;
  sessions: DriveSessionIndexEntry[];
}

const INDEX_FILE_NAME = "cm-index.json";
const SESSION_FILE_PREFIX = "session-";

// launchWebAuthFlow does not cache tokens — we do it ourselves here.
// Google access tokens are valid for ~3600s; we refresh slightly early.
const FLOW_TOKEN_KEY = "drive.flowToken";
const FLOW_TOKEN_AT_KEY = "drive.flowTokenAt";
const FLOW_TOKEN_TTL_MS = 55 * 60 * 1000;

class DriveClient {
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

    // 1. Our own launchWebAuthFlow token cache. Valid for ~55 min.
    const cached = await this.readFlowToken();
    if (cached) return cached;

    // 2. Non-interactive: no cached token → caller must prompt the user.
    if (!interactive) return null;

    // 3. launchWebAuthFlow — the only path used pre-publish.
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
    try {
      const stored = await chrome.storage.local.get(["drive.flowToken", "drive.flowTokenAt"]);
      const token = stored["drive.flowToken"];
      const at = stored["drive.flowTokenAt"];
      if (!token || !at) return false;
      return Date.now() - Number(at) < FLOW_TOKEN_TTL_MS;
    } catch (err) {
      console.warn("[CM:drive] isTokenValid failed:", err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Pure connection check — never prompts the user. */
  async isConnected(): Promise<boolean> {
    const t = await this.getToken(false);
    return t !== null;
  }

  /** Interactive sign-in. Returns true on success, false on cancel/error. */
  async connect(): Promise<boolean> {
    const t = await this.getToken(true);
    return t !== null;
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
    // 3. Clear local-only drive sync metadata.
    try {
      await chrome.storage.local.remove([
        "drive.lastSyncAt",
        "drive.sourcedIds",
        "drive.profileId",
        "drive.lastSyncCount",
      ]);
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

    let res = await doFetch(token);
    if (res.status === 401) {
      // Token expired or revoked — drop both caches and try once more.
      try {
        await new Promise<void>((resolve) =>
          chrome.identity.removeCachedAuthToken({ token: token! }, () => resolve())
        );
      } catch { /* ignore */ }
      await this.clearFlowToken();
      const fresh = await this.getToken(false);
      if (!fresh) return res; // give up; caller handles
      res = await doFetch(fresh);
    }
    return res;
  }

  /** Locate a file by exact name within the appDataFolder. */
  private async findFile(name: string): Promise<string | null> {
    try {
      const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and trashed=false`);
      const url =
        `${DRIVE_FILES_BASE}?spaces=appDataFolder&q=${q}` +
        `&fields=files(id,name)&pageSize=1`;
      const res = await this.apiCall(url, { method: "GET" });
      if (!res.ok) return null;
      const json = (await res.json()) as { files?: Array<{ id: string }> };
      return json.files?.[0]?.id ?? null;
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
        console.warn(
          `[drive] upsert ${name} failed: ${res.status} ${res.statusText}`
        );
      }
    } catch (e) {
      console.warn(`[drive] upsert ${name} error:`, e);
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

  async downloadIndex(): Promise<DriveIndex | null> {
    try {
      const id = await this.findFile(INDEX_FILE_NAME);
      if (!id) return null;
      const url = `${DRIVE_FILES_BASE}/${encodeURIComponent(id)}?alt=media`;
      const res = await this.apiCall(url, { method: "GET" });
      if (!res.ok) return null;
      const parsed = (await res.json()) as Partial<DriveIndex>;
      if (!parsed || typeof parsed.version !== "number" || !Array.isArray(parsed.sessions)) {
        return null;
      }
      return parsed as DriveIndex;
    } catch {
      return null;
    }
  }
}

export const driveClient = new DriveClient();
