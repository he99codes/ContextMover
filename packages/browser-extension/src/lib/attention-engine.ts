/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/attention-engine.ts
//
// Attention Engine — semantic understanding layer for context migration.
// Transforms dumb token compression into task-aware, embedding-driven extraction.
//
// Vector store : in-memory cosine search over Float32Arrays, persisted in a
//               dedicated IndexedDB database ("contextmover-attention").
//               LanceDB has no browser/WASM build; this is the correct
//               in-browser alternative with identical API surface.
//
// Embeddings   : @xenova/transformers — Xenova/all-MiniLM-L6-v2 (384-dim).
//               Dynamic import, model cached in browser cache after first load.
//               Falls back to keyword TF-IDF scoring if model unavailable.
//
// AST parsing  : web-tree-sitter runtime + pre-built grammar .wasm files
//               from tree-sitter-wasms (npm).  Grammar files must be copied
//               to web_accessible_resources (extension) or /public/grammars/
//               (web app) — see vite.config.ts.  Falls back to regex extraction
//               if grammars are absent or fail to load.

import { openDB, type IDBPDatabase } from "idb";
import { sampleForEmbedding } from "./semantic-index/chunker";
import type { ContextSession, Message, CodeBlock, ScoredMessage, ScoredMessageScores } from "./types";
import { dexieDb, type ChunkEmbedding } from "./db";
import { recordPerf } from "./perf-track";
import { cosineSimilarity, searchContextChunks } from "./math";
import {
  capabilityDetector,
  getTierConfig,
  type Tier,
  type TierConfig,
  type SystemHeadroom,
  startHeadroomMonitor,
} from "./capability-detector";
import { latencyTracker } from "./adaptive-timeout";

// ─────────────────────────────────────────────────────────────────────────────
// Public interfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface FileStructure {
  path: string;
  language: string;
  functions: string[];
  classes: string[];
  imports: string[];
  exports: string[];
  dependencies: string[];
}

export interface AppStructure {
  files: FileStructure[];
  modules: {
    name: string;
    type: "component" | "service" | "util" | "config" | "test" | "unknown";
    relatedFiles: string[];
  }[];
  lastUpdated: number;
}

export interface AttentionChunk {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  embedding: number[];
  relevanceScore: number;
  type: "message" | "code";
  filePath?: string;
  language?: string;
  timestamp: number;
  // [CM-OFFSCREEN-FIX] true when chunks were written without embeddings because
  // the offscreen document was unavailable. retrieve() will use keyword fallback
  // for these chunks. Lets T3 proceed (with keyword ranking) instead of failing.
  keywordOnly?: boolean;
}

export interface AttentionMap {
  task: string;
  threshold: number;
  topChunks: AttentionChunk[];
  highlightedFiles: string[];
  highlightedModules: string[];
  structuralContext: AppStructure;
  focusedContext: string;
  compressionRatio: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ATTENTION_DB_NAME = "contextmover-attention";
const ATTENTION_DB_VERSION = 1;
const CHUNKS_STORE = "ae_chunks";
const STRUCTURE_STORE = "ae_structure";
const SESSIONS_META_STORE = "ae_sessions_meta";
const STRUCTURE_KEY = "singleton";

// Default model ID — overridden per-tier by TIER_CONFIGS at initialize() time.
const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;
const EMBEDDING_CACHE_MAX = 500;
const SEARCH_TOP_K = 100;
const TAIL_SIZE = 6;

const THRESHOLDS: Record<"light" | "balanced" | "strict", number> = { light: 0.4, balanced: 0.45, strict: 0.7 };

const TAG = "[ContextMover:attention-engine]";

// [CM-FIX-3] Migration guard — when SW signals MIGRATION_ACTIVE, indexSession()
// backs off immediately so it doesn't compete with migration for the ONNX worker.
let _migrationActive = false;
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'MIGRATION_ACTIVE') {
      _migrationActive = !!msg.active;
    }
  });
} catch { /* not in extension context */ }

// [PRE-COMPUTE-FIX] In-memory attention map cache keyed by sessionId + task.
// The SW pre-computes a default-task attention map after capture; the sidebar
// live preview also builds maps. Caching prevents duplicate ONNX scoring when
// the same session + task is requested again within the TTL window.
const ATTENTION_MAP_CACHE_TTL_MS = 5 * 60_000; // 5 min
const _attentionMapCache = new Map<string, { map: AttentionMap; ts: number }>();

export function invalidateAttentionMapCache(sessionId: string): void {
  for (const key of _attentionMapCache.keys()) {
    if (key.startsWith(`${sessionId}::`)) {
      _attentionMapCache.delete(key);
    }
  }
}

