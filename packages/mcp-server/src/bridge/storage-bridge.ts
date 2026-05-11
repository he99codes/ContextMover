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

// ── Input types for new mutators ─────────────────────────────────────────────
export interface ChunkEmbeddingInput {
  id:           string;
  chunkIndex:   number;
  text:         string;
  embedding:    number[];
  role:         string;
  messageIndex: number;
  hasCode:      boolean;
  language?:    string;
}

export interface SelectedFileInput {
  path:      string;
  content:   string;
  language?: string | null;
  size:      number;
}

export interface SelectedFileRow {
  path:       string;
  content:    string;
  language:   string | null;
  size:       number;
  selectedAt: number;
}

export interface SemanticSearchResult {
  sessionId:       string;
  chunkText:       string;
  score:           number;
  role:            string;
  hasCode:         boolean;
  sessionTitle:    string;
  sessionPlatform: string;
  session:         StoredSession | null;
}

interface ScoredChunk {
  sessionId:       string;
  chunkText:       string;
  score:           number;
  role:            string;
  hasCode:         boolean;
  sessionTitle:    string;
  sessionPlatform: string;
}

interface ChunkRow {
  id:                string;
  session_id:        string;
  text:              string;
  embedding:         Buffer;
  role:              string;
  has_code:          number;
  session_title:     string | null;
  session_platform:  string | null;
}

// Pure-JS cosine similarity — no native deps. Hot path during search; keep tight.
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i], y = b[i];
    dot   += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

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
    // Enable FK constraints — required for ON DELETE CASCADE on chunk_embeddings.
    this.db.pragma("foreign_keys = ON");

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

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        id            TEXT    PRIMARY KEY,
        session_id    TEXT    NOT NULL,
        chunk_index   INTEGER NOT NULL,
        text          TEXT    NOT NULL,
        embedding     BLOB    NOT NULL,
        role          TEXT    NOT NULL,
        message_index INTEGER NOT NULL,
        has_code      INTEGER DEFAULT 0,
        language      TEXT,
        created_at    INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS selected_files (
        path        TEXT    PRIMARY KEY,
        content     TEXT    NOT NULL,
        language    TEXT,
        size        INTEGER NOT NULL,
        selected_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_platform ON sessions(platform);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated  ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_session    ON chunk_embeddings(session_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_code       ON chunk_embeddings(has_code);
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

  // ── Chunk embeddings (Add-on 1: semantic search) ─────────────────────────
  upsertChunkEmbeddings(
    sessionId: string,
    chunks: ChunkEmbeddingInput[]
  ): void {
    if (chunks.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO chunk_embeddings (
        id, session_id, chunk_index, text, embedding,
        role, message_index, has_code, language, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text      = excluded.text,
        embedding = excluded.embedding
    `);

    const insertMany = this.db.transaction((items: ChunkEmbeddingInput[]) => {
      const now = Date.now();
      for (const chunk of items) {
        // Float32 little-endian buffer — Float32Array constructor on read
        // will reinterpret correctly on any LE host (x86/ARM/RISC-V).
        const f32    = new Float32Array(chunk.embedding);
        const buffer = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
        stmt.run(
          chunk.id,
          sessionId,
          chunk.chunkIndex,
          chunk.text,
          buffer,
          chunk.role,
          chunk.messageIndex,
          chunk.hasCode ? 1 : 0,
          chunk.language ?? null,
          now
        );
      }
    });

    insertMany(chunks);
    console.error(`[CM:bridge] Stored ${chunks.length} embeddings for session ${sessionId}`);
  }

  searchSemantic(
    queryEmbedding: number[],
    topK: number = 10
  ): SemanticSearchResult[] {
    const rows = this.db.prepare(`
      SELECT
        ce.id            AS id,
        ce.session_id    AS session_id,
        ce.text          AS text,
        ce.embedding     AS embedding,
        ce.role          AS role,
        ce.has_code      AS has_code,
        s.title          AS session_title,
        s.platform       AS session_platform
      FROM chunk_embeddings ce
      LEFT JOIN sessions s ON s.id = ce.session_id
      ORDER BY ce.created_at DESC
      LIMIT 5000
    `).all() as ChunkRow[];

    if (rows.length === 0) return [];

    const queryVec = new Float32Array(queryEmbedding);

    const scored: Array<ScoredChunk> = rows.map(row => {
      // row.embedding is a Buffer (Node) — wrap its ArrayBuffer slice as Float32Array.
      const buf = row.embedding;
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      return {
        sessionId:       row.session_id,
        chunkText:       row.text,
        score:           cosineSimilarity(queryVec, f32),
        role:            row.role,
        hasCode:         row.has_code === 1,
        sessionTitle:    row.session_title ?? "Unknown",
        sessionPlatform: row.session_platform ?? "unknown",
      };
    });

    scored.sort((a, b) => b.score - a.score);

    // Deduplicate to top-K unique sessions, keeping the highest-scoring chunk per session.
    const seen: Set<string>       = new Set();
    const out:  SemanticSearchResult[] = [];
    for (const item of scored) {
      if (out.length >= topK) break;
      if (seen.has(item.sessionId)) continue;
      seen.add(item.sessionId);
      out.push({ ...item, session: this.getSession(item.sessionId) });
    }
    return out;
  }

  // ── Selected files (Add-on 3: file context) ──────────────────────────────
  upsertSelectedFiles(files: SelectedFileInput[]): void {
    if (files.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO selected_files (path, content, language, size, selected_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        content     = excluded.content,
        language    = excluded.language,
        size        = excluded.size,
        selected_at = excluded.selected_at
    `);

    const insertMany = this.db.transaction((items: SelectedFileInput[]) => {
      const now = Date.now();
      for (const f of items) {
        stmt.run(f.path, f.content, f.language ?? null, f.size, now);
      }
    });

    insertMany(files);
    console.error(`[CM:bridge] ${files.length} selected files synced`);
  }

  getSelectedFiles(): SelectedFileRow[] {
    const rows = this.db
      .prepare("SELECT path, content, language, size, selected_at FROM selected_files ORDER BY selected_at DESC")
      .all() as Array<{ path: string; content: string; language: string | null; size: number; selected_at: number }>;
    return rows.map(r => ({
      path:       r.path,
      content:    r.content,
      language:   r.language,
      size:       r.size,
      selectedAt: r.selected_at,
    }));
  }

  clearSelectedFiles(): void {
    this.db.prepare("DELETE FROM selected_files").run();
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
