// packages/browser-extension/src/lib/db.ts
import { openDB, type IDBPDatabase } from "idb";
import type { ContextSession } from "./types";

const DB_NAME = "contextforge";
const DB_VERSION = 1;
const SESSIONS_STORE = "sessions";

let _db: IDBPDatabase | null = null;

async function getDb() {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        const store = db.createObjectStore(SESSIONS_STORE, { keyPath: "id" });
        store.createIndex("platform", "platform");
        store.createIndex("updatedAt", "updatedAt");
      }
    },
  });
  return _db;
}

export const db = {
  async saveSession(session: ContextSession): Promise<void> {
    const database = await getDb();
    await database.put(SESSIONS_STORE, session);
  },

  async getSession(id: string): Promise<ContextSession | undefined> {
    const database = await getDb();
    return database.get(SESSIONS_STORE, id);
  },

  async getAllSessions(): Promise<ContextSession[]> {
    const database = await getDb();
    const sessions = await database.getAllFromIndex(SESSIONS_STORE, "updatedAt");
    return sessions.reverse(); // newest first
  },

  async deleteSession(id: string): Promise<void> {
    const database = await getDb();
    await database.delete(SESSIONS_STORE, id);
  },

  async getSessionsByPlatform(platform: string): Promise<ContextSession[]> {
    const database = await getDb();
    return database.getAllFromIndex(SESSIONS_STORE, "platform", platform);
  },
};
