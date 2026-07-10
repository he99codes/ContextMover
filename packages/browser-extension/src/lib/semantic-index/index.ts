/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/semantic-index/index.ts
//
// Core retrieval-first engine. Embed once, persist forever, retrieve fast.
//
// Architecture:
//   • Indexing happens in the offscreen document (heavy work off SW thread)
//   • Retrieval (cosine sim) happens wherever the caller is — pure JS, fast
//   • IndexedDB writes happen wherever IDB is reliable (SW or offscreen)
//   • Service worker can call this class directly, but heavy ops will be
//     forwarded to the offscreen document via chrome.runtime messages

import {
  dexieDb,
  type ChunkEmbedding,
  type StoredSummary,
} from "../db";
import type { ContextSession } from "../types";
import { SUMMARIZER_VERSION } from "../summarizer";
import { MODEL_CONFIGS, type ModelTier } from "./model-constants";
import { hashMessages, hashQuery } from "./hasher";
import { getHardwareProfile, type HardwareProfile } from "../attention-engine";
import { recordPerf } from "../perf-track";
import { latencyTracker, StallDetector } from "../adaptive-timeout";

// ──────────────────────────────────────────────────────────────────────────
// Cosine similarity helper
// ──────────────────────────────────────────────────────────────────────────
/**
 * BM25-inspired keyword retrieval — used when ML embedding is unavailable
 * (e.g. when the offscreen document is unreachable in SW context).
 * Mirrors the cosine-path boosts so scores are comparable.
 *
 * [CM-P0-FIX] Limit to MAX_KEYWORD_CHUNKS (200) most recent chunks to prevent
 * 90s hangs on large sessions (500+ chunks). Keyword fallback should be fast
 * (<5s), not exhaustive. If user needs full semantic search, they should wait
 * for ONNX to warm up and retry.
 */
const MAX_KEYWORD_CHUNKS = 200; // [CM-P0-FIX] Prevent scanning 911 chunks
const KEYWORD_TIMEOUT_MS = 5000; // [CM-P0-FIX] 5s max for keyword fallback

function keywordRetrieve(
  allChunks: ChunkEmbedding[],
  query: string,
  topK: number
): ChunkEmbedding[] {
  const t0 = performance.now();

  // [CM-P0-FIX] Limit chunks to prevent 90s scans on large sessions
  // Sort by recency (newest first) and take most recent MAX_KEYWORD_CHUNKS
  const chunksToScan = allChunks.length > MAX_KEYWORD_CHUNKS
    ? [...allChunks].sort((a, b) => b.messageIndex - a.messageIndex).slice(0, MAX_KEYWORD_CHUNKS)
    : allChunks;

  const tokens = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const maxMsgIdx = Math.max(...chunksToScan.map((c) => c.messageIndex), 0);

  const scored: { chunk: ChunkEmbedding; score: number }[] = [];

  // [CM-P0-FIX] Use for-loop with timeout check instead of .map() for early bailout
  for (let i = 0; i < chunksToScan.length; i++) {
    // Check timeout every 50 chunks
    if (i % 50 === 0 && performance.now() - t0 > KEYWORD_TIMEOUT_MS) {
      console.warn(`[CM:index] Keyword search timeout after ${i} chunks — returning partial results`);
      break;
    }

    const chunk = chunksToScan[i];
    const text = chunk.text.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      let pos = 0;
      while ((pos = text.indexOf(tok, pos)) !== -1) { score++; pos += tok.length; }
    }
    const recency = maxMsgIdx > 0 ? 0.15 * (chunk.messageIndex / maxMsgIdx) : 0;
    if (chunk.hasCode) score += 0.5;
    scored.push({ chunk, score: score + recency });
  }

  scored.sort((a, b) => b.score - a.score);

  // Always keep a recent tail (mirror TAIL_SIZE in attention-engine)
  const RECENT_WINDOW = maxMsgIdx < 60 ? 6 : maxMsgIdx < 200 ? 10 : 15;
  const recentCutoff = Math.max(0, maxMsgIdx - RECENT_WINDOW + 1);
  const recent = allChunks.filter((c) => c.messageIndex >= recentCutoff);
  const topScored = scored
    .filter((s) => s.chunk.messageIndex < recentCutoff)
    .slice(0, Math.max(0, topK - recent.length))
    .map((s) => s.chunk);

  const seen = new Set<string>();
  return [...recent, ...topScored]
    .filter((c) => { if (seen.has(c.id)) return false; seen.add(c.id); return true; })
    .sort((a, b) => a.messageIndex - b.messageIndex)
    .slice(0, topK);
}

// [ADAPTIVE] getTierMul replaced by latencyTracker — timeouts now learned from observed performance, not hardware guess

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ──────────────────────────────────────────────────────────────────────────
// Offscreen-document orchestration (callable from any extension context)
// ──────────────────────────────────────────────────────────────────────────

const OFFSCREEN_DOC_URL = "src/offscreen/offscreen.html";

let _offscreenReady = false;
let _offscreenReadyPromise: Promise<void> | null = null;
let _offscreenReadyResolve: (() => void) | null = null;
let _offscreenCreating = false; // [FIX-6] Guard against concurrent recreation
// [FIX-13] Cooldown to prevent close+recreate storms. A crashed offscreen doc
// triggers a cold ONNX reload (20-40s). If the ping retry loop falsely declares
// the doc dead (e.g. during a long batch), rapid recreate cycles waste 60-90s.
// We track the last destroy timestamp and skip recreation if within 30s.
let _lastOffscreenDestroyTs = 0;
const OFFSCREEN_RECREATE_COOLDOWN_MS = 30_000;
let _pendingEmbedCount = 0;
// [FIX-9] Track consecutive "model not ready" occurrences to add backoff
// before recreating the offscreen document. Prevents thrashing.
let _modelNotReadyCount = 0;
// [FIX-14] Circuit breaker: if the model fails to load MAX_MODEL_RETRY_ATTEMPTS
// times in a row, stop closing+recreating the document on every single call —
// a broken model config (or unsupported browser) makes every recreate a
// guaranteed-failure 20-40s ONNX reload, and without this cap the SW's
// periodic keepalive alarm + every index/embed call would retrigger a fresh
// recreate forever, starving real work (this was observed as an unbounded
// "model not ready after N attempts" loop climbing past 30-40 attempts).
// Once tripped, we accept the existing doc as-is (embeds fast-fail to keyword
// fallback via modelReady checks in offscreen.ts) and only try again after a
// cooldown, in case the failure was transient (e.g. a slow first paint).
const MAX_MODEL_RETRY_ATTEMPTS = 4;
const MODEL_RETRY_COOLDOWN_MS = 5 * 60_000;
let _modelPermanentlyFailedUntil = 0;
const EMBED_QUEUE_CAP = 50;
// [CANCEL-FIX] Track the in-flight background index requestId so we can evict
// its offscreen batches when migration starts — unblocks the ONNX worker fast.
let _bgIndexRequestId: string | null = null;
let _priorityIndexRequestId: string | null = null;

