/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/semantic-index/index.ts
//
// Core retrieval-first engine. Embed once, persist forever, retrieve fast.
//
// Architecture:
//   • Indexing happens in the offscreen document (heavy work off SW thread)
//   • Retrieval (cosine sim) happens wherever the caller is — pure JS, fast
//   • IndexedDB writes happen wherever IDB is reliable (SW or offscreen)
//   • Service worker can call this class directly, but heavy ops will be
//     forwarded to the offscreen document via chrome.runtime messages

import {
  dexieDb,
  type ChunkEmbedding,
  type StoredSummary,
} from "../db";
import type { ContextSession } from "../types";
import { MODEL_CONFIGS, type ModelTier } from "./model-constants";
import { hashMessages, hashQuery } from "./hasher";
import { getHardwareProfile, type HardwareProfile } from "../attention-engine";

// ──────────────────────────────────────────────────────────────────────────
// Cosine similarity helper
// ──────────────────────────────────────────────────────────────────────────
/**
 * BM25-inspired keyword retrieval — used when ML embedding is unavailable
 * (e.g. when the offscreen document is unreachable in SW context).
 * Mirrors the cosine-path boosts so scores are comparable.
 */
function keywordRetrieve(
  allChunks: ChunkEmbedding[],
  query: string,
  topK: number
): ChunkEmbedding[] {
  const tokens = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const maxMsgIdx = Math.max(...allChunks.map((c) => c.messageIndex), 0);

  const scored = allChunks.map((chunk) => {
    const text = chunk.text.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      let pos = 0;
      while ((pos = text.indexOf(tok, pos)) !== -1) { score++; pos += tok.length; }
    }
    const recency = maxMsgIdx > 0 ? 0.15 * (chunk.messageIndex / maxMsgIdx) : 0;
    if (chunk.hasCode) score += 0.5;
    return { chunk, score: score + recency };
  });
  scored.sort((a, b) => b.score - a.score);

  // Always keep a recent tail (mirror TAIL_SIZE in attention-engine)
  const RECENT_WINDOW = maxMsgIdx < 60 ? 6 : maxMsgIdx < 200 ? 10 : 15;
  const recentCutoff = Math.max(0, maxMsgIdx - RECENT_WINDOW + 1);
  const recent = allChunks.filter((c) => c.messageIndex >= recentCutoff);
  const topScored = scored
    .filter((s) => s.chunk.messageIndex < recentCutoff)
    .slice(0, Math.max(0, topK - recent.length))
    .map((s) => s.chunk);

  const seen = new Set<string>();
  return [...recent, ...topScored]
    .filter((c) => { if (seen.has(c.id)) return false; seen.add(c.id); return true; })
    .sort((a, b) => a.messageIndex - b.messageIndex)
    .slice(0, topK);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ──────────────────────────────────────────────────────────────────────────
// Offscreen-document orchestration (callable from any extension context)
// ──────────────────────────────────────────────────────────────────────────

const OFFSCREEN_DOC_URL = "src/offscreen/offscreen.html";

async function ensureOffscreenDocument(): Promise<void> {
  // chrome.offscreen is only available in MV3 SW + extension pages.
  // Sidebar context can also call createDocument; if it errors with
  // "already exists", we silently swallow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offscreen = (chrome as any).offscreen;
  if (!offscreen) return; // not supported here — caller will fall back

  try {
    // hasDocument is only on Chrome 116+
    const has = await offscreen.hasDocument?.();
    if (has) {
      // Verify the doc is alive — it may have crashed without Chrome updating hasDocument.
      const alive = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 1_500);
        chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" }, (resp) => {
          clearTimeout(t);
          resolve(!chrome.runtime.lastError && resp?.alive === true);
        });
      });
      if (alive) return;
      console.warn("[CM:offscreen] document unresponsive — closing and recreating");
      await offscreen.closeDocument?.().catch(() => {});
    }
  } catch { /* fall through to createDocument */ }

  try {
    await offscreen.createDocument({
      url: OFFSCREEN_DOC_URL,
      reasons: ["WORKERS"],
      justification: "Run embedding model in a worker for retrieval-first migration",
    });
    console.log("[CM:offscreen] document created");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Only a single offscreen") && !msg.includes("already")) {
      console.error("[CM:offscreen] document creation failed:", msg);
      throw err;
    }
    console.log("[CM:offscreen] document already exists");
  }
}

