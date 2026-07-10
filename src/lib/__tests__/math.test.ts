/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { describe, it, expect } from "vitest";
import { cosineSimilarity, searchContextChunks } from "../math";

// ─────────────────────────────────────────────────────────────────────────────
// cosineSimilarity
// ─────────────────────────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for zero-vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("works with Float32Array inputs", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 4);
  });

  it("computes correct similarity for known vectors", () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    // dot = 32, magA = sqrt(14), magB = sqrt(77)
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// searchContextChunks
// ─────────────────────────────────────────────────────────────────────────────

describe("searchContextChunks", () => {
  const chunks = [
    { text: "chunk about dogs", embedding: [1, 0, 0] },
    { text: "chunk about cats", embedding: [0, 1, 0] },
    { text: "chunk about birds", embedding: [0, 0, 1] },
    { text: "chunk about pets", embedding: [0.7, 0.7, 0] },
  ];

  it("returns empty array for empty chunks", () => {
    expect(searchContextChunks([1, 0, 0], [])).toEqual([]);
  });

  it("returns empty array for empty query embedding", () => {
    expect(searchContextChunks([], chunks)).toEqual([]);
  });

  it("returns top-K results sorted by score descending", () => {
    const results = searchContextChunks([1, 0, 0], chunks, 2);
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe("chunk about dogs");
    expect(results[0].score).toBeCloseTo(1, 5);
    expect(results[1].score).toBeLessThan(results[0].score);
  });

  it("respects the default topK=5", () => {
    const results = searchContextChunks([1, 0, 0], chunks);
    expect(results).toHaveLength(4); // only 4 chunks available
  });

  it("returns correct scores for each result", () => {
    const results = searchContextChunks([0, 1, 0], chunks, 4);
    expect(results[0].text).toBe("chunk about cats");
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  it("each result includes text, embedding, and score", () => {
    const results = searchContextChunks([1, 0, 0], chunks, 1);
    expect(results[0]).toHaveProperty("text");
    expect(results[0]).toHaveProperty("embedding");
    expect(results[0]).toHaveProperty("score");
  });
});
