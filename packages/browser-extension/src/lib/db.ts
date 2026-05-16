// packages/browser-extension/src/lib/db.ts
//
// Dexie wrapper around the IndexedDB database "contextmover".
//
// LEGACY MIGRATION NOTE:
//   This database was previously named "contextforge" (pre-rebrand).
//   A one-shot migration in db-migration.ts copies sessions from the
//   legacy "contextforge" IDB into this "contextmover" database and
//   then deletes the old one. Safe to skip on fresh installs where the
//   legacy database does not exist.
//
// Migration strategy:
//   v1 (legacy idb): sessions store
//   v2 (legacy idb): + prompt_templates, prompt_assignments
//   v3 (this file):  + chunk_embeddings, session_hashes, stored_summaries, retrieval_cache
//
// Dexie can take over an existing IDB database as long as:
//   1. The store names match exactly
//   2. The version is >= the previous version
//   3. We declare the schemas for ALL prior versions, not just the latest
// We preserve the legacy schemas by declaring v1, v2, then bumping to v3.

import Dexie, { type Table } from "dexie";
import type { ContextSession, MetaPrompt } from "./types";
import type { PromptTemplate } from "./prompt-engine/types";
import type { QualityScore } from "./quality/migration-scorer";

// ──────────────────────────────────────────────────────────────────────────
// Existing types (kept compatible with the legacy idb schema)
// ──────────────────────────────────────────────────────────────────────────

export interface PromptAssignment {
  id: string;
  sessionId: string;
  platform: string;
  templateId: string;
}

// ──────────────────────────────────────────────────────────────────────────
// New types — Semantic Index (v3)
// ──────────────────────────────────────────────────────────────────────────

export interface ChunkEmbedding {
  id: string;                  // "{sessionId}:{chunkIndex}"
  sessionId: string;
  chunkIndex: number;
  text: string;
  embedding: number[];         // 384-dim vector
  role: "user" | "assistant";
  messageIndex: number;
  hasCode: boolean;
  language?: string;
  tokenCount: number;
  createdAt: number;
}

export interface SessionHash {
  sessionId: string;           // primary key
  hash: string;                // djb2 hash of messages
  chunkCount: number;
  messageCount: number;
  model: string;               // which model embedded this
  indexedAt: number;
}

export interface StoredSummary {
  id: string;                  // "{sessionId}:{tier}:{taskHash}"
  sessionId: string;
  tier: 1 | 2 | 3;
  task: string | null;
  content: string;             // tier1: string, tier2: JSON
  compressionRatio: number;
  builtAt: number;
  messageCount: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Migration Quality (v4)
// ──────────────────────────────────────────────────────────────────────────

export interface MigrationQualityRecord {
  id: string;                            // migrationId (uuid)
  sessionId: string;
  sessionTitle: string;
  platform: string;
  tier: 1 | 2 | 3;
  score: number;                         // 0–100
  grade: string;
  breakdown: QualityScore["breakdown"];
  meta: QualityScore["meta"];
  createdAt: number;
}

export interface RetrievalCache {
  id: string;                  // "{sessionId}:{queryHash}:{platform}:{tier}:{templateId}"
  sessionId: string;
  queryHash: string;
  chunkIds: string[];
  prompt: string;
  platform: string;
  tier: number;
  templateId: string | null;
  builtAt: number;
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory session cache — kept for backwards compatibility with callers
// ──────────────────────────────────────────────────────────────────────────

class SessionCache {
  private byId = new Map<string, ContextSession>();
  private all: ContextSession[] | null = null;
  private cacheTime = 0;
  private readonly TTL = 5_000;

  isValid(): boolean { return Date.now() - this.cacheTime < this.TTL; }

  setAll(sessions: ContextSession[]): void {
    this.all = sessions;
    this.byId.clear();
    for (const s of sessions) this.byId.set(s.id, s);
    this.cacheTime = Date.now();
  }

  getAll(): ContextSession[] | null {
    return this.isValid() ? this.all : null;
  }

  get(id: string): ContextSession | null {
    return this.isValid() ? (this.byId.get(id) ?? null) : null;
  }

  upsert(session: ContextSession): void {
    this.byId.set(session.id, session);
    if (this.all !== null) {
      const idx = this.all.findIndex((s) => s.id === session.id);
      if (idx >= 0) this.all[idx] = session;
      else this.all = [session, ...this.all];
      this.cacheTime = Date.now();
    }
  }

  invalidate(): void {
    this.all = null;
    this.cacheTime = 0;
  }
}

export const sessionCache = new SessionCache();

// ──────────────────────────────────────────────────────────────────────────
// Dexie database class
// ──────────────────────────────────────────────────────────────────────────

class ContextMoverDB extends Dexie {
  // Legacy stores (kept verbatim — original idb store names use snake_case)
  sessions!: Table<ContextSession, string>;
  prompt_templates!: Table<PromptTemplate, string>;
  prompt_assignments!: Table<PromptAssignment, string>;

