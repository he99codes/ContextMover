/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/semantic-index/model-registry.ts
//
// Single global embedding-model registry. Hardware-aware tier selection.
// Never loads the same model twice across an entire context (sidebar /
// offscreen / SW). Caller is expected to hold this module lifetime.

import type { HardwareProfile } from "../attention-engine";
import { MODEL_CONFIGS, type ModelTier, type ModelConfig } from "./model-constants";
import { getTransformers } from "./transformers-loader";

export type { ModelTier, ModelConfig };
export { MODEL_CONFIGS };

class ModelRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private loadedModel: any = null;
  private loadedTier: ModelTier | null = null;
  private loadingPromise: Promise<void> | null = null;
  private config: ModelConfig | null = null;

  selectModelTier(hardware: HardwareProfile): ModelTier {
    if (hardware.tier === "minimal") return "tiny";
    if (hardware.hasWebGPU && hardware.cores >= 8) return "full";
    return "tiny";
  }

  async initialize(
    hardware: HardwareProfile,
    onProgress?: (pct: number) => void
  ): Promise<void> {
    if (this.loadedModel && this.loadedTier) return;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = this._doInit(hardware, onProgress);
    try {
      await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  private async _doInit(
    hardware: HardwareProfile,
    onProgress?: (pct: number) => void
  ): Promise<void> {
    // When running as a Chrome extension, load the bundled model files
    // directly from the extension package — zero network request needed.
    const isExtension =
      typeof chrome !== "undefined" &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typeof (chrome as any).runtime?.getURL === "function";

    // Load @xenova/transformers via the statically-bundled pre-built bundle.
    // transformers-loader.ts imports @xenova/transformers/dist/transformers.min.js
    // so Rollup bundles it into the offscreen chunk instead of leaving a bare
    // specifier that Chrome cannot resolve at runtime.
    const { pipeline, env } = getTransformers();
    if (isExtension) {
      env.localModelPath = chrome.runtime.getURL("models/");
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.useBrowserCache = false; // files are already local
    } else {
      env.useBrowserCache = true;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
    }

    const tier = this.selectModelTier(hardware);
    const config = MODEL_CONFIGS[tier];
    const threads = Math.min(4, Math.max(1, hardware.cores));

    // env.backends.onnx may be undefined in some build/runtime combos
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (env as any).backends.onnx.wasm.numThreads = threads;
      // ONNX runtime fetches its WASM from a CDN by default; in the extension
      // sandbox CSP blocks that. Point it at the local copy emitted by the
      // copy-onnx-wasm Vite plugin into dist/wasm/.
      if (isExtension) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (env as any).backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("wasm/");
        // Disable proxy worker — blob: workers are blocked in the extension sandbox.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (env as any).backends.onnx.wasm.proxy = false;
      }
    } catch { /* ignore — onnx backend may not be initialised yet */ }

    console.log(
      `[ContextMover:model] Loading ${config.label} device=${config.device} threads=${threads}`
    );

    onProgress?.(10);

    const device = hardware.hasWebGPU ? "webgpu" : "wasm";

    const MAX_ATTEMPTS = 3;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.debug(
          `[CM:attention] Loading model attempt ${attempt}/${MAX_ATTEMPTS}: ${config.modelId}`
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.loadedModel = await pipeline(
          "feature-extraction",
          config.modelId,
          {
            device,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            progress_callback: (progress: any) => {
              if (progress?.status === "downloading") {
                const p = typeof progress.progress === "number" ? progress.progress : 0;
                onProgress?.(10 + p * 0.8);
              }
            },
          } as Record<string, unknown>
        );
        this.loadedTier = tier;
        this.config = { ...config, threads };
        onProgress?.(100);
        console.log(`[CM:attention] Model loaded successfully: ${config.label}`);
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(
          `[CM:attention] Model load attempt ${attempt} failed:`, lastError.message
        );
        const isNetwork =
          lastError.message.includes("Failed to fetch") ||
          lastError.message.includes("NetworkError") ||
          lastError.message.includes("net::ERR");
        if (isNetwork && attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
        break;
      }
    }
    throw lastError ?? new Error("Model failed to load");
  }

  async embed(text: string): Promise<number[]> {
    if (!this.loadedModel) throw new Error("Model not initialized");
    const output = await this.loadedModel(text, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data as Float32Array);
  }

  /**
   * True array batching — passes up to BATCH_SIZE texts to the pipeline in
   * one call so ONNX processes them in a single forward pass.  ~8-12× faster
   * than calling embed() individually per text.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.loadedModel) throw new Error("Model not initialized");
    const BATCH_SIZE = 32;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      // Pass the entire batch as an array — pipeline returns [N, dim] tensor
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const output: any = await this.loadedModel(batch, {
        pooling: "mean",
        normalize: true,
      });
      // .tolist() → number[][] when input was string[]
      const embeddings: number[][] = Array.isArray(output.tolist) ? output.tolist() : output.tolist?.() ?? [];
      results.push(...embeddings);

      // Yield every 64 texts so search queries don't starve
      if (i + BATCH_SIZE < texts.length && (i + BATCH_SIZE) % 64 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return results;
  }

  getConfig(): ModelConfig | null { return this.config; }
  isLoaded(): boolean { return this.loadedModel !== null; }
  getTier(): ModelTier | null { return this.loadedTier; }

  reset(): void {
    this.loadedModel = null;
    this.loadedTier = null;
    this.loadingPromise = null;
    this.config = null;
  }
}

export const modelRegistry = new ModelRegistry();
