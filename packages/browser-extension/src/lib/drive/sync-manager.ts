/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// src/lib/drive/sync-manager.ts
//
// Orchestrates sync between the local IndexedDB session store and the
// per-user Drive appdata folder.  Read-only against db.ts (the local store
// is the source of truth for the LOCAL device) and read-only against the
// existing Supabase vault code (zero overlap).
//
// Design invariants:
//   1. LOCAL FIRST. Every UI path reads IndexedDB first and updates from
//      Drive in the background.
//   2. No caller of this module ever awaits sync work in a user-blocking
//      path.  Every public method is safe to "fire and forget".
//   3. We never throw upward — every error is logged and swallowed.
//   4. Conflict resolution is deterministic: HIGHER messageCount wins,
//      ties broken by HIGHER updatedAt.  This guarantees we can never
//      regress to a less-complete capture.

import { db } from "@/lib/db";
import { driveClient, type DriveIndex, type DriveSessionIndexEntry } from "./drive-client";
import type { ContextSession } from "@/lib/types";

const PROFILE_ID_KEY = "drive.profileId";
const SOURCED_IDS_KEY = "drive.sourcedIds";
const LAST_SYNC_AT_KEY = "drive.lastSyncAt";
const LAST_SYNC_COUNT_KEY = "drive.lastSyncCount";

const DEBOUNCE_MS = 30_000; // 30 seconds — group rapid captures into one upload burst.

async function getOrCreateProfileId(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(PROFILE_ID_KEY);
    const existing = stored[PROFILE_ID_KEY];
    if (typeof existing === "string" && existing.length > 0) return existing;
    const fresh = `cm-${(crypto.randomUUID?.() ?? Math.random().toString(36).slice(2))}`;
    await chrome.storage.local.set({ [PROFILE_ID_KEY]: fresh });
    return fresh;
  } catch {
    // Fallback if chrome.storage is somehow unavailable.
    return `cm-${Math.random().toString(36).slice(2)}`;
  }
}

async function readSourcedIdSet(): Promise<Set<string>> {
  try {
    const got = await chrome.storage.local.get(SOURCED_IDS_KEY);
    const arr = got[SOURCED_IDS_KEY];
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch { /* fall through */ }
  return new Set();
}

async function addSourcedIds(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const current = await readSourcedIdSet();
    for (const id of ids) current.add(id);
    await chrome.storage.local.set({ [SOURCED_IDS_KEY]: [...current] });
  } catch { /* swallow */ }
}

/**
 * Pick the more complete of two sessions for the same id.
 * Higher messageCount wins; tie broken by higher updatedAt.
 */
function pickBetter(local: ContextSession, remote: ContextSession): ContextSession {
  if (local.messages.length !== remote.messages.length) {
    return local.messages.length >= remote.messages.length ? local : remote;
  }
  return (local.updatedAt ?? 0) >= (remote.updatedAt ?? 0) ? local : remote;
}

class DriveSyncManager {
  private uploadQueue: Set<string> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isPulling = false;
  private isFlushing = false;
  // Per-session record of (sessionId → local.updatedAt) at the moment each
  // session was successfully uploaded to Drive. Used in pullFromDrive to
  // suppress re-queuing the same version when the remote index is stale
  // (e.g. rebuildIndex failed or has not yet run).
  private lastUploadedAt: Map<string, number> = new Map();