  // New semantic-index stores (v3)
  chunkEmbeddings!: Table<ChunkEmbedding, string>;
  sessionHashes!: Table<SessionHash, string>;
  storedSummaries!: Table<StoredSummary, string>;
  retrievalCache!: Table<RetrievalCache, string>;

  // Migration quality store (v4)
  migrationQuality!: Table<MigrationQualityRecord, string>;

  // Pre-built MetaPrompt store (v5) — per-session per-platform per-tier
  metaPrompts!: Table<MetaPrompt, string>;

  constructor() {
    super("contextmover");

    // ── v1: original sessions store ──
    this.version(1).stores({
      sessions: "id, platform, updatedAt",
    });

    // ── v2: + prompt templates / assignments ──
    this.version(2).stores({
      sessions: "id, platform, updatedAt",
      prompt_templates: "id, userId, isDefault, usageCount, updatedAt",
      prompt_assignments: "id, sessionId, platform, templateId",
    });

    // ── v3: + semantic-index stores (camelCase per Dexie spec) ──
    this.version(3).stores({
      sessions: "id, platform, updatedAt",
      prompt_templates: "id, userId, isDefault, usageCount, updatedAt",
      prompt_assignments: "id, sessionId, platform, templateId",
      chunkEmbeddings: "id, sessionId, createdAt, hasCode",
      sessionHashes: "sessionId, indexedAt",
      storedSummaries: "id, sessionId, tier, builtAt",
      retrievalCache: "id, sessionId, builtAt",
    });

    // ── v4: + migrationQuality store (per-migration scorecard) ──
    // Indexes: by sessionId for per-session queries, by platform/tier for
    // aggregation in the report generator, by score and createdAt for
    // chronological / sorted scans without full-table reads.
    this.version(4).stores({
      sessions: "id, platform, updatedAt",
      prompt_templates: "id, userId, isDefault, usageCount, updatedAt",
      prompt_assignments: "id, sessionId, platform, templateId",
      chunkEmbeddings: "id, sessionId, createdAt, hasCode",
      sessionHashes: "sessionId, indexedAt",
      storedSummaries: "id, sessionId, tier, builtAt",
      retrievalCache: "id, sessionId, builtAt",
      migrationQuality: "id, sessionId, platform, tier, score, createdAt",
    });

    // ── v5: + metaPrompts store (pre-built migration prompts) ──
    // Indexed by sessionId for fast lookup during migration.
    this.version(5).stores({
      sessions: "id, platform, updatedAt",
      prompt_templates: "id, userId, isDefault, usageCount, updatedAt",
      prompt_assignments: "id, sessionId, platform, templateId",
      chunkEmbeddings: "id, sessionId, createdAt, hasCode",
      sessionHashes: "sessionId, indexedAt",
      storedSummaries: "id, sessionId, tier, builtAt",
      retrievalCache: "id, sessionId, builtAt",
      migrationQuality: "id, sessionId, platform, tier, score, createdAt",
      metaPrompts: "id, platform, tier, builtAt",
    });

    // ── v6: metaPrompts composite key ── the prior simple "id" keyPath caused
    // every platform/tier record for the same session to overwrite each other.
    // Recreate the store with a compound primary key [sessionId+platform+tier].
    this.version(6).stores({
      sessions: "id, platform, updatedAt",
      prompt_templates: "id, userId, isDefault, usageCount, updatedAt",
      prompt_assignments: "id, sessionId, platform, templateId",
      chunkEmbeddings: "id, sessionId, createdAt, hasCode",
      sessionHashes: "sessionId, indexedAt",
      storedSummaries: "id, sessionId, tier, builtAt",
      retrievalCache: "id, sessionId, builtAt",
      migrationQuality: "id, sessionId, platform, tier, score, createdAt",
      metaPrompts: "[sessionId+platform+tier], sessionId, builtAt",
    });
  }
}

export const dexieDb = new ContextMoverDB();

// ── Schema-conflict recovery ────────────────────────────────────────────────
// Dexie cannot alter the primary key of an existing store. If a prior version
// created `metaPrompts` with keyPath `id` and a newer version needs the compound
// key `[sessionId+platform+tier]`, Dexie throws SchemaError on open. We catch it,
// delete the DB, and let Dexie recreate from scratch. Local session data can be
// re-captured from the page, so this is safe.
export async function ensureDbReady(): Promise<void> {
  if (dexieDb.isOpen()) return;
  try {
    await dexieDb.open();
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const name = err?.name ?? "";
    // Dexie throws several distinct error types when an upgrade can't run.
    // The most common in practice (and the one currently breaking users) is:
    //   UpgradeError: "Not yet support for changing primary key"
    // — fired when the metaPrompts store's keyPath changed from `id` to
    // `[sessionId+platform+tier]` (v5 → v6). Match on both message substrings
    // and Dexie's error names so any schema-impossible-to-migrate case is
    // recovered by deleting and recreating the DB.
    const isSchemaProblem =
      name === "UpgradeError" ||
      name === "SchemaError" ||
      name === "VersionError" ||
      msg.includes("Schema") ||
      msg.includes("keyPath") ||
      msg.includes("primary key") ||
      msg.includes("object store") ||
      msg.includes("Cannot upgrade") ||
      msg.includes("not compatible") ||
      msg.includes("UpgradeError");
    if (isSchemaProblem) {
      console.warn(
        `[CM:db] Schema conflict detected (${name}: ${msg}) — recreating database...`
      );
      try { dexieDb.close(); } catch { /* already closed */ }
      await Dexie.delete("contextmover");
      await dexieDb.open();
      console.log("[CM:db] Database recreated successfully");
    } else {
      throw err;
    }
  }
}

// Friendly aliases — direct table exports for ergonomic imports elsewhere.
export const chunkEmbeddings: Table<ChunkEmbedding, string> = dexieDb.chunkEmbeddings;
export const sessionHashes: Table<SessionHash, string> = dexieDb.sessionHashes;
export const storedSummaries: Table<StoredSummary, string> = dexieDb.storedSummaries;
export const retrievalCache: Table<RetrievalCache, string> = dexieDb.retrievalCache;
export const migrationQuality: Table<MigrationQualityRecord, string> = dexieDb.migrationQuality;
export const metaPrompts: Table<MetaPrompt, string> = dexieDb.metaPrompts;

// ──────────────────────────────────────────────────────────────────────────
// Backwards-compatible facade — same public surface as the old `db` object
// ──────────────────────────────────────────────────────────────────────────

export const db = {
  // Convenient direct table access (used by SemanticIndex + new handlers)
  sessions: dexieDb.sessions,
  chunkEmbeddings: dexieDb.chunkEmbeddings,
  sessionHashes: dexieDb.sessionHashes,
  storedSummaries: dexieDb.storedSummaries,
  retrievalCache: dexieDb.retrievalCache,
  migrationQuality: dexieDb.migrationQuality,
  metaPrompts: dexieDb.metaPrompts,

  // Legacy methods — preserved exactly so existing callers do not break
  async saveSession(session: ContextSession): Promise<void> {
    await dexieDb.sessions.put(session);
    sessionCache.upsert(session);
  },

  async getSession(id: string): Promise<ContextSession | undefined> {
    const cached = sessionCache.get(id);
    if (cached) return cached;
    return dexieDb.sessions.get(id);
  },

  async getAllSessions(): Promise<ContextSession[]> {
    const cached = sessionCache.getAll();
    if (cached) return cached;
    const sessions = await dexieDb.sessions.orderBy("updatedAt").reverse().toArray();
    sessionCache.setAll(sessions);
    return sessions;
  },

  async deleteSession(id: string): Promise<void> {
    await dexieDb.sessions.delete(id);
    sessionCache.invalidate();
  },

  async getSessionsByPlatform(platform: string): Promise<ContextSession[]> {
    return dexieDb.sessions.where("platform").equals(platform).toArray();
  },

  async saveMetaPrompt(metaPrompt: MetaPrompt): Promise<void> {
    await dexieDb.metaPrompts.put(metaPrompt);
  },

  async getMetaPrompt(sessionId: string, platform: string, tier: 1 | 2 | 3): Promise<MetaPrompt | undefined> {
    return dexieDb.metaPrompts.get([sessionId, platform, tier]);
  },

  async deleteMetaPrompt(sessionId: string): Promise<void> {
    await dexieDb.metaPrompts.where("sessionId").equals(sessionId).delete();
  },
};

// Legacy compatibility — the old `getDb()` returned an idb-style IDBPDatabase
// used by prompt-engine and cloud-sync code. We provide a thin idb-compatible
// facade over Dexie so those callers keep working unchanged.
class IdbFacade {
  constructor(private d: ContextMoverDB) {}
  async getAll<T = unknown>(storeName: string): Promise<T[]> {
    return this.d.table(storeName).toArray() as Promise<T[]>;
  }
  async get<T = unknown>(storeName: string, key: string): Promise<T | undefined> {
    return this.d.table(storeName).get(key) as Promise<T | undefined>;
  }
  async put<T = unknown>(storeName: string, value: T): Promise<unknown> {
    return this.d.table(storeName).put(value as Record<string, unknown>);
  }
  async delete(storeName: string, key: string): Promise<void> {
    await this.d.table(storeName).delete(key);
  }
  async getAllFromIndex<T = unknown>(storeName: string, indexName: string, value?: unknown): Promise<T[]> {
    if (value === undefined) {
      return this.d.table(storeName).orderBy(indexName).toArray() as Promise<T[]>;
    }
    return this.d.table(storeName).where(indexName).equals(value as string | number).toArray() as Promise<T[]>;
  }
  async clear(storeName: string): Promise<void> {
    await this.d.table(storeName).clear();
  }
}

let _idbFacade: IdbFacade | null = null;
export async function getDb(): Promise<IdbFacade> {
  if (_idbFacade) return _idbFacade;
  await dexieDb.open();
  _idbFacade = new IdbFacade(dexieDb);
  return _idbFacade;
}
