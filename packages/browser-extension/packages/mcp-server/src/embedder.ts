// packages/mcp-server/src/embedder.ts
//
// Query-side embedder for semantic_search.
// Uses the same model family the extension uses (gte-tiny, 384-dim) so query
// vectors are directly comparable to the chunk vectors synced from the browser.
//
// First call lazily loads the model (~20 MB download to ~/.contextmover/models).
// Subsequent calls reuse the in-memory pipeline.

import os   from "node:os";
import path from "node:path";

import { env, pipeline } from "@xenova/transformers";

// Cache model files under the same home dir the SQLite DB lives in.
const HOME = process.env.CONTEXTMOVER_HOME
          ?? process.env.HOME
          ?? process.env.USERPROFILE
          ?? os.homedir()
          ?? ".";

env.useBrowserCache = false;
env.cacheDir        = path.join(HOME, ".contextmover", "models");
// @xenova/transformers tries to read from local first then falls back to remote.
env.allowRemoteModels = true;

// `pipeline` is loosely typed in @xenova/transformers — keep as unknown internally
// and narrow at call site.
type FeatureExtractor = (
  text: string,
  opts: { pooling: "mean" | "cls" | "none"; normalize: boolean }
) => Promise<{ data: Float32Array | number[] }>;

let model:   FeatureExtractor | null         = null;
let loading: Promise<FeatureExtractor> | null = null;

async function ensureModel(): Promise<FeatureExtractor> {
  if (model) return model;
  if (!loading) {
    loading = (async () => {
      console.error("[CM:embedder] Loading gte-tiny (first-call download may take ~30 s)...");
      // Cast is required because the SDK types `pipeline` very loosely.
      // Must match the extension's tiny-tier model so query & chunk vectors
      // share the same 384-dim space. See:
      //   packages/browser-extension/src/lib/semantic-index/model-registry.ts
      const fn = (await pipeline("feature-extraction", "TaylorAI/gte-tiny", {
        // `dtype` only exists on newer transformers builds; the older typings
        // don't know about it. Pass through with `as any` — runtime accepts it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dtype: "fp32",
      } as any)) as unknown as FeatureExtractor;
      console.error("[CM:embedder] Model ready");
      return fn;
    })();
  }
  model = await loading;
  loading = null;
  return model;
}

/**
 * Embed a single natural-language query into a 384-dim normalized vector.
 * Throws if the model fails to load (caller is expected to fall back to keyword search).
 */
export async function embedQuery(text: string): Promise<number[]> {
  const fn  = await ensureModel();
  const out = await fn(text, { pooling: "mean", normalize: true });
  const arr = out.data instanceof Float32Array ? Array.from(out.data) : Array.from(out.data as number[]);
  return arr;
}
