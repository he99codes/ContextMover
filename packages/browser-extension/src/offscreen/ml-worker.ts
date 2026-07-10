/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/offscreen/ml-worker.ts
//
// Dedicated Web Worker — the ONLY file that imports @xenova/transformers.
// Runs the ONNX WASM embedding pipeline on its own thread so the offscreen
// document's event loop stays free to manage the priority queue.
//
// Message protocol (Worker ↔ Offscreen Document):
//   IN:  { type: 'OFFSCREEN_EMBED_QUERY';  requestId: string; text: string }
//        { type: 'OFFSCREEN_EMBED_BATCH';  requestId: string; texts: string[] }           // [PERF-BATCH]
//        { type: 'OFFSCREEN_SEARCH_QUERY'; requestId: string;
//                queryEmbedding: number[]; chunks: OffscreenSearchChunk[]; topK: number }
//   OUT: { type: 'WORKER_READY' }
//        { type: 'OFFSCREEN_EMBED_DONE';       requestId: string; embedding: number[] }
//        { type: 'OFFSCREEN_EMBED_BATCH_DONE'; requestId: string; embeddings: number[][] } // [PERF-BATCH]
//        { type: 'OFFSCREEN_SEARCH_DONE'; requestId: string; results: OffscreenSearchResult[] }
//        { type: 'OFFSCREEN_ERROR';       requestId: string; error: string }

import { pipeline, env } from "@xenova/transformers";
import { cosineSimilarity } from "../lib/math";
import type { OffscreenSearchChunk, OffscreenSearchResult } from "../lib/types";

// ── WASM / runtime configuration ─────────────────────────────────────────────
// Mirror the exact settings from embedder.ts so ONNX uses the local SIMD file.
// numThreads=1: SharedArrayBuffer is unavailable in extension Worker contexts.
// wasmPaths:    points to dist/assets/ via the extension origin so no CDN fetch.
// [PERF-C3] WASM SIMD support probe. The ONNX runtime auto-selects the SIMD
// binary (ort-wasm-simd.wasm). On some CPUs the SIMD instructions raise an
// illegal-instruction fault (SIGILL) that crashes the whole tab — uncatchable
// from JS. We validate a tiny SIMD module first; if the CPU/runtime can't run
// it, force ONNX onto the scalar (non-SIMD) binary which is universally safe.
function wasmSimdSupported(): boolean {
  try {
    // Minimal valid WASM module containing a v128 (SIMD) instruction.
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3,
      2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wasmCfg = (env as any).backends?.onnx?.wasm;
if (wasmCfg) {
  wasmCfg.numThreads = 1;
  // [PERF-C3] Disable SIMD when the probe fails — avoids SIGILL on unsupported CPUs.
  if (!wasmSimdSupported()) {
    wasmCfg.simd = false;
    console.warn("[CM:ml-worker] WASM SIMD unsupported — falling back to scalar ONNX backend");
  }
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    wasmCfg.wasmPaths = chrome.runtime.getURL("assets/");
  }
}

// [PERF-C4] Load the MiniLM model from the bundled copy in public/models/
// (copied to dist/models/ at build time) instead of fetching ~25MB from the
// HuggingFace CDN on every fresh profile. Eliminates the 20-40s cold-start
// network dependency and works fully offline.
env.allowLocalModels  = true;
env.allowRemoteModels = false;
if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
  env.localModelPath = chrome.runtime.getURL("models/");
}

// ── Pipeline singleton ────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadingPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getExtractor(): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise)   return loadingPromise;

  // [ISSUE-11] Disable browser cache for model fetch — Cache API can serve stale/corrupt WASM
  // Setting useBrowserCache=false forces a fresh fetch each time instead of relying on
  // the Cache API which can serve stale entries after an extension update.
  // NOTE: do NOT touch allowLocalModels here — it must stay true (set above) so the
  // bundled dist/models/ copy loads. A prior version force-set it to false right
  // before use, which combined with allowRemoteModels=false left BOTH sources
  // disabled, hard-failing transformers.js with "both local and remote models
  // are disabled" on every single load attempt.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envCfg = (env as any);
  try {
    if (envCfg) {
      envCfg.useBrowserCache = false;
    }
  } catch {}

  loadingPromise = pipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2",
    { quantized: true, device: "wasm" } as Parameters<typeof pipeline>[2]
  ).then((p) => {
    pipelineInstance = p;
    loadingPromise   = null;
    return p;
  }).catch((err) => {
    loadingPromise   = null;
    pipelineInstance = null;
    throw err;
  });

  return loadingPromise;
}

// ── Boot warmup ───────────────────────────────────────────────────────────────
// Load the model immediately so it is hot before the first real request.
// [CM-WARMUP-TIMEOUT] If ONNX WASM hangs during compilation (rare but happens
// on some CPUs), we must still signal WORKER_READY so the offscreen queue
// doesn't stall forever. Keyword fallback will handle embeds until retry.
const WARMUP_TIMEOUT_MS = 30000;
Promise.race([
  getExtractor(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('warmup timeout')), WARMUP_TIMEOUT_MS))
])
  .then(() => {
    postMessage({ type: "WORKER_READY", modelLoaded: true });
    console.log("[CM:ml-worker] model warmed up and ready");
  })
  .catch((err: unknown) => {
    // Still signal ready so the offscreen queue is not blocked forever.
    // modelLoaded: false tells the offscreen doc to fail embeds fast
    // instead of sending them to a worker with no working model.
    postMessage({ type: "WORKER_READY", modelLoaded: false });
    console.warn("[CM:ml-worker] warmup failed (will use keyword fallback):", err);
  });

