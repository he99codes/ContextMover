/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension → repo-root port: P50/P90/P95/P99 perf tracker.
// Persists to the performanceMetrics Dexie store (db v8). 7-day retention,
// max 500 rows per operation. Used by PerfStatsPanel in the sidebar.
//
// [CM-OFFSCREEN-FIX] This file is ported from packages/browser-extension/src/lib/perf-track.ts
// so repo-root builds have the same perf dashboard as the nested clone. The
// dashboard distinguishes:
//   - migrate_total: end-to-end user-perceived time (sidebar-measured, SLO 15s)
//   - migrate_tierN (SW): SW handler time only (not user-perceived)
//   - migrate_tier3_fallback: T3 that fell back to T1 (failure signal)

import { dexieDb, type PerfOperation, type PerformanceMetric } from './db';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROWS_PER_OP = 500;

export function perfStart(operation: PerfOperation) {
  const t0 = performance.now();
  return async (opts: { sessionId?: string; metadata?: PerformanceMetric['metadata'] } = {}) => {
    const durationMs = Math.round(performance.now() - t0);
    try {
      await dexieDb.performanceMetrics.add({ operation, durationMs, timestamp: Date.now(), sessionId: opts.sessionId, metadata: opts.metadata });
      pruneOld(operation).catch(() => {});
    } catch { /* never break main path */ }
  };
}

export async function recordPerf(operation: PerfOperation, durationMs: number, opts: { sessionId?: string; metadata?: PerformanceMetric['metadata'] } = {}) {
  try {
    await dexieDb.performanceMetrics.add({ operation, durationMs: Math.round(durationMs), timestamp: Date.now(), ...opts });
    pruneOld(operation).catch(() => {});
  } catch { /* never break main path */ }
}

async function pruneOld(operation: PerfOperation) {
  await dexieDb.performanceMetrics.where('timestamp').below(Date.now() - RETENTION_MS).delete().catch(() => {});
  const all = await dexieDb.performanceMetrics.where('operation').equals(operation).sortBy('timestamp');
  if (all.length > MAX_ROWS_PER_OP) {
    const ids = all.slice(0, all.length - MAX_ROWS_PER_OP).map(r => r.id).filter((id): id is number => id != null);
    await dexieDb.performanceMetrics.bulkDelete(ids).catch(() => {});
  }
}

export interface PerfStats {
  operation: PerfOperation;
  count: number;
  p50: number; p90: number; p95: number; p99: number;
  min: number; max: number;
  sloTarget: number;
  sloMet: boolean;
}

const SLO: Record<PerfOperation, number> = {
  capture_session: 2000,
  migrate_tier1: 1000,
  migrate_tier2: 8000,
  migrate_tier3: 8000,
  migrate_tier3_fallback: 8000,
  migrate_total: 15000,
  background_index: 30000,
  background_index_chunk: 30000,
  semantic_search: 2000,
  drive_sync: 10000,
  tree_sitter_parse: 500,
  embedding_generate: 5000,
  embedding_query: 3000,
};

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(Math.floor(sorted.length * p / 100), sorted.length - 1)];
}

export async function getPerfStats(windowMs = RETENTION_MS): Promise<PerfStats[]> {
  const cutoff = Date.now() - windowMs;
  const rows = await dexieDb.performanceMetrics.where('timestamp').above(cutoff).toArray().catch(() => [] as PerformanceMetric[]);
  const byOp = new Map<PerfOperation, number[]>();
  for (const r of rows) {
    if (!byOp.has(r.operation)) byOp.set(r.operation, []);
    byOp.get(r.operation)!.push(r.durationMs);
  }
  const ops: PerfOperation[] = ['capture_session','migrate_tier1','migrate_tier2','migrate_tier3','migrate_tier3_fallback','migrate_total','background_index','semantic_search','drive_sync','tree_sitter_parse','embedding_generate','embedding_query'];
  return ops.map(op => {
    const sorted = (byOp.get(op) ?? []).sort((a, b) => a - b);
    const p90 = pct(sorted, 90);
    return { operation: op, count: sorted.length, p50: pct(sorted,50), p90, p95: pct(sorted,95), p99: pct(sorted,99), min: sorted[0] ?? 0, max: sorted[sorted.length-1] ?? 0, sloTarget: SLO[op], sloMet: sorted.length === 0 || p90 <= SLO[op] };
  });
}
