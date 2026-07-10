/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

export type ModelTier = "tiny" | "full";

export interface ModelConfig {
  modelId: string;
  dimensions: number;
  device: "webgpu" | "wasm";
  threads: number;
  label: string;
}

export const MODEL_CONFIGS: Record<ModelTier, ModelConfig> = {
  tiny: {
    modelId: "Xenova/all-MiniLM-L6-v2",
    dimensions: 384,
    device: "wasm",
    threads: 0,
    label: "gte-tiny (fast)",
  },
  full: {
    modelId: "Xenova/all-MiniLM-L6-v2",
    dimensions: 384,
    device: "webgpu",
    threads: 0,
    label: "MiniLM-L6 (accurate)",
  },
};
