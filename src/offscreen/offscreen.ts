/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/offscreen/offscreen.ts
//
// Offscreen document — Preemptive Priority Queue Manager.
//
// Architecture: SW (Boss) → Offscreen (Queue Manager) → ml-worker (Heavy Lifter)
//
// The offscreen document's JS thread manages two queues and drip-feeds work
// to the dedicated Web Worker (ml-worker.ts) that runs the WASM pipeline.
// Yielding between chunks keeps this thread responsive to priority interrupts
// from the SW (e.g. when the user clicks "Migrate").
//
// Message protocol with SW (unchanged — backward-compatible):
//   IN:  { type: 'OFFSCREEN_INDEX_SESSION', session, hardware, requestId, priority? }
//        { type: 'OFFSCREEN_EMBED_QUERY',   text,    requestId, priority? }
//        { type: 'OFFSCREEN_WARMUP' }
//        { type: 'OFFSCREEN_PING' }
//   OUT: (chrome.runtime.sendMessage broadcasts back to SW listeners)
//        { type: 'OFFSCREEN_READY' }
//        { type: 'OFFSCREEN_PROGRESS', requestId, progress, stage }
//        { type: 'OFFSCREEN_INDEX_DONE', requestId, chunkCount }
//        { type: 'OFFSCREEN_EMBED_DONE', requestId, embedding }
//        { type: 'OFFSCREEN_ERROR', requestId, error }

import type { ContextSession, OffscreenSearchChunk, OffscreenSearchResult } from "../lib/types";
import type { HardwareProfile } from "../lib/attention-engine";
import { chunkMessages, type Chunk } from "../lib/semantic-index/chunker";
import { dexieDb, type ChunkEmbedding } from "../lib/db";
import { hashMessages } from "../lib/semantic-index/hasher";
// Vite ?worker syntax — @crxjs bundles this as an extension-origin worker chunk.
// @ts-ignore — worker plugin injects the default export at build time
import MLWorker from "./ml-worker?worker";

console.log("[CM:offscreen] booted — queue manager initialising");

// ── Web Worker setup ──────────────────────────────────────────────────────────

type WorkerResponse =
  | { type: "WORKER_READY"; modelLoaded?: boolean }
  | { type: "OFFSCREEN_EMBED_DONE";       requestId: string; embedding: number[] }
  | { type: "OFFSCREEN_BATCH_EMBED_DONE"; requestId: string; embeddings: number[][] }
  | { type: "OFFSCREEN_SEARCH_DONE";      requestId: string; results: OffscreenSearchResult[] }
  | { type: "OFFSCREEN_ERROR";            requestId: string; error: string };

// Chunk batch size for index jobs — 8 texts per ONNX forward pass.
// On modern CPUs (SIMD, ≥4 cores) this reduces 114-chunk indexing from
// ~120s to ~20-30s by amortising WASM startup overhead across the batch.
// On weak i3 hardware: ~120s → ~50-70s (still a ~2x win).
// Keep ≤ 16 to avoid WASM OOM on 2-4 GB RAM machines.
const EMBED_BATCH_SIZE = 8;

const worker = new (MLWorker as { new(): Worker })();
let workerReady = false;
let modelReady = false; // [CM-RACE-FIX] true when ml-worker finished model init
let modelFailed = false; // true when ml-worker signalled ready but the model did NOT load

