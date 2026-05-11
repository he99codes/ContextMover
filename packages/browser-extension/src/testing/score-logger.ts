// packages/browser-extension/src/testing/score-logger.ts
// Persists TestReport objects to a dedicated IndexedDB database.
// Uses its own DB ("contextmover-tests") to avoid version conflicts
// with the production "contextmover" DB.

import { openDB, type IDBPDatabase } from "idb";
import type { TestReport } from "./test-runner";

const TEST_DB_NAME    = "contextmover-tests";
const TEST_DB_VERSION = 1;
const REPORTS_STORE   = "test_reports";
const MAX_REPORTS     = 50;

let _testDb: IDBPDatabase | null = null;

async function getTestDb(): Promise<IDBPDatabase> {
  if (_testDb) return _testDb;
  _testDb = await openDB(TEST_DB_NAME, TEST_DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(REPORTS_STORE)) {
        const store = db.createObjectStore(REPORTS_STORE, { keyPath: "runId" });
        store.createIndex("runAt", "runAt");
      }
    },
  });
  return _testDb;
}

export async function saveTestReport(report: TestReport): Promise<void> {
  const db = await getTestDb();
  await db.put(REPORTS_STORE, report);

  // Trim to MAX_REPORTS (oldest first)
  const all = await db.getAllFromIndex(REPORTS_STORE, "runAt") as TestReport[];
  if (all.length > MAX_REPORTS) {
    const toDelete = all.slice(0, all.length - MAX_REPORTS);
    const tx = db.transaction(REPORTS_STORE, "readwrite");
    for (const r of toDelete) await tx.store.delete(r.runId);
    await tx.done;
  }
}

export async function getLastTestReport(): Promise<TestReport | null> {
  const db = await getTestDb();
  const all = await db.getAllFromIndex(REPORTS_STORE, "runAt") as TestReport[];
  if (all.length === 0) return null;
  return all[all.length - 1]; // highest runAt = most recent
}

export async function getAllTestReports(): Promise<TestReport[]> {
  const db = await getTestDb();
  const all = await db.getAllFromIndex(REPORTS_STORE, "runAt") as TestReport[];
  return all.reverse(); // newest first
}
