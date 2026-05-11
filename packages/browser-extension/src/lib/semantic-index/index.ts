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
import {
  modelRegistry,
  MODEL_CONFIGS,
  type ModelTier,
} from "./model-registry";
import { hashMessages, hashQuery } from "./hasher";
import { getHardwareProfile, type HardwareProfile } from "../attention-engine";

// ──────────────────────────────────────────────────────────────────────────
// Cosine similarity helper
// ──────────────────────────────────────────────────────────────────────────
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
    if (has) return;
  } catch { /* fall through */ }

  try {
    await offscreen.createDocument({
      url: OFFSCREEN_DOC_URL,
      reasons: ["WORKERS"],
      justification: "Run embedding model in a worker for retrieval-first migration",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Only a single offscreen") && !msg.includes("already")) {
      throw err;
    }
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
   * Indexes a session via the offscreen document.
   * If offscreen is unavailable (e.g. we're already in offscreen), falls
   * back to direct in-process indexing.
   */
  async indexSession(
    session: ContextSession,
    onProgress?: (pct: number, stage: string) => void
  ): Promise<void> {
    if (!(await this.needsIndexing(session))) {
      console.log(`[CF:index] Skip (unchanged): ${session.id}`);
      return;
    }

    const hw = await getHardwareProfile();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasOffscreen = !!(chrome as any).offscreen;
    if (hasOffscreen) {
      const t0 = performance.now();
      onProgress?.(5, "Spawning indexing worker...");
      const chunkCount = await offscreenIndex(session, hw, onProgress);
      console.log(
        `[CF:index] ${session.id}: ${chunkCount} chunks indexed in ${(performance.now() - t0).toFixed(0)}ms`
      );
      onProgress?.(100, "Indexed");
      return;
    }

    // Direct fallback (e.g. when running inside the offscreen doc itself)
    await this._indexInProcess(session, hw, onProgress);
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

    const config = modelRegistry.getConfig();
    await dexieDb.sessionHashes.put({
      sessionId: session.id,
      hash: hashMessages(session.messages),
      chunkCount: chunks.length,
      messageCount: session.messages.length,
      model: config?.modelId ?? "unknown",
      indexedAt: Date.now(),
    });

    console.log(
      `[CF:index] (in-process) ${session.id}: ${chunks.length} chunks in ${(performance.now() - t0).toFixed(0)}ms`
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

    const allChunks = await dexieDb.chunkEmbeddings.where("sessionId").equals(sessionId).toArray();
    if (allChunks.length === 0) {
      console.warn(`[CF:index] No chunks for ${sessionId}`);
      return [];
    }

    if (!query || !query.trim()) {
      // No query — return most recent N chunks
      const sorted = [...allChunks].sort((a, b) => b.messageIndex - a.messageIndex);
      return sorted.slice(0, topK).reverse();
    }

    // Embed the query — prefer offscreen path, fall back to in-process
    const hw = await getHardwareProfile();
    let queryEmbedding: number[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasOffscreen = !!(chrome as any).offscreen;
    if (hasOffscreen) {
      try {
        queryEmbedding = await offscreenEmbedQuery(query, hw);
      } catch (err) {
        console.warn("[CF:index] Offscreen query embed failed, retrying in-process:", err);
        await modelRegistry.initialize(hw);
        queryEmbedding = await modelRegistry.embed(query);
      }
    } else {
      await modelRegistry.initialize(hw);
      queryEmbedding = await modelRegistry.embed(query);
    }

    const scored = allChunks.map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);

    // Boost code chunks — always include up to 5 top code blocks
    const topCode = scored.filter((s) => s.chunk.hasCode).slice(0, 5);
    const topProse = scored
      .filter((s) => !s.chunk.hasCode)
      .slice(0, Math.max(0, topK - topCode.length));

    const retrieved = [...topCode, ...topProse]
      .sort((a, b) => a.chunk.messageIndex - b.chunk.messageIndex)
      .map((s) => s.chunk);

    console.log(
      `[CF:index] Retrieved ${retrieved.length}/${allChunks.length} chunks in ${(performance.now() - t0).toFixed(1)}ms`
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
        console.log(`[CF:index] Cleaned up orphan: ${h.sessionId}`);
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
      console.log(`[CF:index] Pruned ${toDelete} oldest chunks (was ${total})`);
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
      modelTier: modelRegistry.getTier(),
      modelLabel: modelRegistry.getConfig()?.label ?? null,
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