export async function ensureOffscreenDocument(): Promise<void> {
  // chrome.offscreen is only available in MV3 SW + extension pages.
  // Sidebar context can also call createDocument; if it errors with
  // "already exists", we silently swallow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offscreen = (chrome as any).offscreen;
  if (!offscreen) return; // not supported here — caller will fall back

  // [FIX-6] If another caller is already creating/recreating the document,
  // wait for it instead of triggering a second close/recreate cycle.
  if (_offscreenCreating) {
    if (_offscreenReadyPromise) await _offscreenReadyPromise;
    return;
  }

  try {
    // hasDocument is only on Chrome 116+
    const has = await offscreen.hasDocument?.();
    // [FIX-14] Breaker tripped and doc already exists — skip the 3×8s ping
    // round-trip entirely. We already know the model won't come up this
    // cooldown window; callers proceed straight to keyword fallback.
    if (has && _modelPermanentlyFailedUntil > Date.now()) {
      _offscreenReady = true;
      _offscreenReadyPromise = null;
      return;
    }
    if (has) {
      // Verify the doc is alive — it may have crashed without Chrome updating hasDocument.
      // [PING-FIX] The offscreen JS thread is single-threaded; while it processes a
      // 32-chunk ONNX batch (5-10s) it cannot answer the ping. A short 1.5s timeout
      // therefore falsely declared a busy-but-healthy doc "unresponsive" and
      // destroyed it mid-inference (20-40s cold reload + lost work). We now use a
      // generous 8s timeout and retry up to 3 times before giving up — only a truly
      // crashed doc fails all 3 pings.
      const pingOnce = (timeoutMs: number) => new Promise<{ alive: boolean; modelReady: boolean }>((resolve) => {
        const t = setTimeout(() => resolve({ alive: false, modelReady: false }), timeoutMs);
        chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" }, (resp) => {
          clearTimeout(t);
          const alive = !chrome.runtime.lastError && resp?.alive === true;
          resolve({ alive, modelReady: alive && resp?.modelReady === true });
        });
      });
      let alive = false;
      let modelReady = false;
      for (let attempt = 0; attempt < 3 && !alive; attempt++) {
        const result = await pingOnce(8_000);
        alive = result.alive;
        modelReady = result.modelReady;
      }
      if (alive) {
        // Doc is alive. Only mark ready if the model is also loaded —
        // otherwise the doc exists but embeds will fail.
        if (modelReady) {
          _offscreenReady = true;
          _offscreenReadyPromise = null;
          _modelNotReadyCount = 0; // [FIX-9] Reset — model is ready
          return;
        }
        // [FIX-14] Circuit breaker: if we've already given up on the model this
        // cooldown window, don't even attempt the wait/recreate dance — just
        // accept the doc as-is so callers proceed immediately to keyword
        // fallback instead of eating another 8-40s of pings + reload.
        if (_modelPermanentlyFailedUntil > Date.now()) {
          _offscreenReady = true;
          _offscreenReadyPromise = null;
          return;
        }
        // [FIX-9] Doc is alive but model not ready. Add wait/retry with backoff
        // before recreating — the model may just be loading (20-40s).
        // First 2 occurrences: wait and re-check. Third+: proceed with recreate.
        _modelNotReadyCount++;
        // [FIX-14] Past the retry cap — stop recreating forever. Trip the
        // breaker, accept the current doc, and let embeds fast-fail to
        // keyword fallback until the cooldown expires.
        if (_modelNotReadyCount > MAX_MODEL_RETRY_ATTEMPTS) {
          console.warn(`[CM:offscreen] model failed to load after ${_modelNotReadyCount} attempts — giving up for ${MODEL_RETRY_COOLDOWN_MS / 60_000}min, using keyword fallback`);
          _modelPermanentlyFailedUntil = Date.now() + MODEL_RETRY_COOLDOWN_MS;
          _modelNotReadyCount = 0;
          _offscreenReady = true;
          _offscreenReadyPromise = null;
          return;
        }
        if (_modelNotReadyCount <= 2) {
          const waitMs = _modelNotReadyCount === 1 ? 3000 : 5000;
          console.warn(`[CM:offscreen] doc alive but model not ready (attempt ${_modelNotReadyCount}) — waiting ${waitMs}ms before re-check`);
          await new Promise(r => setTimeout(r, waitMs));
          // Re-ping to check if model became ready
          const recheck = await pingOnce(8_000);
          if (recheck.modelReady) {
            console.log("[CM:offscreen] model became ready after wait — no recreation needed");
            _modelNotReadyCount = 0;
            _offscreenReady = true;
            _offscreenReadyPromise = null;
            return;
          }
          console.warn(`[CM:offscreen] model still not ready after ${waitMs}ms wait — proceeding to recreate`);
        } else {
          console.warn(`[CM:offscreen] model not ready after ${_modelNotReadyCount} attempts — recreating document`);
        }
        _lastOffscreenDestroyTs = Date.now();
        _offscreenCreating = true;
        await offscreen.closeDocument?.().catch(() => {});
        // Fall through to createDocument path — do NOT return.
      } else {
        // [FIX-13] Cooldown: if we destroyed the doc less than 30s ago, don't
        // close+recreate again — the ONNX model is still reloading and a second
        // destroy would waste another 20-40s. Instead, wait for the existing
        // recreation to finish (if _offscreenCreating) or proceed with the
        // current doc (it may have recovered).
        const sinceDestroy = Date.now() - _lastOffscreenDestroyTs;
        if (sinceDestroy < OFFSCREEN_RECREATE_COOLDOWN_MS) {
          console.warn(`[CM:offscreen] document unresponsive but recreate cooldown active (${Math.round(sinceDestroy / 1000)}s ago) — keeping current doc`);
          _offscreenReady = true; // Assume it will recover — let callers try
          _offscreenReadyPromise = null;
          return;
        }
        console.warn("[CM:offscreen] document unresponsive — closing and recreating");
        _lastOffscreenDestroyTs = Date.now(); // [FIX-13] Record destroy time
        _offscreenCreating = true; // [FIX-6]
        await offscreen.closeDocument?.().catch(() => {});
      }
    }
  } catch { /* fall through to createDocument */ }

  // Creating (or recreating) the document — reset the readiness gate.
  _offscreenReady = false;
  _offscreenCreating = true; // [FIX-6] Set for fresh creation path too
  if (!_offscreenReadyPromise) {
    _offscreenReadyPromise = new Promise<void>((resolve) => {
      _offscreenReadyResolve = resolve;
    });
    const readyListener = (msg: { type?: string }) => {
      if (msg?.type === "OFFSCREEN_READY") {
        _offscreenReady = true;
        _offscreenReadyResolve?.();
        _offscreenReadyResolve = null;
        _offscreenReadyPromise = null;
        chrome.runtime.onMessage.removeListener(readyListener);
      }
    };
    chrome.runtime.onMessage.addListener(readyListener);
  }

  try {
    await offscreen.createDocument({
      url: OFFSCREEN_DOC_URL,
      reasons: ["WORKERS"],
      justification: "Run embedding model in a worker for retrieval-first migration",
    });
    console.log("[CM:offscreen] document created");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Only a single offscreen") && !msg.includes("already")) {
      console.error("[CM:offscreen] document creation failed:", msg);
      throw err;
    }
    console.log("[CM:offscreen] document already exists");
  }
  _offscreenCreating = false; // [FIX-6] Allow future recreation if needed
}

interface OffscreenIndexResponse { ok: boolean; chunkCount?: number; error?: string }
interface OffscreenEmbedResponse { ok: boolean; embedding?: number[]; error?: string }

