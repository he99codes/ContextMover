// packages/browser-extension/src/lib/db-migration.ts
//
// One-shot IndexedDB migration from the pre-rebrand "contextforge" database
// to the current "contextmover" database. Invoked from the service-worker
// install handler; safe to call on every install (no-op if old DB absent).
//
// Strategy:
//   1. Probe indexedDB.databases() for an existing "contextforge" DB.
//   2. If present, copy every record from its "sessions" store into the
//      new Dexie-backed "contextmover" DB via db.sessions.bulkPut().
//   3. Delete the old "contextforge" DB.
//
// Failures are swallowed — migration must NEVER crash the service worker.

export async function migrateFromContextForge(): Promise<void> {
  try {
    const oldDbName = "contextforge";
    const newDbName = "contextmover";

    // `indexedDB.databases()` is available in Chrome / Chromium (MV3 SW runtime)
    // but not typed on every lib target, so we feature-detect defensively.
    const maybeList = (indexedDB as unknown as {
      databases?: () => Promise<Array<{ name?: string; version?: number }>>;
    }).databases;
    if (typeof maybeList !== "function") {
      return;
    }

    const databases = await maybeList.call(indexedDB);
    const oldExists = databases.some((d) => d.name === oldDbName);
    if (!oldExists) return;

    console.log(`[CM:db] Found legacy "${oldDbName}" DB, migrating to "${newDbName}"...`);

    // Open the old DB read-only.
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(oldDbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("legacy DB open blocked"));
    });

    if (!oldDb.objectStoreNames.contains("sessions")) {
      oldDb.close();
      // Nothing of value — just drop the old DB.
      await deleteDb(oldDbName);
      console.log(`[CM:db] Legacy "${oldDbName}" had no sessions store — deleted.`);
      return;
    }

    // Read all sessions from the legacy DB.
    const sessions = await new Promise<unknown[]>((resolve, reject) => {
      const tx = oldDb.transaction("sessions", "readonly");
      const store = tx.objectStore("sessions");
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    oldDb.close();

    if (!Array.isArray(sessions) || sessions.length === 0) {
      console.log("[CM:db] No sessions to migrate");
      await deleteDb(oldDbName);
      return;
    }

    // Import into the new Dexie DB.
    const { db } = await import("./db");
    // `bulkPut` is idempotent on primary key — safe to re-run.
    await db.sessions.bulkPut(sessions as Parameters<typeof db.sessions.bulkPut>[0]);

    console.log(`[CM:db] Migrated ${sessions.length} session(s) → "${newDbName}"`);

    // Finally, delete the old DB.
    await deleteDb(oldDbName);
    console.log(`[CM:db] Legacy "${oldDbName}" DB deleted`);
  } catch (err) {
    // Never crash on migration failure.
    console.warn("[CM:db] Rebrand migration failed (non-fatal):", err);
  }
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // other tabs still hold it — best-effort
  });
}
