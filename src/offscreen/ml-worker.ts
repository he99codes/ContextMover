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

// Load the model from the copy bundled at dist/models/ (see vite closeBundle),
// NOT from huggingface.co. Remote loading is disabled so init never depends on
// the network — and so a stale/blocked CDN can't leave BOTH sources disabled,
// which hard-fails transformers.js with "both local and remote models are disabled".
env.allowLocalModels  = true;
env.allowRemoteModels = false;
if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
  // Resolves modelId to chrome-extension://<id>/models/Xenova/all-MiniLM-L6-v2/…
  env.localModelPath = chrome.runtime.getURL("models/");
}
env.useFSCache = false; // Cache API doesn't support chrome-extension scheme

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
console.log("[CM:ml-worker] Using CPU (WASM, 1 thread) — no WebGPU in extension Worker context");
getExtractor()
  .then(() => {
    postMessage({ type: "WORKER_READY", modelLoaded: true });
  })
  .catch((err: unknown) => {
    // Still signal ready so the offscreen queue is not blocked forever — but
    // report modelLoaded=false so the offscreen doc fast-fails embed requests
    // to keyword fallback instead of hanging them against a dead model.
    postMessage({ type: "WORKER_READY", modelLoaded: false });
    console.warn("[CM:ml-worker] warmup failed:", err);
  });

// ── Message handler ───────────────────────────────────────────────────────────

type WorkerInMessage =
  | { type: "OFFSCREEN_EMBED_QUERY";       requestId: string; text: string }
  | { type: "OFFSCREEN_BATCH_EMBED_QUERY"; requestId: string; texts: string[] }
  | { type: "OFFSCREEN_SEARCH_QUERY";      requestId: string;
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

  // ── Batch embedding — run multiple texts in one ONNX call ────────────────
  // Transformers.js processes an array of strings in a single forward pass,
  // reusing KV-cache setup and amortising WASM call overhead across chunks.
  // On a modern CPU this is ~4-8× faster than one-by-one inference.
  if (msg.type === "OFFSCREEN_BATCH_EMBED_QUERY") {
    const { requestId, texts } = msg;
    try {
      const extractor = await getExtractor();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const output: any = await extractor(texts, { pooling: "mean", normalize: true });
      // output.data is a flat Float32Array of shape [N × 384].
      const DIM = 384;
      const embeddings: number[][] = [];
      for (let i = 0; i < texts.length; i++) {
        embeddings.push(Array.from(output.data.slice(i * DIM, (i + 1) * DIM) as Float32Array));
      }
      postMessage({ type: "OFFSCREEN_BATCH_EMBED_DONE", requestId, embeddings });
    } catch (err: unknown) {
      postMessage({
        type: "OFFSCREEN_ERROR",
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ── Single embedding — runs ONNX WASM pipeline ───────────────────────────
  const { requestId, text } = msg as { type: "OFFSCREEN_EMBED_QUERY"; requestId: string; text: string };
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
