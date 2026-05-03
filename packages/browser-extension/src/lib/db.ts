// packages/browser-extension/src/lib/db.ts
import { openDB, type IDBPDatabase } from "idb";
import type { ContextSession } from "./types";

const DB_NAME = "contextforge";
const DB_VERSION = 2;
const SESSIONS_STORE = "sessions";

let _db: IDBPDatabase | null = null;

export async function getDb() {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const store = db.createObjectStore(SESSIONS_STORE, { keyPath: "id" });
        store.createIndex("platform", "platform");
        store.createIndex("updatedAt", "updatedAt");
      }
      if (oldVersion < 2) {
        const ptStore = db.createObjectStore("prompt_templates", { keyPath: "id" });
        ptStore.createIndex("userId", "userId");
        ptStore.createIndex("isDefault", "isDefault");
        ptStore.createIndex("usageCount", "usageCount");
        ptStore.createIndex("updatedAt", "updatedAt");

        const paStore = db.createObjectStore("prompt_assignments", { keyPath: "id" });
        paStore.createIndex("sessionId", "sessionId");
        paStore.createIndex("platform", "platform");
        paStore.createIndex("templateId", "templateId");
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
