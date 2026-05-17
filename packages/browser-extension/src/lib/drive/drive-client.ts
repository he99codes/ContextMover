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
// Auth model:
//   - chrome.identity.getAuthToken({ interactive: false }) is used for
//     EVERY routine call. It silently returns a cached token if the user
//     is signed into Chrome AND has previously granted consent.
//   - { interactive: true } is ONLY invoked from connect() — i.e. the
//     explicit "Connect Google Drive" button. Never automatic.

import type { ContextSession } from "@/lib/types";

const DRIVE_FILES_BASE = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files";

export interface DriveSessionIndexEntry {
  id: string;
  platform: string;
  title: string;
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

class DriveClient {
  /**
   * Resolve an OAuth token via chrome.identity.
   * `interactive=false` is the default — never shows a popup.
   * Returns null on any error (including "user has not granted consent").
   */
  private async getToken(interactive = false): Promise<string | null> {
    if (typeof chrome === "undefined" || !chrome.identity?.getAuthToken) {
      return null;
    }
    return new Promise((resolve) => {
      try {
        chrome.identity.getAuthToken({ interactive }, (token) => {
          // chrome.runtime.lastError fires when consent missing /
          // user cancelled / network failed. Always treat as "not connected".
          if (chrome.runtime.lastError || !token) {
            // touch lastError to silence Chrome's "Unchecked" warning
            void chrome.runtime.lastError;
            resolve(null);
            return;
          }
          resolve(typeof token === "string" ? token : (token as { token?: string }).token ?? null);
        });
      } catch {
        resolve(null);
      }
    });
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

  /** Revoke the cached token + clear local drive state. */
  async disconnect(): Promise<void> {
    try {
      const t = await this.getToken(false);
      if (t && chrome.identity?.removeCachedAuthToken) {
        await new Promise<void>((resolve) =>
          chrome.identity.removeCachedAuthToken({ token: t }, () => resolve())
        );
      }
    } catch { /* swallow */ }
    // Clear any local-only drive sync metadata (last-sync ts, sourced-ids, etc.).
    try {
      await chrome.storage.local.remove([
        "drive.lastSyncAt",
        "drive.sourcedIds",
        "drive.profileId",
        "drive.lastSyncCount",
      ]);
    } catch { /* swallow */ }
  }

  /**
   * Authenticated fetch helper. Adds Authorization header.
   * On 401: invalidates the cached token, requests a fresh one
   * (still non-interactive), and retries once.
   */
  private async apiCall(url: string, options: RequestInit = {}): Promise<Response> {
    let token = await this.getToken(false);
    if (!token) throw new Error("drive: no token");

    const doFetch = (tok: string) =>
      fetch(url, {
        ...options,
        headers: {
          ...(options.headers ?? {}),
          Authorization: `Bearer ${tok}`,
        },
      });

    let res = await doFetch(token);
    if (res.status === 401) {
      // Token expired or revoked — drop it and try once more.
      try {
        await new Promise<void>((resolve) =>
          chrome.identity.removeCachedAuthToken({ token: token! }, () => resolve())
        );
      } catch { /* ignore */ }
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
