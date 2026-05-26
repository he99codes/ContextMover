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
//        { type: 'OFFSCREEN_SEARCH_QUERY'; requestId: string;
//                queryEmbedding: number[]; chunks: OffscreenSearchChunk[]; topK: number }
//   OUT: { type: 'WORKER_READY' }
//        { type: 'OFFSCREEN_EMBED_DONE';  requestId: string; embedding: number[] }
//        { type: 'OFFSCREEN_SEARCH_DONE'; requestId: string; results: OffscreenSearchResult[] }
//        { type: 'OFFSCREEN_ERROR';       requestId: string; error: string }

import { pipeline, env } from "@xenova/transformers";
import { cosineSimilarity } from "../lib/math";
import type { OffscreenSearchChunk, OffscreenSearchResult } from "../lib/types";

// ── WASM / runtime configuration ─────────────────────────────────────────────
// Mirror the exact settings from embedder.ts so ONNX uses the local SIMD file.
// numThreads=1: SharedArrayBuffer is unavailable in extension Worker contexts.
// wasmPaths:    points to dist/assets/ via the extension origin so no CDN fetch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wasmCfg = (env as any).backends?.onnx?.wasm;
if (wasmCfg) {
  wasmCfg.numThreads = 1;
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    wasmCfg.wasmPaths = chrome.runtime.getURL("assets/");
  }
}

env.allowRemoteModels = true;
env.allowLocalModels  = false;

// ── Pipeline singleton ────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadingPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getExtractor(): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise)   return loadingPromise;

  loadingPromise = pipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2",
    { quantized: true }
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
getExtractor()
  .then(() => {
    postMessage({ type: "WORKER_READY" });
  })
  .catch((err: unknown) => {
    // Still signal ready so the offscreen queue is not blocked forever.
    postMessage({ type: "WORKER_READY" });
    console.warn("[CM:ml-worker] warmup failed:", err);
  });

// ── Message handler ───────────────────────────────────────────────────────────

type WorkerInMessage =
  | { type: "OFFSCREEN_EMBED_QUERY";  requestId: string; text: string }
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

  // ── Embedding — runs ONNX WASM pipeline ──────────────────────────────────
  const { requestId, text } = msg;
  try {
    const extractor = await getExtractor();
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
