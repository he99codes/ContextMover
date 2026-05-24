/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/server-intelligence-client.ts
//
// Thin client for the three server-side intelligence APIs.
// Every method has a typed fallback parameter — if the server is
// unreachable / returns an error, the local result is returned instead.
// This ensures the extension ALWAYS works offline or when the API is down.
//
// APIs:
//   POST /api/attention/score   → signal-based message importance
//   POST /api/summarize         → tier-2 intelligent summary
//   POST /api/migrate/build     → final migration XML (core IP)
//
// Timeouts: 4s for score, 8s for summarize, 8s for build.
// On any error or timeout: local fallback, no user-visible failure.

import type { Message } from "./types";
import type { IntelligentSummary } from "./summarizer";
import type { MigrationFile } from "./file-builder";

const API_BASE = "https://www.contextmover.com";

// How long to wait before giving up and using the local fallback.
const TIMEOUT_SCORE_MS = 4_000;
const TIMEOUT_SUMMARIZE_MS = 8_000;
const TIMEOUT_BUILD_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[CM:sic] API timeout after ${ms}ms`)), ms)
    ),
  ]);
}

async function apiFetch<T>(
  path: string,
  body: unknown,
  accessToken: string,
  timeoutMs: number
): Promise<T> {
  const res = await withTimeout(
    fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    }),
    timeoutMs
  );
  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString());
    throw new Error(`[CM:sic] ${path} → ${res.status}: ${text.slice(0, 120)}`);
  }
  return res.json() as Promise<T>;
}

// ── Attention Score ───────────────────────────────────────────────────────────

export interface AttentionScoreResult {
  scores: number[];
  topIndices: number[];
}

/**
 * Fetch per-message importance scores from the server.
 * Falls back to `localFallback` on any error.
 */
export async function fetchAttentionScores(
  messages: Message[],
  goal: string,
  accessToken: string,
  localFallback: AttentionScoreResult
): Promise<AttentionScoreResult> {
  try {
    const result = await apiFetch<AttentionScoreResult>(
      "/api/attention/score",
      { messages, goal },
      accessToken,
      TIMEOUT_SCORE_MS
    );
    if (!Array.isArray(result.scores) || !Array.isArray(result.topIndices)) {
      throw new Error("[CM:sic] Malformed score response");
    }
    return result;
  } catch (err) {
    console.debug("[CM:sic] attention/score fallback:", (err as Error).message);
    return localFallback;
  }
}

// ── Summarize ─────────────────────────────────────────────────────────────────

/**
 * Run tier-2 intelligent summarization server-side.
 * Falls back to `localFallback` on any error.
 */
export async function fetchSummary(
  messages: Message[],
  task: string | undefined,
  accessToken: string,
  localFallback: IntelligentSummary
): Promise<IntelligentSummary> {
  try {
    const result = await apiFetch<IntelligentSummary>(
      "/api/summarize",
      { messages, task },
      accessToken,
      TIMEOUT_SUMMARIZE_MS
    );
    if (!result.goal && !result.decisions) {
      throw new Error("[CM:sic] Malformed summarize response");
    }
    console.debug("[CM:sic] summarize: server OK, compressionRatio=", result.compressionRatio);
    return result;
  } catch (err) {
    console.debug("[CM:sic] summarize fallback:", (err as Error).message);
    return localFallback;
  }
}

// ── Migration Build ───────────────────────────────────────────────────────────

export interface BuildPayload {
  tier: 1 | 2 | 3;
  platform: string;
  sessionTitle: string;
  messages: Message[];
  originalCount?: number;
  summary?: IntelligentSummary;
  chunks?: Message[];
  task?: string;
  attentionMap?: { highlightedFiles?: string[]; compressionRatio?: number };
}

export interface BuildResult {
  filename: string;
  content: string;
  charCount: number;
  estimatedTokens: number;
}

/**
 * Build the final migration XML on the server.
 * Falls back to `localFallback` (a locally built MigrationFile) on any error.
 */
export async function fetchMigrationBuild(
  payload: BuildPayload,
  accessToken: string,
  localFallback: MigrationFile
): Promise<MigrationFile> {
  try {
    const result = await apiFetch<BuildResult>(
      "/api/migrate/build",
      payload,
      accessToken,
      TIMEOUT_BUILD_MS
    );
    if (!result.content || !result.filename) {
      throw new Error("[CM:sic] Malformed build response");
    }
    console.debug(`[CM:sic] migrate/build: server OK, tier=${payload.tier}, chars=${result.charCount}`);
    return {
      filename: result.filename,
      content: result.content,
      format: "xml",
      tier: payload.tier,
      charCount: result.charCount,
      estimatedTokens: result.estimatedTokens,
      sessionTitle: payload.sessionTitle,
      platform: payload.platform,
    };
  } catch (err) {
    console.debug("[CM:sic] migrate/build fallback:", (err as Error).message);
    return localFallback;
  }
}
