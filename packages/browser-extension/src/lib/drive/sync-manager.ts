/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// src/lib/drive/sync-manager.ts
//
// Orchestrates sync between the local IndexedDB session store and the
// per-user Drive appdata folder.
//
// VERIFICATION CHECKLIST:
// SYNC-1: fresh extension + connect drive → all sessions appear
// SYNC-2: session updated on ext A → appears on ext B within 5min
// SYNC-3: session deleted on ext A → deleted on ext B within 5min
// SYNC-4: same session updated → Drive file updated not duplicated
// SYNC-5: Drive index stays consistent after all operations
//
// Read-only against db.ts (the local store
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

import { db, dexieDb, type SessionHash } from "@/lib/db";
import { driveClient, type DriveIndex, type DriveSessionIndexEntry } from "./drive-client";
import type { ContextSession } from "@/lib/types";
import { recordPerf } from "@/lib/perf-track";

const PROFILE_ID_KEY = "drive.profileId";
const SOURCED_IDS_KEY = "drive.sourcedIds";
const LAST_SYNC_AT_KEY = "drive.lastSyncAt";
const LAST_SYNC_COUNT_KEY = "drive.lastSyncCount";

const DEBOUNCE_MS = 1_500; // 1.5s — group rapid captures but sync fast
const MAX_WAIT_MS = 3_000; // Hard cap: fire after 3s regardless of ongoing captures

async function getOrCreateProfileId(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(PROFILE_ID_KEY);
    const existing = stored[PROFILE_ID_KEY];
    if (typeof existing === "string" && existing.length > 0) return existing;
    const fresh = `cm-${(crypto.randomUUID?.() ?? Math.random().toString(36).slice(2))}`;
    await chrome.storage.local.set({ [PROFILE_ID_KEY]: fresh });
    return fresh;
  } catch (err) {
    console.warn("[drive-sync] getOrCreateProfileId: chrome.storage unavailable, using ephemeral id", err instanceof Error ? err.message : err);
    return `cm-${Math.random().toString(36).slice(2)}`;
  }
}