async function offscreenIndex(
  session: ContextSession,
  hardware: HardwareProfile,
  onProgress?: (pct: number, stage: string) => void,
  abortSignal?: AbortSignal
): Promise<number> {
  await ensureOffscreenDocument();
  const requestId = `idx_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  // [CANCEL-FIX] Track requestId for background jobs so cancelBackgroundJobs() can evict them.
  // abortSignal is defined for background jobs (priority='background'), undefined for priority jobs.
  if (abortSignal) _bgIndexRequestId = requestId;
  else _priorityIndexRequestId = requestId;
  let _indexCompleted = false; // [FIX-B] Track completion to cancel zombie batches

  // Listen for progress
  const progressListener = (msg: { type?: string; requestId?: string; progress?: number; stage?: string }) => {
    if (msg?.type === "OFFSCREEN_PROGRESS" && msg.requestId === requestId) {
      onProgress?.(msg.progress ?? 0, msg.stage ?? "");
    }
  };
  chrome.runtime.onMessage.addListener(progressListener);

  try {
    // [CM-MIGRATION-PRIORITY] Timeout depends on job type:
    // - Priority (migration): timeout must EXCEED the outer INDEX_TIMEOUT_MS so the
    //   offscreen message never times out before the SW's migration timeout does.
    //   60s base + 250ms/msg, max 200s. For 337 msgs → 144s (outer is 117s).
    // - Background: loose timeout (60s + 2s/msg, max 300s)
    // [FIX-4] abortSignal is set for BACKGROUND jobs (not priority), so isPriority = !abortSignal
    const isPriority = !abortSignal;
    // [ADAPTIVE] StallDetector replaces fixed timeout — resets on every OFFSCREEN_PROGRESS,
    // so a job that's actively making progress never gets killed regardless of machine speed.
    // [FIX-2] Background: 120s stall / 300s max (was 90s/180s — too tight for 120+ msg sessions
    // on balanced hardware where 32-chunk ONNX batches take 8-12s each). The stall resets on
    // every progress event, so 120s only fires if the worker is truly stuck (no batch completed
    // for 2 minutes). Priority: 60s stall (migration jobs should be responsive).
    const stall = new StallDetector(isPriority ? 60_000 : 120_000, isPriority ? 120_000 : 300_000);
    const stallPromise = stall.start();
    // Wire progress listener to reset stall timer
    const stallResetListener = (msg: { type?: string; requestId?: string }) => {
      if (msg?.type === "OFFSCREEN_PROGRESS" && msg.requestId === requestId) stall.reset();
    };
    chrome.runtime.onMessage.addListener(stallResetListener);
    // [CM-MIGRATION-PRIORITY] If an abort signal is provided, race it too
    const abortPromise = abortSignal
      ? new Promise<OffscreenIndexResponse>((_, reject) => {
          if (abortSignal.aborted) { reject(new Error('cancelled_for_migration')); return; }
          abortSignal.addEventListener('abort', () => reject(new Error('cancelled_for_migration')), { once: true });
        })
      : null;
    const racers: Promise<OffscreenIndexResponse>[] = [
      chrome.runtime.sendMessage<unknown, OffscreenIndexResponse>({
        type: "OFFSCREEN_INDEX_SESSION",
        session,
        hardware,
        requestId,
        priority: isPriority,
      }),
      stallPromise.then(() => { throw new Error('offscreen index stall (no progress within stall window)'); }) as Promise<OffscreenIndexResponse>,
    ];
    if (abortPromise) racers.push(abortPromise);
    const t0 = performance.now();
    const res = await Promise.race(racers);
    stall.stop();
    chrome.runtime.onMessage.removeListener(stallResetListener);
    _indexCompleted = true;
    if (!res?.ok) throw new Error(res?.error ?? "Offscreen indexing failed");
    // [ADAPTIVE] Record normalized latency (ms per message) for future timeout decisions
    latencyTracker.record("background_index", performance.now() - t0, session.messages.length);
    return res.chunkCount ?? 0;
  } finally {
    // [FIX-B] Cancel zombie offscreen batches on timeout/abort. Without this, the
    // offscreen worker keeps processing stale batches, blocking the next job.
    if (!_indexCompleted) {
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_CANCEL_BATCH', requestId }).catch(() => {});
    }
    chrome.runtime.onMessage.removeListener(progressListener);
    if (_bgIndexRequestId === requestId) _bgIndexRequestId = null;
    if (_priorityIndexRequestId === requestId) _priorityIndexRequestId = null;
  }
}

async function offscreenEmbedQuery(
  text: string,
  hardware: HardwareProfile
): Promise<number[]> {
  const t0 = performance.now();
  await ensureOffscreenDocument();
  if (_pendingEmbedCount >= EMBED_QUEUE_CAP) {
    console.warn(`[CM:offscreen] queue cap hit — dropping ${_pendingEmbedCount - EMBED_QUEUE_CAP + 1} stale queries`);
    throw new Error(`Offscreen embed queue cap (${EMBED_QUEUE_CAP}) exceeded`);
  }
  _pendingEmbedCount++;
  try {
    if (!_offscreenReady && _offscreenReadyPromise) {
      await _offscreenReadyPromise;
    }
    const requestId = `q_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    // [T7-FIX] Dynamic timeout: base 90s + 2s per queued index job, capped at 150s.
    // Worst case: 500-msg bg job (~48s batches) + cold WASM start (~30s) = 78s.
    // With a 32-job queue: 90 + 64 = 154 → capped at 150s. Keeps it sane.
    const queueDepth = _priorityQueue.length + _backgroundQueue.length;
    const adaptiveMs = await latencyTracker.getTimeoutMs("embedding_query", 1);
    const dynamicTimeoutMs = Math.min(adaptiveMs + queueDepth * 1_000, 90_000);
    const res = await Promise.race([
      chrome.runtime.sendMessage<unknown, OffscreenEmbedResponse>({
        type: "OFFSCREEN_EMBED_QUERY",
        text,
        hardware,
        requestId,
        // [RETRIEVE-FIX] priority:true jumps ahead of any in-flight background index
        // batches in the offscreen queue. Without this, retrieve() waits up to 10s
        // per background batch and hits the 90s timeout.
        priority: true,
      }),
      new Promise<OffscreenEmbedResponse>((_, reject) =>
        setTimeout(() => reject(new Error(`offscreen embed timeout (${dynamicTimeoutMs / 1000}s)`)), dynamicTimeoutMs)
      ),
    ]);
    if (!res?.ok || !res.embedding) throw new Error(res?.error ?? "Offscreen embed failed");
    const dt = performance.now() - t0;
    void recordPerf('embedding_query', dt, { metadata: { textLength: text.length } });
    latencyTracker.record("embedding_query", dt, 1);
    return res.embedding;
  } finally {
    _pendingEmbedCount--;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Indexing queue — at most ONE concurrent indexing job at a time, regardless
// of caller. On low-end hardware (minimal tier, 4 cores, no WebGPU) running
// 3 sessions concurrently saturated the offscreen doc and froze the UI for
// minutes. Serializing the queue keeps WASM embeddings on (quality matters
// for the attention engine) while letting the browser breathe.
// ──────────────────────────────────────────────────────────────────────
type IndexJob = {
  session: ContextSession;
  onProgress?: (pct: number, stage: string) => void;
  priority: "priority" | "background";
  resolve: () => void;
  reject: (err: unknown) => void;
  enqueuedAt: number; // [ISSUE-13] for recency-based sorting
};
const _priorityQueue:   IndexJob[] = [];
const _backgroundQueue: IndexJob[] = [];
// [FIX-3] Cap at 50 — 30 was too low for Drive restore with 50+ sessions,
// causing permanent drops. 50 handles most Drive restores without overflow.
// Overflow sessions stay in pendingIndex for drainPendingIndex to pick up.
// [BUG-8 FIX] Raised from 30 to 50 to prevent post-wipe indexing gaps.
const _BACKGROUND_QUEUE_CAP = 50;
let _indexQueueRunning = false;
// [ISSUE-12] Pause flag — migration pauses background jobs instead of cancelling them
let _bgPaused = false;
// [CM-MIGRATION-PRIORITY] Abort signal for in-flight background jobs.
// When migration starts, we signal this to instantly abort any running bg job
// so the queue can drain to priority jobs without waiting for bg timeout.
let _migrationAbort: AbortController | null = null;
// [CM-FIX-B] Session-level in-flight lock — prevents two concurrent index jobs
// for the same session (e.g. backgroundIndex + attentionEngine.indexSession
// both firing simultaneously, doubling ml-worker ONNX load).
const _indexingSessionLock = new Set<string>();

function broadcastIndexStatus(status: {
  active: boolean;
  queued: number;
  sessionId?: string;
  progress?: number;
  stage?: string;
}): void {
  // Fire-and-forget broadcast to sidebar / popup. No-op if no listeners.
  try {
    chrome.runtime.sendMessage({ type: "INDEXING_STATUS", ...status }).catch(() => {});
  } catch { /* runtime may be torn down during reload */ }
}

let _offscreenCloseTimer: ReturnType<typeof setTimeout> | null = null;

async function maybeCloseOffscreen(): Promise<void> {
  // Keep the offscreen document (and its loaded embedding model) alive for
  // 5 min after the last job drains. 30s was too short — a user who migrates,
  // browses for 1 minute, then migrates again would hit a full 45s ONNX reload.
  // 5 min covers a natural work session without holding memory indefinitely.
  if (_offscreenCloseTimer) clearTimeout(_offscreenCloseTimer);
  _offscreenCloseTimer = setTimeout(async () => {
    _offscreenCloseTimer = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const offscreen = (chrome as any).offscreen;
    if (!offscreen?.closeDocument) return;
    try { await offscreen.closeDocument(); } catch { /* already closed */ }
  }, 15 * 60_000); // 15 minutes — keep model hot; 5min was too short (caused 5.8s cold reload on search)
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory retrieval cache (30 s TTL, keyed by sessionId + query prefix)
// ──────────────────────────────────────────────────────────────────────
type RetrieveResult = { chunks: ChunkEmbedding[]; usedKeywordFallback: boolean };
const _retrieveCache = new Map<string, RetrieveResult & { ts: number }>();
const _RETRIEVE_CACHE_TTL_MS = 30_000;
const _RETRIEVE_CACHE_MAX = 200;

// In-memory query embedding cache (5 min TTL, keyed by normalised query text)
// Avoids re-embedding the same query string across repeated searches within a
// single SW lifetime (e.g. user types in search box, updates session, retries).
const _queryEmbedCache = new Map<string, { embedding: number[]; ts: number }>();
const _QUERY_EMBED_CACHE_TTL_MS = 5 * 60_000;
const _QUERY_EMBED_CACHE_MAX = 50;

/**
 * Prune expired and oldest entries from the retrieval cache.
 * Exported for unit testing — call on every cache write to prevent unbounded growth.
 */
export function pruneRetrieveCache<T extends { ts: number }>(
  cache: Map<string, T>,
  now: number,
  ttlMs: number,
  maxSize: number
): void {
  // 1. Drop expired entries
  for (const [key, entry] of cache) {
    if (now - entry.ts >= ttlMs) cache.delete(key);
  }
  // 2. Enforce size cap — evict oldest first
  if (cache.size > maxSize) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < sorted.length - maxSize; i++) {
      cache.delete(sorted[i][0]);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// SemanticIndex
// ──────────────────────────────────────────────────────────────────────────

export class SemanticIndex {
  // ─── INDEXING ─────────────────────────────────────────────────────────

  async needsIndexing(session: ContextSession): Promise<boolean> {
    const stored = await dexieDb.sessionHashes.get(session.id);
    if (!stored) return true;

    // [DRIVE-RESTORE-FIX] Check isComplete + chunks BEFORE hash comparison.
    // Synthetic hashes from Drive restore have hash='' which would always
    // mismatch at the hash check below, triggering needless re-indexing.
    if (stored.isComplete === true) {
      const chunkCount = await dexieDb.chunkEmbeddings
        .where('sessionId').equals(session.id)
        .count();
      if (chunkCount > 0) return false;
      // isComplete=true but 0 chunks → phantom hash, needs re-index
      console.warn(`[CM:index] phantom hash for ${session.id} — isComplete=true but 0 chunks`);
      await dexieDb.sessionHashes.delete(session.id);
      return true;
    }

    // [PARTIAL-INDEX-FIX] backgroundIndex writes the FULL-session hash even when
    // it has only embedded a tail sub-chunk (isComplete=false). Without this
    // guard, needsIndexing() sees the matching hash and returns false, so a
    // migration's indexSessionPriority() silently no-ops on a session that is
    // only partially indexed — the SW then waits forever for chunks that never
    // arrive. Treat any non-complete checkpoint as still needing indexing.
    if (stored.isComplete === false) return true;

    const currentHash = hashMessages(session.messages);
    if (stored.hash !== currentHash) return true;

    // Hardware profile may have changed (e.g. new GPU available)
    try {
      const hw = await getHardwareProfile();
      const expectedTier: ModelTier =
        hw.tier === "minimal" ? "tiny"
        : (hw.hasWebGPU && hw.cores >= 8) ? "full"
        : "tiny";
      if (stored.model !== MODEL_CONFIGS[expectedTier].modelId) return true;
    } catch { /* hw detection failure → keep existing index */ }

    // [CM-T3-FIX] FINAL guard — chunk validation (must be last, after all other checks)
    // A session can have a valid hash + matching hardware but 0 actual chunks
    // (interrupted index, offscreen doc crashed during embed loop)
    const chunkCount = await dexieDb.chunkEmbeddings
      .where('sessionId').equals(session.id)
      .count();
    if (chunkCount === 0) {
      console.warn(
        `[CM:index] phantom hash (current) for ${session.id} ` +
        `— hash matches but 0 chunks, clearing and re-indexing`
      );
      await dexieDb.sessionHashes.delete(session.id);
      // [CM-PERSIST-FIX] Also add to persistentQueue for startup recovery
      await dexieDb.pendingIndex.put({
        sessionId: session.id,
        createdAt: Date.now(),
        priority: 'background' as const,
        retryCount: 0,
      }).catch(() => {})
      return true;
    }

    // [CM-PERSIST-FIX] partial embed guard — catches interrupted index loops
    // e.g. 6 of 12 chunks written before offscreen doc was destroyed
    if (stored.chunkCount != null && stored.chunkCount > 0) {
      const expectedCount = stored.chunkCount
      // Allow 20% tolerance for chunker variability between versions
      if (chunkCount < expectedCount * 0.8) {
        console.warn(
          `[CM:index] partial embed for ${session.id} — ` +
          `${chunkCount}/${expectedCount} chunks found (<80%), clearing for re-index` 
        )
        await dexieDb.sessionHashes.delete(session.id)
        // Write to persistent queue so recovery fires on next startup
        await dexieDb.pendingIndex.put({
          sessionId: session.id,
          createdAt: Date.now(),
          priority: 'background' as const,
          retryCount: 0,
        }).catch(() => {})
        return true
      }
    }

    return false;
  }

  /**
   * Indexes a session via the offscreen document. Serialized — at most ONE
   * indexing job runs at a time across the entire extension. Subsequent
   * callers wait their turn. On minimal-tier hardware (no WebGPU, ≤ 4
   * cores) we insert a 2 s breathing delay between jobs so the UI thread
   * doesn't starve when the user just captured 3 conversations in a row.
   *
   * If offscreen is unavailable (e.g. we're already in offscreen), falls
   * back to direct in-process indexing — but still serializes.
   */
  async indexSession(
    session: ContextSession,
    onProgress?: (pct: number, stage: string) => void
  ): Promise<void> {
    if (!(await this.needsIndexing(session))) {
      console.log(`[CM:index] Skip (unchanged): ${session.id}`);
      return;
    }
    // [CM-FIX-B] Skip duplicate concurrent index jobs for same session.
    if (_indexingSessionLock.has(session.id)) {
      console.log(`[CM:index] Skip (in-flight lock): ${session.id}`);
      return;
    }
    _indexingSessionLock.add(session.id);

    return new Promise<void>((resolve, reject) => {
      // Cap background queue — drop newest on overflow instead of rescheduling.
      // The old code retried after 30s, which looped forever if the queue stayed
      // full (e.g. during Drive restore with 100+ sessions). The session will be
      // re-queued naturally on next capture or sidebar backfill.
      if (_backgroundQueue.length >= _BACKGROUND_QUEUE_CAP) {
        console.warn(`[CM:queue] At capacity (${_backgroundQueue.length}/${_BACKGROUND_QUEUE_CAP}) — dropping ${session.id} (will re-queue on next capture)`);
        // [BG-OVERFLOW-FIX] Write to pendingIndex so the idle re-index scan
        // picks this up. Without this, backgroundIndex's finally block deletes
        // the pendingIndex entry and the session is permanently lost.
        dexieDb.pendingIndex.put({
          sessionId: session.id,
          createdAt: Date.now(),
          priority: 'background' as const,
          retryCount: 0,
        }).catch(() => {});
        _indexingSessionLock.delete(session.id);
        resolve();
        return;
      }
      // [CM-FIX-B] Wrap resolve/reject so lock is always released when job finishes.
      const unlock = () => _indexingSessionLock.delete(session.id);
      const wrappedResolve = () => { unlock(); resolve(); };
      const wrappedReject  = (e: unknown) => { unlock(); reject(e); };
      _backgroundQueue.push({ session, onProgress, priority: "background", resolve: wrappedResolve, reject: wrappedReject, enqueuedAt: Date.now() });
      broadcastIndexStatus({
        active: _indexQueueRunning,
        queued: _priorityQueue.length + _backgroundQueue.length,
        sessionId: session.id,
        stage: _indexQueueRunning ? "Queued" : "Starting",
      });
      void this._drainIndexQueue();
    });
  }

  /**
   * [BUG-8 FIX] Drain pendingIndex entries that were dropped due to queue
   * overflow. Called after each backgroundIndex completes and on startup.
   * Processes entries in batches, stopping when the queue is full again.
   */
  async drainPendingIndex(): Promise<void> {
    try {
      const pending = await dexieDb.pendingIndex.toArray();
      if (pending.length === 0) return;
      console.log(`[CM:index] draining ${pending.length} pending index entries`);

      for (const entry of pending) {
        if (_backgroundQueue.length >= _BACKGROUND_QUEUE_CAP) break;
        const session = await dexieDb.sessions.get(entry.sessionId);
        if (!session || session.messages.length === 0) {
          await dexieDb.pendingIndex.delete(entry.sessionId).catch(() => {});
          continue;
        }
        const hash = await dexieDb.sessionHashes.get(session.id);
        if (hash?.isComplete) {
          const chunks = await dexieDb.chunkEmbeddings.where('sessionId').equals(session.id).count();
          if (chunks > 0) {
            await dexieDb.pendingIndex.delete(entry.sessionId).catch(() => {});
            continue;
          }
        }
        await dexieDb.pendingIndex.delete(entry.sessionId).catch(() => {});
        void this.indexSession(session).catch(() => {});
      }
    } catch (e) {
      console.warn('[CM:index] drainPendingIndex failed', e);
    }
  }

  /**
   * Priority-lane enqueue — user-triggered migrations go here.
   * Runs before any background jobs currently in the queue.
   */
  async indexSessionPriority(
    session: ContextSession,
    onProgress?: (pct: number, stage: string) => void
  ): Promise<void> {
    if (!(await this.needsIndexing(session))) {
      console.log(`[CM:index] Skip (unchanged): ${session.id}`);
      return;
    }
    // [CM-FIX-B] Priority overrides: force-clear any bg lock immediately, never wait.
    // cancelBackgroundJobs() already aborted the in-flight bg job — lock will be
    // released by wrappedReject asynchronously, but we cannot block on that here.
    _indexingSessionLock.delete(session.id);
    _indexingSessionLock.add(session.id);

    return new Promise<void>((resolve, reject) => {
      const unlock = () => _indexingSessionLock.delete(session.id); // [CM-FIX-B]
      const wrappedResolve = () => { unlock(); resolve(); };
      const wrappedReject  = (e: unknown) => { unlock(); reject(e); };
      _priorityQueue.push({ session, onProgress, priority: "priority", resolve: wrappedResolve, reject: wrappedReject, enqueuedAt: Date.now() });
      broadcastIndexStatus({
        active: _indexQueueRunning,
        queued: _priorityQueue.length + _backgroundQueue.length,
        sessionId: session.id,
        stage: "Priority — starting soon",
      });
      void this._drainIndexQueue();
    });
  }

  private async _drainIndexQueue(): Promise<void> {
    if (_indexQueueRunning) return;
    _indexQueueRunning = true;

    try {
      while (_priorityQueue.length > 0 || (_backgroundQueue.length > 0 && !_bgPaused)) {
        // Always drain priority lane first
        // [CM-QUEUE-SORT] Sort background queue by session size (largest first).
        // Large sessions with rich context are indexed before small ones so that
        // by the time a user migrates a big conversation, the index is ready.
        // Previously sorted by recency; that still matters for tiny new captures
        // but largest-first is the user-specified invariant.
        let job: IndexJob;
        if (_priorityQueue.length > 0) {
          job = _priorityQueue.shift()!;
        } else {
          // Sort by message count descending (largest session first).
          // Tie-break by recency (most recently enqueued) so new captures aren't starved.
          _backgroundQueue.sort((a, b) => {
            const sizeDiff = b.session.messages.length - a.session.messages.length;
            if (sizeDiff !== 0) return sizeDiff;
            return b.enqueuedAt - a.enqueuedAt; // recency tie-break
          });
          job = _backgroundQueue.shift()!;
        }
        console.log(`[CM:queue] dequeue ${job.priority} ${job.session.id}`,
          { priority: _priorityQueue.length, background: _backgroundQueue.length });
        // [CM-MIGRATION-PRIORITY] Set up abort controller for background jobs
        // so cancelBackgroundJobs() can abort in-flight work instantly.
        if (job.priority === 'background') {
          // [FIX-C] Abort any stale controller before replacing it.
          if (_migrationAbort) _migrationAbort.abort();
          _migrationAbort = new AbortController();
        } else {
          _migrationAbort = null;
        }
        try {
          // [CM-MIGRATION-PRIORITY] If this bg job was already aborted, skip it
          if (job.priority === 'background' && _migrationAbort?.signal.aborted) {
            // [CM-PAUSE-REQUEUE] Re-add to queue front instead of rejecting so it
            // resumes when resumeBackgroundJobs() is called after migration completes.
            _backgroundQueue.unshift(job);
            continue;
          }
          broadcastIndexStatus({
            active: true,
            // [CM-QUEUE-FIX] Only include background jobs in queued count when actually
            // running a background job. When a priority migration is active, paused
            // background jobs are NOT waiting — they're suspended until migration completes.
            // Showing their count was causing the misleading "N sessions in queue — migration
            // will start after indexing" warning even though the migration was already running.
            queued: job.priority === 'priority'
              ? _priorityQueue.length
              : _priorityQueue.length + _backgroundQueue.length,
            sessionId: job.session.id,
            progress: 0,
            stage: job.priority === "priority" ? "Indexing (priority)..." : "Indexing in background...",
          });
          await this._runIndexJob(job);
          job.resolve();
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // [CM-PAUSE-REQUEUE] If a background job was aborted/cancelled for migration,
          // re-add it to the queue front so it resumes after migration instead of being lost.
          if (job.priority === 'background' && errMsg.includes('cancelled_for_migration')) {
            console.log(`[CM:queue] bg job ${job.session.id} paused for migration — re-queuing for resume`);
            _backgroundQueue.unshift(job); // Put back at front so it runs first on resume
            // Don't call job.reject() — the promise stays pending until resume
          } else {
            job.reject(err);
          }
        }


        // [ISSUE-22] Reduced yield (50ms) + microtask yield to prevent capture starvation
        if (_priorityQueue.length > 0 || _backgroundQueue.length > 0) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    } finally {
      _indexQueueRunning = false;
      broadcastIndexStatus({ active: false, queued: 0 });
      // [ISSUE-12] If background jobs are paused, don't close offscreen — we'll resume
      if (!_bgPaused) void maybeCloseOffscreen();
    }
  }

  private async _runIndexJob(job: IndexJob): Promise<void> {
    const { session, onProgress } = job;
    const hw = await getHardwareProfile();

    const wrappedProgress = (pct: number, stage: string) => {
      onProgress?.(pct, stage);
      broadcastIndexStatus({
        active: true,
        // [CM-QUEUE-FIX] Same priority-aware queued count fix as in _drainIndexQueue.
        queued: job.priority === 'priority'
          ? _priorityQueue.length
          : _priorityQueue.length + _backgroundQueue.length,
        sessionId: session.id,
        progress: pct,
        stage,
      });
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasOffscreen = !!(chrome as any).offscreen;
    if (hasOffscreen) {
      const t0 = performance.now();
      wrappedProgress(5, "Spawning indexing worker...");
      // [CM-MIGRATION-PRIORITY] Pass abort signal for bg jobs so migration can cancel them
      const abortSignal = job.priority === 'background' ? _migrationAbort?.signal : undefined;
      const chunkCount = await offscreenIndex(session, hw, wrappedProgress, abortSignal);
      console.log(
        `[CM:index] ${session.id}: ${chunkCount} chunks indexed in ${(performance.now() - t0).toFixed(0)}ms`
      );
      wrappedProgress(100, "Indexed");
      return;
    }

    // Direct fallback (e.g. when running inside the offscreen doc itself)
    await this._indexInProcess(session, hw, wrappedProgress);
  }

  private async _indexInProcess(
    session: ContextSession,
    hw: HardwareProfile,
    onProgress?: (pct: number, stage: string) => void
  ): Promise<void> {
    console.warn(`[CM:index] Indexing skipped: offscreen unavailable for ${session.id}`);
  }

  // ─── QUEUE UTILS ────────────────────────────────────────────────────────

  // [FULL-SPEED-FIX] Expose queue length so the SW can backpressure background
  // pre-computation when the offscreen is already saturated.
  getQueueLength(): number {
    return _priorityQueue.length + _backgroundQueue.length;
  }

  // ─── RETRIEVAL ────────────────────────────────────────────────────────

  async retrieve(
    sessionId: string,
    query: string | null,
    topK: number = 15
  ): Promise<RetrieveResult> {
    const t0 = performance.now();

    // ── In-memory cache check (30 s TTL) ──
    const cacheKey = `${sessionId}::${query?.slice(0, 50) ?? ''}`;
    const _cached = _retrieveCache.get(cacheKey);
    if (_cached && Date.now() - _cached.ts < 30_000) {
      return { chunks: _cached.chunks, usedKeywordFallback: _cached.usedKeywordFallback };
    }

    const allChunks = await dexieDb.chunkEmbeddings.where("sessionId").equals(sessionId).toArray();
    if (allChunks.length === 0) {
      console.warn(`[CM:index] No chunks for ${sessionId}`);
      return { chunks: [], usedKeywordFallback: false };
    }

    if (!query || !query.trim()) {
      // No query — return most recent N chunks
      const sorted = [...allChunks].sort((a, b) => b.messageIndex - a.messageIndex);
      const result = sorted.slice(0, topK).reverse();
      _retrieveCache.set(cacheKey, { chunks: result, usedKeywordFallback: false, ts: Date.now() });
      return { chunks: result, usedKeywordFallback: false };
    }

    // Embed the query — check in-memory cache first, then offscreen path
    const hw = await getHardwareProfile();
    let queryEmbedding: number[] | null = null;
    const qCacheKey = query.trim().toLowerCase().slice(0, 200);
    const qCached = _queryEmbedCache.get(qCacheKey);
    if (qCached && Date.now() - qCached.ts < _QUERY_EMBED_CACHE_TTL_MS) {
      queryEmbedding = qCached.embedding;
      console.debug('[CM:index] Query embed cache hit');
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hasOffscreen = !!(chrome as any).offscreen;
      if (hasOffscreen) {
        try {
          // [PROGRESSIVE-SEARCH] Race the embed against a budget. If the
          // offscreen worker is busy with index batches, return keyword results
          // immediately and fire-and-forget the embed to populate the cache for
          // the next search. This keeps search latency low even when the
          // embedding queue is backed up.
          // [BUG-11 FIX] Scale budget with chunk count — 2s was too short for
          // large sessions (100+ chunks), causing premature keyword fallback
          // with poor compression ratios.
          const SEARCH_EMBED_BUDGET_MS = Math.max(2_000, Math.min(8_000, Math.ceil(allChunks.length * 50)));
          queryEmbedding = await Promise.race([
            offscreenEmbedQuery(query, hw),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), SEARCH_EMBED_BUDGET_MS)
            ),
          ]);
          if (queryEmbedding !== null) {
            _queryEmbedCache.set(qCacheKey, { embedding: queryEmbedding, ts: Date.now() });
            pruneRetrieveCache(_queryEmbedCache, Date.now(), _QUERY_EMBED_CACHE_TTL_MS, _QUERY_EMBED_CACHE_MAX);
          } else {
            // Embed didn't complete in time — fire-and-forget to populate cache
            // for the next search. Keyword fallback will be used this time.
            console.log('[CM:index] Search embed budget exceeded — using keyword fallback, caching embed in background');
            offscreenEmbedQuery(query, hw)
              .then((emb) => {
                _queryEmbedCache.set(qCacheKey, { embedding: emb, ts: Date.now() });
                pruneRetrieveCache(_queryEmbedCache, Date.now(), _QUERY_EMBED_CACHE_TTL_MS, _QUERY_EMBED_CACHE_MAX);
                _retrieveCache.delete(cacheKey); // invalidate so next search uses fresh semantic results
              })
              .catch(() => {});
          }
        } catch (err) {
          console.warn("[CM:index] Offscreen query embed failed — using keyword fallback:", err);
        }
      } else {
        console.warn("[CM:index] Offscreen unavailable — using keyword fallback");
      }
    }

    if (queryEmbedding === null) {
      const result = keywordRetrieve(allChunks, query, topK);
      _retrieveCache.set(cacheKey, { chunks: result, usedKeywordFallback: true, ts: Date.now() });
      pruneRetrieveCache(_retrieveCache, Date.now(), _RETRIEVE_CACHE_TTL_MS, _RETRIEVE_CACHE_MAX);
      const kwDt = performance.now() - t0;
      // [CM-P0-FIX] Show scanned vs total — keyword fallback now limited to MAX_KEYWORD_CHUNKS
      const scanned = Math.min(allChunks.length, MAX_KEYWORD_CHUNKS);
      console.log(`[CM:index] Keyword fallback: ${result.length}/${scanned} chunks scanned (${allChunks.length} total) in ${kwDt.toFixed(1)}ms`);
      void recordPerf('semantic_search', kwDt, { sessionId, metadata: { chunkCount: result.length, scannedChunks: scanned, totalChunks: allChunks.length, usedKeywordFallback: true } });
      return { chunks: result, usedKeywordFallback: true };
    }

    // Multi-signal attention score:
    //   • cosine similarity to the query embedding (the dominant signal)
    //   • recency boost  → recent messages slightly outrank old ones at
    //                     equal semantic relevance (linear decay over the
    //                     session length, capped at +0.15)
    //   • signal boost   → chunks containing decisions, errors / stack
    //                     traces, or code get a small additive bump that
    //                     can lift them past the MIN_SIMILARITY threshold
    //                     when the query is generic but the chunk is
    //                     clearly load-bearing
    //   • length boost   → very long chunks get a slight bump up to a cap
    //                     because they tend to carry more signal
    const maxMessageIndex = Math.max(
      ...allChunks.map((c) => c.messageIndex),
      0
    );
    const SIGNAL_RE = /\b(?:we decided|the fix is|root cause|the issue was|bug was|the goal|next step|TypeError|ReferenceError|Traceback|throws? \w+Error|fails? with|caused by)\b/i;

    const scored = allChunks.map((chunk) => {
      const cos = cosineSimilarity(queryEmbedding, chunk.embedding);
      const recency = maxMessageIndex > 0
        ? 0.15 * (chunk.messageIndex / maxMessageIndex)
        : 0;
      let signal = 0;
      if (SIGNAL_RE.test(chunk.text)) signal += 0.10;
      if (chunk.hasCode) signal += 0.05;
      // Length boost is small and capped — guards against rambling chunks
      // dominating purely on size.
      const length = Math.min(0.05, chunk.text.length / 6000);
      return { chunk, score: cos + recency + signal + length, cos };
    });
    scored.sort((a, b) => b.score - a.score);

    // Discard near-zero similarity chunks — they're semantic noise and would
    // dilute the retrieval if there's room to fill from better candidates.
    // We threshold on the raw cosine, not the boosted score, so the recency
    // bump never single-handedly admits an off-topic chunk.
    const MIN_SIMILARITY = 0.05;
    const usable = scored.filter((s) => s.cos >= MIN_SIMILARITY);
    const pool = usable.length > 0 ? usable : scored;

    // Boost code chunks — always include up to 5 top code blocks
    const topCode = pool.filter((s) => s.chunk.hasCode).slice(0, 5);
    const topProse = pool
      .filter((s) => !s.chunk.hasCode)
      .slice(0, Math.max(0, topK - topCode.length));

    // CRITICAL: always include chunks from the recent tail regardless of
    // cosine score. The window scales with session length so a 300-msg
    // session doesn't lose continuity to a fixed 6-msg window.
    //   • <  60 msgs  → 6 messages
    //   • 60–200 msgs → 10 messages
    //   • > 200 msgs  → 15 messages
    const RECENT_WINDOW =
      maxMessageIndex < 60 ? 6 : maxMessageIndex < 200 ? 10 : 15;
    const recentCutoff = Math.max(0, maxMessageIndex - RECENT_WINDOW + 1);
    const recentChunks = scored.filter(
      (s) => s.chunk.messageIndex >= recentCutoff
    );

    // Union of: top-scored code + top-scored prose + all recent chunks.
    // De-dup by chunk id so a chunk that's both recent AND top-scored isn't
    // counted twice.
    const seen = new Set<string>();
    const retrieved = [...topCode, ...topProse, ...recentChunks]
      .filter((s) => {
        if (seen.has(s.chunk.id)) return false;
        seen.add(s.chunk.id);
        return true;
      })
      .sort((a, b) => a.chunk.messageIndex - b.chunk.messageIndex)
      .map((s) => s.chunk);

    _retrieveCache.set(cacheKey, { chunks: retrieved, usedKeywordFallback: false, ts: Date.now() });
    pruneRetrieveCache(_retrieveCache, Date.now(), _RETRIEVE_CACHE_TTL_MS, _RETRIEVE_CACHE_MAX);
    const retrieveDt = performance.now() - t0;
    console.log(
      `[CM:index] Retrieved ${retrieved.length}/${allChunks.length} chunks ` +
      `(top-code=${topCode.length} top-prose=${topProse.length} recent=${recentChunks.length}) ` +
      `in ${retrieveDt.toFixed(1)}ms`
    );
    void recordPerf('semantic_search', retrieveDt, { sessionId, metadata: { chunkCount: retrieved.length, usedKeywordFallback: false } });
    return { chunks: retrieved, usedKeywordFallback: false };
  }

  // ─── SUMMARY PERSISTENCE ──────────────────────────────────────────────

  async getSummary(
    sessionId: string,
    tier: 1 | 2,
    task: string | null,
    messageCount: number
  ): Promise<StoredSummary | null> {
    const taskHash = task ? hashQuery(task) : "none";
    const id = `${sessionId}:${tier}:v${SUMMARIZER_VERSION}:${taskHash}`;
    const stored = await dexieDb.storedSummaries.get(id);
    if (!stored) return null;
    // Allow ±5 message drift — a single new turn (2 msgs) or minor MutationObserver
    // noise shouldn't invalidate the full ONNX scoring run.
    if (Math.abs(stored.messageCount - messageCount) > 5) return null;
    if (Date.now() - stored.builtAt > 86_400_000) return null;
    return stored;
  }

  async saveSummary(
    sessionId: string,
    tier: 1 | 2,
    task: string | null,
    content: string,
    compressionRatio: number,
    messageCount: number
  ): Promise<void> {
    const taskHash = task ? hashQuery(task) : "none";
    await dexieDb.storedSummaries.put({
      id: `${sessionId}:${tier}:v${SUMMARIZER_VERSION}:${taskHash}`,
      sessionId,
      tier,
      task,
      content,
      compressionRatio,
      builtAt: Date.now(),
      messageCount,
    });
  }

  // ─── RETRIEVAL CACHE (full prompt) ────────────────────────────────────

  async getCachedPrompt(
    sessionId: string,
    query: string | null,
    platform: string,
    tier: number,
    templateId: string | null
  ): Promise<string | null> {
    const queryHash = query ? hashQuery(query) : "none";
    const id = `${sessionId}:${queryHash}:${platform}:${tier}:${templateId ?? "none"}`;
    const cached = await dexieDb.retrievalCache.get(id);
    if (!cached) return null;
    if (Date.now() - cached.builtAt > 300_000) return null; // 5 min
    return cached.prompt;
  }

  async cachePrompt(
    sessionId: string,
    query: string | null,
    platform: string,
    tier: number,
    templateId: string | null,
    prompt: string,
    chunkIds: string[]
  ): Promise<void> {
    const queryHash = query ? hashQuery(query) : "none";
    const id = `${sessionId}:${queryHash}:${platform}:${tier}:${templateId ?? "none"}`;
    await dexieDb.retrievalCache.put({
      id,
      sessionId,
      queryHash,
      chunkIds,
      prompt,
      platform,
      tier,
      templateId,
      builtAt: Date.now(),
    });
  }

  // [FIX-1] Get the set of message indices that have been indexed (have chunks).
  // Used by Tier 2/3 migration to compute unindexed messages for raw fallback.
  async getIndexedMessageIndices(sessionId: string): Promise<Set<number>> {
    const chunks = await dexieDb.chunkEmbeddings
      .where('sessionId').equals(sessionId).toArray();
    return new Set(chunks.map(c => c.messageIndex));
  }

  // ─── CLEANUP / GC ─────────────────────────────────────────────────────

  async cleanupOldData(): Promise<void> {
    // 1. Remove orphaned data for deleted sessions
    const sessionIds = new Set((await dexieDb.sessions.toArray()).map((s) => s.id));
    const allHashes = await dexieDb.sessionHashes.toArray();
    for (const h of allHashes) {
      if (!sessionIds.has(h.sessionId)) {
        await dexieDb.chunkEmbeddings.where("sessionId").equals(h.sessionId).delete();
        await dexieDb.sessionHashes.delete(h.sessionId);
        await dexieDb.storedSummaries.where("sessionId").equals(h.sessionId).delete();
        await dexieDb.retrievalCache.where("sessionId").equals(h.sessionId).delete();
        console.log(`[CM:index] Cleaned up orphan: ${h.sessionId}`);
      }
    }

    // 2. Expire retrieval cache > 1h
    const oneHourAgo = Date.now() - 3_600_000;
    await dexieDb.retrievalCache.where("builtAt").below(oneHourAgo).delete();

    // 3. Enforce max chunks (100k)
    const total = await dexieDb.chunkEmbeddings.count();
    if (total > 100_000) {
      const toDelete = Math.floor(total * 0.2);
      const oldest = await dexieDb.chunkEmbeddings
        .orderBy("createdAt")
        .limit(toDelete)
        .toArray();
      await dexieDb.chunkEmbeddings.bulkDelete(oldest.map((c) => c.id));
      console.log(`[CM:index] Pruned ${toDelete} oldest chunks (was ${total})`);
    }

    // 4. Cap stored summaries per session at 20
    const summaries = await dexieDb.storedSummaries.toArray();
    const bySession = new Map<string, StoredSummary[]>();
    for (const s of summaries) {
      const arr = bySession.get(s.sessionId) ?? [];
      arr.push(s);
      bySession.set(s.sessionId, arr);
    }
    for (const [, arr] of bySession) {
      if (arr.length > 20) {
        arr.sort((a, b) => a.builtAt - b.builtAt);
        const drop = arr.slice(0, arr.length - 20);
        await dexieDb.storedSummaries.bulkDelete(drop.map((s) => s.id));
      }
    }
  }

  // ─── STATS (for settings UI) ──────────────────────────────────────────

  async getStats(): Promise<{
    sessionCount: number;
    indexedCount: number;
    chunkCount: number;
    summaryCount: number;
    cacheCount: number;
    estimatedStorageMB: number;
    modelTier: string | null;
    modelLabel: string | null;
  }> {
    const [sessionCount, chunkCount, summaryCount, cacheCount, hashes] = await Promise.all([
      dexieDb.sessions.count(),
      dexieDb.chunkEmbeddings.count(),
      dexieDb.storedSummaries.count(),
      dexieDb.retrievalCache.count(),
      dexieDb.sessionHashes.toArray(),
    ]);
    // [INDEX-COUNT-FIX] Only count sessions with isComplete=true AND actual chunks.
    // Counting all hashes includes phantom hashes (isComplete=true but 0 chunks from Drive sync).
    const completeHashIds = new Set(hashes.filter(h => h.isComplete).map(h => h.sessionId));
    const chunkSessionIds = await dexieDb.chunkEmbeddings.orderBy('sessionId').uniqueKeys();
    const indexedCount = completeHashIds.size > 0
      ? [...completeHashIds].filter(id => chunkSessionIds.includes(id as string)).length
      : 0;
    const estimatedStorageMB = Math.round((chunkCount * 384 * 4) / (1024 * 1024));
    return {
      sessionCount,
      indexedCount,
      chunkCount,
      summaryCount,
      cacheCount,
      estimatedStorageMB,
      // modelRegistry is only loaded in offscreen/sidebar contexts.
      // Return null in SW context — non-critical for stats display.
      modelTier: null,
      modelLabel: null,
    };
  }

  // [ISSUE-12] Pause background jobs instead of cancelling — preserves queue for resume
  pauseBackgroundJobs(): void {
    _bgPaused = true;
    // Abort in-flight bg job so migration gets CPU immediately
    if (_migrationAbort) {
      _migrationAbort.abort();
      _migrationAbort = null;
    }
    if (_bgIndexRequestId) {
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_CANCEL_BATCH', requestId: _bgIndexRequestId }).catch(() => {});
      _bgIndexRequestId = null;
    }
    console.log(`[CM:queue] Paused background indexing (${_backgroundQueue.length} jobs preserved)`);
  }

  // [ISSUE-12] Resume background jobs after migration completes
  resumeBackgroundJobs(): void {
    if (!_bgPaused) return;
    _bgPaused = false;
    console.log(`[CM:queue] Resumed background indexing (${_backgroundQueue.length} jobs queued)`);
    void this._drainIndexQueue();
  }

  // [CM-MIGRATION-PRIORITY] Cancel all background index jobs so migration gets full CPU.
  // Priority jobs are NOT cancelled — they serve migration.
  // Also aborts any in-flight background job via AbortController.
  cancelBackgroundJobs(): number {
    const count = _backgroundQueue.length;
    while (_backgroundQueue.length > 0) {
      const job = _backgroundQueue.pop()!;
      _indexingSessionLock.delete(job.session.id); // [CM-FIX-B] release lock for queued jobs
      job.reject(new Error('cancelled_for_migration'));
    }
    // Abort the currently running background job (if any) and release its lock.
    if (_migrationAbort) {
      _migrationAbort.abort();
      _migrationAbort = null;
    }
    // [CANCEL-FIX] Evict the in-flight background index job from the offscreen queue.
    // This stops its embed batches from blocking the ONNX worker for the priority job.
    if (_bgIndexRequestId) {
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_CANCEL_BATCH', requestId: _bgIndexRequestId }).catch(() => {});
      _bgIndexRequestId = null;
    }
    // [CM-FIX-B] Force-clear ALL session locks — migration needs a clean slate.
    _indexingSessionLock.clear();
    if (count > 0) {
      console.log(`[CM:queue] Cancelled ${count} queued + aborted in-flight background jobs for migration`);
    }
    return count;
  }

  cancelPriorityIndex(sessionId: string): void {
    for (let i = _priorityQueue.length - 1; i >= 0; i--) {
      if (_priorityQueue[i].session.id === sessionId) {
        const job = _priorityQueue.splice(i, 1)[0];
        _indexingSessionLock.delete(sessionId);
        job.reject(new Error('cancelled_for_timeout'));
      }
    }
    if (_priorityIndexRequestId) {
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_CANCEL_BATCH', requestId: _priorityIndexRequestId }).catch(() => {});
      _priorityIndexRequestId = null;
    }
    _indexingSessionLock.delete(sessionId);
    console.log(`[CM:queue] Cancelled priority index for ${sessionId}`);
  }

  async resetOffscreenDoc(): Promise<void> {
    const offscreen = (chrome as any).offscreen;
    if (!offscreen?.closeDocument) return;
    _offscreenReady = false;
    _offscreenReadyPromise = null;
    _offscreenReadyResolve = null;
    _offscreenCreating = false; // [FIX-6]
    try { await offscreen.closeDocument(); } catch { /* already closed */ }
    console.log('[CM:offscreen] reset — doc closed, will recreate on next warmup/index');
  }

  // [ISSUE-10] Try to warm up existing offscreen doc before destroying it
  async warmupWorker(): Promise<boolean> {
    try {
      await ensureOffscreenDocument();
      // Send WARMUP message to existing offscreen — if model already loaded, this is a no-op
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_WARMUP' }).catch(() => {});
      // Wait briefly for ready signal
      if (_offscreenReady) return true;
      const WARMUP_TIMEOUT_MS = 30_000;
      await Promise.race([
        _offscreenReadyPromise ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, WARMUP_TIMEOUT_MS)),
      ]);
      return _offscreenReady;
    } catch {
      return false;
    }
  }

  async warmup(): Promise<void> {
    // [ISSUE-10] Try warmupWorker first — only reset offscreen if warmup fails
    const warmed = await this.warmupWorker().catch(() => false);
    if (warmed) return;
    // Fallback: full reset + recreate
    await this.resetOffscreenDoc();
    await ensureOffscreenDocument();
    if (_offscreenReady) return;
    const WARMUP_TIMEOUT_MS = 60_000;
    await Promise.race([
      _offscreenReadyPromise ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, WARMUP_TIMEOUT_MS)),
    ]);
  }

  async clearAll(): Promise<void> {
    await Promise.all([
      dexieDb.chunkEmbeddings.clear(),
      dexieDb.sessionHashes.clear(),
      dexieDb.storedSummaries.clear(),
      dexieDb.retrievalCache.clear(),
    ]);
  }
}

export const semanticIndex = new SemanticIndex();
