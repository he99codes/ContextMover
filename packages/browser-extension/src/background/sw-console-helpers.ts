// SW Console debugging helpers - exposed globally for direct console access
// Usage in SW console:
//   await getPerfStatsFromConsole()
//   await exportPerfMetricsFromConsole()

import { getPerfStats } from "../lib/perf-track";
import { dexieDb } from "../lib/db";

// @ts-expect-error - intentionally exposing to globalThis for debugging
globalThis.getPerfStatsFromConsole = async (windowMs?: number) => {
  const stats = await getPerfStats(windowMs).catch(() => []);
  console.table(stats);
  return { ok: true, stats };
};

(globalThis as Record<string, unknown>).exportPerfMetricsFromConsole = async (windowMs?: number) => {
  const exportWindowMs = windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - exportWindowMs;
  const rows = await dexieDb.performanceMetrics.where('timestamp').above(cutoff).toArray().catch(() => []);
  console.table(rows);
  return { ok: true, rows, count: rows.length };
};
// @ts-expect-error
globalThis.checkSessionInDb = async (sessionId: string) => {
  const session = await dexieDb.sessions.get(sessionId);
  console.log('Session in DB:', session ? {id: session.id, title: session.title, platform: session.platform} : 'NOT FOUND');
  return session;
};

// @ts-expect-error
globalThis.listRecentSessions = async (limit = 10) => {
  const sessions = await dexieDb.sessions.orderBy('updatedAt').reverse().limit(limit).toArray();
  console.table(sessions.map(s => ({id: s.id, nativeId: s.nativeId ?? 'none', title: s.title, platform: s.platform, updatedAt: new Date(s.updatedAt).toLocaleTimeString()})));
  return sessions;
};

// @ts-expect-error
globalThis.checkNativeIdMapping = async (nativeId: string) => {
  const sessions = await dexieDb.sessions.where('nativeId').equals(nativeId).toArray();
  console.log(`Sessions with nativeId "${nativeId}":`, sessions.map(s => ({id: s.id, platform: s.platform, title: s.title})));
  return sessions;
};

console.log('[CM:sw] Console helpers: getPerfStatsFromConsole(), listRecentSessions(), checkNativeIdMapping(), checkSessionInDb()');
