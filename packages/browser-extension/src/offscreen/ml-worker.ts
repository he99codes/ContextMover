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
//   IN:  { type: 'OFFSCREEN_EMBED_QUERY'; requestId: string; text: string }
//   OUT: { type: 'WORKER_READY' }
//        { type: 'OFFSCREEN_EMBED_DONE'; requestId: string; embedding: number[] }
//        { type: 'OFFSCREEN_ERROR';      requestId: string; error: string }

import { pipeline, env } from "@xenova/transformers";

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
self.onmessage = async (event: MessageEvent<{ type: string; requestId: string; text: string }>) => {
  const { requestId, text } = event.data;
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
