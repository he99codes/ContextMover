// packages/mcp-server/src/bridge/storage-bridge.ts
//
// SQLite-backed local store. The extension cannot directly share
// IndexedDB with a Node process, so captures are mirrored via the HTTP
// extension-bridge into this file. The MCP server reads from this file
// to answer IDE tool calls.
//
// Location: ~/.contextmover/sessions.db
// Created automatically on first use — zero setup required from the user.

import Database, { type Database as DbHandle } from "better-sqlite3";
import fs   from "node:fs";
import os   from "node:os";
import path from "node:path";

import type { Message, SessionStats, StoredSession } from "../types.js";

interface SessionRow {
  id:             string;
  platform:       string;
  title:          string;
  messages:       string;
  created_at:     number;
  updated_at:     number;
  message_count:  number;
  has_code:       number;
  quality_score:  number | null;
  indexed:        number;
}

export class StorageBridge {
  private readonly db:     DbHandle;
  private readonly dbPath: string;

  constructor(customPath?: string) {
    const home = process.env.CONTEXTMOVER_HOME
              ?? process.env.HOME
              ?? process.env.USERPROFILE
              ?? os.homedir()
              ?? ".";
    this.dbPath = customPath ?? path.join(home, ".contextmover", "sessions.db");
    this.ensureDirectory();
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");   // concurrent extension-write + MCP-read
    this.db.pragma("synchronous = NORMAL"); // safe with WAL, faster
    this.initSchema();
  }

  private ensureDirectory(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT    PRIMARY KEY,
        platform      TEXT    NOT NULL,
        title         TEXT    NOT NULL,
        messages      TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        message_count INTEGER DEFAULT 0,
        has_code      INTEGER DEFAULT 0,
        quality_score REAL,
        indexed       INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS summaries (
        id         TEXT    PRIMARY KEY,
        session_id TEXT    NOT NULL,
        tier       INTEGER NOT NULL,
        content    TEXT    NOT NULL,
        built_at   INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_platform ON sessions(platform);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated  ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
    `);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────
  getAllSessions(limit = 20): StoredSession[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as SessionRow[];
    return rows.map(this.rowToSession);
  }

  getSession(id: string): StoredSession | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    return row ? this.rowToSession(row) : null;
  }

  searchSessions(query: string, limit = 10): StoredSession[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(`
        SELECT * FROM sessions
        WHERE title LIKE ? OR messages LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(like, like, limit) as SessionRow[];
    return rows.map(this.rowToSession);
  }

  getSessionsByPlatform(platform: string, limit = 10): StoredSession[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM sessions
        WHERE platform = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(platform, limit) as SessionRow[];
    return rows.map(this.rowToSession);
  }

  getSummary(sessionId: string, tier: number): string | null {
    const row = this.db
      .prepare(`
        SELECT content FROM summaries
        WHERE session_id = ? AND tier = ?
        ORDER BY built_at DESC
        LIMIT 1
      `)
      .get(sessionId, tier) as { content: string } | undefined;
    return row?.content ?? null;
  }

  // ── Writes ────────────────────────────────────────────────────────────────
  upsertSession(session: StoredSession): void {
    this.db
      .prepare(`
        INSERT INTO sessions (
          id, platform, title, messages,
          created_at, updated_at,
          message_count, has_code, quality_score
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          title         = excluded.title,
          messages      = excluded.messages,
          updated_at    = excluded.updated_at,
          message_count = excluded.message_count,
          has_code      = excluded.has_code,
          quality_score = excluded.quality_score
      `)
      .run(
        session.id,
        session.platform,
        session.title,
        JSON.stringify(session.messages),
        session.createdAt,
        session.updatedAt,
        session.messageCount,
        session.hasCode ? 1 : 0,
        session.qualityScore ?? null
      );
  }

  upsertSummary(sessionId: string, tier: number, content: string): void {
    const id = `${sessionId}:${tier}`;
    this.db
      .prepare(`
        INSERT INTO summaries (id, session_id, tier, content, built_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          content  = excluded.content,
          built_at = excluded.built_at
      `)
      .run(id, sessionId, tier, content, Date.now());
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  getStats(): SessionStats {
    const total = (this.db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number }).count;
    const platforms = this.db
      .prepare("SELECT platform, COUNT(*) as count FROM sessions GROUP BY platform")
      .all() as { platform: string; count: number }[];
    const lastUpdated = (this.db.prepare("SELECT MAX(updated_at) as last FROM sessions").get() as { last: number | null }).last;

    return {
      totalSessions: total,
      platforms:     Object.fromEntries(platforms.map(p => [p.platform, p.count])),
      lastUpdated,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }

  getDbPath(): string {
    return this.dbPath;
  }

  private rowToSession(row: SessionRow): StoredSession {
    let messages: Message[] = [];
    try {
      const parsed = JSON.parse(row.messages);
      if (Array.isArray(parsed)) messages = parsed as Message[];
    } catch {
      // Corrupted row — surface as empty rather than crashing the IDE.
    }
    return {
      id:           row.id,
      platform:     row.platform,
      title:        row.title,
      messages,
      createdAt:    row.created_at,
      updatedAt:    row.updated_at,
      messageCount: row.message_count,
      hasCode:      row.has_code === 1,
      qualityScore: row.quality_score ?? undefined,
    };
  }
}

// Module-level singleton — initialised lazily so tests / self-test can swap.
let _instance: StorageBridge | null = null;

export function getStorageBridge(): StorageBridge {
  if (!_instance) _instance = new StorageBridge();
  return _instance;
}

export const storageBridge = new Proxy({} as StorageBridge, {
  get(_t, prop: keyof StorageBridge) {
    const target = getStorageBridge();
    const value  = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});
