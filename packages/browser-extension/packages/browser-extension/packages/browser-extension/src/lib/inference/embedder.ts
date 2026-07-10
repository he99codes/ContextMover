/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { pipeline, env } from "@xenova/transformers";

env.allowRemoteModels = true;
env.allowLocalModels = false;

// v2.17.2 WASM config — env.backends.onnx.wasm exists in v2 (confirmed in env.js).
// numThreads=1: SharedArrayBuffer is not available in offscreen/worker extension contexts.
// wasmPaths: point to the extension-local copy in dist/assets/ so ONNX runtime
// doesn't need to fetch from CDN (avoids any network-related init failures).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ((env as any).backends?.onnx?.wasm) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wasmCfg = (env as any).backends.onnx.wasm;
  wasmCfg.numThreads = 1;
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    wasmCfg.wasmPaths = chrome.runtime.getURL("assets/");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadingPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getExtractor(): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = pipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2",
    { quantized: true }
  )
    .then((p) => {
      pipelineInstance = p;
      console.log("[embedder] pipeline ready");
      return p;
    })
    .catch((err) => {
      console.error("[embedder] pipeline failed:", err);
      pipelineInstance = null;
      loadingPromise = null;
      throw err;
    });

  return loadingPromise;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  try {
    const extractor = await getExtractor();
    const BATCH_SIZE = 32;
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out: any = await extractor(batch, { pooling: "mean", normalize: true });
      results.push(...out.tolist());
    }
    return results;
  } catch {
    console.error("[embedder] returning zero vectors");
    return texts.map(() => new Array(384).fill(0));
  }
}

export async function embedText(text: string): Promise<number[]> {
  const results = await embedTexts([text]);
  return results[0] ?? new Array(384).fill(0);
}

export async function warmup(): Promise<void> {
  await getExtractor().catch(() => {});
}