interface OffscreenIndexResponse { ok: boolean; chunkCount?: number; error?: string }
interface OffscreenEmbedResponse { ok: boolean; embedding?: number[]; error?: string }

async function offscreenIndex(
  session: ContextSession,
  hardware: HardwareProfile,
  onProgress?: (pct: number, stage: string) => void
): Promise<number> {
  await ensureOffscreenDocument();
  const requestId = `idx_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Listen for progress
  const progressListener = (msg: { type?: string; requestId?: string; progress?: number; stage?: string }) => {
    if (msg?.type === "OFFSCREEN_PROGRESS" && msg.requestId === requestId) {
      onProgress?.(msg.progress ?? 0, msg.stage ?? "");
    }
  };
  chrome.runtime.onMessage.addListener(progressListener);

  try {
    const res = await chrome.runtime.sendMessage<unknown, OffscreenIndexResponse>({
      type: "OFFSCREEN_INDEX_SESSION",
      session,
      hardware,
      requestId,
    });
    if (!res?.ok) throw new Error(res?.error ?? "Offscreen indexing failed");
    return res.chunkCount ?? 0;
  } finally {
    chrome.runtime.onMessage.removeListener(progressListener);
  }
}

async function offscreenEmbedQuery(
  text: string,
  hardware: HardwareProfile
): Promise<number[]> {
  await ensureOffscreenDocument();
  const requestId = `q_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const res = await chrome.runtime.sendMessage<unknown, OffscreenEmbedResponse>({
    type: "OFFSCREEN_EMBED_QUERY",
    text,
    hardware,
    requestId,
  });
  if (!res?.ok || !res.embedding) throw new Error(res?.error ?? "Offscreen embed failed");
  return res.embedding;
}

// ──────────────────────────────────────────────────────────────────────────
// Indexing queue — at most ONE concurrent indexing job at a time, regardless
// of caller. On low-end hardware (minimal tier, 4 cores, no WebGPU) running
// 3 sessions concurrently saturated the offscreen doc and froze the UI for
// minutes. Serializing the queue keeps WASM embeddings on (quality matters
// for the attention engine) while letting the browser breathe.
// ──────────────────────────────────────────────────────────────────────
type IndexJob = {
  session: ContextSession;
  onProgress?: (pct: number, stage: string) => void;
  resolve: () => void;
  reject: (err: unknown) => void;
};
const _indexQueue: IndexJob[] = [];
let _indexQueueRunning = false;

function broadcastIndexStatus(status: {
  active: boolean;
  queued: number;
  sessionId?: string;
  progress?: number;
  stage?: string;
}): void {
  // Fire-and-forget broadcast to sidebar / popup. No-op if no listeners.
  try {
    chrome.runtime.sendMessage({ type: "INDEXING_STATUS", ...status }).catch(() => {});
  } catch { /* runtime may be torn down during reload */ }
}

