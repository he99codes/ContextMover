/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/semantic-index/transformers-loader.ts
//
// Single canonical entry point for loading @xenova/transformers.
//
// Why a shim instead of `import("@xenova/transformers")` directly?
//   The package's `main` field points at `./src/transformers.js`, which
//   transitively imports `onnxruntime-web`. Under pnpm's hoisted node_modules
//   layout `onnxruntime-web` isn't reachable from packages/browser-extension,
//   so Rollup silently bails on bundling and leaves the bare specifier in
//   the output — Chrome's offscreen document then fails with
//   "Failed to resolve module specifier '@xenova/transformers'".
//
//   `@xenova/transformers/dist/transformers.min.js` is a self-contained
//   webpack ESM bundle with onnxruntime-web inlined, so Rollup can bundle
//   it without chasing external deps.

import * as transformers from "@xenova/transformers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TransformersModule = { pipeline: any; env: any } & Record<string, unknown>;

export function getTransformers(): TransformersModule {
  return transformers as unknown as TransformersModule;
}
