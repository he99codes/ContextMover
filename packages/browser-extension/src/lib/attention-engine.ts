// packages/browser-extension/src/lib/attention-engine.ts
//
// Attention Engine — semantic understanding layer for context migration.
// Transforms dumb token compression into task-aware, embedding-driven extraction.
//
// Vector store : in-memory cosine search over Float32Arrays, persisted in a
//               dedicated IndexedDB database ("contextforge-attention").
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
import type { ContextSession, Message, CodeBlock } from "./types";
import {
  capabilityDetector,
  getTierConfig,
  type Tier,
  type TierConfig,
  type SystemHeadroom,
  startHeadroomMonitor,
} from "./capability-detector";

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

// Minimal typing for the @xenova/transformers pipeline callable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extractor = (input: any, options?: any) => Promise<{ data: Float32Array; dims: number[] }>;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ATTENTION_DB_NAME = "contextforge-attention";
const ATTENTION_DB_VERSION = 1;
const CHUNKS_STORE = "ae_chunks";
const STRUCTURE_STORE = "ae_structure";
const SESSIONS_META_STORE = "ae_sessions_meta";
const STRUCTURE_KEY = "singleton";

// Default model ID — overridden per-tier by TIER_CONFIGS at initialize() time.
const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;
const SEARCH_TOP_K = 100;
const TAIL_SIZE = 6;

const THRESHOLDS: Record<"light" | "strict", number> = { light: 0.4, strict: 0.7 };