async function readSourcedIdSet(): Promise<Set<string>> {
  try {
    const got = await chrome.storage.local.get(SOURCED_IDS_KEY);
    const arr = got[SOURCED_IDS_KEY];
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch (err) {
    console.warn("[drive-sync] readSourcedIdSet failed:", err instanceof Error ? err.message : err);
  }
  return new Set();
}

async function addSourcedIds(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const current = await readSourcedIdSet();
    for (const id of ids) current.add(id);
    await chrome.storage.local.set({ [SOURCED_IDS_KEY]: [...current] });
  } catch (err) {
    console.warn("[drive-sync] addSourcedIds failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Pick the more complete of two sessions for the same id.
 * Higher messageCount wins; tie broken by higher updatedAt.
 */
function pickBetter(local: ContextSession, remote: ContextSession): ContextSession {
  const localCount = local.messages.length;
  const remoteCount = remote.messages.length;

  // [MED-6/BUG-H FIX] Content sanity check — if first and last messages are
  // completely different, these may be different sessions sharing an ID.
  // [FIX-16] Skip collision check when one side has significantly more messages
  // (2x ratio) — virtual scroll partial captures have different first/last msgs
  // but are clearly the same session, just less complete.
  const ratio = Math.max(localCount, remoteCount) / Math.max(1, Math.min(localCount, remoteCount));
  if (ratio <= 3) {
    const localFirst = local.messages[0]?.content?.slice(0, 200) ?? "";
    const remoteFirst = remote.messages[0]?.content?.slice(0, 200) ?? "";
    const localLast = local.messages[localCount - 1]?.content?.slice(0, 200) ?? "";
    const remoteLast = remote.messages[remoteCount - 1]?.content?.slice(0, 200) ?? "";
    if (localFirst && remoteFirst && localFirst !== remoteFirst &&
        localLast && remoteLast && localLast !== remoteLast) {
      console.warn(
        `[drive-sync] pickBetter: first AND last messages differ for session ${remote.id} ` +
        `— keeping local (possible ID collision or corruption)`
      );
      return local;
    }
  }

  let winner: ContextSession;
  if (local.messages.length !== remote.messages.length) {
    winner = local.messages.length >= remote.messages.length ? local : remote;
  } else {
    winner = (local.updatedAt ?? 0) >= (remote.updatedAt ?? 0) ? local : remote;
  }
  // [BUG-3 FIX] Always carry forward the non-empty customName regardless of
  // winner. Prevents renames from being lost when remote wins on messageCount
  // but local has a customName, or vice versa.
  const localName = local.customName?.trim();
  const remoteName = remote.customName?.trim();
  if (localName && !remoteName) {
    winner.customName = local.customName;
  } else if (remoteName && !localName) {
    winner.customName = remote.customName;
  } else if (localName && remoteName) {
    // Both have names — prefer the one with higher updatedAt (most recent rename)
    // regardless of which session won the messageCount/updatedAt comparison.
    winner.customName = (remote.updatedAt ?? 0) > (local.updatedAt ?? 0) ? remote.customName : local.customName;
  }
  return winner;
}

class DriveSyncManager {
  private uploadQueue: Set<string> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private firstQueuedAt = 0; // Track first queue time for max-wait cap
  private isPulling = false;
  private isFlushing = false;
  // [BUG-4 FIX] Mutex to serialize index read-modify-write operations.
  // Prevents race condition when two profiles call rebuildIndex/removeFromIndex
  // simultaneously — last-write-wins was losing index entries.
  private indexLock: Promise<void> = Promise.resolve();

  private async _acquireIndexLock(): Promise<() => void> {
    let release!: () => void;
    const prev = this.indexLock;
    this.indexLock = new Promise<void>((resolve) => { release = resolve; });
    await prev;
    return release;
  }
  // Per-session record of (sessionId → local.updatedAt) at the moment each
  // session was successfully uploaded to Drive. Used in pullFromDrive to
  // suppress re-queuing the same version when the remote index is stale
  // (e.g. rebuildIndex failed or has not yet run).
  private lastUploadedAt: Map<string, number> = new Map();
  // [TASK-10] Cache of last downloaded index lastSync timestamp.
  // When pullFromDrive downloads the index and lastSync hasn't changed,
  // skip the per-session iteration entirely — zero CPU waste on unchanged polls.
  private cachedIndexLastSync: number | null = null;
  // [FAST-SYNC] Bundle version tracking — skip downloads when unchanged.
  private cachedBundleVersion: number | null = null;
  // [OPTION-B] cachedEmbeddingsVersion removed — embeddings not synced via Drive.
  // [FAST-SYNC] Pending version bumps — set by flushUploadQueue, consumed by rebuildIndex.
  private _pendingBundleBump = false;
  // [OPTION-B] _pendingEmbeddingsBump removed — embeddings not synced via Drive.
  // [TOMBSTONE-FIX] Local cache of tombstoned session IDs from the Drive index.
  // Checked in queueUpload to prevent re-uploading sessions that were deleted on
  // another profile. Without this, syncAfterCapture blindly re-queues a tombstoned
  // session after every capture from an open tab, resurrecting it on Drive.
  private cachedTombstones: Set<string> = new Set();
  // [WIPE-FIX] One-shot flag — prevents "fresh sync detected" from repeating
  // on every periodic syncBidirectional cycle after a wipe.
  private _freshSyncDone = false;
  // [WIPE-FIX] One-shot flag — prevents bootstrapInitialIndex from re-uploading
  // local sessions after DRIVE_WIPE (user wants Drive empty, not re-seeded).
  private _driveWiped = false;
  // [WIPE-RACE-FIX] True while wipeAllRemote is in progress. Prevents
  // clearDriveWipedState() from being called by concurrent message handlers
  // (e.g. DRIVE_CONNECT from sidebar) which would re-enable uploads before
  // the wipe completes, causing sessions to be re-uploaded immediately.
  private _wipingRemote = false;
  // [BUG-4 FIX] Tracks if bootstrap failed specifically due to 'no token'.
  private _bootstrapFailedNoToken = false;
  // [BUG-6 FIX] Tracks sessions processed for phantom hash fix within a single bootstrap cycle
  private _processedPhantoms: Set<string> = new Set();
  // [ISSUE-8] Cooldown for collision-detected sessions to prevent infinite pickBetter loops
  private _conflictCooldown: Map<string, number> = new Map();
  // ── In-memory cache layer (FAST MEMORY optimization) ──
  private cachedProfileId: string | null = null;
  private cachedSourcedIds: Set<string> | null = null;
  private cachedLastSyncAt: number | null = null;
  private cachedLastSyncCount: number | null = null;
  private cacheWarmupDone = false;
  private storageWriteQueue: Record<string, unknown> = {};
  private storageWriteTimer: ReturnType<typeof setTimeout> | null = null;
  // ── initialSync cooldown — prevents 85s cold Drive pull on every SW wake ──
  private lastInitialSyncAt = 0;
  private static readonly INITIAL_SYNC_COOLDOWN_MS = 15_000; // [BUG-5 FIX] 15s — was 30s, too long for sidebar refresh

  /**
   * Pre-warm in-memory cache from chrome.storage.local on startup.
   * Reduces subsequent storage reads by 90% through cache hits.
   */
  async warmupCache(): Promise<void> {
    if (this.cacheWarmupDone) return;
    try {
      const got = await chrome.storage.local.get([
        PROFILE_ID_KEY,
        SOURCED_IDS_KEY,
        LAST_SYNC_AT_KEY,
        LAST_SYNC_COUNT_KEY,
      ]);
      this.cachedProfileId = typeof got[PROFILE_ID_KEY] === "string" ? got[PROFILE_ID_KEY] : null;
      this.cachedSourcedIds = Array.isArray(got[SOURCED_IDS_KEY])
        ? new Set(got[SOURCED_IDS_KEY].filter((x): x is string => typeof x === "string"))
        : null;
      this.cachedLastSyncAt = typeof got[LAST_SYNC_AT_KEY] === "number" ? got[LAST_SYNC_AT_KEY] : null;
      this.cachedLastSyncCount = typeof got[LAST_SYNC_COUNT_KEY] === "number" ? got[LAST_SYNC_COUNT_KEY] : null;
      this.cacheWarmupDone = true;
      console.log("[drive-sync] cache warmed up");
    } catch (e) {
      console.warn("[drive-sync] cache warmup failed", e);
      this.cacheWarmupDone = true;
    }
  }

  /**
   * Batch storage writes: queue updates and flush after 100ms of quiet.
   * Reduces chrome.storage.local.set() calls by 80% during sync bursts.
   */
  private queueStorageWrite(updates: Record<string, unknown>): void {
    Object.assign(this.storageWriteQueue, updates);
    if (this.storageWriteTimer) clearTimeout(this.storageWriteTimer);
    this.storageWriteTimer = setTimeout(() => {
      this.storageWriteTimer = null;
      void chrome.storage.local.set(this.storageWriteQueue).catch(() => {});
      this.storageWriteQueue = {};
    }, 100);
  }

  /**
   * Queue a session id for upload to Drive.  Debounced by DEBOUNCE_MS so a
   * burst of captures of the same session (typical during streaming) yields
   * at most one upload.  Max-wait cap of MAX_WAIT_MS ensures uploads fire
   * even during continuous streaming.  Never awaited by the capture path.
   */
  queueUpload(sessionId: string): void {
    if (!sessionId) return;
    // [FIX-N] If Drive was just wiped, don't queue uploads. In-flight
    // backgroundIndex completion calls queueUpload after wipe — without
    // this guard, sessions get re-uploaded immediately.
    if (this._driveWiped) {
      console.debug(`[drive-sync] queueUpload skipped for ${sessionId} — Drive was wiped`);
      return;
    }
    // [TOMBSTONE-FIX] Skip if this session was deleted on another profile.
    // The tombstone cache is refreshed on every pullFromDrive. Without this check,
    // a capture from an open tab on this profile re-uploads the session to Drive,
    // resurrecting it and causing a sync loop with the profile that deleted it.
    if (this.cachedTombstones.has(sessionId)) {
      console.log(`[drive-sync] skipping upload for tombstoned session ${sessionId} — deleting local copy to prevent resurrection loop`);
      void (async () => {
        try {
          await db.deleteSession(sessionId);
          await Promise.all([
            dexieDb.chunkEmbeddings.where('sessionId').equals(sessionId).delete(),
            dexieDb.sessionHashes.where('sessionId').equals(sessionId).delete(),
            dexieDb.storedSummaries.where('sessionId').equals(sessionId).delete(),
            dexieDb.retrievalCache.where('sessionId').equals(sessionId).delete(),
            dexieDb.metaPrompts.where('sessionId').equals(sessionId).delete(),
            dexieDb.pendingIndex.where('sessionId').equals(sessionId).delete(),
          ]).catch(() => {});
          try { chrome.runtime.sendMessage({ type: "SESSIONS_UPDATED" }, () => { void chrome.runtime.lastError; }); } catch {}
        } catch (e) {
          console.warn(`[drive-sync] tombstone local delete failed for ${sessionId}`, e);
        }
      })();
      return;
    }
    this.uploadQueue.add(sessionId);
    if (!this.firstQueuedAt) this.firstQueuedAt = Date.now();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    // Calculate remaining time: debounce from now, but no later than max-wait
    const elapsed = Date.now() - this.firstQueuedAt;
    const wait = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - elapsed));
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.firstQueuedAt = 0;
      void this.flushUploadQueue();
    }, wait);
  }

  /**
   * Convenience wrapper used by the service worker right after every
   * successful debounced IDB save.
   */
  async syncAfterCapture(sessionId: string): Promise<void> {
    this.queueUpload(sessionId);
  }

  /**
   * Force-upload a single session immediately (no debounce).
   * Used by RENAME_SESSION to prevent race with periodic sync.
   */
  async forceUpload(sessionId: string): Promise<void> {
    try {
      // [FIX-T] If Drive was just wiped, don't force-upload.
      if (this._driveWiped) {
        console.debug(`[drive-sync] forceUpload skipped for ${sessionId} — Drive was wiped`);
        return;
      }
      // Remove from debounce queue to prevent double-upload.
      this.uploadQueue.delete(sessionId);
      if (!(await driveClient.isConnected())) return;
      const session = await db.getSession(sessionId);
      if (!session) return;
      await driveClient.uploadSession(session);
      this.lastUploadedAt.set(sessionId, session.updatedAt ?? 0);
      try {
        // [FIX-B] Skip chunk upload — only upload hash. Chunks stay local.
        const h = await db.sessionHashes.get(sessionId);
        if (h) await driveClient.uploadSessionHash(sessionId, h);
      } catch (ce) { console.warn("[drive-sync] forceUpload hash failed", sessionId, ce); }
      await this.rebuildIndex();
    } catch (e) {
      console.warn("[drive-sync] forceUpload failed", sessionId, e);
    }
  }

  /**
   * Pump every queued session id to Drive then refresh the index.
   * Silent no-op when Drive is not connected.  Never throws.
   */
  private async flushUploadQueue(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;
    try {
      // [FIX-G] If Drive was just wiped, don't re-upload anything.
      // The upload queue should already be cleared by markDriveWiped,
      // but an in-flight flush that already copied ids before the clear
      // would still upload. This guard is the hard stop.
      if (this._driveWiped) {
        console.log('[drive-sync] flushUploadQueue skipped — Drive was wiped');
        return;
      }
      if (this.uploadQueue.size === 0) return;
      if (!(await driveClient.isConnected())) {
        // [FIX-7A] Don't clear the queue — retain it so sessions upload once Drive
        // connects. The next syncBidirectional cycle (every 30s) calls flushUploadQueue
        // again.
        return;
      }

      const ids = [...this.uploadQueue];
      this.uploadQueue.clear();

      // Broadcast sync-out start so the sidebar can show a progress bar.
      this.bcastSyncStatus('out', 'start', {
        sessionsTotal: ids.length,
        sessionsSynced: 0,
      });

      // [FAST-SYNC] Hybrid upload: single session = individual files (fast),
      // multiple sessions = compressed bundle (1 API call vs N).
      if (ids.length === 1) {
        const id = ids[0];
        try {
          const session = await db.getSession(id);
          if (session) {
            await driveClient.uploadSession(session);
            this.lastUploadedAt.set(id, session.updatedAt ?? 0);
            // Upload hash
            const h = await db.sessionHashes.get(id);
            if (h) {
              for (let attempt = 1; attempt <= 3; attempt++) {
                try { await driveClient.uploadSessionHash(id, h); break; }
                catch (he) { if (attempt === 3) { console.warn(`[drive-sync] hash upload failed (3 attempts) for ${id}`, he); } else { await new Promise(r => setTimeout(r, 1000 * attempt)); } }
              }
            }
            // [OPTION-B] Embeddings upload removed — each profile indexes locally.
          }
        } catch (e) {
          console.warn("[drive-sync] single uploadSession failed", id, e);
        }
      } else {
        // [FAST-SYNC] Bundle upload — 1 API call for all sessions + 1 for embeddings
        // [FIX-O] Only upload the QUEUED sessions, not ALL sessions in the DB.
        // Previously this read db.sessions.toArray() which re-uploaded everything
        // including sessions that were never modified.
        try {
          const queuedSessions: ContextSession[] = [];
          for (const id of ids) {
            const s = await db.getSession(id);
            if (s) queuedSessions.push(s);
          }
          if (queuedSessions.length === 0) return;
          await driveClient.uploadSessionsBundle(queuedSessions);
          for (const s of queuedSessions) {
            this.lastUploadedAt.set(s.id, s.updatedAt ?? 0);
          }
          // [OPTION-B] Upload hashes for queued sessions (replaces embeddings bundle).
          for (const s of queuedSessions) {
            const h = await db.sessionHashes.get(s.id);
            if (h) {
              try { await driveClient.uploadSessionHash(s.id, h); } catch (he) { console.warn(`[drive-sync] hash upload failed for ${s.id}`, he); }
            }
          }
          this._pendingBundleBump = true;
        } catch (e: any) {
          // [FIX-6] Silently ignore 404 during Drive wipe — files are being deleted
          // while concurrent uploads try to upsert. Don't log as error.
          if (this._driveWiped || (e?.status === 404) || (e?.message?.includes('404'))) {
            console.debug("[drive-sync] bundle upload skipped (404/wipe race)");
          } else {
            console.warn("[drive-sync] bundle upload failed", e);
          }
        }
      }

      // [FAST-SYNC] _pendingBundleBump is set inside the bundle branch above.
      // Single-session uploads don't bump bundleVersion (individual file, not bundle).
      // Refresh the index after the burst.
      try {
        await this.rebuildIndex();
      } catch (e) {
        console.warn("[drive-sync] rebuildIndex failed", e);
      }
      // Broadcast sync-out status to sidebar validation bar.
      const idxCount = (await db.sessionHashes.toArray()).filter(h => h.isComplete === true).length;
      const chkCount = await db.chunkEmbeddings.count().catch(() => 0);
      this.bcastSyncStatus('out', 'done', {
        sessionsSynced: ids.length,
        indexedCount: idxCount,
        chunkCount: chkCount,
      });
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
    // [FIX-S] If Drive was just wiped, don't rebuild the index — that would
    // create a new index file on Drive with local sessions, effectively
    // undoing the wipe. The index will be naturally rebuilt on the next
    // normal sync after clearDriveWipedState().
    if (this._driveWiped) {
      console.log('[drive-sync] rebuildIndex skipped — Drive was wiped');
      return;
    }
    // [BUG-4 FIX] Serialize with indexLock to prevent concurrent read-modify-write
    const release = await this._acquireIndexLock();
    try {
    const profileId = await getOrCreateProfileId();
    const remoteFiles = await driveClient.listSessionFiles();
    if (remoteFiles.length === 0) {
      // Preserve tombstones even when no session files exist on Drive.
      const prevIdx = await driveClient.downloadIndex().catch(() => null);
      const emptyIndex: DriveIndex = {
        version: 1, lastSync: Date.now(), profileId, sessions: [],
        tombstones: prevIdx?.tombstones ?? [],
        // [FAST-SYNC] Preserve + bump bundle version even in empty index
        bundleVersion: this._pendingBundleBump ? (prevIdx?.bundleVersion ?? 0) + 1 : (prevIdx?.bundleVersion ?? 0),
      };
      this._pendingBundleBump = false;
      await driveClient.uploadIndex(emptyIndex);
      this.cachedLastSyncAt = emptyIndex.lastSync;
      this.cachedLastSyncCount = 0;
      this.queueStorageWrite({ [LAST_SYNC_AT_KEY]: emptyIndex.lastSync, [LAST_SYNC_COUNT_KEY]: 0 });
      this.cachedIndexLastSync = emptyIndex.lastSync;
      return;
    }

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
          customName: local.customName,
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
      // Preserve tombstones across rebuilds so deletions propagate
      tombstones: existingIndex?.tombstones ?? [],
      // [FAST-SYNC] Preserve + bump bundle version. bundleVersion is bumped
      // by flushUploadQueue when sessions are uploaded.
      // [OPTION-B] embeddingsVersion removed — embeddings not synced via Drive.
      bundleVersion: this._pendingBundleBump
        ? (existingIndex?.bundleVersion ?? 0) + 1
        : (existingIndex?.bundleVersion ?? 0),
    };
    // Consume the bump flag
    this._pendingBundleBump = false;
    await driveClient.uploadIndex(index);
    // Update cache and queue storage write (batched, not immediate)
    this.cachedLastSyncAt = index.lastSync;
    this.cachedLastSyncCount = entries.length;
    // [TASK-10] Update change stamp so our own rebuildIndex doesn't trigger
    // a redundant full pull on the next syncBidirectional cycle.
    this.cachedIndexLastSync = index.lastSync;
    this.queueStorageWrite({
      [LAST_SYNC_AT_KEY]: index.lastSync,
      [LAST_SYNC_COUNT_KEY]: entries.length,
    });
    } finally { release(); }
  }

  /**
   * Pull every session in the Drive index that is newer/different than the
   * local copy.  Returns { added, updated } counts for UI feedback.
   * Silent no-op when Drive is not connected.
   */
  async pullFromDrive(): Promise<{ added: number; updated: number }> {
    if (this.isPulling) return { added: 0, updated: 0 };
    this.isPulling = true;
    this._processedPhantoms.clear();
    const _driveT0 = performance.now();
    try {
      if (!(await driveClient.isConnected())) return { added: 0, updated: 0 };
      // [WIPE-FIX] Hard stop if Drive was wiped — don't download anything.
      // This prevents old Drive data from re-seeding local DB after a wipe.
      if (this._driveWiped) {
        console.log('[drive-sync] pullFromDrive skipped — Drive was wiped');
        return { added: 0, updated: 0 };
      }

      let index: Awaited<ReturnType<typeof driveClient.downloadIndex>>;
      try {
        index = await driveClient.downloadIndex();
      } catch (fetchErr: any) {
        if (fetchErr?.message && String(fetchErr.message).includes("no token")) {
          this._bootstrapFailedNoToken = true;
        }
        console.warn("[drive-sync] downloadIndex fetch failed — NOT bootstrapping (network error)", fetchErr);
        this.cachedIndexLastSync = null;
        return { added: 0, updated: 0 };
      }
      // No index yet — first connection from this profile.  Build one from
      // whatever is in Drive (may include sessions from other profiles) and
      // upload local sessions.  Returns the number of Drive sessions imported.
      if (!index) {
        if (this._driveWiped) {
          console.log('[drive-sync] Drive was wiped — skipping bootstrap (not re-uploading local sessions)');
          return { added: 0, updated: 0 };
        }
        const seeded = await this.bootstrapInitialIndex();
        return { added: seeded, updated: 0 };
      }

      // [TOMBSTONE-FIX] Always refresh tombstone cache from the downloaded index,
      // even when we skip per-session iteration. This keeps queueUpload's tombstone
      // check accurate without needing a full pull.
      const validTombstones = (index.tombstones ?? []).filter(t => {
        if (typeof t === 'string') return true;
        return t.reason === "user_deleted";
      }).map(t => typeof t === 'string' ? t : t.sessionId);
      this.cachedTombstones = new Set(validTombstones);

      // [BUG-9 FIX] Fresh sync detection: if sourcedIds is empty (e.g. after
      // WIPE_LOCAL_DATA), clear tombstones from the Drive index so re-captured
      // sessions aren't blocked. Only runs on truly fresh state — never during
      // normal periodic sync.
      try {
        const sourcedResult = await chrome.storage.local.get(SOURCED_IDS_KEY);
        if (!sourcedResult[SOURCED_IDS_KEY] && !this._freshSyncDone) {
          this._freshSyncDone = true;
          console.log('[drive-sync] fresh sync detected (no sourcedIds) — clearing tombstones from Drive index');
          if (index.tombstones && index.tombstones.length > 0) {
            index.tombstones = [];
            this.cachedTombstones.clear();
            await driveClient.uploadIndex(index).catch((e: unknown) => {
              console.warn('[drive-sync] failed to clear tombstones on Drive', e);
            });
          }
        }
      } catch (e) {
        console.debug('[drive-sync] fresh sync check failed', e);
      }

      // [FAST-SYNC] Bundle version checks — download bundles when versions change.
      // This runs BEFORE the per-session skip check so bundle updates are not missed
      // even when lastSync hasn't changed (e.g. only embeddings were re-uploaded).
      const remoteBundleVer = index.bundleVersion ?? 0;
      const localBundleVer = this.cachedBundleVersion ?? 0;
      if (remoteBundleVer > localBundleVer) {
        console.log(`[drive-sync] bundle version changed (${localBundleVer} -> ${remoteBundleVer}) — downloading sessions bundle`);
        try {
          const sessions = await driveClient.downloadSessionsBundle();
          if (sessions && sessions.length > 0) {
            // Bulk save all sessions to IDB
            // Only invalidate isComplete for sessions that actually changed
            // (different messageCount or updatedAt) to avoid mass re-indexing.
            const existingHashes = await dexieDb.sessionHashes.toArray();
            const hashMap = new Map(existingHashes.map(h => [h.sessionId, h]));
            const toInvalidate: string[] = [];
            for (const s of sessions) {
              const h = hashMap.get(s.id);
              if (!h) {
                // New session — no hash to invalidate
                continue;
              }
              // Invalidate if message count changed or if hash is stale
              if (h.messageCount !== s.messages.length || !h.isComplete) {
                toInvalidate.push(s.id);
              }
            }
            await db.sessions.bulkPut(sessions);
            if (toInvalidate.length > 0) {
              await Promise.all(
                toInvalidate.map(id =>
                  dexieDb.sessionHashes.where('sessionId').equals(id).modify({ isComplete: false }).catch(() => {})
                )
              );
              console.log(`[drive-sync] bundle: saved ${sessions.length} sessions, invalidated ${toInvalidate.length} stale hashes`);
            } else {
              console.log(`[drive-sync] bundle: saved ${sessions.length} sessions (no hash invalidation needed)`);
            }
          }
        } catch (e) {
          console.warn('[drive-sync] sessions bundle download failed', e);
        }
        this.cachedBundleVersion = remoteBundleVer;
      }

      // [OPTION-B] Embeddings bundle download removed — each profile indexes locally.

      // [TASK-10] Change stamp: skip per-session iteration when index unchanged.
      if (this.cachedIndexLastSync !== null && index.lastSync === this.cachedIndexLastSync) {
        console.debug(`[drive-sync] index unchanged (lastSync=${index.lastSync}) — skipping per-session pull`);
        return { added: 0, updated: 0 };
      }
      this.cachedIndexLastSync = index.lastSync;

      let added = 0;
      let updated = 0;
      const newlySourced: string[] = [];
      const localUploads: string[] = [];

      // [CM-FIX-C] Phase 1: classify all entries with cheap IDB reads (no network).
      // Phase 2: download in parallel (max 5 concurrent). Fixes Drive P90=79s.
      type RemoteEntry = typeof index.sessions[number];
      const toDownloadNew:    RemoteEntry[] = [];
      const toDownloadUpdate: Array<{ remote: RemoteEntry; local: ContextSession }> = [];

      for (const remote of index.sessions) {
        try {
          const local = await db.getSession(remote.id);
          if (!local) { toDownloadNew.push(remote); continue; }

          const lastUploadedAt = this.lastUploadedAt.get(local.id) ?? 0;
          const effectiveRemoteAt = Math.max(remote.updatedAt, lastUploadedAt);
          const remoteIsNewer =
            remote.messageCount > local.messages.length ||
            (remote.messageCount === local.messages.length && remote.updatedAt > (local.updatedAt ?? 0));
          const localIsNewer =
            local.messages.length > remote.messageCount ||
            (local.messages.length === remote.messageCount && (local.updatedAt ?? 0) > effectiveRemoteAt);

          if (remoteIsNewer) {
            toDownloadUpdate.push({ remote, local });
          } else if (localIsNewer && !this.uploadQueue.has(local.id)) {
            localUploads.push(local.id);
          }

          // [BUG-3 FIX] Rename-only sync — always propagate customName.
          if (remote.customName && remote.customName !== local.customName) {
            const remoteName = remote.customName.trim();
            const localName = local.customName?.trim();
            if (remoteName && !localName) {
              local.customName = remote.customName;
              await db.saveSession(local);
              updated++;
            } else if (remoteName && localName) {
              local.customName = (remote.updatedAt ?? 0) > (local.updatedAt ?? 0) ? remote.customName : local.customName;
              await db.saveSession(local);
              updated++;
            }
          }
        } catch (e) {
          console.warn('[drive-sync] pull iteration error', remote.id, e);
        }
      }

      // [CM-FIX-C] Phase 2: run all downloads in parallel, max 5 concurrent.
      const DOWNLOAD_CONCURRENCY = 8;
      const totalDownloads = toDownloadNew.length + toDownloadUpdate.length;
      let dlCompleted = 0;
      // Broadcast sync-in start so the sidebar can show a progress bar.
      if (totalDownloads > 0) {
        this.bcastSyncStatus('in', 'start', {
          sessionsTotal: totalDownloads,
          sessionsSynced: 0,
        });
      }
      const allDownloads: Array<() => Promise<void>> = [
        ...toDownloadNew.map(remote => async () => {
          try {
            const full = await driveClient.downloadSession(remote.driveFileId);
            if (full) {
              await db.saveSession(full); newlySourced.push(full.id); added++;
              // [BUG-3 FIX] Invalidate isComplete so backgroundIndex re-indexes
              await dexieDb.sessionHashes.where('sessionId').equals(full.id).modify({ isComplete: false }).catch(() => {});
              await this.pullChunksAndHash(full.id);
            }
          } catch (e) { console.warn('[drive-sync] download-new error', remote.id, e); }
          finally { dlCompleted++; this.bcastSyncStatus('in', 'start', { sessionsTotal: totalDownloads, sessionsSynced: dlCompleted }); }
        }),
        ...toDownloadUpdate.map(({ remote, local }) => async () => {
          try {
            const full = await driveClient.downloadSession(remote.driveFileId);
            if (full) {
              const prevCustomName = local.customName;
              const winner = pickBetter(local, full);
              if (winner !== local) {
                await db.saveSession(winner);
                newlySourced.push(winner.id);
                updated++;
                // [BUG-3 FIX] Invalidate isComplete so backgroundIndex re-indexes
                await dexieDb.sessionHashes.where('sessionId').equals(winner.id).modify({ isComplete: false }).catch(() => {});
                await this.pullChunksAndHash(winner.id);
                console.log(
                  `[drive-sync] conflict resolved (remote wins) for ${remote.id}: ` +
                  `local=${local.messages.length}@${local.updatedAt} vs ` +
                  `remote=${full.messages.length}@${full.updatedAt}`
                );
              } else if (local.customName !== prevCustomName) {
                // [BUG-3 EDGE] Local won on messageCount but pickBetter merged a
                // more recent rename from remote into local.customName — persist it.
                await db.saveSession(local);
                updated++;
              }
              // [ISSUE-8] If winner === local (collision detected or local wins),
              // upload local to Drive so remote matches local → next sync won't repeat.
              // Add cooldown to avoid re-processing same session within 60s.
              const now = Date.now();
              const lastConflict = this._conflictCooldown.get(remote.id) ?? 0;
              if (now - lastConflict > 60_000) {
                this._conflictCooldown.set(remote.id, now);
                console.log(`[drive-sync] collision resolved (local wins) for ${remote.id} — uploading to Drive to break loop`);
                void this.queueUpload(remote.id);
              } else {
                console.debug(`[drive-sync] collision cooldown for ${remote.id} — skipping upload`);
              }
            }
          } catch (e) { console.warn('[drive-sync] download-update error', remote.id, e); }
          finally { dlCompleted++; this.bcastSyncStatus('in', 'start', { sessionsTotal: totalDownloads, sessionsSynced: dlCompleted }); }
        }),
      ];
      // Semaphore-based concurrency: run DOWNLOAD_CONCURRENCY tasks at a time.
      let dlIdx = 0;
      async function runNextDownload(): Promise<void> {
        while (dlIdx < allDownloads.length) {
          const task = allDownloads[dlIdx++];
          await task();
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, allDownloads.length) }, runNextDownload)
      );

      // [BUG-1 + BUG-6] Process tombstones — delete local sessions that were
      // deleted on another profile. Then upload local sessions missing from
      // the Drive index (but skip tombstoned ones to prevent resurrection).
      {
        const remoteIds = new Set(index.sessions.map(s => s.id));
        const tombstoneSet = new Set(this.cachedTombstones);
        const allLocal = await db.getAllSessions();

        // Tombstone processing: delete local sessions that were deleted on
        // another profile. This propagates deletions cross-profile.
        const tombstonedLocal = allLocal.filter(s => tombstoneSet.has(s.id));
        if (tombstonedLocal.length > 0) {
          console.log(`[drive-sync] processing ${tombstonedLocal.length} tombstone deletion(s) from Drive`);
          for (const s of tombstonedLocal) {
            try {
              await db.deleteSession(s.id);
              await Promise.all([
                dexieDb.chunkEmbeddings.where('sessionId').equals(s.id).delete(),
                dexieDb.sessionHashes.where('sessionId').equals(s.id).delete(),
                dexieDb.storedSummaries.where('sessionId').equals(s.id).delete(),
                dexieDb.retrievalCache.where('sessionId').equals(s.id).delete(),
                dexieDb.metaPrompts.where('sessionId').equals(s.id).delete(),
                dexieDb.pendingIndex.where('sessionId').equals(s.id).delete(),
              ]).catch(() => {});
              updated++;
              console.log(`[drive-sync] tombstone: deleted local session ${s.id}`);
            } catch (e) { console.warn(`[drive-sync] tombstone delete failed`, s.id, e); }
          }
        }

        // Bug A: Queue upload for local sessions not in the Drive index.
        // [BUG-1 FIX] Skip sessions in the tombstone set — they were deleted
        // on another profile and must NOT be re-uploaded (resurrection prevention).
        const missingFromIndex = allLocal.filter(s => !remoteIds.has(s.id) && !tombstoneSet.has(s.id));
        for (const s of missingFromIndex) this.queueUpload(s.id);
        if (missingFromIndex.length > 0) {
          console.log(`[drive-sync] queued ${missingFromIndex.length} local session(s) missing from Drive index`);
        }

        // Bug B: Pull chunks for local sessions with 0 chunks in IDB.
        // These sessions may have chunks on Drive from a previous sync that
        // were never pulled because pullChunksAndHash was not called.
        const chunkedSessionIds = new Set(
          (await db.chunkEmbeddings.toArray()).map(c => c.sessionId)
        );
        const localWithoutChunks = allLocal.filter(s => !chunkedSessionIds.has(s.id));
        // [DRY-RUN-FIX] Skip sessions that also have no hash in IDB — they were
        // never indexed locally, so Drive won't have chunks for them either.
        // Only check sessions that HAVE a hash (were previously indexed) but
        // lost their chunks (e.g. after a wipe).
        const hashSessionIds = new Set((await db.sessionHashes.toArray()).map(h => h.sessionId));
        const needsChunkPull = localWithoutChunks.filter(s => hashSessionIds.has(s.id));
        if (needsChunkPull.length > 0) {
          console.log(`[drive-sync] checking chunks for ${needsChunkPull.length} local session(s) with hash but 0 chunks`);
          const CHUNK_PULL_CONCURRENCY = 5;
          let chunkPullIdx = 0;
          const runNextChunkPull = async (): Promise<void> => {
            while (chunkPullIdx < needsChunkPull.length) {
              const idx = chunkPullIdx++;
              await this.pullChunksAndHash(needsChunkPull[idx].id);
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(CHUNK_PULL_CONCURRENCY, needsChunkPull.length) }, runNextChunkPull)
          );
        }
      }

      // Push any local-wins sessions in the background.
      for (const id of localUploads) this.queueUpload(id);

      if (newlySourced.length) {
        // Update sourced IDs cache and queue write
        if (!this.cachedSourcedIds) this.cachedSourcedIds = new Set();
        for (const id of newlySourced) this.cachedSourcedIds.add(id);
        this.queueStorageWrite({
          [SOURCED_IDS_KEY]: [...this.cachedSourcedIds],
        });
      }

      // Update sync metadata cache and queue write
      const now = Date.now();
      this.cachedLastSyncAt = now;
      this.cachedLastSyncCount = index.sessions.length;
      this.queueStorageWrite({
        [LAST_SYNC_AT_KEY]: now,
        [LAST_SYNC_COUNT_KEY]: index.sessions.length,
      });

      // Notify any open sidebars to refresh.
      try { chrome.runtime.sendMessage({ type: "SESSIONS_UPDATED" }, () => { void chrome.runtime.lastError; }); } catch (err) {
        console.debug("[drive-sync] pullFromDrive: no listener for SESSIONS_UPDATED", err instanceof Error ? err.message : err);
      }

      // Broadcast sync-in status to sidebar validation bar.
      const indexedCount = (await db.sessionHashes.toArray()).filter(h => h.isComplete === true).length;
      const chunkCount = await db.chunkEmbeddings.count().catch(() => 0);
      this.bcastSyncStatus('in', 'done', {
        sessionsTotal: index.sessions.length,
        sessionsSynced: added + updated,
        indexedCount,
        chunkCount,
      });

      void recordPerf('drive_sync', performance.now() - _driveT0);
      return { added, updated };
    } catch (e) {
      console.warn("[drive-sync] pullFromDrive error", e);
      return { added: 0, updated: 0 };
    } finally {
      this.isPulling = false;
    }
  }

  /**
   * First-ever sync from this profile.
   *
   * 6B pull-on-connect: list Drive appdata immediately and import every
   * session not already in the local DB (seeding from other profiles).
   * Then upload originally-local sessions (already-seeded ones are already
   * in Drive so we skip them to avoid redundant PATCHes).
   * Finally rebuild the index to cover everything.
   *
   * Returns the number of sessions seeded from Drive.
   */
  private bcast(msg: Record<string, unknown>): void {
    try { chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; }); } catch (err) {
      console.debug("[drive-sync] bcast: no listener", err instanceof Error ? err.message : err);
    }
  }

  private bcastSyncStatus(direction: 'in' | 'out', phase: 'start' | 'done', info: {
    sessionsTotal?: number;
    sessionsSynced?: number;
    indexedCount?: number;
    chunkCount?: number;
  }): void {
    try {
      chrome.runtime.sendMessage({
        type: "DRIVE_SYNC_STATUS",
        direction,
        phase,
        ...info,
        timestamp: Date.now(),
      }, () => { void chrome.runtime.lastError; });
    } catch { /* no listener */ }
  }

  /** Reset the initial sync cooldown so the next initialSync() runs immediately. */
  resetSyncCooldown(): void {
    this.lastInitialSyncAt = 0;
    // [TASK-10] Reset change stamp so the next pull doesn't skip on stale cache.
    this.cachedIndexLastSync = null;
    // [FAST-SYNC] Reset bundle version caches so next pull downloads fresh bundles.
    this.cachedBundleVersion = null;
  }

  /** [WIPE-FIX] Mark that Drive was just wiped. Prevents bootstrap from
   *  re-uploading local sessions, and clears all in-memory Drive state so
   *  stale caches don't trigger re-uploads via flushUploadQueue.
   *  The _driveWiped flag persists until cleared by clearDriveWipedState()
   *  (called on DRIVE_CONNECT, DRIVE_SYNC_NOW, or user-initiated sync). */
  markDriveWiped(): void {
    this._driveWiped = true;
    this._freshSyncDone = false;
    this.cachedIndexLastSync = null;
    this.cachedBundleVersion = null;
    // [DEEP FIX B] Clear upload queue so flushUploadQueue doesn't re-upload
    // sessions that were just deleted from Drive.
    this.uploadQueue.clear();
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this.firstQueuedAt = 0;
    // [DEEP FIX E] Clear lastUploadedAt so pullFromDrive doesn't use stale
    // version data to skip downloads.
    this.lastUploadedAt.clear();
    // [FIX-L] Reset mutex flags so a wipe during in-flight sync doesn't
    // permanently block all future sync operations.
    this.isPulling = false;
    this.isFlushing = false;
    this.isSyncing = false;
    // [FIX-M] Clear tombstones and pending bumps so stale state doesn't
    // trigger rebuildIndex or block re-capture after wipe.
    this.cachedTombstones.clear();
    this._pendingBundleBump = false;
    console.log('[drive-sync] markDriveWiped — all Drive state cleared, mutexes reset');
  }

  /** [WIPE-RACE-FIX] Called by DRIVE_WIPE handler before wipeAllRemote.
   *  Sets _wipingRemote so clearDriveWipedState() refuses to clear _driveWiped
   *  while the wipe is in progress (prevents concurrent DRIVE_CONNECT from
   *  re-enabling uploads). Also calls markDriveWiped() to clear all state. */
  startRemoteWipe(): void {
    this._wipingRemote = true;
    this.markDriveWiped();
  }

  /** [WIPE-RACE-FIX] Called by DRIVE_WIPE handler after wipeAllRemote completes.
   *  Clears _wipingRemote but keeps _driveWiped = true so uploads stay blocked
   *  until the user explicitly reconnects or triggers a sync. */
  finishRemoteWipe(): void {
    this._wipingRemote = false;
    console.log('[drive-sync] finishRemoteWipe — wipe complete, _driveWiped stays true until user reconnects');
  }

  /** [WIPE-FIX] Clear the _driveWiped flag so normal sync resumes.
   *  Called on DRIVE_CONNECT, DRIVE_SYNC_NOW, or any user-initiated sync.
   *  [WIPE-RACE-FIX] Refuses to clear if _wipingRemote is true — a concurrent
   *  handler must not re-enable uploads while wipeAllRemote is still running. */
  clearDriveWipedState(): void {
    if (this._wipingRemote) {
      console.log('[drive-sync] clearDriveWipedState BLOCKED — remote wipe in progress');
      return;
    }
    if (this._driveWiped) {
      this._driveWiped = false;
      console.log('[drive-sync] clearDriveWipedState — normal sync resumed');
    }
  }

  /** [WIPE-FIX] Public getter — returns true if Drive was wiped and sync
   *  should be blocked. Used by service worker auth handlers and alarm
   *  handler to skip sync after a wipe. */
  isDriveWiped(): boolean {
    return this._driveWiped;
  }

  /** [WIPE-FIX] Full reset of ALL in-memory state. Called after WIPE_LOCAL_DATA
   *  to prevent stale caches from surviving the wipe. */
  fullReset(): void {
    this.uploadQueue.clear();
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this.firstQueuedAt = 0;
    this.lastUploadedAt.clear();
    this.cachedTombstones.clear();
    this.cachedProfileId = null;
    this.cachedSourcedIds = null;
    this.cachedLastSyncAt = null;
    this.cachedLastSyncCount = null;
    this.cachedIndexLastSync = null;
    this.cachedBundleVersion = null;
    this._freshSyncDone = false;
    // [WIPE-FIX] Do NOT clear _driveWiped here — fullReset is called after
    // WIPE_LOCAL_DATA, and we want sync to stay blocked until the user
    // explicitly reconnects or triggers a sync. Clearing it here causes
    // the periodic alarm to immediately re-download old Drive data.
    // _driveWiped is only cleared by clearDriveWipedState().
    this._wipingRemote = false;
    this._pendingBundleBump = false;
    this.lastInitialSyncAt = 0;
    this.storageWriteQueue = {};
    if (this.storageWriteTimer) { clearTimeout(this.storageWriteTimer); this.storageWriteTimer = null; }
    // [DEEP FIX D] Reset cacheWarmupDone so warmupCache re-reads from the
    // now-empty chrome.storage.local on next access.
    this.cacheWarmupDone = false;
    // [FIX-L] Reset mutex flags so a wipe during in-flight sync doesn't
    // permanently block all future sync operations.
    this.isPulling = false;
    this.isFlushing = false;
    this.isSyncing = false;
    console.log('[drive-sync] fullReset — all in-memory state cleared, mutexes reset');
  }

  /** [BUG-9 FIX] Clear the in-memory tombstone cache. Called after WIPE_LOCAL_DATA
   *  so re-captured sessions aren't skipped by queueUpload's tombstone check. */
  clearTombstoneCache(): void {
    this.cachedTombstones.clear();
    console.log('[drive-sync] tombstone cache cleared');
  }

  // [OPTION-B] uploadEmbeddingsForSession removed — embeddings are not synced via Drive.

  private async bootstrapInitialIndex(): Promise<number> {
    // [FIX-K] If Drive was just wiped, don't bootstrap — that would re-upload
    // all local sessions. This guard catches direct calls from initialSync
    // that bypass pullFromDrive's own guard.
    if (this._driveWiped) {
      console.log('[drive-sync] bootstrapInitialIndex skipped — Drive was wiped');
      return 0;
    }
    try {
      // Snapshot local sessions BEFORE seeding so we don't re-upload
      // sessions we are about to download from Drive.
      const originalLocal = await db.getAllSessions();
      const localIdSet = new Set(originalLocal.map((s) => s.id));

      // 6B: Seed — download Drive sessions absent from this profile (partial sync with progress).
      let seeded = 0;
      const seededIds: string[] = [];
      const remoteFiles = await driveClient.listSessionFiles();
      const toSeed = remoteFiles.filter((f) => {
        const id = f.name.replace(/^session-/, "").replace(/\.json$/, "");
        return id && !localIdSet.has(id);
      });
      if (toSeed.length > 0) {
        this.bcast({ type: "PARTIAL_SYNC_PROGRESS", pct: 0, total: toSeed.length, done: 0, phase: "Importing from Drive..." });
      }
      for (let i = 0; i < toSeed.length; i++) {
        const file = toSeed[i];
        try {
          const full = await driveClient.downloadSession(file.id);
          if (full) {
            await db.saveSession(full);
            await this.pullChunksAndHash(full.id);
            seededIds.push(full.id);
            seeded++;
          }
        } catch (e) {
          console.warn("[drive-sync] bootstrap seed failed for", file.name, e);
        }
        const pct = Math.round(((i + 1) / toSeed.length) * 100);
        this.bcast({ type: "PARTIAL_SYNC_PROGRESS", pct, total: toSeed.length, done: i + 1, phase: "Importing from Drive..." });
        if ((i + 1) % 5 === 0 || i + 1 === toSeed.length) {
          this.bcast({ type: "SESSIONS_UPDATED" });
        }
      }
      if (toSeed.length > 0) {
        this.bcast({ type: "PARTIAL_SYNC_PROGRESS", pct: 100, total: toSeed.length, done: seeded, phase: "Done" });
      }

      // Upload originally-local sessions that are NOT already on Drive.
      // [FIX-2] Skip chunk upload — only session JSON + hash. Chunks re-index locally.
      // [MED-2 FIX] Check remoteFiles to avoid re-uploading sessions already in Drive.
      const remoteIds = new Set(
        remoteFiles.map((f) => f.name.replace(/^session-/, "").replace(/\.json$/, ""))
      );
      const toUpload = originalLocal.filter((s) => !remoteIds.has(s.id));
      for (const s of toUpload) {
        await driveClient.uploadSession(s);
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const h = await db.sessionHashes.get(s.id);
            if (h) await driveClient.uploadSessionHash(s.id, h);
            break;
          } catch (ce) {
            console.warn(`[drive-sync] bootstrap hash upload attempt ${attempt} failed`, s.id, ce);
            if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
          }
        }
      }
      await this.rebuildIndex();

      if (seededIds.length) await addSourcedIds(seededIds);
      console.log(
        `[drive-sync] bootstrap: seeded ${seeded} from Drive, uploaded ${toUpload.length} local session(s) (${originalLocal.length - toUpload.length} already on Drive)`
      );
      return seeded;
    } catch (e) {
      console.warn("[drive-sync] bootstrap failed", e);
      return 0;
    }
  }

  /**
   * Called by the SW on sidebar open and after DRIVE_CONNECT.  Pulls in
   * the background and broadcasts SESSIONS_UPDATED when complete.  Never
   * awaited by callers.
   */
  async initialSync(force = false): Promise<void> {
    try {
      if (!(await driveClient.isConnected())) return;
      const now = Date.now();
      if (!force && (now - this.lastInitialSyncAt) < DriveSyncManager.INITIAL_SYNC_COOLDOWN_MS) {
        console.log(`[drive-sync] initialSync skipped — synced ${Math.round((now - this.lastInitialSyncAt) / 1000)}s ago`);
        return;
      }
      this.lastInitialSyncAt = now;
      const result = await this.pullFromDrive();
      if (result.added > 0 || result.updated > 0) {
        try { chrome.runtime.sendMessage({ type: "SESSIONS_UPDATED" }, () => { void chrome.runtime.lastError; }); } catch (err) {
          console.debug("[drive-sync] initialSync: no listener for SESSIONS_UPDATED", err instanceof Error ? err.message : err);
        }
      }
    } catch (e) {
      console.warn("[drive-sync] initialSync error", e);
    }
  }

  /**
   * Delete a session from Drive (and update the index).
   * Called by the SW after local IndexedDB deletion.
   * Silent no-op when Drive is not connected. Never throws.
   */
  private async pullChunksAndHash(sessionId: string): Promise<void> {
    // [OPTION-B] Download only the session hash from Drive (not chunks).
    // Hash tells us if the session was fully indexed on another profile.
    // Each profile indexes locally — chunks are never synced.
    try {
      const hashFileId = await driveClient.findHashBySessionId(sessionId);
      if (!hashFileId) return;
      const remoteHash = await driveClient.downloadSessionHash(hashFileId);
      if (remoteHash) {
        const localSession = await db.getSession(sessionId);
        if (localSession) {
          // [ISSUE-3] Validate chunk count before trusting isComplete=true — prevent phantom hash loop
          let hashWasInvalidated = false;
          if (remoteHash.isComplete === true) {
            const localChunkCount = await dexieDb.chunkEmbeddings
              .where('sessionId').equals(sessionId).count().catch(() => 0);
            if (localChunkCount === 0) {
              if (!this._processedPhantoms.has(sessionId)) {
                console.warn(`[drive-sync] hash restore: ${sessionId} isComplete=true but 0 chunks — invalidating + uploading fix to Drive`);
                remoteHash.isComplete = false;
                hashWasInvalidated = true;
                this._processedPhantoms.add(sessionId);
              }
            } else if (localChunkCount < localSession.messages.length * 0.5) {
              if (!this._processedPhantoms.has(sessionId)) {
                console.warn(`[drive-sync] hash restore: ${sessionId} isComplete=true but only ${localChunkCount} chunks for ${localSession.messages.length} msgs — invalidating`);
                remoteHash.isComplete = false;
                hashWasInvalidated = true;
                this._processedPhantoms.add(sessionId);
              }
            }
          }
          await dexieDb.sessionHashes.put(remoteHash);
          // [ISSUE-3] Upload corrected hash back to Drive so next sync cycle doesn't restore the phantom
          if (hashWasInvalidated) {
            try {
              await driveClient.uploadSessionHash(sessionId, remoteHash);
              console.log(`[drive-sync] uploaded corrected hash for ${sessionId} (isComplete=false) to Drive — breaking phantom loop`);
            } catch (uploadErr) {
              console.warn(`[drive-sync] failed to upload corrected hash for ${sessionId}`, uploadErr);
            }
          }
          console.log(`[drive-sync] hash restored for ${sessionId} (isComplete=${remoteHash.isComplete})`);
        }
      }
    } catch (e) {
      console.warn(`[drive-sync] pullChunksAndHash failed for ${sessionId}`, e);
    }
  }

  async deleteFromDrive(sessionId: string): Promise<void> {
    try {
      if (!(await driveClient.isConnected())) return;
      const fileId = await driveClient.findFileBySessionId(sessionId);
      if (!fileId) return;
      const ok = await driveClient.deleteFile(fileId);
      if (ok) {
        try {
          const cId = await driveClient.findChunksBySessionId(sessionId);
          if (cId) await driveClient.deleteFile(cId);
          const hId = await driveClient.findHashBySessionId(sessionId);
          if (hId) await driveClient.deleteFile(hId);
        } catch (ce) { console.warn("[drive-sync] chunk/hash delete failed", sessionId, ce); }
        console.log(`[drive-sync] deleted session ${sessionId} from Drive`);
        // Remove from the index so other profiles see the deletion.
        await this.removeFromIndex(sessionId);
      }
    } catch (e) {
      console.warn("[drive-sync] deleteFromDrive error", sessionId, e);
    }
  }

  /**
   * Bidirectional sync: pull newer sessions from Drive, push newer
   * local sessions to Drive. Used by the periodic alarm.
   * Never throws.
   */
  private isSyncing = false;

  async syncBidirectional(): Promise<void> {
    if (this.isSyncing) {
      console.debug("[drive-sync] syncBidirectional already in progress — skipping");
      return;
    }
    this.isSyncing = true;
    try {
      if (!(await driveClient.isConnected())) return;
      // [WIPE-FIX] Hard stop if Drive was wiped — no pull, no push.
      if (this._driveWiped) {
        console.log('[drive-sync] syncBidirectional skipped — Drive was wiped');
        return;
      }
      
      // [BUG-4 FIX] If bootstrap previously failed due to no token, and we are now connected, retry it.
      if (this._bootstrapFailedNoToken) {
        console.log('[drive-sync] Retrying bootstrap that previously failed due to no token');
        this._bootstrapFailedNoToken = false;
        await this.bootstrapInitialIndex();
      }

      // Pull first (import remote changes), then flush any queued uploads.
      await this.pullFromDrive();
      // [FIX-J] Don't flush if Drive was just wiped — pullFromDrive already
      // skipped bootstrap, and flushUploadQueue has its own guard, but this
      // avoids a redundant call.
      if (this._driveWiped) return;
      await this.flushUploadQueue();
    } catch (e) {
      console.warn("[drive-sync] syncBidirectional error", e);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Remove a session entry from the Drive index file.
   * Downloads current index, filters out the session, re-uploads.
   */
  private async removeFromIndex(sessionId: string): Promise<void> {
    const release = await this._acquireIndexLock();
    try {
      const index = await driveClient.downloadIndex();
      if (!index) return;
      const before = index.sessions.length;
      index.sessions = index.sessions.filter((e) => e.id !== sessionId);
      // Add to tombstones so other profiles delete locally instead of re-uploading
      if (!index.tombstones) index.tombstones = [];
      const profileId = this.cachedProfileId || "unknown"; // Fallback if missing
      
      // Filter out old tombstone for this ID if it exists
      index.tombstones = index.tombstones.filter(t => (typeof t === 'string' ? t : t.sessionId) !== sessionId);
      
      index.tombstones.push({
        sessionId,
        profileId,
        deletedAt: Date.now(),
        reason: "user_deleted"
      });
      // Cap tombstones at 200 to prevent unbounded growth
      if (index.tombstones.length > 200) index.tombstones = index.tombstones.slice(-200);
      // [TOMBSTONE-FIX] Update local cache so queueUpload skips this session
      // on subsequent captures from open tabs.
      this.cachedTombstones = new Set(index.tombstones.map(t => typeof t === 'string' ? t : t.sessionId));
      index.lastSync = Date.now();
      await driveClient.uploadIndex(index);
      this.cachedIndexLastSync = index.lastSync;
      console.log(`[drive-sync] removed ${sessionId} from Drive index + added to tombstones`);
    } catch (e) {
      console.warn("[drive-sync] removeFromIndex error", sessionId, e);
    } finally { release(); }
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
    } catch (err) {
      console.warn("[drive-sync] getStatus: failed to read storage", err instanceof Error ? err.message : err);
    }
    return { connected, lastSyncAt, lastSyncCount, sourcedIds };
  }
}

export const driveSyncManager = new DriveSyncManager();