// Pending runtime embeds that arrived before model was ready.
// Each entry carries a safety timeout so the Chrome message channel never hangs.
const pendingRuntimeEmbeds: Array<{
  requestId: string;
  text: string;
  sendResponse: (response: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}> = [];

// Pending embed callbacks keyed by requestId.
const pendingEmbeds = new Map<string, {
  resolve: (embedding: number[]) => void;
  reject:  (err: Error) => void;
}>();

// Pending batch-embed callbacks keyed by requestId.
const pendingBatchEmbeds = new Map<string, {
  resolve: (embeddings: number[][]) => void;
  reject:  (err: Error) => void;
}>();

// Pending sendResponse callbacks for OFFSCREEN_EMBED_QUERY messages.
// Keyed by job requestId — called instead of chrome.runtime.sendMessage so the
// embedding travels ONLY back to the sender, never broadcast to all listeners.
const pendingResponses = new Map<string, (response: unknown) => void>();

// Pending sendResponse callbacks for OFFSCREEN_SEARCH_QUERY messages.
// Search bypasses the job queue entirely (pure math, no model) and resolves
// as soon as the worker finishes the cosine sort.
const pendingSearches = new Map<string, (response: unknown) => void>();

worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
  if (data.type === "WORKER_READY") {
    workerReady = true;
    // Only mark the model ready if it actually loaded. On failure, embed
    // requests fast-fail to keyword fallback instead of stalling for 25s.
    modelReady = data.modelLoaded !== false;
    modelFailed = data.modelLoaded === false;
    console.log(`[CM:offscreen] ml-worker ready — modelLoaded=${modelReady}, signalling SW`);
    chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" }).catch(() => {});
    // Start draining any jobs that were enqueued before the worker booted.
    void drainLoop();
    // [CM-RACE-FIX] drain runtime embeds that arrived while model was loading
    while (pendingRuntimeEmbeds.length > 0) {
      const pending = pendingRuntimeEmbeds.shift()!;
      clearTimeout(pending.timeoutId);
      if (modelFailed) {
        // No model — resolve immediately so the caller uses keyword fallback now.
        pending.sendResponse({ ok: false, error: "model_unavailable" });
        continue;
      }
      pendingResponses.set(pending.requestId, pending.sendResponse);
      enqueue({ kind: "embed", text: pending.text, requestId: pending.requestId, priority: true });
    }
    return;
  }
  if (data.type === "OFFSCREEN_SEARCH_DONE") {
    const searchCb = pendingSearches.get(data.requestId);
    if (searchCb) {
      pendingSearches.delete(data.requestId);
      searchCb({ ok: true, results: data.results });
    }
    return;
  }

  // Batch embed response — resolves the batch promise
  if (data.type === "OFFSCREEN_BATCH_EMBED_DONE") {
    const batchCb = pendingBatchEmbeds.get(data.requestId);
    if (batchCb) {
      pendingBatchEmbeds.delete(data.requestId);
      batchCb.resolve(data.embeddings);
    }
    return;
  }

  // Error response — check both single and batch pending maps
  if ((data as { type: string }).type === "OFFSCREEN_ERROR") {
    const batchCb = pendingBatchEmbeds.get(data.requestId);
    if (batchCb) {
      pendingBatchEmbeds.delete(data.requestId);
      batchCb.reject(new Error((data as { error?: string }).error ?? "batch embed failed"));
      return;
    }
  }

  const cb = pendingEmbeds.get(data.requestId);
  if (!cb) return;
  pendingEmbeds.delete(data.requestId);
  if (data.type === "OFFSCREEN_EMBED_DONE") {
    cb.resolve(data.embedding);
  } else {
    cb.reject(new Error((data as { error?: string }).error ?? "embed failed"));
  }
};

worker.onerror = (ev: ErrorEvent) => {
  console.error("[CM:offscreen] ml-worker error:", ev.message);
  // Unblock any waiting embeds with a zero vector fallback.
  for (const [id, cb] of pendingEmbeds) {
    cb.reject(new Error(`worker error: ${ev.message}`));
    pendingEmbeds.delete(id);
  }
  // Unblock any waiting searches with an error response.
  for (const [id, cb] of pendingSearches) {
    cb({ ok: false, error: `worker error: ${ev.message}` });
    pendingSearches.delete(id);
  }
  // [CM-RACE-FIX] clear runtime embeds that were waiting for model init
  for (const pending of pendingRuntimeEmbeds) {
    clearTimeout(pending.timeoutId);
    pending.sendResponse({ ok: false, error: `worker error: ${ev.message}` });
  }
  pendingRuntimeEmbeds.length = 0;
};

