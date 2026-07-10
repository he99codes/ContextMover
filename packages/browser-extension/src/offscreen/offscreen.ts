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
import { chunkMessages, sampleForEmbedding, type Chunk } from "../lib/semantic-index/chunker";
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
  | { type: "OFFSCREEN_EMBED_BATCH_DONE"; requestId: string; embeddings: number[][] }  // [PERF-BATCH]
  | { type: "OFFSCREEN_SEARCH_DONE";     requestId: string; results: OffscreenSearchResult[] }
  | { type: "OFFSCREEN_ERROR";           requestId: string; error: string };

const worker = new (MLWorker as { new(): Worker })();
let workerReady = false;
let modelReady = false;  // [CM-RACE-FIX] true when ml-worker finished model init
let modelFailed = false; // [CM-KEEPALIVE-FIX] true only when model explicitly failed to load (not just still warming up)

// Pending runtime embeds that arrived before model was ready.
// Each entry carries a safety timeout so the Chrome message channel never hangs.
const pendingRuntimeEmbeds: Array<{
  requestId: string;
  text: string;
  sendResponse: (response: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}> = [];

// [T1-FIX] Pending BATCH embeds that arrived before model was ready.
// Same pattern as pendingRuntimeEmbeds — queues the full texts[] until WORKER_READY.
const pendingRuntimeBatchEmbeds: Array<{
  requestId: string;
  texts: string[];
  sendResponse: (response: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  priority: boolean;
}> = [];

// Pending embed callbacks keyed by requestId.
const pendingEmbeds = new Map<string, {
  resolve: (embedding: number[]) => void;
  reject:  (err: Error) => void;
}>();

// [PERF-BATCH] Pending batch-embed callbacks keyed by requestId.
const pendingBatchEmbeds = new Map<string, {  // [PERF-BATCH]
  resolve: (v: number[][]) => void;           // [PERF-BATCH]
  reject:  (e: Error) => void;                // [PERF-BATCH]
}>();                                          // [PERF-BATCH]

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
    const warmupSucceeded = data.modelLoaded !== false;
    modelReady = warmupSucceeded;  // Only true when model actually loaded
    modelFailed = !warmupSucceeded; // [CM-KEEPALIVE-FIX] Only true on explicit failure, NOT during warmup
    console.log(`[CM:offscreen] ml-worker ready — modelLoaded=${warmupSucceeded}, signalling SW`);
    chrome.runtime.sendMessage({ type: "OFFSCREEN_READY", modelLoaded: warmupSucceeded }).catch(() => {});
    if (warmupSucceeded) {
      // Start draining any jobs that were enqueued before the worker booted.
      void drainLoop();
      // [CM-RACE-FIX] drain runtime embeds that arrived while model was loading
      while (pendingRuntimeEmbeds.length > 0) {
        const pending = pendingRuntimeEmbeds.shift()!;
        clearTimeout(pending.timeoutId);
        pendingResponses.set(pending.requestId, pending.sendResponse);
        enqueue({ kind: "embed", text: pending.text, requestId: pending.requestId, priority: true });
      }
      // [T1-FIX][T2-FIX] drain batch embeds that arrived while model was cold — enqueue through priority queue
      while (pendingRuntimeBatchEmbeds.length > 0) {
        const pending = pendingRuntimeBatchEmbeds.shift()!;
        clearTimeout(pending.timeoutId);
        enqueue({ kind: 'batch', texts: pending.texts, requestId: pending.requestId, priority: pending.priority, sendResponse: pending.sendResponse });
      }
    } else {
      // Warmup failed — fail pending embeds immediately instead of sending
      // them to a worker with no working model (which would burn 20-30s per embed).
      for (const pending of pendingRuntimeEmbeds) {
        clearTimeout(pending.timeoutId);
        pending.sendResponse({ ok: false, error: 'model warmup failed — keyword fallback will be used' });
      }
      pendingRuntimeEmbeds.length = 0;
      for (const pending of pendingRuntimeBatchEmbeds) {
        clearTimeout(pending.timeoutId);
        pending.sendResponse({ ok: false, error: 'model warmup failed — keyword fallback will be used' });
      }
      pendingRuntimeBatchEmbeds.length = 0;
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

  // [PERF-BATCH] Handle batch embedding responses — must be BEFORE pendingEmbeds
  // lookup because batch requestIds are never in pendingEmbeds and would hit
  // the `if (!cb) return` guard, silently dropping the response.    // [PERF-BATCH]
  if (data.type === "OFFSCREEN_EMBED_BATCH_DONE") {            // [PERF-BATCH]
    console.log(`[CM:offscreen] received BATCH_DONE for ${data.requestId.slice(0,8)}, pending=${pendingBatchEmbeds.has(data.requestId)}`); // [DEBUG]
    const batchCb = pendingBatchEmbeds.get(data.requestId);    // [PERF-BATCH]
    if (batchCb) {                                             // [PERF-BATCH]
      pendingBatchEmbeds.delete(data.requestId);               // [PERF-BATCH]
      batchCb.resolve(data.embeddings);                        // [PERF-BATCH]
    } else {                                                   // [DEBUG]
      console.warn(`[CM:offscreen] BATCH_DONE but no callback for ${data.requestId.slice(0,8)}`); // [DEBUG]
    }                                                          // [PERF-BATCH]
    return;                                                    // [PERF-BATCH]
  }                                                            // [PERF-BATCH]
  if (data.type === "OFFSCREEN_ERROR" && pendingBatchEmbeds.has(data.requestId)) { // [PERF-BATCH]
    const batchCb = pendingBatchEmbeds.get(data.requestId)!;   // [PERF-BATCH]
    pendingBatchEmbeds.delete(data.requestId);                 // [PERF-BATCH]
    batchCb.reject(new Error((data as { error?: string }).error ?? "batch embed failed")); // [PERF-BATCH]
    return;                                                    // [PERF-BATCH]
  }                                                            // [PERF-BATCH]

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
  const errMsg = `worker error: ${ev.message}`;
  // Unblock any waiting embeds with a zero vector fallback.
  for (const [id, cb] of pendingEmbeds) {
    cb.reject(new Error(errMsg));
    pendingEmbeds.delete(id);
  }
  // Unblock any waiting batch embeds.
  for (const [id, cb] of pendingBatchEmbeds) {
    cb.reject(new Error(errMsg));
    pendingBatchEmbeds.delete(id);
  }
  // Unblock any waiting searches with an error response.
  for (const [id, cb] of pendingSearches) {
    cb({ ok: false, error: errMsg });
    pendingSearches.delete(id);
  }
  // Unblock any pending SW responses (jobs queued but not yet processed).
  for (const [id, cb] of pendingResponses) {
    cb({ ok: false, error: errMsg });
    pendingResponses.delete(id);
  }
  // [CM-RACE-FIX] clear runtime embeds that were waiting for model init
  for (const pending of pendingRuntimeEmbeds) {
    clearTimeout(pending.timeoutId);
    pending.sendResponse({ ok: false, error: errMsg });
  }
  pendingRuntimeEmbeds.length = 0;
  // [T1-FIX] clear batch embeds that were waiting for model init
  for (const pending of pendingRuntimeBatchEmbeds) {
    clearTimeout(pending.timeoutId);
    pending.sendResponse({ ok: false, error: errMsg });
  }
  pendingRuntimeBatchEmbeds.length = 0;
  // [4b-FIX] Drain all job queues — jobs sitting in the queue will never be
  // processed (worker is dead). Fail them immediately instead of letting
  // their sendResponse callbacks hang until the SW's 20-30s timeout fires.
  const drainQueue = (queue: Job[]) => {
    while (queue.length > 0) {
      const job = queue.shift()!;
      if (job.kind === 'batch') {
        (job as BatchEmbedJob).sendResponse({ ok: false, error: errMsg });
      } else {
        const respond = pendingResponses.get(job.requestId);
        pendingResponses.delete(job.requestId);
        respond?.({ ok: false, error: errMsg });
      }
    }
  };
  drainQueue(urgentQueue);
  drainQueue(priorityQueue);
  drainQueue(backgroundQueue);
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

/** Send one text to the worker; returns a Promise that resolves with the embedding. */
function embedViaWorker(text: string): Promise<number[]> {  // unchanged — used by single-query path
  const requestId = Math.random().toString(36).slice(2, 14);
  return new Promise<number[]>((resolve, reject) => {
    pendingEmbeds.set(requestId, { resolve, reject });
    // Native Worker.postMessage — stays strictly inside the Worker boundary,
    // never touches chrome.runtime.
    worker.postMessage({ type: "OFFSCREEN_EMBED_QUERY", requestId, text });
  });
}

// [PERF-BATCH] Send a batch of texts to the worker; resolves with one embedding per text.
function embedBatchViaWorker(texts: string[]): Promise<number[][]> {  // [PERF-BATCH]
  const requestId = Math.random().toString(36).slice(2, 14);          // [PERF-BATCH]
  console.log(`[CM:offscreen] embedBatchViaWorker: sending ${texts.length} texts, req=${requestId.slice(0,8)}`); // [DEBUG]
  return new Promise<number[][]>((resolve, reject) => {               // [PERF-BATCH]
    pendingBatchEmbeds.set(requestId, { resolve, reject });           // [PERF-BATCH]
    worker.postMessage({ type: "OFFSCREEN_EMBED_BATCH", requestId, texts }); // [PERF-BATCH]
  });                                                                  // [PERF-BATCH]
}                                                                      // [PERF-BATCH]

// [PERF-SAMPLE] Samples a representative subset of chunks to embed when the
// session is too large to embed in full within the time budget.          // [PERF-SAMPLE]
// Strategy: 10% from the start (framing/context), 40% from the recent   // [PERF-SAMPLE]
// tail (most relevant for migration), 50% evenly-spaced from the middle. // [PERF-SAMPLE]
function sampleChunksForEmbedding(                                     // [PERF-SAMPLE]
  chunks: Chunk[],                                                     // [PERF-SAMPLE]
  maxChunks: number                                                    // [PERF-SAMPLE]
): { sampled: Chunk[]; indices: number[] } {                          // [PERF-SAMPLE]
  if (chunks.length <= maxChunks) {                                   // [PERF-SAMPLE]
    return { sampled: chunks, indices: chunks.map((_, i) => i) };    // [PERF-SAMPLE]
  }                                                                    // [PERF-SAMPLE]
  const firstCount  = Math.floor(maxChunks * 0.10);                  // [PERF-SAMPLE]
  const recentCount = Math.floor(maxChunks * 0.40);                  // [PERF-SAMPLE]
  const middleCount = maxChunks - firstCount - recentCount;          // [PERF-SAMPLE]
  const firstIdx  = Array.from({ length: firstCount }, (_, i) => i); // [PERF-SAMPLE]
  const recentIdx = Array.from({ length: recentCount },              // [PERF-SAMPLE]
    (_, i) => chunks.length - recentCount + i);                      // [PERF-SAMPLE]
  const middleStart = firstCount;                                     // [PERF-SAMPLE]
  const middleEnd   = chunks.length - recentCount;                   // [PERF-SAMPLE]
  const step = (middleEnd - middleStart) / middleCount;              // [PERF-SAMPLE]
  const middleIdx = Array.from({ length: middleCount },              // [PERF-SAMPLE]
    (_, i) => Math.floor(middleStart + i * step));                   // [PERF-SAMPLE]
  const allIdx = [...new Set([...firstIdx, ...middleIdx, ...recentIdx])] // [PERF-SAMPLE]
    .sort((a, b) => a - b);                                          // [PERF-SAMPLE]
  return {                                                            // [PERF-SAMPLE]
    sampled: allIdx.map(i => chunks[i]),                             // [PERF-SAMPLE]
    indices: allIdx,                                                  // [PERF-SAMPLE]
  };                                                                  // [PERF-SAMPLE]
}                                                                      // [PERF-SAMPLE]

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

// [T2-FIX] Batch embed job — routes OFFSCREEN_EMBED_BATCH through the priority
// queue so it can't race concurrently with index jobs.
interface BatchEmbedJob {
  kind: "batch";
  texts: string[];
  requestId: string;
  priority: boolean;
  sendResponse: (response: unknown) => void;
}

type Job = IndexJob | EmbedJob | BatchEmbedJob;

const priorityQueue:   Job[] = [];
const urgentQueue:    Job[] = [];
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
    // [URGENT-FIX] Single-text query embeds (OFFSCREEN_EMBED_QUERY) go to the
    // urgent queue so they are never blocked by batch embeds (OFFSCREEN_EMBED_BATCH)
    // from scoreMessagesForSummarization or buildAttentionMap. A query embed is
    // ~150ms; a batch embed is ~5s. Without this, retrieve() hits its 8s timeout
    // while waiting behind 5 batch embeds from T2 scoring.
    if (job.kind === 'embed') {
      urgentQueue.push(job);
    } else {
      priorityQueue.push(job);
    }
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
    while (urgentQueue.length > 0 || priorityQueue.length > 0 || backgroundQueue.length > 0) {
      // Urgent (query embeds) → Priority (batch embeds, index) → Background (index)
      const job = urgentQueue.shift() ?? priorityQueue.shift() ?? backgroundQueue.shift()!;
      if (job.kind === "index")      await processIndexJob(job);
      else if (job.kind === "batch") await processBatchEmbedJob(job);
      else                           await processEmbedJob(job);
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

// [T2-FIX][T3-FIX] Process a batch embed job through the queue.
// Checks cancelledRequests so SW can abort zombie attention-engine batches.
async function processBatchEmbedJob(job: BatchEmbedJob): Promise<void> {
  if (cancelledRequests.has(job.requestId)) {
    cancelledRequests.delete(job.requestId);
    job.sendResponse({ ok: false, error: 'cancelled' });
    return;
  }
  try {
    const SUB = 16;
    const all: number[][] = [];
    for (let i = 0; i < job.texts.length; i += SUB) {
      if (cancelledRequests.has(job.requestId)) break;
      // [URGENT-PREEMPT] Drain urgent + priority queue BEFORE every sub-batch,
      // including the first one. Same fix as processIndexJob.
      await yieldToEventLoop();
      while (urgentQueue.length > 0 || priorityQueue.length > 0) {
        const u = urgentQueue.shift() ?? priorityQueue.shift()!;
        if (u.kind === "index")      await processIndexJob(u);
        else if (u.kind === "batch") await processBatchEmbedJob(u);
        else                           await processEmbedJob(u);
        await yieldToEventLoop();
      }
      const sub = job.texts.slice(i, Math.min(i + SUB, job.texts.length));
      const res = await embedBatchViaWorker(sub);
      all.push(...res);
    }
    if (cancelledRequests.has(job.requestId)) {
      cancelledRequests.delete(job.requestId);
      job.sendResponse({ ok: false, error: 'cancelled' });
    } else {
      job.sendResponse({ ok: true, embeddings: all });
    }
  } catch (err) {
    job.sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function processIndexJob(job: IndexJob): Promise<void> {
  const { session, requestId } = job;
  const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

  try {
    progress(requestId, 5, "Starting...");
    progress(requestId, 10, "Chunking messages...");
    // Extract text content from ContextSession.messages for embedding.
    const chunks: Chunk[] = chunkMessages(session.messages);

    // [PERF-SAMPLE-FIX] Raised caps: minimal=200, balanced=500, full=1000.
    // Previous caps (80/150/300) were too low — 911-chunk sessions had 761
    // chunks permanently discarded, degrading T3 retrieval quality.
    const maxChunks = (job.hardware?.tier === 'minimal') ? 200
      : (job.hardware?.tier === 'balanced') ? 500 : 1000;
    // [T6-FIX] Use shared sampleForEmbedding — identical 10/40/50 strategy as attention-engine.
    // Build indices in parallel so chunkIndex in Dexie reflects original position.
    const sampledIndices: number[] = (() => {
      if (chunks.length <= maxChunks) return chunks.map((_, i) => i);
      return sampleForEmbedding(chunks.map((_, i) => i), maxChunks);
    })();
    const sampled = sampledIndices.map(i => chunks[i]);
    const indices = sampledIndices;                               // [T6-FIX] alias for Dexie write below
    if (sampled.length < chunks.length) {                         // [PERF-SAMPLE]
      console.log(`[CM:T3] sampling ${sampled.length}/${chunks.length} chunks (${job.hardware?.tier ?? 'unknown'} tier)`); // [PERF-SAMPLE]
    }                                                             // [PERF-SAMPLE]

    progress(requestId, 20, `Embedding ${sampled.length} chunk(s)...`);
    const embeddings: number[][] = [];

    // [PERF-BATCH-OPT] ONNX processes a whole batch in one forward pass, so
    // larger batches reduce round-trips with negligible inference cost increase.
    // minimal=24, balanced=48, full=48. ~3× fewer batches than before.
    const BATCH_SIZE = (job.hardware?.tier === 'minimal') ? 24
      : 48;

    // [FIX-C-V2] DON'T delete before the loop — that destroys existing chunks
    // before new ones are written, causing 0-chunk state if the job is cancelled
    // mid-batch. Instead, write new chunks incrementally (bulkPut overwrites by
    // ID), then delete stale chunks AFTER all batches complete.
    const newChunkIds = new Set<string>();

    // [FIX-11] Sub-batch yielding: split each BATCH_SIZE batch into sub-batches
    // and drain the priority queue between sub-batches. This prevents a retrieve query
    // embed from being blocked too long. 16 for balanced/full (fewer round-trips),
    // 8 for minimal (less memory pressure).
    const SUB_BATCH_SIZE = (job.hardware?.tier === 'minimal') ? 8 : 16;

    for (let i = 0; i < sampled.length; i += BATCH_SIZE) {
      // [CM-FIX-A] Abort mid-loop instantly if this bg job was cancelled by a priority job.
      if (cancelledRequests.has(requestId)) break;
      // Yield between batches to keep event loop responsive to priority interrupts
      if (i > 0) {
        await yieldToEventLoop();
        // Flush all urgent + priority jobs that arrived while processing the previous batch.
        while (urgentQueue.length > 0 || priorityQueue.length > 0) {
          const urgent = urgentQueue.shift() ?? priorityQueue.shift()!;
          if (urgent.kind === "index")      await processIndexJob(urgent);
          else if (urgent.kind === "batch") await processBatchEmbedJob(urgent);
          else                              await processEmbedJob(urgent);
          await yieldToEventLoop();
        }
      }

      // [FIX-11] Process the batch in sub-batches, draining urgent + priority queue between them.
      const batchEnd = Math.min(i + BATCH_SIZE, sampled.length);
      for (let si = i; si < batchEnd; si += SUB_BATCH_SIZE) {
        if (cancelledRequests.has(requestId)) break;
        // [URGENT-PREEMPT] Drain urgent + priority queue BEFORE every sub-batch,
        // including the first one in each batch. Without this, a query embed
        // arriving just before a new batch starts waits up to 2s for the first
        // sub-batch to complete before being processed.
        await yieldToEventLoop();
        while (urgentQueue.length > 0 || priorityQueue.length > 0) {
          const urgent = urgentQueue.shift() ?? priorityQueue.shift()!;
          if (urgent.kind === "index")      await processIndexJob(urgent);
          else if (urgent.kind === "batch") await processBatchEmbedJob(urgent);
          else                              await processEmbedJob(urgent);
          await yieldToEventLoop();
        }

        const subBatch = sampled.slice(si, Math.min(si + SUB_BATCH_SIZE, batchEnd));
        const subIndices = indices.slice(si, Math.min(si + SUB_BATCH_SIZE, batchEnd));
        const subEmbeddings = await embedBatchViaWorker(subBatch.map(c => c.text));
        embeddings.push(...subEmbeddings);

        // [FIX-C] Persist this sub-batch's chunks immediately.
        const subRecords: ChunkEmbedding[] = subBatch.map((chunk, j) => ({
          id:           `${session.id}:${subIndices[j]}`,
          sessionId:    session.id,
          chunkIndex:   subIndices[j],
          text:         chunk.text,
          embedding:    subEmbeddings[j],
          role:         chunk.role,
          messageIndex: chunk.messageIndex,
          hasCode:      chunk.hasCode,
          language:     chunk.language,
          tokenCount:   chunk.tokenCount,
          createdAt:    Date.now(),
        }));
        await dexieDb.chunkEmbeddings.bulkPut(subRecords);
        subRecords.forEach(r => newChunkIds.add(r.id));
        // [STALL-FIX] Send progress after EACH sub-batch, not just full batches.
        // The StallDetector resets on every OFFSCREEN_PROGRESS. Without this, a
        // full BATCH_SIZE=48 batch can take >60s on slow hardware, triggering a
        // false stall_detected. Sub-batches (16) complete in ~1/3 the time.
        const subEnd = Math.min(si + SUB_BATCH_SIZE, batchEnd);
        const subPct = 20 + Math.round((subEnd / sampled.length) * 60);
        progress(requestId, subPct, `Embedding ${subEnd}/${sampled.length}`);
      }

      const batch = sampled.slice(i, batchEnd);
      const pct = 20 + Math.round((batchEnd / sampled.length) * 60);
      progress(requestId, pct, `Embedding ${Math.min(batchEnd, sampled.length)}/${sampled.length}`);
    }

    // [CM-T3-FIX] cancel stale bg jobs — partial chunks already persisted above
    if (cancelledRequests.has(requestId)) {
      cancelledRequests.delete(requestId);
      console.log(`[CM:offscreen] index job ${requestId} was cancelled — partial chunks already persisted`);
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

    // [FIX-C-V2] Now that all new chunks are persisted, delete stale chunks
    // from previous indexing runs that aren't in the new set.
    const existingChunks = await dexieDb.chunkEmbeddings
      .where('sessionId').equals(session.id).toArray();
    const staleIds = existingChunks
      .filter(c => !newChunkIds.has(c.id))
      .map(c => c.id);
    if (staleIds.length > 0) {
      await dexieDb.chunkEmbeddings.bulkDelete(staleIds);
    }

    await dexieDb.sessionHashes.put({
      sessionId:    session.id,
      hash:         hashMessages(session.messages),
      chunkCount:   sampled.length,
      messageCount: session.messages.length,
      model:        MODEL_ID,
      indexedAt:    Date.now(),
      // [FULL-INDEX-FIX] processIndexJob always embeds the entire session (sampled),
      // so the session is fully indexed. Without these fields the SW's isComplete
      // check fails AND SemanticIndex.needsIndexing()/indexSessionPriority disagree,
      // causing the priority index to silently no-op while the SW waits.
      lastIndexedMessageIndex: 0,
      isComplete:   true,
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

  // [WARMUP-FIX] Health-check reply — ensureOffscreenDocument pings to verify doc is alive.
  if (msg.type === "OFFSCREEN_PING") {
    sendResponse({ alive: true, modelReady, modelFailed });
    return false;
  }

  // [WARMUP-FIX] Keep-alive heartbeat — SW alarm sends this every 20s.
  // Model stays loaded simply by the offscreen doc existing; nothing to do.
  // [CM-KEEPALIVE-FIX] Include modelFailed so SW can distinguish between
  // "still warming up" (modelReady=false, modelFailed=false) and
  // "permanently failed" (modelReady=false, modelFailed=true).
  if (msg.type === "OFFSCREEN_WARMUP") {
    sendResponse({ ok: true, modelReady, modelFailed });
    return false;
  }

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
    if (!modelReady) {
      // [CM-FIX] 60s timeout — first-run WASM compilation of the ONNX model
      // can take 20-40s. Previous 25s was too short, causing "model load timeout".
      const MODEL_LOAD_TIMEOUT_MS = 60_000;
      const to = setTimeout(() => { const i = pendingRuntimeEmbeds.findIndex(p => p.requestId === requestId); if (i !== -1) { const p = pendingRuntimeEmbeds.splice(i,1)[0]; p.sendResponse({ok:false,error:"model load timeout"}); } }, MODEL_LOAD_TIMEOUT_MS);
      pendingRuntimeEmbeds.push({requestId,text,sendResponse,timeoutId:to});
      return true;
    }
    pendingResponses.set(requestId, sendResponse);
    enqueue({ kind: "embed", text, requestId, priority });
    return true;
  }

  if (msg.type === "OFFSCREEN_EMBED_BATCH") {
    const { texts, requestId, priority = false } = msg as { texts: string[]; requestId: string; priority?: boolean };
    if (!modelReady) {
      // [T1-FIX] Queue instead of failing — model may still be warming up (20-40s cold start).
      const MODEL_LOAD_TIMEOUT_MS = 60_000;
      const to = setTimeout(() => {
        const i = pendingRuntimeBatchEmbeds.findIndex(p => p.requestId === requestId);
        if (i !== -1) {
          const p = pendingRuntimeBatchEmbeds.splice(i, 1)[0];
          p.sendResponse({ ok: false, error: 'model load timeout' });
        }
      }, MODEL_LOAD_TIMEOUT_MS);
      pendingRuntimeBatchEmbeds.push({ requestId, texts, sendResponse, timeoutId: to, priority });
      return true;
    }
    // [T2-FIX] Route through priority queue — prevents batch embeds racing with index jobs.
    enqueue({ kind: 'batch', texts, requestId, priority, sendResponse });
    return true;
  }

  // [T3-FIX] Cancel a queued or in-flight batch embed job (zombie cleanup).
  // SW sends this when the 10s attentionMap kill-switch fires so the job doesn't
  // block the next migration's priority queue.
  if (msg.type === "OFFSCREEN_CANCEL_BATCH") {
    const { requestId: cancelId } = msg as { requestId: string };
    cancelledRequests.add(cancelId);
    // Evict from urgent queue if not yet dequeued.
    const ui = urgentQueue.findIndex(j => j.requestId === cancelId);
    if (ui !== -1) {
      const uJob = urgentQueue.splice(ui, 1)[0];
      if (uJob.kind === 'batch') {
        (uJob as BatchEmbedJob).sendResponse({ ok: false, error: 'cancelled' });
      } else {
        const respond = pendingResponses.get(uJob.requestId);
        pendingResponses.delete(uJob.requestId);
        respond?.({ ok: false, error: 'cancelled' });
      }
    }
    // Evict from priority queue if not yet dequeued.
    const pi = priorityQueue.findIndex(j => j.requestId === cancelId);
    if (pi !== -1) {
      const job = priorityQueue.splice(pi, 1)[0];
      // [CANCEL-FIX] IndexJob has no sendResponse — respond via pendingResponses.
      // Blindly casting to BatchEmbedJob and calling .sendResponse() crashes when
      // cancelBackgroundJobs() cancels an IndexJob (bg index requestId).
      if (job.kind === 'batch') {
        (job as BatchEmbedJob).sendResponse({ ok: false, error: 'cancelled' });
      } else {
        const respond = pendingResponses.get(job.requestId);
        pendingResponses.delete(job.requestId);
        respond?.({ ok: false, error: 'cancelled' });
      }
    }
    const bi = backgroundQueue.findIndex(j => j.requestId === cancelId);
    if (bi !== -1) {
      const job = backgroundQueue.splice(bi, 1)[0];
      if (job.kind === 'batch') {
        (job as BatchEmbedJob).sendResponse({ ok: false, error: 'cancelled' });
      } else {
        const respond = pendingResponses.get(job.requestId);
        pendingResponses.delete(job.requestId);
        respond?.({ ok: false, error: 'cancelled' });
      }
    }
    sendResponse({ ok: true });
    return false;
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

  return false;
});
