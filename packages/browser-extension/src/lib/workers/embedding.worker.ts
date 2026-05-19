/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

/// <reference lib="webworker" />
// packages/browser-extension/src/lib/workers/embedding.worker.ts
//
// Web Worker — all @xenova/transformers ONNX inference runs here so the
// React sidebar never blocks during embedding generation.
//
// Protocol (main → worker):
//   { type: 'INIT',         id, payload: { device?: 'webgpu'|'wasm' } }
//   { type: 'EMBED_BATCH',  id, payload: { texts: string[] } }
//   { type: 'EMBED_SINGLE', id, payload: { text: string } }
//
// Protocol (worker → main):
//   { type: 'INIT_DONE',        id }
//   { type: 'EMBED_DONE',       id, embeddings: number[][] }
//   { type: 'EMBED_SINGLE_DONE',id, embedding: number[] }
//   { type: 'PROGRESS',         id, progress: number }
//   { type: 'ERROR',            id, error: string }

// Import the pre-built ESM bundle directly. The package's `main` source
// entry transitively imports `onnxruntime-web` which isn't reachable under
// pnpm's hoisted layout; the dist bundle has it inlined.
// @ts-expect-error — no .d.ts ships alongside the dist bundle
import { pipeline, env } from "@xenova/transformers/dist/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache  = true;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let model: any = null;

async function loadModel(device: "webgpu" | "wasm" = "wasm"): Promise<void> {
  if (model) return;
  model = await pipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2",
    { device, dtype: "fp32" } as Record<string, unknown>
  );
}

self.onmessage = async ({ data }: MessageEvent) => {
  const { type, payload, id } = data as {
    type: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: any;
    id: string;
  };

  try {
    if (type === "INIT") {
      await loadModel(payload?.device ?? "wasm");
      self.postMessage({ id, type: "INIT_DONE" });
      return;
    }

    if (type === "EMBED_BATCH") {
      if (!model) await loadModel("wasm");
      const texts: string[] = payload.texts;
      const results: number[][] = [];

      for (let i = 0; i < texts.length; i += 8) {
        const batch = texts.slice(i, i + 8);
        const outputs = await Promise.all(
          batch.map((text: string) =>
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            model(text, { pooling: "mean", normalize: true })
          )
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        results.push(...outputs.map((o: any) => Array.from(o.data) as number[]));

        self.postMessage({
          id,
          type: "PROGRESS",
          progress: Math.round(((i + batch.length) / texts.length) * 100),
        });
      }

      self.postMessage({ id, type: "EMBED_DONE", embeddings: results });
      return;
    }

    if (type === "EMBED_SINGLE") {
      if (!model) await loadModel("wasm");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const output = await model(payload.text, { pooling: "mean", normalize: true });
      self.postMessage({
        id,
        type: "EMBED_SINGLE_DONE",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        embedding: Array.from((output as any).data) as number[],
      });
      return;
    }
  } catch (err: unknown) {
    self.postMessage({
      id,
      type: "ERROR",
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