const TAG = "[ContextForge:attention-engine]";

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
  private extractor: Extractor | null = null;
  private idb: IDBPDatabase | null = null;
  private appStructure: AppStructure | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tsParser: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tsLanguages = new Map<string, any>();
  private treeSitterAvailable = false;
  private modelAvailable = false;
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

        // Minimal tier skips the model + tree-sitter entirely — it relies on the
        // keyword scoring path and the regex code-block extractor.
        if (!this.tierConfig.useEmbeddings) {
          this.modelAvailable = false;
          this.treeSitterAvailable = false;
          onProgress?.(100);
          this.initialized = true;
          console.log(`${TAG} Ready (minimal tier — no model, regex only)`);
          return;
        }

        // Model download is the heavy step (~23 MB on first run).
        // Progress is mapped into the 12–80 range.
        await this.loadEmbeddingModel(onProgress);
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
    this.extractor = null;
    this.modelAvailable = false;
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
      if (headroom.gpuAvailable && this.tierConfig.device !== "webgpu") {
        this.loadEmbeddingModel().catch(() => {
          console.debug(`${TAG} GPU reload failed — keeping current device`);
        });
      }
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
    console.log(
      `${TAG} indexSession — session=${session.id} msgs=${session.messages.length}`
    );

    const db = await this.openIdb();

    // Rebuild structural map with any new code (cheap, always run).
    await this.buildStructure(session.messages);

    // Build the full set of raw chunks for the current session state.
    const rawChunks = this.sessionToChunks(session);
    const cap = this.tierConfig.maxChunksPerSession || rawChunks.length;
    const allRaw = rawChunks.slice(0, cap);

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

    // Embed only the new chunks.
    const embedded = await this.embedChunks(newChunks);

    // Append new chunks + update meta atomically. Never touches existing chunks.
    const tx = db.transaction([CHUNKS_STORE, SESSIONS_META_STORE], "readwrite");
    for (const chunk of embedded) {
      await tx.objectStore(CHUNKS_STORE).put(chunk);
    }
    await tx.objectStore(SESSIONS_META_STORE).put({
      sessionId: session.id,
      messageCount: session.messages.length,
      indexedAt: Date.now(),
    });
    await tx.done;

    console.log(`${TAG} Appended ${embedded.length} new chunk(s) for session ${session.id}`);
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
    strength: "light" | "strict"
  ): Promise<AttentionMap> {
    console.log(`${TAG} buildAttentionMap — strength=${strength}`);

    const threshold = THRESHOLDS[strength];

    // Ensure session is indexed first.
    await this.indexSession(session);

    // Embed the task query.
    const taskEmb = await this.getEmbedding(task);

    // Load all indexed chunks for this session.
    const db = await this.openIdb();
    const allChunks = (await (
      db.getAllFromIndex(CHUNKS_STORE, "sessionId", session.id) as Promise<AttentionChunk[]>
    ));

    console.log(
      `${TAG} Scoring ${allChunks.length} chunk(s) against task embedding`
    );

    // Score every chunk.
    const scored: AttentionChunk[] = allChunks.map((chunk) => ({
      ...chunk,
      relevanceScore:
        taskEmb.some((v) => v !== 0) && chunk.embedding.length === EMBEDDING_DIM
          ? this.cosineSimilarity(taskEmb, chunk.embedding)
          : this.keywordScore(task, chunk.content),
    }));

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
    const compressionRatio =
      originalSize > 0 ? Math.round((1 - compressedSize / originalSize) * 100) : 0;

    console.log(
      `${TAG} AttentionMap ready — chunks=${merged.length} files=${highlightedFiles.length}` +
      ` compression=${compressionRatio}%`
    );

    return {
      task,
      threshold,
      topChunks: merged,
      highlightedFiles,
      highlightedModules,
      structuralContext: structure,
      focusedContext,
      compressionRatio,
    };
  }

  // ─── semanticSearch ───────────────────────────────────────────────────────

  /**
   * Search across ALL indexed sessions by semantic similarity to query.
   * Falls back to keyword scoring when the model is not loaded.
   */
  async semanticSearch(query: string, limit = 10): Promise<AttentionChunk[]> {
    console.log(`${TAG} semanticSearch — limit=${limit}`);
    const db = await this.openIdb();
    const allChunks = (await (db.getAll(CHUNKS_STORE) as Promise<AttentionChunk[]>));
    const queryEmb = await this.getEmbedding(query);

    const scored = allChunks.map((chunk) => ({
      ...chunk,
      relevanceScore:
        queryEmb.some((v) => v !== 0) && chunk.embedding.length === EMBEDDING_DIM
          ? this.cosineSimilarity(queryEmb, chunk.embedding)
          : this.keywordScore(query, chunk.content),
    }));

    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return scored.slice(0, limit);
  }

  // ─── clearIndex ───────────────────────────────────────────────────────────

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

  // ─── Private: embedding model ─────────────────────────────────────────────

  private async loadEmbeddingModel(
    onProgress?: (progress: number) => void
  ): Promise<void> {
    const cfg = this.tierConfig;
    const modelId = cfg.modelId || DEFAULT_MODEL_ID;

    try {
      const transformers = await import("@xenova/transformers");

      // ── ONNX runtime tuning ───────────────────────────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const envObj = (transformers as any).env;
      if (envObj?.backends?.onnx?.wasm) {
        // Disable blob: proxy worker — blocked in the Chrome extension sandbox.
        envObj.backends.onnx.wasm.proxy = false;
        // Thread count comes from the active tier config, capped by the
        // hardware concurrency reported by the browser.
        const hasSharedBuffer = typeof SharedArrayBuffer !== "undefined";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hwThreads = (navigator as any).hardwareConcurrency ?? 1;
        const threads = hasSharedBuffer
          ? Math.min(cfg.maxWasmThreads, hwThreads)
          : 1;
        envObj.backends.onnx.wasm.numThreads = threads;
        console.log(`${TAG} ONNX WASM threads=${threads}/${hwThreads} (tier cap=${cfg.maxWasmThreads}) SAB=${hasSharedBuffer}`);
      }

      // ── Device selection — driven by tier config ─────────────────────────
      // Full tier requests WebGPU; balanced tier stays on WASM for predictable
      // memory + thermal behavior on mid-range laptops.
      let device: string | undefined;
      if (cfg.device === "webgpu") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gpu = typeof navigator !== "undefined" ? (navigator as any).gpu : null;
        if (gpu?.requestAdapter) {
          try {
            const adapter = await gpu.requestAdapter();
            if (adapter) {
              device = "webgpu";
              console.log(`${TAG} WebGPU adapter acquired — GPU inference enabled`);
            }
          } catch { /* WebGPU not available — fall back to wasm */ }
        }
      }

      const pipelineFn = transformers.pipeline ?? (transformers as unknown as Record<string, unknown>).default;
      if (typeof pipelineFn !== "function") throw new Error("pipeline not found in @xenova/transformers");

      this.extractor = (await pipelineFn(
        "feature-extraction",
        modelId,
        {
          ...(device ? { device } : {}),
          progress_callback: (info: { status: string; progress?: number }) => {
            if (info.status === "progress" && typeof info.progress === "number") {
              // Map model download 0–100 into overall range 12–78.
              onProgress?.(Math.round(12 + info.progress * 0.66));
            }
          },
        }
      )) as Extractor;

      this.modelAvailable = true;
      console.log(`${TAG} Embedding model loaded (${modelId}) device=${device ?? "wasm"} tier=${this.tier}`);
    } catch (err) {
      console.warn(`${TAG} Model load failed — keyword fallback active:`, err);
      this.modelAvailable = false;
    }
  }

  // ─── Private: tree-sitter ─────────────────────────────────────────────────

  private async initTreeSitter(): Promise<void> {
    try {
      const mod = await import("web-tree-sitter");
      // web-tree-sitter 0.22+ uses named ESM exports — extract Parser explicitly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const TS: any = (mod as any).Parser ?? (mod as any).default ?? mod;
      await TS.init({
        locateFile: (path: string) => {
          if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
            return chrome.runtime.getURL(`grammars/${path}`);
          }
          return `/grammars/${path}`;
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
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot  += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  // ─── Private: keyword scoring (model fallback) ────────────────────────────

  private keywordScore(query: string, content: string): number {
    const tokens = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    if (tokens.length === 0) return 0;
    const lower = content.toLowerCase();
    const hits = tokens.filter((t) => lower.includes(t)).length;
    return hits / tokens.length;
  }

  // ─── Private: embedding generation ───────────────────────────────────────

  private async getEmbedding(text: string): Promise<number[]> {
    if (!this.extractor || !this.modelAvailable) {
      return new Array(EMBEDDING_DIM).fill(0); // zero vector → triggers keyword fallback
    }
    try {
      const out = await this.extractor(text, { pooling: "mean", normalize: true });
      return Array.from(out.data);
    } catch (err) {
      console.warn(`${TAG} Single embedding failed:`, err);
      return new Array(EMBEDDING_DIM).fill(0);
    }
  }

  private async embedChunks(chunks: AttentionChunk[]): Promise<AttentionChunk[]> {
    if (!this.extractor || !this.modelAvailable) {
      return chunks.map((c) => ({ ...c, embedding: new Array(EMBEDDING_DIM).fill(0) }));
    }

    const result: AttentionChunk[] = [];
    const batchSize = this.tierConfig.batchSize || 32;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      try {
        // Truncate to 2000 chars (~500 tokens, near full MiniLM-L6 capacity).
        const texts = batch.map((c) => c.content.slice(0, 2000));
        const out = await this.extractor(texts, { pooling: "mean", normalize: true });

        // out.data is Float32Array[batch * EMBEDDING_DIM]; out.dims = [batch, 384]
        for (let j = 0; j < batch.length; j++) {
          const start = j * EMBEDDING_DIM;
          const embedding = Array.from(out.data.slice(start, start + EMBEDDING_DIM));
          result.push({ ...batch[j], embedding });
        }
      } catch (err) {
        console.warn(`${TAG} Batch ${Math.floor(i / batchSize)} embed failed:`, err);
        for (const c of batch) {
          result.push({ ...c, embedding: new Array(EMBEDDING_DIM).fill(0) });
        }
      }
    }

    return result;
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