function attentionCacheKey(sessionId: string, task: string, strength: string): string {
  return `${sessionId}::${task}::${strength}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Offscreen document helpers
// ─────────────────────────────────────────────────────────────────────────────

async function ensureOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("src/offscreen/offscreen.html"),
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Run embedding model inference via WASM",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grammar URL helper
//
// Grammar .wasm files must be present at these paths:
//   Extension : web_accessible_resources → chrome.runtime.getURL('grammars/...')
//   Web app   : /public/grammars/...
//
// Copy them from: node_modules/tree-sitter-wasms/out/*.wasm
// (done in vite.config.ts — see Piece 2 of the Attention Engine setup)
// ─────────────────────────────────────────────────────────────────────────────

const GRAMMAR_FILE_MAP: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
};

function grammarUrl(lang: string): string {
  const file = GRAMMAR_FILE_MAP[lang] ?? `tree-sitter-${lang}.wasm`;
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(`grammars/${file}`);
  }
  return `/grammars/${file}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AttentionEngine
// ─────────────────────────────────────────────────────────────────────────────

export class AttentionEngine {
  /** LRU-style cache: first 100 chars of text → Float32Array embedding. */
  private embeddingCache = new Map<string, number[]>();

  private idb: IDBPDatabase | null = null;
  private appStructure: AppStructure | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tsParser: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tsLanguages = new Map<string, any>();
  private treeSitterAvailable = false;
  private modelAvailable = true;
  initialized = false;
  /** In-flight init promise so concurrent callers await the same work. */
  private initPromise: Promise<void> | null = null;

  /** Active tier — set by initialize() and mutated by downgradeToMinimal(). */
  private tier: Tier = "balanced";
  /** Resolved tier configuration (model id, device, thread count, etc.). */
  private tierConfig: TierConfig = getTierConfig("balanced");
  /** Unsubscribe fn for capabilityDetector.onDowngrade(). */
  private offDowngrade: (() => void) | null = null;
  private currentHeadroom: SystemHeadroom | null = null;
  private stopHeadroomMonitor: (() => void) | null = null;
  /** Original tier defaults captured before any dynamic boost overrides. */
  private baselineConfig: TierConfig | null = null;
  private boosted = false;

  // ─── initialize ──────────────────────────────────────────────────────────

  /**
   * Load the embedding model + tree-sitter runtime.
   * Safe to call multiple times — subsequent calls are no-ops.
   * Reports 0→100 progress via onProgress.
   */
  async initialize(
    onProgress?: (progress: number) => void,
    tier?: Tier,
  ): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    // Resolve the tier — explicit arg wins; otherwise ask the detector.
    this.tier = tier ?? (await capabilityDetector.getEffectiveTier().catch(() => "balanced"));
    this.tierConfig = getTierConfig(this.tier);
    if (!this.baselineConfig) this.baselineConfig = { ...this.tierConfig };
    this.stopHeadroomMonitor?.();
    this.stopHeadroomMonitor = startHeadroomMonitor((headroom) => {
      this.currentHeadroom = headroom;
      this.applyDynamicBoost(headroom);
    });
    console.log(`${TAG} Initializing tier=${this.tier} config=`, this.tierConfig);
    onProgress?.(0);

    // Subscribe to mid-migration downgrade events so we can react in flight.
    this.offDowngrade?.();
    this.offDowngrade = capabilityDetector.onDowngrade((from, to, reason) => {
      if (from === this.tier) {
        console.warn(`${TAG} live downgrade ${from}→${to} (${reason})`);
        if (to === "minimal") this.downgradeToMinimal(reason);
        else { this.tier = to; this.tierConfig = getTierConfig(to); }
      }
    });

    this.initPromise = (async () => {
      try {
        await this.openIdb();
        onProgress?.(8);

        this.appStructure = await this.loadAppStructure();
        onProgress?.(12);

        // Minimal tier skips tree-sitter entirely — relies on regex code-block extractor.
        // Embeddings are handled by the offscreen document via chrome.runtime messages.
        if (!this.tierConfig.useEmbeddings) {
          this.treeSitterAvailable = false;
          onProgress?.(100);
          this.initialized = true;
          console.log(`${TAG} Ready (minimal tier — regex only)`);
          return;
        }

        onProgress?.(80);

        if (this.tierConfig.useTreeSitter) {
          await this.initTreeSitter();
        }
        onProgress?.(100);

        this.initialized = true;
        console.log(
          `${TAG} Ready tier=${this.tier} model=${this.modelAvailable} treeSitter=${this.treeSitterAvailable}`
        );
      } catch (err) {
        // Partial init still produces a working engine (keyword fallback active).
        console.warn(`${TAG} Init error (partial init, keyword fallback active):`, err);
        this.initialized = true;
        onProgress?.(100);
      }
    })();

    await this.initPromise;
    this.initPromise = null;
  }

  // ─── downgradeToMinimal ───────────────────────────────────────────────────

  /**
   * Live-downgrade the running engine to the minimal tier without re-initializing.
   * Drops the loaded model so subsequent embedding calls return zero-vectors and
   * fall through to the keyword scoring path.  Idempotent.
   */
  downgradeToMinimal(reason = "manual"): void {
    if (this.tier === "minimal") return;
    console.warn(`${TAG} downgradeToMinimal: ${reason}`);
    this.tier = "minimal";
    this.tierConfig = getTierConfig("minimal");
  }

  /** Currently active tier — read by callers for telemetry/UI. */
  getActiveTier(): Tier {
    return this.tier;
  }

  /** Release the headroom monitor and downgrade listener. Call when tearing down. */
  destroy(): void {
    this.stopHeadroomMonitor?.();
    this.stopHeadroomMonitor = null;
    this.offDowngrade?.();
    this.offDowngrade = null;
  }

  // ─── applyDynamicBoost ────────────────────────────────────────────────────

  private applyDynamicBoost(headroom: SystemHeadroom): void {
    const base = this.baselineConfig ?? this.tierConfig;
    if (headroom.boostEligible) {
      this.tierConfig.batchSize = Math.min(headroom.recommendedBatchSize, 64);
      this.tierConfig.maxWasmThreads = Math.min(headroom.recommendedThreads, 8);
      this.boosted = true;
      console.debug(
        `${TAG} Boosted: batch=${headroom.recommendedBatchSize} threads=${headroom.recommendedThreads} gpu=${headroom.gpuAvailable}`
      );
    } else if (this.boosted) {
      this.tierConfig.batchSize = base.batchSize;
      this.tierConfig.maxWasmThreads = base.maxWasmThreads;
      this.boosted = false;
      console.debug(`${TAG} Boost removed: system under load`);
    }
  }

  // ─── buildStructure ───────────────────────────────────────────────────────

  /**
   * Parse all code blocks in a set of messages with tree-sitter (or regex
   * fallback), extract functions/classes/imports/exports, and merge the result
   * into the persistent AppStructure.  Never overwrites — only adds.
   */
  async buildStructure(messages: Message[]): Promise<AppStructure> {
    const blocks = this.extractCodeBlocks(messages);
    console.log(`${TAG} buildStructure — ${blocks.length} code block(s) found`);

    const current = this.appStructure ?? this.emptyStructure();

    for (const block of blocks) {
      if (!block.content.trim()) continue;
      const lang = block.language && block.language !== "unknown"
        ? block.language
        : this.detectLanguage(block.content);
      const parsed = await this.parseCode(block.content, lang);
      const path = block.path ?? `unknown.${langExt(lang)}`;

      const existing = current.files.find((f) => f.path === path);
      if (existing) {
        existing.functions   = dedupe([...existing.functions,   ...parsed.functions]);
        existing.classes     = dedupe([...existing.classes,     ...parsed.classes]);
        existing.imports     = dedupe([...existing.imports,     ...parsed.imports]);
        existing.exports     = dedupe([...existing.exports,     ...parsed.exports]);
        existing.dependencies = dedupe([...existing.dependencies, ...parsed.dependencies]);
      } else {
        current.files.push({ path, language: lang, ...parsed });
      }
    }

    current.modules    = this.inferModules(current.files);
    current.lastUpdated = Date.now();
    this.appStructure  = current;

    await this.saveAppStructure(current);
    return current;
  }

  // ─── indexSession ─────────────────────────────────────────────────────────

  /**
   * Generate and persist embeddings for new messages + code blocks in a session.
   * Delta-only: fetches existing chunk IDs from IDB and only embeds chunks
   * whose IDs are not already stored. Existing chunks are never deleted or
   * re-written. Falls through to a full index when no chunks exist yet.
   * Fire-and-forget safe: any error is logged and silently ignored.
   */
  async indexSession(session: ContextSession): Promise<void> {
    // [CM-FIX-3] Back off during migration — SW owns the ONNX worker during this window.
    if (_migrationActive) {
      console.debug(`${TAG} indexSession skipped (migration active): ${session.id}`);
      return;
    }
    // [FIX-5] Cross-context check: ask the SW if it's already indexing this session.
    // The sidebar and SW run in separate JS contexts — module-level Sets are NOT shared.
    // Without this, both paths call offscreenIndex simultaneously, doubling ONNX worker
    // load and causing offscreen timeouts.
    try {
      const resp = await chrome.runtime.sendMessage({ type: "CHECK_INDEXING", sessionId: session.id });
      if (resp?.inFlight) {
        console.debug(`${TAG} indexSession skipped — SW is already indexing ${session.id}`);
        return;
      }
    } catch {
      // SW may not be listening (e.g. during startup) — proceed with sidebar index.
    }
    console.log(
      `${TAG} indexSession — session=${session.id} msgs=${session.messages.length}`
    );

    // [FIX-9] If Dexie (authoritative store) already has chunks for this session,
    // skip the attention IDB write entirely. The SW's offscreen path is authoritative
    // and the sidebar's delta-index only creates duplicate ONNX embed jobs that bloat
    // the attention IDB with unsampled chunks (366 for 199 msgs in logs).
    // [FIX-11] Coverage check — if Dexie has chunks but coverage is < 50%, the
    // session is severely under-indexed (e.g. 16 chunks for 132 msgs). Continue
    // indexing instead of skipping.
    const dexieCount = await dexieDb.chunkEmbeddings
      .where('sessionId').equals(session.id).count().catch(() => 0);
    if (dexieCount > 0 && dexieCount >= session.messages.length * 0.5) {
      console.debug(
        `${TAG} indexSession skipped — Dexie has ${dexieCount} chunks for ${session.id} (authoritative)`
      );
      return;
    }
    if (dexieCount > 0) {
      console.warn(
        `${TAG} indexSession — Dexie has only ${dexieCount} chunks for ${session.messages.length} msgs (low coverage) — continuing index`
      );
    }

    const db = await this.openIdb();

    // Rebuild structural map with any new code (cheap, always run).
    await this.buildStructure(session.messages);

    // Build the full set of raw chunks for the current session state.
    const rawChunks = this.sessionToChunks(session);
    const cap = this.tierConfig.maxChunksPerSession || rawChunks.length;
    // [T6-FIX] Use shared 10/40/50 distribution sampling instead of simple slice(0,cap).
    // Matches the offscreen processIndexJob path so both DBs embed the same chunk coverage.
    const allRaw = sampleForEmbedding(rawChunks, cap);

    // Fetch IDs of chunks already stored in IDB for this session.
    const existingChunks = await (
      db.getAllFromIndex(CHUNKS_STORE, "sessionId", session.id) as Promise<AttentionChunk[]>
    );
    const existingIds = new Set(existingChunks.map((c) => c.id));

    // Delta: only embed chunks not already present in IDB.
    const newChunks = allRaw.filter((c) => !existingIds.has(c.id));

    if (newChunks.length === 0) {
      // All chunks accounted for — just refresh the meta counter.
      await (db.put(SESSIONS_META_STORE, {
        sessionId: session.id,
        messageCount: session.messages.length,
        indexedAt: Date.now(),
      }) as Promise<unknown>);
      console.log(
        `${TAG} Session ${session.id} fully up-to-date — ` +
        `${existingChunks.length} chunk(s) already indexed, nothing new`
      );
      return;
    }

    console.log(
      `${TAG} Delta-indexing ${newChunks.length} new chunk(s) for session ${session.id} ` +
      `(${existingChunks.length} already indexed, tier=${this.tier} cap=${cap})`
    );

    // [CM-OFFSCREEN-FIX] Embed only the new chunks. If the offscreen document
    // is dead (the v1.0.4 regression), embedChunks throws. Previously this was
    // silently swallowed (fire-and-forget) leaving ae_chunks empty → SW's
    // hasAttentionChunks() returned false → T3 fell back to T1. Now we catch
    // the failure and write keyword-only chunks (zeroed embeddings +
    // keywordOnly flag) so retrieve() can use keyword fallback immediately.
    let embedded: AttentionChunk[];
    let keywordOnly = false;
    try {
      embedded = await this.embedChunks(newChunks);
    } catch (embedErr) {
      console.warn(
        `${TAG} indexSession — embedChunks FAILED for ${session.id} ` +
        `(offscreen unavailable?): ${embedErr instanceof Error ? embedErr.message : String(embedErr)}. ` +
        `Writing keyword-only chunks so retrieve() can use keyword fallback.`
      );
      embedded = newChunks.map((c) => ({
        ...c,
        embedding: new Array(EMBEDDING_DIM).fill(0),
        keywordOnly: true,
      }));
      keywordOnly = true;
    }

    // Append new chunks + update meta atomically. Never touches existing chunks.
    const tx = db.transaction([CHUNKS_STORE, SESSIONS_META_STORE], "readwrite");
    for (const chunk of embedded) {
      await tx.objectStore(CHUNKS_STORE).put(chunk);
    }
    await tx.objectStore(SESSIONS_META_STORE).put({
      sessionId: session.id,
      messageCount: session.messages.length,
      indexedAt: Date.now(),
      // [CM-OFFSCREEN-FIX] record whether this index was keyword-only so the
      // SW bridge knows whether to attempt re-index with embeddings later.
      keywordOnly,
    });
    await tx.done;

    console.log(
      `${TAG} Appended ${embedded.length} new chunk(s) for session ${session.id}` +
      `${keywordOnly ? ' (keyword-only — offscreen was unavailable)' : ''}`
    );
  }

  // ─── buildAttentionMap ────────────────────────────────────────────────────

  /**
   * Build a task-aware AttentionMap for a session.
   *
   * light  — keep chunks with score ≥ 0.4
   * strict — keep chunks with score ≥ 0.7
   * Always includes: last TAIL_SIZE messages + full structural context.
   */
  async buildAttentionMap(
    session: ContextSession,
    task: string,
    strength: "light" | "balanced" | "strict",
    signal?: AbortSignal,
    _skipMigrationGuard = false
  ): Promise<AttentionMap> {
    if (_migrationActive && !_skipMigrationGuard) {
      console.log(`${TAG} buildAttentionMap skipped (migration active): ${session.id}`);
      throw new Error('migration_active');
    }
    console.log(`${TAG} buildAttentionMap — strength=${strength}`);

    const threshold = THRESHOLDS[strength];

    // [PRE-COMPUTE-FIX] Check in-memory cache before running ONNX scoring.
    const cacheKey = attentionCacheKey(session.id, task, strength);
    const cached = _attentionMapCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ATTENTION_MAP_CACHE_TTL_MS) {
      console.log(`${TAG} AttentionMap cache hit — returning cached map for ${session.id}`);
      return cached.map;
    }

    // Ensure session is indexed first.
    await this.indexSession(session);

    // Multi-query expansion: embed 3-5 task variants and average for richer retrieval.
    const variants = this.expandQueryVariants(task);
    // [T3-FIX] Pass signal so batches self-cancel if SW's kill-switch fires.
    const variantEmbs = await this.embedTexts(variants, signal, _skipMigrationGuard);
    const taskEmb = variantEmbs.length > 0
      ? this.averageEmbeddings(variantEmbs)
      : await this.getEmbedding(task);

    // [T5-FIX] Read from Dexie chunkEmbeddings first — this is the authoritative
    // store populated by the SW's priority index job (same model, same vectors).
    // The attention IDB (ae_chunks) is only populated by sidebar indexSession(),
    // which may be empty or stale if the sidebar never ran. Using Dexie ensures
    // buildAttentionMap scores the exact same chunks that retrieve() used.
    let allChunks: AttentionChunk[] = [];
    const dexieChunks = await dexieDb.chunkEmbeddings
      .where('sessionId').equals(session.id).toArray();

    if (dexieChunks.length > 0) {
      // Map ChunkEmbedding → AttentionChunk.
      // timestamp: derive from messageIndex (relative ordering preserved).
      // type: 'code' if hasCode, else 'message'.
      // filePath: use language as a proxy (only code chunks have it).
      allChunks = dexieChunks.map((c): AttentionChunk => ({
        id: c.id,
        sessionId: c.sessionId,
        role: c.role,
        content: c.text,
        embedding: c.embedding,
        relevanceScore: 0,
        type: c.hasCode ? 'code' : 'message',
        filePath: c.hasCode && c.language ? `unknown.${c.language}` : undefined,
        language: c.language,
        timestamp: c.messageIndex,
      }));
      console.log(`${TAG} Scoring ${allChunks.length} chunk(s) from Dexie (authoritative store)`);

      // [FIX-9] Clean up stale attention IDB chunks for this session.
      // The attention IDB may have 300+ unsampled chunks from sidebar delta-indexing
      // that are never read when Dexie is authoritative. Clear them to reclaim storage.
      try {
        const aeDb = await this.openIdb();
        const tx = aeDb.transaction(CHUNKS_STORE, "readwrite");
        const idx = tx.store.index("sessionId");
        let cursor = await idx.openCursor(session.id);
        let cleared = 0;
        while (cursor) {
          await cursor.delete();
          cleared++;
          cursor = await cursor.continue();
        }
        await tx.done;
        if (cleared > 0) {
          console.log(`${TAG} Cleaned up ${cleared} stale attention IDB chunks for ${session.id}`);
        }
      } catch (e) {
        console.warn(`${TAG} Attention IDB cleanup failed (non-fatal):`, e);
      }
    } else {
      // Fallback: read from the attention IDB (sidebar-indexed path).
      const db = await this.openIdb();
      allChunks = await (
        db.getAllFromIndex(CHUNKS_STORE, "sessionId", session.id) as Promise<AttentionChunk[]>
      );
      console.log(`${TAG} Scoring ${allChunks.length} chunk(s) from attention IDB (fallback)`);
    }

    // Score every chunk.
    const scored: AttentionChunk[] = allChunks.map((chunk) => ({
      ...chunk,
      relevanceScore:
        taskEmb.some((v) => v !== 0) && chunk.embedding.length === EMBEDDING_DIM
          ? this.cosineSimilarity(taskEmb, chunk.embedding)
          : this.keywordScore(task, chunk.content),
    }));

    // Context chain preservation: boost near-threshold neighbors of high-score chunks
    // so setup/context messages are included alongside their payoff messages.
    const chronological = [...scored].sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < chronological.length; i++) {
      if (chronological[i].relevanceScore >= threshold) {
        for (const delta of [-1, 1]) {
          const neighbor = chronological[i + delta];
          if (
            neighbor &&
            neighbor.relevanceScore < threshold &&
            neighbor.relevanceScore >= threshold * 0.65
          ) {
            neighbor.relevanceScore = threshold;
          }
        }
      }
    }

    // Sort descending and apply threshold.
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const topChunks = scored.filter((c) => c.relevanceScore >= threshold).slice(0, SEARCH_TOP_K);

    // Always add the last TAIL_SIZE messages verbatim (score 1.0).
    const tailStart = Math.max(0, session.messages.length - TAIL_SIZE);
    const tail = session.messages.slice(-TAIL_SIZE).map((m, i) => {
      const existing = allChunks.find(
        (c) => c.type === "message" && c.content === m.content && c.role === m.role
      );
      return existing ?? this.messageToChunk(m, session.id, m.timestamp, tailStart + i);
    });

    const merged = [...topChunks];
    for (const tailChunk of tail) {
      if (!merged.some((c) => c.id === tailChunk.id)) {
        merged.push({ ...tailChunk, relevanceScore: 1.0 });
      }
    }

    // Derive highlighted files and modules.
    const codeChunks = merged.filter((c) => c.type === "code" && c.filePath);
    const highlightedFiles = dedupe(codeChunks.map((c) => c.filePath!));
    const structure = this.appStructure ?? this.emptyStructure();
    const highlightedModules = structure.modules
      .filter((m) => m.relatedFiles.some((f) => highlightedFiles.includes(f)))
      .map((m) => m.name);

    // Build focused context string.
    const focusedContext = this.buildFocusedContext(merged, structure);

    // Compression ratio (by character count).
    const originalSize = session.messages.reduce((s, m) => s + m.content.length, 0);
    const compressedSize = merged.reduce((s, c) => s + c.content.length, 0);
    // [COMPRESSION-FIX] Clamp to >=0. The attention-IDB fallback path can
    // accumulate more chunks (delta-indexed, never pruned) than the original
    // session has characters, yielding a NEGATIVE ratio — i.e. the "compressed"
    // file is larger than the source. A negative number is meaningless to the
    // user and signals the fallback store is bloated; clamp and treat as 0%.
    const compressionRatio =
      originalSize > 0
        ? Math.max(0, Math.round((1 - compressedSize / originalSize) * 100))
        : 0;

    console.log(
      `${TAG} AttentionMap ready — chunks=${merged.length} files=${highlightedFiles.length}` +
      ` compression=${compressionRatio}%`
    );

    const map: AttentionMap = {
      task,
      threshold,
      topChunks: merged,
      highlightedFiles,
      highlightedModules,
      structuralContext: structure,
      focusedContext,
      compressionRatio,
    };

    // [PRE-COMPUTE-FIX] Cache the computed attention map for reuse.
    _attentionMapCache.set(cacheKey, { map, ts: Date.now() });

    return map;
  }

  // ─── semanticSearch ───────────────────────────────────────────────────────

  /**
   * Search across ALL indexed sessions by semantic similarity to query.
   *
   * Offloads the O(N) cosine sort to the ml-worker so the main thread
   * (sidebar UI) stays unblocked regardless of corpus size.
   *
   * @param query   - Natural-language search query.
   * @param limit   - Maximum results to return (default 10).
   * @param filters - Optional pre-filters applied *before* the IPC call to
   *                  shrink the payload. Currently supports `language`.
   */
  async semanticSearch(
    query: string,
    limit = 10,
    filters?: { language?: string; sessionId?: string; platform?: string },
  ): Promise<AttentionChunk[]> {
    console.log(`${TAG} semanticSearch — limit=${limit}` +
      (filters?.sessionId ? ` sessionId=${filters.sessionId}` : "") +
      (filters?.language ? ` language=${filters.language}` : "") +
      (filters?.platform ? ` platform=${filters.platform}` : ""));

    // ── 1. Fetch + pre-filter ──────────────────────────────────────────────
    // [PERF-FIX] If sessionId filter provided, use indexed query instead of toArray()
    // — avoids loading all sessions' chunks (was the cause of P50=65s).
    let allChunks = filters?.sessionId
      ? await dexieDb.chunkEmbeddings.where("sessionId").equals(filters.sessionId).toArray()
      : await dexieDb.chunkEmbeddings.toArray();
    if (allChunks.length === 0) return [];

    // [PERF-FIX-2] Platform filter — narrow chunks before IPC to reduce payload.
    if (filters?.platform) {
      const platformSessionIds = new Set(
        (await dexieDb.sessions.where("platform").equals(filters.platform).toArray())
          .map((s) => s.id)
      );
      allChunks = allChunks.filter((c) => platformSessionIds.has(c.sessionId));
      if (allChunks.length === 0) return [];
    }

    if (filters?.language) {
      allChunks = allChunks.filter((c) => c.language === filters.language);
      if (allChunks.length === 0) return [];
    }

    // ── 2. Embed the query (routes through offscreen WASM pipeline) ────────
    const queryEmb = await this.getEmbedding(query);

    // ── 3. Model-unavailable fallback (zero-vector → keyword scoring) ──────
    if (!queryEmb.some((v) => v !== 0)) {
      return allChunks
        .map((chunk) => ({
          id:             chunk.id,
          sessionId:      chunk.sessionId,
          role:           chunk.role,
          content:        chunk.text,
          embedding:      chunk.embedding,
          relevanceScore: this.keywordScore(query, chunk.text),
          type:           (chunk.hasCode ? "code" : "message") as "message" | "code",
          language:       chunk.language,
          timestamp:      chunk.createdAt,
        }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, limit);
    }

    // ── 3.5. Session-level pre-scoring — reduce IPC payload ──────────────
    // [PERF-FIX-2] When corpus is large (>500 chunks), compute a per-session
    // centroid embedding (average of chunk embeddings) and score it against
    // the query. Only send chunks from the top 20 sessions to the worker.
    // This cuts IPC payload by 60-80% on large corpora with negligible
    // accuracy loss — sessions with low centroid similarity rarely contain
    // individually relevant chunks.
    const SESSION_PRE_FILTER_THRESHOLD = 500;
    const SESSION_PRE_FILTER_TOP_K = 20;

    if (!filters?.sessionId && allChunks.length > SESSION_PRE_FILTER_THRESHOLD) {
      const sessionChunks = new Map<string, number[]>();
      for (let i = 0; i < allChunks.length; i++) {
        const sid = allChunks[i].sessionId;
        const arr = sessionChunks.get(sid);
        if (arr) arr.push(i);
        else sessionChunks.set(sid, [i]);
      }

      const dim = queryEmb.length;
      const sessionScores: { sessionId: string; score: number }[] = [];
      for (const [sid, indices] of sessionChunks) {
        const centroid = new Float32Array(dim);
        for (const idx of indices) {
          const emb = allChunks[idx].embedding;
          for (let d = 0; d < dim; d++) centroid[d] += emb[d];
        }
        for (let d = 0; d < dim; d++) centroid[d] /= indices.length;
        sessionScores.push({ sessionId: sid, score: cosineSimilarity(queryEmb, centroid) });
      }

      sessionScores.sort((a, b) => b.score - a.score);
      const topSessionIds = new Set(
        sessionScores.slice(0, SESSION_PRE_FILTER_TOP_K).map((s) => s.sessionId)
      );

      const before = allChunks.length;
      allChunks = allChunks.filter((c) => topSessionIds.has(c.sessionId));
      console.log(
        `${TAG} semanticSearch: pre-filtered ${before} -> ${allChunks.length} chunks ` +
        `(top ${SESSION_PRE_FILTER_TOP_K}/${sessionScores.length} sessions)`
      );
    }

    // ── 4. Build the slim IPC payload — id + embedding only, never .text ──
    const workerChunks = allChunks.map((c) => ({ id: c.id, embedding: c.embedding }));

    // ── 5. Dispatch to ml-worker via offscreen doc ─────────────────────────
    const requestId = crypto.randomUUID();
    type SearchResponse = { ok: boolean; results?: { id: string; score: number }[]; error?: string };
    let res: SearchResponse | undefined;
    try {
      res = await chrome.runtime.sendMessage<unknown, SearchResponse>({
        type:          "OFFSCREEN_SEARCH_QUERY",
        requestId,
        queryEmbedding: queryEmb,
        chunks:         workerChunks,
        topK:           limit,
      });
    } catch (err) {
      console.warn(`${TAG} semanticSearch: IPC error, falling back to main thread`, err);
    }

    // ── 6. Map winning IDs back to full objects (text never left the tab) ──
    if (res?.ok && res.results && res.results.length > 0) {
      const byId = new Map(allChunks.map((c) => [c.id, c]));
      return res.results
        .map(({ id, score }) => {
          const chunk = byId.get(id);
          if (!chunk) return null;
          return {
            id:             chunk.id,
            sessionId:      chunk.sessionId,
            role:           chunk.role,
            content:        chunk.text,
            embedding:      chunk.embedding,
            relevanceScore: score,
            type:           (chunk.hasCode ? "code" : "message") as "message" | "code",
            language:       chunk.language,
            timestamp:      chunk.createdAt,
          } as AttentionChunk;
        })
        .filter((c): c is AttentionChunk => c !== null);
    }

    // ── 7. Main-thread fallback (worker failed / timed out) ────────────────
    console.warn(`${TAG} semanticSearch: worker returned no results, scoring on main thread`);
    return allChunks
      .map((chunk) => ({
        id:             chunk.id,
        sessionId:      chunk.sessionId,
        role:           chunk.role,
        content:        chunk.text,
        embedding:      chunk.embedding,
        relevanceScore: this.cosineSimilarity(queryEmb, chunk.embedding),
        type:           (chunk.hasCode ? "code" : "message") as "message" | "code",
        language:       chunk.language,
        timestamp:      chunk.createdAt,
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
  }

  // ─── scoreMessagesForSummarization ────────────────────────────────────────

  /**
   * [CM-T2-ENHANCE] Score every session message against 5 Tier 2 categories
   * (goals, decisions, bugs, context, questions) using ONNX embeddings.
   * Graceful degradation: minimal tier / ONNX down → all-zero scores.
   * 8-second timeout → aborts, no speed regression.
   */
  async scoreMessagesForSummarization(
    session: ContextSession,
  ): Promise<ScoredMessage[]> {
    if (this.tier === "minimal" || !this.modelAvailable) {
      return this._zeroScoreFallback(session);
    }
    // [ADAPTIVE] Scoring timeout learned from observed semantic_search latencies.
    // Falls back to tier-based values on cold start (<3 samples).
    // [BUG-10 FIX] Scale timeout cap with session size — 25s was too short for
    // 100+ message sessions, causing premature heuristic fallback.
    const adaptiveTimeout = await latencyTracker.getTimeoutMs("semantic_search", session.messages.length);
    const msgCount = session.messages.length;
    const SCORING_TIMEOUT_MS = Math.min(adaptiveTimeout, msgCount > 100 ? 60_000 : 25_000);
    let tid: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ScoredMessage[]>((r) => {
      tid = setTimeout(() => {
        console.warn(`${TAG} scoring timed out — heuristic fallback`);
        r(this._zeroScoreFallback(session));
      }, SCORING_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([this._scoreInternal(session), timeout]);
      clearTimeout(tid);
      return result;
    } catch (e) {
      clearTimeout(tid);
      console.warn(`${TAG} scoring error:`, e);
      return this._zeroScoreFallback(session);
    }
  }

  /** [CM-T2-ENHANCE] Embed category queries + all messages, compute scores. */
  private async _scoreInternal(session: ContextSession): Promise<ScoredMessage[]> {
    const msgs = session.messages;
    if (msgs.length === 0) return [];

    const QUERIES: Record<keyof ScoredMessageScores, string> = {
      goals: "project goal objective purpose aim target outcome",
      decisions: "decided chose selected agreed will use going with picked",
      bugs: "bug error issue broken fix problem crash exception failure",
      context: "background context setup environment stack technology architecture",
      questions: "open question unclear need to figure out unresolved uncertain",
    };
    const keys = Object.keys(QUERIES) as (keyof ScoredMessageScores)[];

    const queryEmbs = await this.embedTexts(keys.map((k) => QUERIES[k]));

    // [T2-SPEED-FIX] Reuse Dexie chunk embeddings instead of re-embedding all
    // messages from scratch. The session is already indexed — re-embedding 156
    // messages took 15-25s and hit the scoring timeout. By loading pre-computed
    // embeddings from Dexie and averaging per messageIndex, we skip the ONNX
    // round-trip entirely. Falls back to embedTexts only if Dexie is empty.
    let msgEmbs: number[][];
    const dexieChunks = await dexieDb.chunkEmbeddings
      .where('sessionId').equals(session.id).toArray().catch(() => []);

    if (dexieChunks.length > 0) {
      const byMsgIdx = new Map<number, number[][]>();
      for (const c of dexieChunks) {
        const arr = byMsgIdx.get(c.messageIndex);
        if (arr) arr.push(c.embedding);
        else byMsgIdx.set(c.messageIndex, [c.embedding]);
      }
      msgEmbs = msgs.map((_, i) => {
        const embs = byMsgIdx.get(i);
        if (!embs || embs.length === 0) return new Array(EMBEDDING_DIM).fill(0);
        if (embs.length === 1) return embs[0];
        const avg = new Array<number>(EMBEDDING_DIM).fill(0);
        for (const e of embs) {
          for (let d = 0; d < EMBEDDING_DIM; d++) avg[d] += e[d] ?? 0;
        }
        for (let d = 0; d < EMBEDDING_DIM; d++) avg[d] /= embs.length;
        return avg;
      });
    } else {
      const msgTexts = msgs.map((m) => m.content);
      msgEmbs = await this.embedTexts(msgTexts);
    }

    const total = msgs.length;
    const results: ScoredMessage[] = msgs.map((m, i) => {
      const emb = msgEmbs[i] ?? new Array(EMBEDDING_DIM).fill(0);
      const hasEmb = emb.some((v) => v !== 0);
      const scores: ScoredMessageScores = {
        goals: 0, decisions: 0, bugs: 0, context: 0, questions: 0,
      };
      if (hasEmb) {
        for (let k = 0; k < keys.length; k++) {
          const qEmb = queryEmbs[k];
          if (qEmb && qEmb.some((v) => v !== 0)) {
            scores[keys[k]] = this.cosineSimilarity(emb, qEmb);
          }
        }
      }
      return {
        index: i,
        role: m.role,
        content: m.content,
        scores,
        recencyBoost: 1.0 + (i / Math.max(total, 1)) * 0.2,
      };
    });

    results.sort((a, b) => {
      const aMax = Math.max(...Object.values(a.scores));
      const bMax = Math.max(...Object.values(b.scores));
      return bMax - aMax;
    });
    return results;
  }

  /** [CM-T2-ENHANCE] All-zero score fallback — triggers heuristic path in summarizer. */
  private _zeroScoreFallback(session: ContextSession): ScoredMessage[] {
    const total = session.messages.length;
    return session.messages.map((m, i) => ({
      index: i,
      role: m.role,
      content: m.content,
      scores: { goals: 0, decisions: 0, bugs: 0, context: 0, questions: 0 },
      recencyBoost: 1.0 + (i / Math.max(total, 1)) * 0.2,
    }));
  }

  // ─── clearIndex ───────────────────────────────────────────────────────────

  /**
   * Check if the attention IDB has chunks for a session.
   * Used as fallback when Dexie chunkEmbeddings is empty.
   */
  async hasAttentionChunks(sessionId: string): Promise<boolean> {
    try {
      const db = await this.openIdb();
      const chunks = await (
        db.getAllFromIndex(CHUNKS_STORE, "sessionId", sessionId) as Promise<AttentionChunk[]>
      );
      return chunks.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Copy chunks from attention IDB to Dexie chunkEmbeddings.
   * Used when the SW's background indexing was cancelled (e.g. by migration)
   * but the sidebar's indexSession already populated the attention IDB.
   * Without this, retrieve() reads from Dexie and gets 0 chunks → T3 fails.
   */
  async copyChunksToDexie(sessionId: string): Promise<number> {
    try {
      const db = await this.openIdb();
      const aeChunks = await (
        db.getAllFromIndex(CHUNKS_STORE, "sessionId", sessionId) as Promise<AttentionChunk[]>
      );
      if (aeChunks.length === 0) return 0;

      const existing = await dexieDb.chunkEmbeddings
        .where('sessionId').equals(sessionId).count().catch(() => 0);
      if (existing > 0) return existing;

      // Sort by timestamp to preserve message ordering, then use array index
      // as messageIndex (NOT c.timestamp, which is an epoch millisecond value).
      const sorted = [...aeChunks].sort((a, b) => a.timestamp - b.timestamp);
      const dexieChunks: ChunkEmbedding[] = sorted.map((c, i) => ({
        id: c.id,
        sessionId: c.sessionId,
        chunkIndex: i,
        text: c.content,
        embedding: c.embedding,
        role: c.role,
        messageIndex: i,
        hasCode: c.type === 'code',
        language: c.language,
        tokenCount: Math.ceil(c.content.length / 4),
        createdAt: c.timestamp,
        // [CM-OFFSCREEN-FIX] propagate keyword-only flag so retrieve() knows
        // to use keyword fallback instead of attempting semantic search.
        keywordOnly: c.keywordOnly,
      }));

      await dexieDb.chunkEmbeddings.bulkPut(dexieChunks);

      await dexieDb.sessionHashes.put({
        sessionId,
        hash: '',
        chunkCount: dexieChunks.length,
        messageCount: 0,
        model: 'attention-idb-copy',
        indexedAt: Date.now(),
        isComplete: true,
        lastIndexedMessageIndex: 0,
        totalChunkCount: dexieChunks.length,
      });

      console.log(`${TAG} Copied ${dexieChunks.length} chunks from attention IDB to Dexie for ${sessionId}`);
      return dexieChunks.length;
    } catch (e) {
      console.warn(`${TAG} copyChunksToDexie failed:`, e);
      return 0;
    }
  }

  /**
   * Wipe all vector data and reset AppStructure.
   * Called from Settings → "Clear data".
   */
  async clearIndex(): Promise<void> {
    const db = await this.openIdb();
    const tx = db.transaction(
      [CHUNKS_STORE, STRUCTURE_STORE, SESSIONS_META_STORE],
      "readwrite"
    );
    await Promise.all([
      tx.objectStore(CHUNKS_STORE).clear(),
      tx.objectStore(STRUCTURE_STORE).clear(),
      tx.objectStore(SESSIONS_META_STORE).clear(),
    ]);
    await tx.done;
    await dexieDb.chunkEmbeddings.clear();
    await dexieDb.sessionHashes.clear();
    this.appStructure = null;
    console.log(`${TAG} Index cleared`);
  }

  // ─── Private: IndexedDB setup ─────────────────────────────────────────────

  private async openIdb(): Promise<IDBPDatabase> {
    if (this.idb) return this.idb;
    this.idb = await openDB(ATTENTION_DB_NAME, ATTENTION_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          const s = db.createObjectStore(CHUNKS_STORE, { keyPath: "id" });
          s.createIndex("sessionId", "sessionId");
          s.createIndex("type", "type");
          s.createIndex("timestamp", "timestamp");
        }
        if (!db.objectStoreNames.contains(STRUCTURE_STORE)) {
          db.createObjectStore(STRUCTURE_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(SESSIONS_META_STORE)) {
          db.createObjectStore(SESSIONS_META_STORE, { keyPath: "sessionId" });
        }
      },
    });
    return this.idb;
  }

  // ─── Private: tree-sitter ─────────────────────────────────────────────────

  private async initTreeSitter(): Promise<void> {
    try {
      const mod = await import("web-tree-sitter");
      // web-tree-sitter 0.22+ uses named ESM exports — extract Parser explicitly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const TS: any = (mod as any).Parser ?? (mod as any).default ?? mod;
      await TS.init({
        locateFile: () => {
          if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
            return chrome.runtime.getURL("tree-sitter.wasm");
          }
          return "/tree-sitter.wasm";
        },
      });
      this.tsParser = new TS();
      this.treeSitterAvailable = true;
      console.log(`${TAG} web-tree-sitter runtime ready`);
    } catch (err) {
      console.warn(`${TAG} web-tree-sitter unavailable — regex fallback active:`, err);
      this.treeSitterAvailable = false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadLanguage(lang: string): Promise<any | null> {
    if (!this.treeSitterAvailable || !this.tsParser) return null;
    // Fast-exit: no grammar file exists for this language — skip fetch entirely.
    if (!GRAMMAR_FILE_MAP[lang]) return null;
    if (this.tsLanguages.has(lang)) return this.tsLanguages.get(lang);
    try {
      const mod = await import("web-tree-sitter");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Lang: any = (mod as any).Language ?? (mod as any).default?.Language;
      // Timeout so a hanging WASM fetch doesn't stall the whole parse pipeline.
      const language = await Promise.race([
        Lang.load(grammarUrl(lang)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Grammar load timeout: ${lang}`)), 6_000)
        ),
      ]);
      this.tsLanguages.set(lang, language);
      return language;
    } catch (err) {
      console.warn(`${TAG} Grammar load failed for "${lang}" — regex fallback`, err);
      return null;
    }
  }

  // ─── Private: code parsing ────────────────────────────────────────────────

  private async parseCode(
    code: string,
    lang: string
  ): Promise<Omit<FileStructure, "path" | "language">> {
    const language = await this.loadLanguage(lang);
    if (language && this.tsParser) {
      try {
        return this.parseWithTreeSitter(code, language);
      } catch (err) {
        console.warn(`${TAG} Tree-sitter parse error for "${lang}":`, err);
      }
    }
    return this.parseWithRegex(code, lang);
  }

  private parseWithTreeSitter(
    code: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    language: any
  ): Omit<FileStructure, "path" | "language"> {
    const functions: string[] = [];
    const classes: string[] = [];
    const imports: string[] = [];
    const exports: string[] = [];
    const dependencies: string[] = [];

    this.tsParser.setLanguage(language);
    const tree = this.tsParser.parse(code);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (node: any): void => {
      switch (node.type) {
        case "function_declaration":
        case "function_definition": {
          const name = node.childForFieldName?.("name")?.text;
          if (name) functions.push(name);
          break;
        }
        case "method_definition":
        case "method": {
          const name = node.childForFieldName?.("name")?.text;
          if (name) functions.push(name);
          break;
        }
        case "lexical_declaration":
        case "variable_declaration": {
          // const foo = (...) => ... / const foo = function ...
          for (const child of node.namedChildren ?? []) {
            if (child.type === "variable_declarator") {
              const val = child.childForFieldName?.("value");
              if (val?.type === "arrow_function" || val?.type === "function_expression") {
                const name = child.childForFieldName?.("name")?.text;
                if (name) functions.push(name);
              }
            }
          }
          break;
        }
        case "class_declaration":
        case "class_definition": {
          const name = node.childForFieldName?.("name")?.text;
          if (name) classes.push(name);
          break;
        }
        case "import_declaration":
        case "import_statement":
        case "import_from_statement": {
          const src =
            node.childForFieldName?.("source")?.text ??
            node.childForFieldName?.("module_name")?.text;
          if (src) {
            const dep = src.replace(/['"]/g, "");
            imports.push(dep);
            if (!dep.startsWith(".")) dependencies.push(dep);
          }
          break;
        }
        case "export_statement":
        case "export_default_declaration": {
          const decl = node.childForFieldName?.("declaration");
          const name =
            decl?.childForFieldName?.("name")?.text ??
            node.childForFieldName?.("name")?.text;
          if (name) exports.push(name);
          break;
        }
      }
      for (const child of node.namedChildren ?? []) {
        walk(child);
      }
    };

    walk(tree.rootNode);

    return {
      functions: dedupe(functions),
      classes: dedupe(classes),
      imports: dedupe(imports),
      exports: dedupe(exports),
      dependencies: dedupe(dependencies),
    };
  }

  private parseWithRegex(
    code: string,
    lang: string
  ): Omit<FileStructure, "path" | "language"> {
    const functions: string[] = [];
    const classes: string[] = [];
    const imports: string[] = [];
    const exports: string[] = [];
    const dependencies: string[] = [];

    if (["typescript", "tsx", "javascript", "jsx", "js", "ts"].includes(lang)) {
      for (const m of code.matchAll(
        /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()/gm
      )) {
        const name = m[1] ?? m[2];
        if (name) functions.push(name);
      }
      for (const m of code.matchAll(
        /(?:export\s+)?(?:const|let)\s+(\w+)\s*[:=][^=].*=>/gm
      )) {
        if (m[1]) functions.push(m[1]);
      }
      for (const m of code.matchAll(/class\s+(\w+)/gm)) {
        if (m[1]) classes.push(m[1]);
      }
      for (const m of code.matchAll(/import\s+.*?from\s+['"]([^'"]+)['"]/gm)) {
        if (m[1]) {
          imports.push(m[1]);
          if (!m[1].startsWith(".")) dependencies.push(m[1]);
        }
      }
      for (const m of code.matchAll(/import\s+['"]([^'"]+)['"]/gm)) {
        if (m[1] && !m[1].startsWith(".")) dependencies.push(m[1]);
      }
      for (const m of code.matchAll(
        /export\s+(?:default\s+)?(?:function|class|const|let)\s+(\w+)/gm
      )) {
        if (m[1]) exports.push(m[1]);
      }
    } else if (lang === "python") {
      for (const m of code.matchAll(/^def\s+(\w+)/gm)) if (m[1]) functions.push(m[1]);
      for (const m of code.matchAll(/^class\s+(\w+)/gm)) if (m[1]) classes.push(m[1]);
      for (const m of code.matchAll(/^(?:import\s+(\S+)|from\s+(\S+)\s+import)/gm)) {
        const dep = m[1] ?? m[2];
        if (dep) { imports.push(dep); dependencies.push(dep); }
      }
    } else if (lang === "rust") {
      for (const m of code.matchAll(/(?:pub\s+)?fn\s+(\w+)/gm)) if (m[1]) functions.push(m[1]);
      for (const m of code.matchAll(
        /(?:pub\s+)?(?:struct|enum)\s+(\w+)/gm
      )) if (m[1]) classes.push(m[1]);
      for (const m of code.matchAll(/use\s+([\w:]+)/gm)) if (m[1]) imports.push(m[1]);
    } else if (lang === "go") {
      for (const m of code.matchAll(/func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm))
        if (m[1]) functions.push(m[1]);
      for (const m of code.matchAll(/type\s+(\w+)\s+struct/gm))
        if (m[1]) classes.push(m[1]);
      for (const m of code.matchAll(/"([\w./]+)"/gm))
        if (m[1]?.includes("/")) imports.push(m[1]);
    }

    return {
      functions: dedupe(functions).slice(0, 50),
      classes: dedupe(classes).slice(0, 20),
      imports: dedupe(imports).slice(0, 30),
      exports: dedupe(exports).slice(0, 20),
      dependencies: dedupe(dependencies).slice(0, 20),
    };
  }

  // ─── Private: code block extraction ──────────────────────────────────────

  extractCodeBlocks(messages: Message[]): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    const codeRe = /```([\w-]*)[ \t]*\n([\s\S]*?)```/g;
    for (const msg of messages) {
      let match: RegExpExecArray | null;
      codeRe.lastIndex = 0;
      while ((match = codeRe.exec(msg.content)) !== null) {
        const language = match[1].trim() || "unknown";
        const content = match[2];
        const firstLine = content.split("\n")[0]?.trim() ?? "";
        const pathMatch =
          firstLine.match(/^(?:\/\/|#|--)\s+([\w./\\-]+\.\w+)\s*$/) ??
          firstLine.match(/^\/\*\*?\s*([\w./\\-]+\.\w+)\s*\*\//);
        const before = msg.content.slice(Math.max(0, match.index - 200), match.index);
        const ctx = before.split(/[.!?\n]/).filter((s) => s.trim().length > 10).pop()?.trim();
        blocks.push({ language, content, path: pathMatch?.[1], context: ctx });
      }
    }
    return blocks;
  }

  // ─── Private: language detection ─────────────────────────────────────────

  detectLanguage(code: string): string {
    if (/import React|ReactDOM|jsx|tsx|<\w+\s*\/>/.test(code)) return "typescript";
    if (/def\s+\w+\(|from\s+\w+\s+import|print\(/.test(code)) return "python";
    if (/fn\s+\w+|let mut |impl\s+\w+|use std::/.test(code)) return "rust";
    if (/func\s+\w+|package\s+\w+|:=|fmt\./.test(code)) return "go";
    if (/class\s+\w+|function\s+\w+|const\s+\w+\s*=/.test(code)) return "javascript";
    return "unknown";
  }

  // ─── Private: cosine similarity ───────────────────────────────────────────

  private cosineSimilarity(a: number[], b: number[]): number {
    return cosineSimilarity(a, b);
  }

  // ─── Private: keyword scoring (model fallback) ────────────────────────────

  private keywordScore(query: string, content: string): number {
    const tokens = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    if (tokens.length === 0) return 0;
    const lower = content.toLowerCase();
    const hits = tokens.filter((t) => lower.includes(t)).length;
    return hits / tokens.length;
  }

  // ─── Private: multi-query expansion ─────────────────────────────────────

  private expandQueryVariants(task: string): string[] {
    const variants: string[] = [task];
    const stopWords = new Set([
      "the","a","an","is","are","was","were","be","been","have","has","had",
      "do","does","did","will","would","could","should","may","might","can",
      "this","that","these","those","which","who","what","where","when","how",
      "and","or","but","not","if","then","than","so","as","at","by","for",
      "in","of","on","to","up","from","with","about","i","you","we","they",
      "me","my",
    ]);
    const words = task.toLowerCase().split(/\W+/).filter(
      (w) => w.length > 2 && !stopWords.has(w)
    );
    const keywords = words.slice(0, 6).join(" ");
    if (keywords && keywords !== task.toLowerCase()) {
      variants.push(keywords);
      variants.push("implementing " + keywords);
    }
    if (/error|bug|fix|fail|issue|crash|broken/i.test(task)) {
      variants.push("error debugging " + keywords);
    } else {
      variants.push("code for " + keywords);
    }
    return [...new Set(variants)].slice(0, 5);
  }

  private averageEmbeddings(embs: number[][]): number[] {
    if (embs.length === 0) return [];
    const dim = embs[0].length;
    const avg = new Array<number>(dim).fill(0);
    for (const emb of embs) {
      for (let i = 0; i < dim; i++) avg[i] += emb[i];
    }
    for (let i = 0; i < dim; i++) avg[i] /= embs.length;
    return avg;
  }

  // ─── Private: cache ──────────────────────────────────────────────────────

  private getCacheKey(text: string): string {
    return text.slice(0, 120);
  }

  async embedTexts(texts: string[], signal?: AbortSignal, _skipMigrationGuard = false): Promise<number[][]> {
    // Check cache; collect uncached indices
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const uncached: { idx: number; text: string }[] = [];

    texts.forEach((text, idx) => {
      const cached = this.embeddingCache.get(this.getCacheKey(text));
      if (cached) {
        results[idx] = cached;
      } else {
        uncached.push({ idx, text });
      }
    });

    if (uncached.length === 0) return results as number[][];

    if (uncached.length > 0) {
      await ensureOffscreenDocument();

      const EMBED_BATCH_SIZE = 32; // [T2-SPEED] Match offscreen's batch size — 4x fewer round-trips
      // [ADAPTIVE] Embed timeout learned from observed embedding_query latencies.
      // Falls back to tier-based values on cold start (<3 samples).
      const EMBED_TIMEOUT_MS: number = await latencyTracker.getTimeoutMs("embedding_query", 1);

      const zeroVec = () => new Array<number>(EMBEDDING_DIM).fill(0);

      const singleEmbed = (text: string): Promise<number[]> => {
        const requestId = crypto.randomUUID();
        const embedPromise = chrome.runtime
          .sendMessage({ type: "OFFSCREEN_EMBED_QUERY", text, requestId, priority: true })
          .then((res: { ok?: boolean; embedding?: number[] } | undefined) =>
            res?.ok && res.embedding ? res.embedding : zeroVec()
          )
          .catch(() => zeroVec());

        const timeoutPromise = new Promise<number[]>((resolve) =>
          setTimeout(() => resolve(zeroVec()), EMBED_TIMEOUT_MS)
        );

        return Promise.race([embedPromise, timeoutPromise]);
      };

      // [PERF-BATCH] Send whole batch in one OFFSCREEN_EMBED_BATCH message instead
      // of N×OFFSCREEN_EMBED_QUERY. Collapses 65 serial embeds (~13s) → 8 batch
      // calls (~1-2s). Falls back to singleEmbed per-text on error.
      // [T3-FIX] Tracks requestId so signal handler can send OFFSCREEN_CANCEL_BATCH.
      const batchEmbed = async (texts: string[], abortSignal?: AbortSignal): Promise<number[][]> => {
        const requestId = crypto.randomUUID();
        // [T3-FIX] On abort: cancel the queued job in offscreen before awaiting.
        const onAbort = () => {
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_CANCEL_BATCH', requestId }).catch(() => {});
        };
        if (abortSignal) {
          if (abortSignal.aborted) { onAbort(); return texts.map(() => zeroVec()); }
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          const res = await Promise.race([
            chrome.runtime.sendMessage({ type: "OFFSCREEN_EMBED_BATCH", texts, requestId, priority: true })
              .then((r: { ok?: boolean; embeddings?: number[][] } | undefined) =>
                r?.ok && r.embeddings ? r.embeddings : null
              ).catch(() => null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), EMBED_TIMEOUT_MS * Math.max(1, Math.ceil(texts.length / 16)))),
          ]);
          if (res && res.length === texts.length) return res;
        } catch { /* fall through */ } finally {
          if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        }
        return Promise.all(texts.map((t) => singleEmbed(t)));
      };

      const freshEmbeddings: number[][] = [];
      for (let b = 0; b < uncached.length; b += EMBED_BATCH_SIZE) {
        // [T3-FIX] Stop sending new batches if signal aborted.
        if (signal?.aborted) break;
        // [MIGRATION-FIX] Stop mid-execution if migration becomes active — SW owns the worker.
        // This aborts indexSession() partway through so priority index batches aren't blocked.
        if (_migrationActive && !_skipMigrationGuard) {
          console.log(`${TAG} embedTexts: aborting mid-batch — migration became active`);
          break;
        }
        const batch = uncached.slice(b, b + EMBED_BATCH_SIZE);
        const batchResults = await batchEmbed(batch.map(({ text }) => text), signal);
        freshEmbeddings.push(...batchResults);
      }

      uncached.forEach(({ idx, text }, i) => {
        const embedding = freshEmbeddings[i] ?? new Array(EMBEDDING_DIM).fill(0);
        results[idx] = embedding;
        const key = this.getCacheKey(text);
        if (this.embeddingCache.size >= EMBEDDING_CACHE_MAX) {
          const first = this.embeddingCache.keys().next().value;
          if (first !== undefined) this.embeddingCache.delete(first);
        }
        this.embeddingCache.set(key, embedding);
      });
    }

    return results as number[][];
  }

  // ─── Private: embedding generation ───────────────────────────────────────

  private async getEmbedding(text: string): Promise<number[]> {
    if (!this.modelAvailable) return new Array(EMBEDDING_DIM).fill(0);
    const results = await this.embedTexts([text]);
    return results[0] ?? new Array(EMBEDDING_DIM).fill(0);
  }

  private async embedChunks(chunks: AttentionChunk[]): Promise<AttentionChunk[]> {
    if (!this.modelAvailable) {
      return chunks.map((c) => ({ ...c, embedding: new Array(EMBEDDING_DIM).fill(0) }));
    }
    const texts = chunks.map((c) => c.content);
    const embeddings = await this.embedTexts(texts);
    return chunks.map((c, i) => ({
      ...c,
      embedding: embeddings[i] ?? new Array(EMBEDDING_DIM).fill(0),
    }));
  }

  // ─── Private: chunk generation ────────────────────────────────────────────

  private sessionToChunks(session: ContextSession): AttentionChunk[] {
    const chunks: AttentionChunk[] = [];

    for (let i = 0; i < session.messages.length; i++) {
      chunks.push(this.messageToChunk(session.messages[i], session.id, session.messages[i].timestamp, i));
    }

    for (const block of this.extractCodeBlocks(session.messages)) {
      if (block.content.trim().length < 20) continue;
      chunks.push({
        id: `${session.id}-code-${chunks.length}`,
        sessionId: session.id,
        role: "assistant",
        content: block.content,
        embedding: [],
        relevanceScore: 0,
        type: "code",
        filePath: block.path,
        language: block.language && block.language !== "unknown"
          ? block.language
          : this.detectLanguage(block.content),
        timestamp: Date.now(),
      });
    }

    return chunks;
  }

  private messageToChunk(
    msg: Message,
    sessionId: string,
    timestamp: number,
    index = 0
  ): AttentionChunk {
    return {
      id: `${sessionId}-msg-${timestamp}-${index}-${msg.role}`,
      sessionId,
      role: msg.role,
      content: msg.content,
      embedding: [],
      relevanceScore: 0,
      type: "message",
      timestamp,
    };
  }

  // ─── Private: AppStructure helpers ────────────────────────────────────────

  private emptyStructure(): AppStructure {
    return { files: [], modules: [], lastUpdated: Date.now() };
  }

  private inferModules(files: FileStructure[]): AppStructure["modules"] {
    const moduleMap = new Map<string, AppStructure["modules"][number]>();
    for (const file of files) {
      const name = file.path.split("/").pop()?.replace(/\.\w+$/, "") ?? file.path;
      const type = inferModuleType(file.path, file.functions, file.classes);
      const existing = moduleMap.get(name);
      if (existing) {
        existing.relatedFiles = dedupe([...existing.relatedFiles, file.path]);
      } else {
        moduleMap.set(name, { name, type, relatedFiles: [file.path] });
      }
    }
    return Array.from(moduleMap.values());
  }

  private async loadAppStructure(): Promise<AppStructure | null> {
    try {
      const db = await this.openIdb();
      const row = await (db.get(STRUCTURE_STORE, STRUCTURE_KEY) as Promise<
        { key: string; data: AppStructure } | undefined
      >);
      return row?.data ?? null;
    } catch {
      return null;
    }
  }

  private async saveAppStructure(structure: AppStructure): Promise<void> {
    try {
      const db = await this.openIdb();
      await db.put(STRUCTURE_STORE, { key: STRUCTURE_KEY, data: structure });
    } catch (err) {
      console.warn(`${TAG} Failed to persist AppStructure:`, err);
    }
  }

  // ─── Public: project file indexing ──────────────────────────────────────────

  /**
   * Embed project files into the attention store so findRelevantFileSections()
   * can surface file sections that match a given task query.
   * Files are chunked in 500-char windows with 100-char overlap.
   */
  async indexProjectFiles(files: import("./file-system/project-reader").ProjectFile[]): Promise<void> {
    if (!this.initialized) return; // silently skip if engine not ready

    const CHUNK_SIZE = 500;
    const OVERLAP = 100;
    const chunks: AttentionChunk[] = [];

    for (const file of files) {
      const lines = file.content.split("\n");
      let charOffset = 0;
      let startLine = 0;
      let chunkIndex = 0;

      while (charOffset < file.content.length) {
        const slice = file.content.slice(charOffset, charOffset + CHUNK_SIZE);
        if (slice.trim().length < 20) { charOffset += CHUNK_SIZE - OVERLAP; continue; }

        // Estimate start/end line numbers for this chunk
        const sliceLineCount = slice.split("\n").length;
        const endLine = startLine + sliceLineCount - 1;

        chunks.push({
          id: `file-${file.path}-chunk-${chunkIndex}`,
          sessionId: `__project__`,
          role: "assistant",
          content: slice,
          embedding: [],
          relevanceScore: 0,
          type: "code",
          filePath: file.path,
          language: file.language,
          timestamp: file.lastModified,
        });

        charOffset += CHUNK_SIZE - OVERLAP;
        startLine = endLine;
        chunkIndex++;
      }
    }

    if (chunks.length === 0) return;

    const embedded = await this.embedChunks(chunks);
    const db = await this.openIdb();
    const tx = db.transaction(CHUNKS_STORE, "readwrite");
    for (const chunk of embedded) {
      await tx.objectStore(CHUNKS_STORE).put(chunk);
    }
    await tx.done;
    console.log(`${TAG} indexed ${embedded.length} project file chunk(s) across ${files.length} file(s)`);
  }

  /**
   * Find the most semantically relevant sections within the indexed project files
   * for a given task description. Returns up to 5 results sorted by relevance.
   */
  async findRelevantFileSections(
    task: string,
  ): Promise<Array<{
    file: string;
    section: string;
    relevanceScore: number;
    startLine: number;
    endLine: number;
  }>> {
    if (!this.initialized || !task.trim()) return [];

    const taskEmb = await this.getEmbedding(task);
    const db = await this.openIdb();

    const allChunks = (await db.getAllFromIndex(
      CHUNKS_STORE,
      "sessionId",
      "__project__",
    ) as AttentionChunk[]);

    if (allChunks.length === 0) return [];

    const scored = allChunks.map((chunk) => {
      const score = this.modelAvailable && chunk.embedding.length > 0
        ? this.cosineSimilarity(taskEmb, chunk.embedding)
        : this.keywordScore(task, chunk.content);
      return { chunk, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const top5 = scored.slice(0, 5);

    return top5.map(({ chunk, score }) => {
      const lines = chunk.content.split("\n");
      return {
        file: chunk.filePath ?? "",
        section: chunk.content,
        relevanceScore: Math.round(score * 100) / 100,
        startLine: 0,
        endLine: lines.length - 1,
      };
    });
  }

  // ─── Public: getHighAttentionContext ──────────────────────────────────────

  /**
   * Semantic point-query retrieval for a single session.
   *
   * 1. Embeds `searchQuery` via the Offscreen Document (WASM pipeline).
   * 2. Loads all pre-computed chunks for `sessionId` from IndexedDB.
   * 3. Scores every chunk with cosine similarity and returns the top `topK`
   *    joined into a single context string, ready to pass to the UI or an LLM.
   *
   * Falls back to keyword scoring when the embedding model is unavailable
   * (zero-vector query), so the function always returns a useful result.
   *
   * @param sessionId   - The session whose indexed chunks are searched.
   * @param searchQuery - Natural-language question or task description.
   * @param topK        - Maximum number of chunks to include (default 10).
   */
  async getHighAttentionContext(
    sessionId: string,
    searchQuery: string,
    topK = 10,
  ): Promise<string> {
    if (!searchQuery.trim()) return "";

    const queryEmb = await this.getEmbedding(searchQuery);

    const db = await this.openIdb();
    const allChunks = (await (
      db.getAllFromIndex(CHUNKS_STORE, "sessionId", sessionId) as Promise<AttentionChunk[]>
    ));

    if (allChunks.length === 0) return "";

    // When the embedding model is unavailable, queryEmb is all-zero.
    // Cosine similarity against zero vectors always returns 0, making ranking
    // meaningless. Fall back to keyword scoring so the result stays useful.
    const modelReady = queryEmb.some((v) => v !== 0);

    let topChunks: Array<{ text: string; score: number }>;

    if (modelReady) {
      const input = allChunks.map((c) => ({ text: c.content, embedding: c.embedding }));
      topChunks = searchContextChunks(queryEmb, input, topK);
    } else {
      topChunks = allChunks
        .map((c) => ({ text: c.content, score: this.keywordScore(searchQuery, c.content) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    }

    return topChunks.map((c) => c.text).join("\n\n---\n\n");
  }

  // ─── Public: clear project index ────────────────────────────────────────────

  async clearProjectIndex(): Promise<void> {
    try {
      const db = await this.openIdb();
      const allChunks = (await db.getAllFromIndex(
        CHUNKS_STORE, "sessionId", "__project__",
      ) as AttentionChunk[]);
      const tx = db.transaction(CHUNKS_STORE, "readwrite");
      for (const c of allChunks) await tx.objectStore(CHUNKS_STORE).delete(c.id);
      await tx.done;
    } catch (err) {
      console.warn(`${TAG} clearProjectIndex failed:`, err);
    }
  }

  // ─── Private: focused context builder ────────────────────────────────────

  private buildFocusedContext(
    chunks: AttentionChunk[],
    structure: AppStructure
  ): string {
    const parts: string[] = [];

    if (structure.files.length > 0) {
      parts.push(
        `[Structural Map: ${structure.files.length} file(s), ` +
        `${structure.modules.length} module(s)]`
      );
    }

    const highMsgs = chunks
      .filter((c) => c.type === "message" && c.relevanceScore >= 0.5)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, 10);
    for (const m of highMsgs) {
      parts.push(`${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}`);
    }

    const highCode = chunks
      .filter((c) => c.type === "code" && c.relevanceScore >= 0.5)
      .slice(0, 5);
    for (const c of highCode) {
      const label = c.filePath ? ` (${c.filePath})` : "";
      parts.push(`CODE${label}:\n${c.content.slice(0, 2000)}`);
    }

    return parts.join("\n\n");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers
// ─────────────────────────────────────────────────────────────────────────────

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function langExt(lang: string): string {
  const m: Record<string, string> = {
    typescript: "ts", tsx: "tsx", javascript: "js",
    python: "py", rust: "rs", go: "go",
  };
  return m[lang] ?? lang;
}

function inferModuleType(
  path: string,
  functions: string[],
  classes: string[]
): AppStructure["modules"][number]["type"] {
  const p = path.toLowerCase();
  if (/\.test\.|\.spec\.|__tests__/.test(p)) return "test";
  if (/config|settings|\.env/.test(p)) return "config";
  if (/components?\/|\.tsx$/.test(p) || classes.some((c) => /Props|Component/.test(c)))
    return "component";
  if (/service|api|client|fetch|http/.test(p)) return "service";
  if (/util|helper|lib\/|shared/.test(p)) return "util";
  if (functions.length > 0 && classes.length === 0) return "util";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
//
// Each JS runtime (extension sidebar/popup, web app) gets its own instance
// backed by its own IndexedDB origin.  Import this singleton everywhere.
// ─────────────────────────────────────────────────────────────────────────────

export const attentionEngine = new AttentionEngine();

// ─────────────────────────────────────────────────────────────────────────────
// Hardware detection
// Detects CPU/GPU capability once per session and recommends a migration tier.
// Safe to call from SW context (canvas/WebGPU failures are caught silently).
// ─────────────────────────────────────────────────────────────────────────────

export interface HardwareProfile {
  cores: number;
  memoryGB: number;
  hasWebGPU: boolean;
  gpuRenderer: string | null;
  tier: "minimal" | "balanced" | "full";
  recommendedMigrationTier: 1 | 2 | 3;
}

export async function detectHardware(): Promise<HardwareProfile> {
  const cores = navigator.hardwareConcurrency ?? 2;
  const memoryGB = (navigator as { deviceMemory?: number }).deviceMemory ?? 4;

  let hasWebGPU = false;
  let gpuRenderer: string | null = null;

  // WebGPU detection (sidebar / tab context only — unavailable in SW)
  // [ISSUE-14] Retry once after 1s if adapter returns null (cold start GPU driver init)
  try {
    if ("gpu" in navigator) {
      let adapter = await (navigator as { gpu?: { requestAdapter: () => Promise<{ requestAdapterInfo: () => Promise<{ description?: string; vendor?: string }> } | null> } }).gpu?.requestAdapter();
      if (!adapter) {
        await new Promise(r => setTimeout(r, 1000));
        adapter = await (navigator as { gpu?: { requestAdapter: () => Promise<{ requestAdapterInfo: () => Promise<{ description?: string; vendor?: string }> } | null> } }).gpu?.requestAdapter();
      }
      if (adapter) {
        hasWebGPU = true;
        const info = await adapter.requestAdapterInfo();
        gpuRenderer = info.description ?? info.vendor ?? "unknown GPU";
      }
    }
  } catch { hasWebGPU = false; }

  // WebGL renderer fallback (also catches SW context — canvas throws and is caught)
  if (!hasWebGPU) {
    try {
      const canvas = document.createElement("canvas");
      const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
      if (gl) {
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        if (ext) {
          gpuRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
          hasWebGPU = !gpuRenderer.toLowerCase().includes("swiftshader") &&
                      !gpuRenderer.toLowerCase().includes("software");
        }
      }
    } catch { /* SW context or locked canvas */ }
  }

  let tier: HardwareProfile["tier"];
  // [CM-TIER-FIX] fixed over-aggressive minimal classification
  // performance: high-end with GPU; balanced: mid-range (WebGPU not required)
  if (hasWebGPU && cores >= 6 && memoryGB >= 12) {
    tier = "full";
  } else if (cores >= 3 && memoryGB >= 6) {
    tier = "balanced";
  } else {
    tier = "minimal";
  }
  console.debug(`[CM:hw] reclassified: cores=${cores} mem=${memoryGB}GB webgpu=${hasWebGPU} -> tier=${tier}`); // [T2-FIX] debug level — reduces log spam from offscreen doc reloads

  const recommendedMigrationTier: 1 | 2 | 3 =
    tier === "full" ? 3 : tier === "balanced" ? 2 : 1;

  return { cores, memoryGB, hasWebGPU, gpuRenderer, tier, recommendedMigrationTier };
}

let cachedHardwareProfile: HardwareProfile | null = null;

const HW_PROFILE_CACHE_KEY = "cm:hwProfileCache";
const HW_PROFILE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export async function getHardwareProfile(): Promise<HardwareProfile> {
  if (cachedHardwareProfile) return cachedHardwareProfile;

  // [CM-PERF] Cross-context persistence. The offscreen document reloads this
  // module on every recreation, wiping the in-memory cache and forcing a fresh
  // navigator.gpu.requestAdapter() probe each time — the source of repeated
  // "No available adapters" spam. Persisting to chrome.storage.local means we
  // probe the GPU at most once per 24h per browser, not once per offscreen doc.
  try {
    const stored = await chrome.storage.local.get(HW_PROFILE_CACHE_KEY);
    const entry = stored[HW_PROFILE_CACHE_KEY] as
      | { profile: HardwareProfile; ts: number }
      | undefined;
    if (entry && Date.now() - entry.ts < HW_PROFILE_TTL_MS) {
      cachedHardwareProfile = entry.profile;
      return cachedHardwareProfile;
    }
  } catch { /* storage unavailable — fall through to fresh detect */ }

  cachedHardwareProfile = await detectHardware();
  console.log("[ContextMover:hw]", JSON.stringify(cachedHardwareProfile));
  try {
    await chrome.storage.local.set({
      [HW_PROFILE_CACHE_KEY]: { profile: cachedHardwareProfile, ts: Date.now() },
    });
  } catch { /* non-fatal */ }
  return cachedHardwareProfile;
}