/** Forward a search payload to the worker; results arrive via pendingSearches. */
function searchViaWorker(
  requestId: string,
  queryEmbedding: number[],
  chunks: OffscreenSearchChunk[],
  topK: number,
): void {
  worker.postMessage({ type: "OFFSCREEN_SEARCH_QUERY", requestId, queryEmbedding, chunks, topK });
}

/** Send a BATCH of texts to the worker in one ONNX forward pass. */
function batchEmbedViaWorker(texts: string[]): Promise<number[][]> {
  const requestId = Math.random().toString(36).slice(2, 14);
  return new Promise<number[][]>((resolve, reject) => {
    pendingBatchEmbeds.set(requestId, { resolve, reject });
    worker.postMessage({ type: "OFFSCREEN_BATCH_EMBED_QUERY", requestId, texts });
  });
}

/** Send one text to the worker; returns a Promise that resolves with the embedding. */
function embedViaWorker(text: string): Promise<number[]> {
  const requestId = Math.random().toString(36).slice(2, 14);
  return new Promise<number[]>((resolve, reject) => {
    pendingEmbeds.set(requestId, { resolve, reject });
    // Native Worker.postMessage — stays strictly inside the Worker boundary,
    // never touches chrome.runtime.
    worker.postMessage({ type: "OFFSCREEN_EMBED_QUERY", requestId, text });
  });
}

// ── Priority / Background job queues ─────────────────────────────────────────

interface IndexJob {
  kind: "index";
  session: ContextSession;
  hardware: HardwareProfile;
  requestId: string;
  priority: boolean;
}

interface EmbedJob {
  kind: "embed";
  text: string;
  requestId: string;
  priority: boolean;
}

type Job = IndexJob | EmbedJob;

const priorityQueue:   Job[] = [];
const backgroundQueue: Job[] = [];
let loopRunning = false;

// [CM-T3-FIX] cancelled background index jobs superseded by priority jobs
const cancelledRequests = new Set<string>();

/** Yield-to-event-loop primitive — lets the message pump process new chrome.runtime messages. */
const yieldToEventLoop = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Enqueue a job. Always restarts the drain loop if it is not running.
 * Priority jobs jump the background queue; they are also processed immediately
 * within an in-progress background index (between chunk boundaries).
 */
function enqueue(job: Job): void {
  if (job.priority) {
    if (job.kind === 'index') {
      const bgIdx = backgroundQueue.findIndex(
        j => j.kind === 'index' && j.session.id === job.session.id
      );
      if (bgIdx !== -1) {
        const cancelled = backgroundQueue.splice(bgIdx, 1)[0] as IndexJob;
        cancelledRequests.add(cancelled.requestId);
        console.log(`[CM:offscreen] cancelled bg index ${cancelled.requestId} — replaced by priority`);
      }
    }
    priorityQueue.push(job);
  } else {
    backgroundQueue.push(job);
  }
  if (!loopRunning && workerReady) void drainLoop();
}

/**
 * Main drain loop — processes all queued jobs with priority-first ordering.
 * After each job (and between chunks of an index job) the loop yields so that
 * newly-arriving priority messages can be inserted before processing resumes.
 */
async function drainLoop(): Promise<void> {
  if (loopRunning || !workerReady) return;
  loopRunning = true;
  try {
    while (priorityQueue.length > 0 || backgroundQueue.length > 0) {
      // Always consume all priority work before touching background queue.
      const job = priorityQueue.shift() ?? backgroundQueue.shift()!;
      if (job.kind === "index") await processIndexJob(job);
      else                      await processEmbedJob(job);
      // Yield after every job so new priority messages can be enqueued.
      await yieldToEventLoop();
    }
  } finally {
    loopRunning = false;
  }
}

