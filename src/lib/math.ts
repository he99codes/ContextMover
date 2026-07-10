/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/math.ts
//
// Pure, dependency-free math utilities for the Attention Engine.
// All functions are designed for performance over hundreds of 384-dim vectors:
//   - raw `for` loops — avoids Function.prototype.call overhead of .reduce/.map
//   - no heap allocations inside the hot loop
//   - accepts both number[] and Float32Array so callers are never forced to copy

// ─────────────────────────────────────────────────────────────────────────────
// Cosine Similarity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the cosine similarity between two equal-length vectors.
 *
 * Score range: −1 (opposite) → 0 (orthogonal) → 1 (identical direction).
 * Returns 0 for zero-vectors or mismatched lengths rather than NaN/Infinity.
 *
 * @param a - Query embedding (number[] or Float32Array)
 * @param b - Candidate embedding (number[] or Float32Array)
 */
export function cosineSimilarity(
  a: number[] | Float32Array,
  b: number[] | Float32Array,
): number {
  const len = a.length;
  if (len === 0 || len !== b.length) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < len; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk Retrieval
// ─────────────────────────────────────────────────────────────────────────────

/** A chunk that has been scored against a query embedding. */
export interface ScoredChunk {
  text: string;
  embedding: number[];
  score: number;
}

/**
 * Score every chunk against `queryEmbedding`, sort descending, and return the
 * top `topK` results.
 *
 * The function never mutates the input array — it allocates one
 * intermediate array of { index, score } pairs and sorts that instead,
 * keeping the original `chunks` reference clean for callers that reuse it.
 *
 * @param queryEmbedding - The embedding of the search query (number[] or Float32Array)
 * @param chunks         - Pre-computed chunk objects with text and embedding
 * @param topK           - Maximum number of results to return (default 5)
 */
export function searchContextChunks(
  queryEmbedding: number[] | Float32Array,
  chunks: Array<{ text: string; embedding: number[] }>,
  topK = 5,
): ScoredChunk[] {
  if (chunks.length === 0 || queryEmbedding.length === 0) return [];

  // Phase 1: score every chunk (one similarity call each, no closures in loop).
  const scores = new Float32Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    scores[i] = cosineSimilarity(queryEmbedding, chunks[i].embedding);
  }

  // Phase 2: build a lightweight index array and sort it descending.
  // Sorting indices (integers) is cheaper than sorting the full chunk objects.
  const indices = Array.from({ length: chunks.length }, (_, i) => i);
  indices.sort((a, b) => scores[b] - scores[a]);

  // Phase 3: materialize only the top-K results.
  const k = Math.min(topK, chunks.length);
  const results: ScoredChunk[] = new Array(k);
  for (let i = 0; i < k; i++) {
    const idx = indices[i];
    results[i] = { text: chunks[idx].text, embedding: chunks[idx].embedding, score: scores[idx] };
  }
  return results;
}