async function maybeCloseOffscreen(): Promise<void> {
  // Release offscreen-doc memory (and the embedding worker it hosts) once
  // the queue drains. The next indexSession call will re-create it. Cheap:
  // doc creation is ~30ms; model warm-up is amortized by modelRegistry's
  // own cache on the next createDocument.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offscreen = (chrome as any).offscreen;
  if (!offscreen?.closeDocument) return;
  try { await offscreen.closeDocument(); } catch { /* already closed */ }
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory retrieval cache (30 s TTL, keyed by sessionId + query prefix)
// ──────────────────────────────────────────────────────────────────────
const _retrieveCache = new Map<string, { results: ChunkEmbedding[]; ts: number }>();

// ──────────────────────────────────────────────────────────────────────────
// SemanticIndex
// ──────────────────────────────────────────────────────────────────────────

export class SemanticIndex {
  // ─── INDEXING ─────────────────────────────────────────────────────────

  async needsIndexing(session: ContextSession): Promise<boolean> {
    const stored = await dexieDb.sessionHashes.get(session.id);
    if (!stored) return true;

    const currentHash = hashMessages(session.messages);
    if (stored.hash !== currentHash) return true;

    // Hardware profile may have changed (e.g. new GPU available)
    try {
      const hw = await getHardwareProfile();
      const expectedTier: ModelTier =
        hw.tier === "minimal" ? "tiny"
        : (hw.hasWebGPU && hw.cores >= 8) ? "full"
        : "tiny";
      if (stored.model !== MODEL_CONFIGS[expectedTier].modelId) return true;
    } catch { /* hw detection failure → keep existing index */ }

    return false;
  }

  /**
   * Indexes a session via the offscreen document. Serialized — at most ONE
   * indexing job runs at a time across the entire extension. Subsequent
   * callers wait their turn. On minimal-tier hardware (no WebGPU, ≤ 4
   * cores) we insert a 2 s breathing delay between jobs so the UI thread
   * doesn't starve when the user just captured 3 conversations in a row.
   *
   * If offscreen is unavailable (e.g. we're already in offscreen), falls
   * back to direct in-process indexing — but still serializes.
   */
  async indexSession(
    session: ContextSession,
    onProgress?: (pct: number, stage: string) => void
  ): Promise<void> {
    if (!(await this.needsIndexing(session))) {
      console.log(`[CM:index] Skip (unchanged): ${session.id}`);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      _indexQueue.push({ session, onProgress, resolve, reject });
      broadcastIndexStatus({
        active: _indexQueueRunning,
        queued: _indexQueue.length,
        sessionId: session.id,
        stage: _indexQueueRunning ? "Queued" : "Starting",
      });
      void this._drainIndexQueue();
    });
  }

  private async _drainIndexQueue(): Promise<void> {
    if (_indexQueueRunning) return;
    _indexQueueRunning = true;

    try {
      while (_indexQueue.length > 0) {
        const job = _indexQueue.shift()!;
        try {
          broadcastIndexStatus({
            active: true,
            queued: _indexQueue.length,
            sessionId: job.session.id,
            progress: 0,
            stage: "Indexing in background...",
          });
          await this._runIndexJob(job);
          job.resolve();
        } catch (err) {
          job.reject(err);
        }

        // Throttle on minimal-tier hardware so the UI thread can recover
        // between back-to-back jobs. Skip the delay if we just drained.
        if (_indexQueue.length > 0) {
          const hw = await getHardwareProfile().catch(() => null);
          if (hw?.tier === "minimal") {
            await new Promise((r) => setTimeout(r, 2_000));
          }
        }
      }
    } finally {
      _indexQueueRunning = false;
      broadcastIndexStatus({ active: false, queued: 0 });
      // Release offscreen-doc memory when nothing else is queued.
      void maybeCloseOffscreen();
    }
  }

  private async _runIndexJob(job: IndexJob): Promise<void> {
    const { session, onProgress } = job;
    const hw = await getHardwareProfile();

    const wrappedProgress = (pct: number, stage: string) => {
      onProgress?.(pct, stage);
      broadcastIndexStatus({
        active: true,
        queued: _indexQueue.length,
        sessionId: session.id,
        progress: pct,
        stage,
      });
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasOffscreen = !!(chrome as any).offscreen;
    if (hasOffscreen) {
      const t0 = performance.now();
      wrappedProgress(5, "Spawning indexing worker...");
      const chunkCount = await offscreenIndex(session, hw, wrappedProgress);
      console.log(
        `[CM:index] ${session.id}: ${chunkCount} chunks indexed in ${(performance.now() - t0).toFixed(0)}ms`
      );
      wrappedProgress(100, "Indexed");
      return;
    }

    // Direct fallback (e.g. when running inside the offscreen doc itself)
    await this._indexInProcess(session, hw, wrappedProgress);
  }

  private async _indexInProcess(
    session: ContextSession,
    hw: HardwareProfile,
    onProgress?: (pct: number, stage: string) => void
  ): Promise<void> {
    const t0 = performance.now();
    onProgress?.(5, "Chunking messages...");
    const { chunkMessages } = await import("./chunker");
    const chunks = chunkMessages(session.messages);

    onProgress?.(15, "Loading model...");
    // Dynamic import: keeps @xenova/transformers out of the SW bundle.
    // This path only runs in sidebar/offscreen contexts (SW always uses offscreen).
    const { modelRegistry } = await import("./model-registry");
    await modelRegistry.initialize(hw, (pct) => {
      onProgress?.(15 + pct * 0.4, "Loading AI model...");
    });

    onProgress?.(55, `Embedding ${chunks.length} chunks...`);
    const texts = chunks.map((c) => c.text);
    const embeddings = await modelRegistry.embedBatch(texts);

    onProgress?.(85, "Persisting to storage...");
    await dexieDb.chunkEmbeddings.where("sessionId").equals(session.id).delete();

    const records: ChunkEmbedding[] = chunks.map((chunk, i) => ({
      id: `${session.id}:${i}`,
      sessionId: session.id,
      chunkIndex: i,
      text: chunk.text,
      embedding: embeddings[i],
      role: chunk.role,
      messageIndex: chunk.messageIndex,
      hasCode: chunk.hasCode,
      language: chunk.language,
      tokenCount: chunk.tokenCount,
      createdAt: Date.now(),
    }));
    await dexieDb.chunkEmbeddings.bulkPut(records);

    const config = (await import("./model-registry")).modelRegistry.getConfig();
    await dexieDb.sessionHashes.put({
      sessionId: session.id,
      hash: hashMessages(session.messages),
      chunkCount: chunks.length,
      messageCount: session.messages.length,
      model: config?.modelId ?? "unknown",
      indexedAt: Date.now(),
    });

    console.log(
      `[CM:index] (in-process) ${session.id}: ${chunks.length} chunks in ${(performance.now() - t0).toFixed(0)}ms`
    );
    onProgress?.(100, "Indexed");
  }

  // ─── RETRIEVAL ────────────────────────────────────────────────────────

  async retrieve(
    sessionId: string,
    query: string | null,
    topK: number = 15
  ): Promise<ChunkEmbedding[]> {
    const t0 = performance.now();

    // ── In-memory cache check (30 s TTL) ──
    const cacheKey = `${sessionId}::${query?.slice(0, 50) ?? ''}`;
    const _cached = _retrieveCache.get(cacheKey);
    if (_cached && Date.now() - _cached.ts < 30_000) {
      return _cached.results;
    }

    const allChunks = await dexieDb.chunkEmbeddings.where("sessionId").equals(sessionId).toArray();
    if (allChunks.length === 0) {
      console.warn(`[CM:index] No chunks for ${sessionId}`);
      return [];
    }

    if (!query || !query.trim()) {
      // No query — return most recent N chunks
      const sorted = [...allChunks].sort((a, b) => b.messageIndex - a.messageIndex);
      const result = sorted.slice(0, topK).reverse();
      _retrieveCache.set(cacheKey, { results: result, ts: Date.now() });
      return result;
    }

    // Embed the query — prefer offscreen path, fall back to keyword-only
    const hw = await getHardwareProfile();
    let queryEmbedding: number[] | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasOffscreen = !!(chrome as any).offscreen;
    if (hasOffscreen) {
      try {
        queryEmbedding = await offscreenEmbedQuery(query, hw);
      } catch (err) {
        // In SW context, DOM is unavailable so in-process model loading fails.
        // Fall through to keyword-only retrieval — safe in all contexts.
        console.warn("[CM:index] Offscreen query embed failed — using keyword fallback:", err);
      }
    } else {
      // Sidebar / page context: safe to load model in-process.
      try {
        const { modelRegistry } = await import("./model-registry");
        await modelRegistry.initialize(hw);
        queryEmbedding = await modelRegistry.embed(query);
      } catch (err) {
        console.warn("[CM:index] In-process embed failed — using keyword fallback:", err);
      }
    }

    if (queryEmbedding === null) {
      const result = keywordRetrieve(allChunks, query, topK);
      _retrieveCache.set(cacheKey, { results: result, ts: Date.now() });
      console.log(`[CM:index] Keyword fallback: ${result.length}/${allChunks.length} chunks in ${(performance.now() - t0).toFixed(1)}ms`);
      return result;
    }

    // Multi-signal attention score:
    //   • cosine similarity to the query embedding (the dominant signal)
    //   • recency boost  → recent messages slightly outrank old ones at
    //                     equal semantic relevance (linear decay over the
    //                     session length, capped at +0.15)
    //   • signal boost   → chunks containing decisions, errors / stack
    //                     traces, or code get a small additive bump that
    //                     can lift them past the MIN_SIMILARITY threshold
    //                     when the query is generic but the chunk is
    //                     clearly load-bearing
    //   • length boost   → very long chunks get a slight bump up to a cap
    //                     because they tend to carry more signal
    const maxMessageIndex = Math.max(
      ...allChunks.map((c) => c.messageIndex),
      0
    );
    const SIGNAL_RE = /\b(?:we decided|the fix is|root cause|the issue was|bug was|the goal|next step|TypeError|ReferenceError|Traceback|throws? \w+Error|fails? with|caused by)\b/i;

    const scored = allChunks.map((chunk) => {
      const cos = cosineSimilarity(queryEmbedding, chunk.embedding);
      const recency = maxMessageIndex > 0
        ? 0.15 * (chunk.messageIndex / maxMessageIndex)
        : 0;
      let signal = 0;
      if (SIGNAL_RE.test(chunk.text)) signal += 0.10;
      if (chunk.hasCode) signal += 0.05;
      // Length boost is small and capped — guards against rambling chunks
      // dominating purely on size.
      const length = Math.min(0.05, chunk.text.length / 6000);
      return { chunk, score: cos + recency + signal + length, cos };
    });
    scored.sort((a, b) => b.score - a.score);

    // Discard near-zero similarity chunks — they're semantic noise and would
    // dilute the retrieval if there's room to fill from better candidates.
    // We threshold on the raw cosine, not the boosted score, so the recency
    // bump never single-handedly admits an off-topic chunk.
    const MIN_SIMILARITY = 0.1;
    const usable = scored.filter((s) => s.cos >= MIN_SIMILARITY);
    const pool = usable.length > 0 ? usable : scored;

    // Boost code chunks — always include up to 5 top code blocks
    const topCode = pool.filter((s) => s.chunk.hasCode).slice(0, 5);
    const topProse = pool
      .filter((s) => !s.chunk.hasCode)
      .slice(0, Math.max(0, topK - topCode.length));

    // CRITICAL: always include chunks from the recent tail regardless of
    // cosine score. The window scales with session length so a 300-msg
    // session doesn't lose continuity to a fixed 6-msg window.
    //   • <  60 msgs  → 6 messages
    //   • 60–200 msgs → 10 messages
    //   • > 200 msgs  → 15 messages
    const RECENT_WINDOW =
      maxMessageIndex < 60 ? 6 : maxMessageIndex < 200 ? 10 : 15;
    const recentCutoff = Math.max(0, maxMessageIndex - RECENT_WINDOW + 1);
    const recentChunks = scored.filter(
      (s) => s.chunk.messageIndex >= recentCutoff
    );

    // Union of: top-scored code + top-scored prose + all recent chunks.
    // De-dup by chunk id so a chunk that's both recent AND top-scored isn't
    // counted twice.
    const seen = new Set<string>();
    const retrieved = [...topCode, ...topProse, ...recentChunks]
      .filter((s) => {
        if (seen.has(s.chunk.id)) return false;
        seen.add(s.chunk.id);
        return true;
      })
      .sort((a, b) => a.chunk.messageIndex - b.chunk.messageIndex)
      .map((s) => s.chunk);

    _retrieveCache.set(cacheKey, { results: retrieved, ts: Date.now() });
    console.log(
      `[CM:index] Retrieved ${retrieved.length}/${allChunks.length} chunks ` +
      `(top-code=${topCode.length} top-prose=${topProse.length} recent=${recentChunks.length}) ` +
      `in ${(performance.now() - t0).toFixed(1)}ms`
    );
    return retrieved;
  }

  // ─── SUMMARY PERSISTENCE ──────────────────────────────────────────────

  async getSummary(
    sessionId: string,
    tier: 1 | 2,
    task: string | null,
    messageCount: number
  ): Promise<StoredSummary | null> {
    const taskHash = task ? hashQuery(task) : "none";
    const id = `${sessionId}:${tier}:${taskHash}`;
    const stored = await dexieDb.storedSummaries.get(id);
    if (!stored) return null;
    if (stored.messageCount !== messageCount) return null;
    if (Date.now() - stored.builtAt > 86_400_000) return null;
    return stored;
  }

  async saveSummary(
    sessionId: string,
    tier: 1 | 2,
    task: string | null,
    content: string,
    compressionRatio: number,
    messageCount: number
  ): Promise<void> {
    const taskHash = task ? hashQuery(task) : "none";
    await dexieDb.storedSummaries.put({
      id: `${sessionId}:${tier}:${taskHash}`,
      sessionId,
      tier,
      task,
      content,
      compressionRatio,
      builtAt: Date.now(),
      messageCount,
    });
  }

  // ─── RETRIEVAL CACHE (full prompt) ────────────────────────────────────

  async getCachedPrompt(
    sessionId: string,
    query: string | null,
    platform: string,
    tier: number,
    templateId: string | null
  ): Promise<string | null> {
    const queryHash = query ? hashQuery(query) : "none";
    const id = `${sessionId}:${queryHash}:${platform}:${tier}:${templateId ?? "none"}`;
    const cached = await dexieDb.retrievalCache.get(id);
    if (!cached) return null;
    if (Date.now() - cached.builtAt > 300_000) return null; // 5 min
    return cached.prompt;
  }

  async cachePrompt(
    sessionId: string,
    query: string | null,
    platform: string,
    tier: number,
    templateId: string | null,
    prompt: string,
    chunkIds: string[]
  ): Promise<void> {
    const queryHash = query ? hashQuery(query) : "none";
    const id = `${sessionId}:${queryHash}:${platform}:${tier}:${templateId ?? "none"}`;
    await dexieDb.retrievalCache.put({
      id,
      sessionId,
      queryHash,
      chunkIds,
      prompt,
      platform,
      tier,
      templateId,
      builtAt: Date.now(),
    });
  }

  // ─── CLEANUP / GC ─────────────────────────────────────────────────────

  async cleanupOldData(): Promise<void> {
    // 1. Remove orphaned data for deleted sessions
    const sessionIds = new Set((await dexieDb.sessions.toArray()).map((s) => s.id));
    const allHashes = await dexieDb.sessionHashes.toArray();
    for (const h of allHashes) {
      if (!sessionIds.has(h.sessionId)) {
        await dexieDb.chunkEmbeddings.where("sessionId").equals(h.sessionId).delete();
        await dexieDb.sessionHashes.delete(h.sessionId);
        await dexieDb.storedSummaries.where("sessionId").equals(h.sessionId).delete();
        await dexieDb.retrievalCache.where("sessionId").equals(h.sessionId).delete();
        console.log(`[CM:index] Cleaned up orphan: ${h.sessionId}`);
      }
    }

    // 2. Expire retrieval cache > 1h
    const oneHourAgo = Date.now() - 3_600_000;
    await dexieDb.retrievalCache.where("builtAt").below(oneHourAgo).delete();

    // 3. Enforce max chunks (100k)
    const total = await dexieDb.chunkEmbeddings.count();
    if (total > 100_000) {
      const toDelete = Math.floor(total * 0.2);
      const oldest = await dexieDb.chunkEmbeddings
        .orderBy("createdAt")
        .limit(toDelete)
        .toArray();
      await dexieDb.chunkEmbeddings.bulkDelete(oldest.map((c) => c.id));
      console.log(`[CM:index] Pruned ${toDelete} oldest chunks (was ${total})`);
    }

    // 4. Cap stored summaries per session at 20
    const summaries = await dexieDb.storedSummaries.toArray();
    const bySession = new Map<string, StoredSummary[]>();
    for (const s of summaries) {
      const arr = bySession.get(s.sessionId) ?? [];
      arr.push(s);
      bySession.set(s.sessionId, arr);
    }
    for (const [, arr] of bySession) {
      if (arr.length > 20) {
        arr.sort((a, b) => a.builtAt - b.builtAt);
        const drop = arr.slice(0, arr.length - 20);
        await dexieDb.storedSummaries.bulkDelete(drop.map((s) => s.id));
      }
    }
  }

  // ─── STATS (for settings UI) ──────────────────────────────────────────

  async getStats(): Promise<{
    sessionCount: number;
    indexedCount: number;
    chunkCount: number;
    summaryCount: number;
    cacheCount: number;
    estimatedStorageMB: number;
    modelTier: string | null;
    modelLabel: string | null;
  }> {
    const [sessionCount, chunkCount, summaryCount, cacheCount, hashCount] = await Promise.all([
      dexieDb.sessions.count(),
      dexieDb.chunkEmbeddings.count(),
      dexieDb.storedSummaries.count(),
      dexieDb.retrievalCache.count(),
      dexieDb.sessionHashes.count(),
    ]);
    const estimatedStorageMB = Math.round((chunkCount * 384 * 4) / (1024 * 1024));
    return {
      sessionCount,
      indexedCount: hashCount,
      chunkCount,
      summaryCount,
      cacheCount,
      estimatedStorageMB,
      // modelRegistry is only loaded in offscreen/sidebar contexts.
      // Return null in SW context — non-critical for stats display.
      modelTier: null,
      modelLabel: null,
    };
  }

  async warmup(): Promise<void> {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_WARMUP" }).catch(() => {});
  }

  async clearAll(): Promise<void> {
    await Promise.all([
      dexieDb.chunkEmbeddings.clear(),
      dexieDb.sessionHashes.clear(),
      dexieDb.storedSummaries.clear(),
      dexieDb.retrievalCache.clear(),
    ]);
  }
}

export const semanticIndex = new SemanticIndex();