// ── Job processors ────────────────────────────────────────────────────────────

async function processEmbedJob(job: EmbedJob): Promise<void> {
  // Retrieve and consume the sendResponse callback that was stored when the
  // OFFSCREEN_EMBED_QUERY message arrived. Replying via sendResponse keeps
  // the embedding private to the original sender — it is NEVER broadcast
  // over chrome.runtime, so the SW logger and all other extension contexts
  // never see the Float32Array payload.
  const respond = pendingResponses.get(job.requestId);
  pendingResponses.delete(job.requestId);
  try {
    const embedding = await embedViaWorker(job.text);
    respond?.({ ok: true, embedding });
  } catch (err) {
    respond?.({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function processIndexJob(job: IndexJob): Promise<void> {
  const { session, requestId } = job;
  const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

  try {
    progress(requestId, 10, "Chunking messages...");
    // Extract text content from ContextSession.messages for embedding.
    const chunks: Chunk[] = chunkMessages(session.messages);

    const totalBatches = Math.ceil(chunks.length / EMBED_BATCH_SIZE);
    progress(requestId, 20, `Embedding ${chunks.length} chunk(s) in ${totalBatches} batch(es)...`);
    const embeddings: number[][] = [];

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      // ── Priority interrupt between batches ───────────────────────────────
      // Yield once per batch (every 8 chunks) so incoming priority messages
      // can be processed without blocking the entire session mid-embed.
      // Worst-case preemption lag = one ONNX batch (~1-3s on modern HW, ~8s on i3).
      await yieldToEventLoop();
      while (priorityQueue.length > 0) {
        const urgent = priorityQueue.shift()!;
        if (urgent.kind === "index") await processIndexJob(urgent);
        else                         await processEmbedJob(urgent);
        await yieldToEventLoop();
      }

      // Check early if this job was cancelled by a priority interrupt.
      if (cancelledRequests.has(requestId)) break;

      const start = batchIdx * EMBED_BATCH_SIZE;
      const end   = Math.min(start + EMBED_BATCH_SIZE, chunks.length);
      const batchTexts = chunks.slice(start, end).map(c => c.text);

      // Single ONNX forward pass over the entire batch — 4-8× faster than
      // one-by-one inference on modern CPUs with SIMD.
      const batchEmbeds = await batchEmbedViaWorker(batchTexts);
      embeddings.push(...batchEmbeds);

      const pct = 20 + Math.round(((batchIdx + 1) / totalBatches) * 60);
      progress(requestId, pct, `Embedding ${end}/${chunks.length} chunks`);
    }

    // [CM-T3-FIX] cancel stale bg jobs before persisting — prevents partial writes
    if (cancelledRequests.has(requestId)) {
      cancelledRequests.delete(requestId);
      console.log(`[CM:offscreen] index job ${requestId} was cancelled — skipping persist`);
      const respond = pendingResponses.get(requestId);
      pendingResponses.delete(requestId);
      respond?.({ ok: false, error: 'cancelled — superseded by priority job' });
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_ERROR',
        requestId,
        error: 'cancelled — superseded by priority job'
      }).catch(() => {});
      return;
    }

    progress(requestId, 90, "Persisting to storage...");
    // Replace stale chunks for this session with fresh embeddings.
    await dexieDb.chunkEmbeddings.where("sessionId").equals(session.id).delete();

    const chunkRecords: ChunkEmbedding[] = chunks.map((chunk, i) => ({
      id:           `${session.id}:${i}`,
      sessionId:    session.id,
      chunkIndex:   i,
      text:         chunk.text,
      embedding:    embeddings[i],
      role:         chunk.role,
      messageIndex: chunk.messageIndex,
      hasCode:      chunk.hasCode,
      language:     chunk.language,
      tokenCount:   chunk.tokenCount,
      createdAt:    Date.now(),
    }));
    await dexieDb.chunkEmbeddings.bulkPut(chunkRecords);

    await dexieDb.sessionHashes.put({
      sessionId:    session.id,
      hash:         hashMessages(session.messages),
      chunkCount:   chunks.length,
      messageCount: session.messages.length,
      model:        MODEL_ID,
      indexedAt:    Date.now(),
    });

    // [CM-T3-FIX] respond to SW with real chunkCount (port kept open since handler returned true)
    const respond = pendingResponses.get(requestId);
    pendingResponses.delete(requestId);
    respond?.({ ok: true, chunkCount: chunks.length });

    // Keep broadcast for progress listeners
    chrome.runtime.sendMessage({
      type: "OFFSCREEN_INDEX_DONE",
      requestId,
      chunkCount: chunks.length,
    }).catch(() => {});

    console.log(`[CM:offscreen] indexed session ${session.id} — ${chunks.length} chunks`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // [CM-T3-FIX] respond to SW with error so offscreenIndex() throws properly
    const respond = pendingResponses.get(requestId);
    pendingResponses.delete(requestId);
    respond?.({ ok: false, error: errMsg });

    chrome.runtime.sendMessage({
      type: "OFFSCREEN_ERROR",
      requestId,
      error: errMsg,
    }).catch(() => {});
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function progress(requestId: string, pct: number, stage: string): void {
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_PROGRESS",
    requestId,
    progress: pct,
    stage,
  }).catch(() => {});
}

// ── chrome.runtime message router ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "OFFSCREEN_INDEX_SESSION") {
    const { session, hardware, requestId, priority = false } = msg as {
      session:   ContextSession;
      hardware:  HardwareProfile;
      requestId: string;
      priority?: boolean;
    };
    // [CM-T3-FIX] async response — SW waits for real chunkCount, not queued=true
    pendingResponses.set(requestId, sendResponse);
    enqueue({ kind: "index", session, hardware, requestId, priority });
    return true;
  }

  if (msg.type === "OFFSCREEN_EMBED_QUERY") {
    const { text, requestId, priority = false } = msg as {
      text:      string;
      requestId: string;
      priority?: boolean;
    };
    // Store sendResponse — processEmbedJob will call it when the embedding is
    // ready. Do NOT call sendResponse here; return true to keep the port open.
    if (modelFailed) {
      // Model permanently failed to load — don't stall, fall back to keyword now.
      sendResponse({ ok: false, error: "model_unavailable" });
      return false;
    }
    if (!modelReady) {
      const to = setTimeout(() => { const i = pendingRuntimeEmbeds.findIndex(p => p.requestId === requestId); if (i !== -1) { const p = pendingRuntimeEmbeds.splice(i,1)[0]; p.sendResponse({ok:false,error:"model load timeout"}); } }, 25000);
      pendingRuntimeEmbeds.push({requestId,text,sendResponse,timeoutId:to});
      return true;
    }
    pendingResponses.set(requestId, sendResponse);
    enqueue({ kind: "embed", text, requestId, priority });
    return true;
  }

  if (msg.type === "OFFSCREEN_SEARCH_QUERY") {
    const { requestId, queryEmbedding, chunks, topK } = msg as {
      requestId:      string;
      queryEmbedding: number[];
      chunks:         OffscreenSearchChunk[];
      topK:           number;
    };
    // Store sendResponse then dispatch directly to the worker.
    // Search bypasses the job queue — it is pure cosine math with no model I/O,
    // so it finishes in microseconds once the worker is free.
    pendingSearches.set(requestId, sendResponse);
    searchViaWorker(requestId, queryEmbedding, chunks, topK);
    return true;
  }

  if (msg.type === "OFFSCREEN_WARMUP") {
    // Worker warms up automatically on boot; nothing extra needed here.
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "OFFSCREEN_PING") {
    sendResponse({ alive: true });
    return false;
  }

  return false;
});