  /**
   * Queue a session id for upload to Drive.  Debounced by DEBOUNCE_MS so a
   * burst of captures of the same session (typical during streaming) yields
   * at most one upload.  Never awaited by the capture path.
   */
  queueUpload(sessionId: string): void {
    if (!sessionId) return;
    this.uploadQueue.add(sessionId);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // Fire and forget — caller never sees errors.
      void this.flushUploadQueue();
    }, DEBOUNCE_MS);
  }

  /**
   * Convenience wrapper used by the service worker right after every
   * successful debounced IDB save.
   */
  async syncAfterCapture(sessionId: string): Promise<void> {
    this.queueUpload(sessionId);
  }

  /**
   * Pump every queued session id to Drive then refresh the index.
   * Silent no-op when Drive is not connected.  Never throws.
   */
  private async flushUploadQueue(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;
    try {
      if (this.uploadQueue.size === 0) return;
      if (!(await driveClient.isConnected())) {
        // Not connected — drop the queue and try again on next capture.
        this.uploadQueue.clear();
        return;
      }

      const ids = [...this.uploadQueue];
      this.uploadQueue.clear();

      for (const id of ids) {
        try {
          const session = await db.getSession(id);
          if (!session) continue;
          await driveClient.uploadSession(session);
          // Record the local.updatedAt we just uploaded so subsequent
          // pulls against a stale remote index don't re-queue this version.
          this.lastUploadedAt.set(id, session.updatedAt ?? 0);
        } catch (e) {
          console.warn("[drive-sync] uploadSession failed", id, e);
        }
      }
      // Refresh the index after the burst.  Use Drive's view (listSessionFiles)
      // so the index always reflects what's actually there.
      try {
        await this.rebuildIndex();
      } catch (e) {
        console.warn("[drive-sync] rebuildIndex failed", e);
      }
    } catch (e) {
      console.warn("[drive-sync] flush error", e);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Walk Drive's session files + the local DB and write a fresh index file.
   * The index lets profile B do a cheap "what's new" diff without
   * downloading every session blob.
   */
  private async rebuildIndex(): Promise<void> {
    const profileId = await getOrCreateProfileId();
    const remoteFiles = await driveClient.listSessionFiles();
    if (remoteFiles.length === 0) return;

    // Build the index by reading each session's metadata.  For files we
    // just uploaded, the local DB is the authoritative source.  For files
    // we did not upload (originated from another profile), use the existing
    // entry from the previous index when present.
    const existingIndex = await driveClient.downloadIndex();
    const prevById = new Map<string, DriveSessionIndexEntry>();
    if (existingIndex) for (const e of existingIndex.sessions) prevById.set(e.id, e);

    const entries: DriveSessionIndexEntry[] = [];
    for (const file of remoteFiles) {
      // file.name === "session-<id>.json"
      const id = file.name.replace(/^session-/, "").replace(/\.json$/, "");
      if (!id) continue;

      const local = await db.getSession(id);
      if (local) {
        entries.push({
          id: local.id,
          platform: String(local.platform),
          title: local.title,
          messageCount: local.messages.length,
          updatedAt: local.updatedAt,
          driveFileId: file.id,
        });
      } else {
        // Preserve old index entry verbatim; only refresh driveFileId.
        const prev = prevById.get(id);
        if (prev) {
          entries.push({ ...prev, driveFileId: file.id });
        } else {
          // No local copy and no prior index entry — best effort placeholder.
          entries.push({
            id,
            platform: "unknown",
            title: id,
            messageCount: 0,
            updatedAt: Date.parse(file.modifiedTime) || Date.now(),
            driveFileId: file.id,
          });
        }
      }
    }

    const index: DriveIndex = {
      version: 1,
      lastSync: Date.now(),
      profileId,
      sessions: entries,
    };
    await driveClient.uploadIndex(index);
    try {
      await chrome.storage.local.set({
        [LAST_SYNC_AT_KEY]: index.lastSync,
        [LAST_SYNC_COUNT_KEY]: entries.length,
      });
    } catch { /* swallow */ }
  }

  /**
   * Pull every session in the Drive index that is newer/different than the
   * local copy.  Returns { added, updated } counts for UI feedback.
   * Silent no-op when Drive is not connected.
   */
  async pullFromDrive(): Promise<{ added: number; updated: number }> {
    if (this.isPulling) return { added: 0, updated: 0 };
    this.isPulling = true;
    try {
      if (!(await driveClient.isConnected())) return { added: 0, updated: 0 };

      const index = await driveClient.downloadIndex();
      // No index yet — first connection from this profile.  Build one from
      // whatever local sessions we already have so other profiles can see them.
      if (!index) {
        await this.bootstrapInitialIndex();
        return { added: 0, updated: 0 };
      }

      let added = 0;
      let updated = 0;
      const newlySourced: string[] = [];
      const localUploads: string[] = [];

      for (const remote of index.sessions) {
        try {
          const local = await db.getSession(remote.id);
          if (!local) {
            // Brand new on this profile — download full body and save.
            const full = await driveClient.downloadSession(remote.driveFileId);
            if (full) {
              await db.saveSession(full);
              newlySourced.push(full.id);
              added++;
            }
            continue;
          }
          // Both sides exist.  Compare to decide.
          // effectiveRemoteAt accounts for uploads we know completed in this
          // SW lifetime even if the remote index hasn't been rebuilt yet.
          const lastUploadedAt = this.lastUploadedAt.get(local.id) ?? 0;
          const effectiveRemoteAt = Math.max(remote.updatedAt, lastUploadedAt);
          const remoteIsNewer =
            remote.messageCount > local.messages.length ||
            (remote.messageCount === local.messages.length && remote.updatedAt > (local.updatedAt ?? 0));
          const localIsNewer =
            local.messages.length > remote.messageCount ||
            (local.messages.length === remote.messageCount && (local.updatedAt ?? 0) > effectiveRemoteAt);

          if (remoteIsNewer) {
            const full = await driveClient.downloadSession(remote.driveFileId);
            if (full) {
              const winner = pickBetter(local, full);
              if (winner !== local) {
                await db.saveSession(winner);
                newlySourced.push(winner.id);
                updated++;
                console.log(
                  `[drive-sync] resolved conflict (remote wins) for ${remote.id}: ` +
                  `local=${local.messages.length}@${local.updatedAt} vs ` +
                  `remote=${full.messages.length}@${full.updatedAt}`
                );
              }
            }
          } else if (localIsNewer && !this.uploadQueue.has(local.id)) {
            localUploads.push(local.id);
            console.log(
              `[drive-sync] local newer for ${remote.id}, queuing upload: ` +
              `local=${local.messages.length}@${local.updatedAt} vs ` +
              `remote=${remote.messageCount}@${remote.updatedAt}`
            );
          }
        } catch (e) {
          console.warn("[drive-sync] pull iteration error", remote.id, e);
        }
      }

      // Push any local-wins sessions in the background.
      for (const id of localUploads) this.queueUpload(id);

      if (newlySourced.length) await addSourcedIds(newlySourced);

      try {
        await chrome.storage.local.set({
          [LAST_SYNC_AT_KEY]: Date.now(),
          [LAST_SYNC_COUNT_KEY]: index.sessions.length,
        });
      } catch { /* swallow */ }

      // Notify any open sidebars to refresh.
      try { chrome.runtime.sendMessage({ type: "SESSIONS_UPDATED" }, () => { void chrome.runtime.lastError; }); } catch { /* no listener */ }

      return { added, updated };
    } catch (e) {
      console.warn("[drive-sync] pullFromDrive error", e);
      return { added: 0, updated: 0 };
    } finally {
      this.isPulling = false;
    }
  }

  /**
   * First-ever sync from this profile: upload every local session and
   * publish the initial index.  Triggered when downloadIndex() returns null.
   */
  private async bootstrapInitialIndex(): Promise<void> {
    try {
      const all = await db.getAllSessions();
      for (const s of all) await driveClient.uploadSession(s);
      await this.rebuildIndex();
      console.log(`[drive-sync] bootstrap: uploaded ${all.length} local session(s)`);
    } catch (e) {
      console.warn("[drive-sync] bootstrap failed", e);
    }
  }

  /**
   * Called by the SW on sidebar open and after DRIVE_CONNECT.  Pulls in
   * the background and broadcasts SESSIONS_UPDATED when complete.  Never
   * awaited by callers.
   */
  async initialSync(): Promise<void> {
    try {
      if (!(await driveClient.isConnected())) return;
      const result = await this.pullFromDrive();
      if (result.added > 0 || result.updated > 0) {
        try { chrome.runtime.sendMessage({ type: "SESSIONS_UPDATED" }, () => { void chrome.runtime.lastError; }); } catch { /* no listener */ }
      }
    } catch (e) {
      console.warn("[drive-sync] initialSync error", e);
    }
  }

  /** Sidebar helper: get Drive-sourced ids + last sync metadata. */
  async getStatus(): Promise<{
    connected: boolean;
    lastSyncAt: number | null;
    lastSyncCount: number | null;
    sourcedIds: string[];
  }> {
    const connected = await driveClient.isConnected();
    let lastSyncAt: number | null = null;
    let lastSyncCount: number | null = null;
    let sourcedIds: string[] = [];
    try {
      const got = await chrome.storage.local.get([
        LAST_SYNC_AT_KEY,
        LAST_SYNC_COUNT_KEY,
        SOURCED_IDS_KEY,
      ]);
      lastSyncAt = typeof got[LAST_SYNC_AT_KEY] === "number" ? got[LAST_SYNC_AT_KEY] : null;
      lastSyncCount = typeof got[LAST_SYNC_COUNT_KEY] === "number" ? got[LAST_SYNC_COUNT_KEY] : null;
      const ids = got[SOURCED_IDS_KEY];
      if (Array.isArray(ids)) sourcedIds = ids.filter((x): x is string => typeof x === "string");
    } catch { /* swallow */ }
    return { connected, lastSyncAt, lastSyncCount, sourcedIds };
  }
}

export const driveSyncManager = new DriveSyncManager();