// ── Message handler ───────────────────────────────────────────────────────────

type WorkerInMessage =
  | { type: "OFFSCREEN_EMBED_QUERY";  requestId: string; text: string }
  | { type: "OFFSCREEN_EMBED_BATCH";  requestId: string; texts: string[] }              // [PERF-BATCH]
  | { type: "OFFSCREEN_SEARCH_QUERY"; requestId: string;
      queryEmbedding: number[]; chunks: OffscreenSearchChunk[]; topK: number };

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  // ── Semantic search — pure math, no model needed ──────────────────────────
  if (msg.type === "OFFSCREEN_SEARCH_QUERY") {
    const { requestId, queryEmbedding, chunks, topK } = msg;
    const len = chunks.length;

    // Score every chunk with cosine similarity using raw for-loops.
    const scores = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      scores[i] = cosineSimilarity(queryEmbedding, chunks[i].embedding);
    }

    // Sort a lightweight index array — avoids moving full chunk objects.
    const indices = Array.from({ length: len }, (_, i) => i);
    indices.sort((a, b) => scores[b] - scores[a]);

    // Materialise top-K results (id + score only — text stays in caller).
    const k = Math.min(topK, len);
    const results: OffscreenSearchResult[] = new Array(k);
    for (let i = 0; i < k; i++) {
      const idx = indices[i];
      results[i] = { id: chunks[idx].id, score: scores[idx] };
    }
    postMessage({ type: "OFFSCREEN_SEARCH_DONE", requestId, results });
    return;
  }

  // ── Batch embedding — single ONNX forward pass over an array of texts ────── // [PERF-BATCH]
  // Passing an array to the extractor costs ~1.5× not N×, giving 4-6× throughput // [PERF-BATCH]
  // on typical batch sizes of 8. The single-query path below is untouched.       // [PERF-BATCH]
  if (msg.type === "OFFSCREEN_EMBED_BATCH") {                                     // [PERF-BATCH]
    const { requestId: batchId, texts } = msg;                                    // [PERF-BATCH]
    console.log(`[CM:ml-worker] BATCH START: ${texts.length} texts, req=${batchId.slice(0,8)}...`); // [DEBUG]
    try {                                                                          // [PERF-BATCH]
      // [CM-BATCH-TIMEOUT] Prevent indefinite hangs when ONNX stalls
      const BATCH_TIMEOUT = 30000; // 30s max for batch (8-16 chunks)
      const extractor = await Promise.race([                                         // [PERF-BATCH]
        getExtractor(),                                                             // [PERF-BATCH]
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('batch extractor timeout')), BATCH_TIMEOUT)) // [PERF-BATCH]
      ]);                                                                           // [PERF-BATCH]
      console.log(`[CM:ml-worker] extractor acquired, running inference...`);      // [DEBUG]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const output: any = await extractor(texts, { pooling: "mean", normalize: true }); // [PERF-BATCH]
      console.log(`[CM:ml-worker] inference complete, dims:`, output?.dims);       // [DEBUG]
      // output for batch input is a single Tensor2D [batchSize × 384] with a flat   // [PERF-BATCH]
      // data array. Slice into individual embeddings of length 384.             // [PERF-BATCH]
      const data = output.data as Float32Array;                                   // [PERF-BATCH]
      const dim = 384; // all-MiniLM-L6-v2 embedding dimension                     // [PERF-BATCH]
      const embeddings: number[][] = [];                                          // [PERF-BATCH]
      for (let i = 0; i < texts.length; i++) {                                   // [PERF-BATCH]
        embeddings.push(Array.from(data.slice(i * dim, (i + 1) * dim)));          // [PERF-BATCH]
      }                                                                           // [PERF-BATCH]
      postMessage({ type: "OFFSCREEN_EMBED_BATCH_DONE", requestId: batchId, embeddings }); // [PERF-BATCH]
      console.log(`[CM:ml-worker] BATCH DONE: sent ${embeddings.length} embeddings`); // [DEBUG]
    } catch (err: unknown) {                                                       // [PERF-BATCH]
      postMessage({                                                                // [PERF-BATCH]
        type: "OFFSCREEN_ERROR",                                                  // [PERF-BATCH]
        requestId: batchId,                                                       // [PERF-BATCH]
        error: err instanceof Error ? err.message : String(err),                  // [PERF-BATCH]
      });                                                                          // [PERF-BATCH]
    }                                                                              // [PERF-BATCH]
    return;                                                                        // [PERF-BATCH]
  }                                                                                // [PERF-BATCH]

  // ── Single-string embedding — runs ONNX WASM pipeline ───────────
  const { requestId, text } = msg as { type: "OFFSCREEN_EMBED_QUERY"; requestId: string; text: string };
  try {
    // [CM-EMBED-TIMEOUT] Prevent indefinite hangs when ONNX stalls
    const EXTRACT_TIMEOUT = 20000; // 20s max for single embed
    const extractor = await Promise.race([
      getExtractor(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('extractor timeout')), EXTRACT_TIMEOUT))
    ]);
    // Single-string inference. output is a Tensor2D [1 × 384].
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output: any = await extractor(text, { pooling: "mean", normalize: true });
    // Extract raw Float32Array and convert to transferable number[].
    const embedding: number[] = Array.from(output.data as Float32Array);
    postMessage({ type: "OFFSCREEN_EMBED_DONE", requestId, embedding });
  } catch (err: unknown) {
    postMessage({
      type: "OFFSCREEN_ERROR",
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
