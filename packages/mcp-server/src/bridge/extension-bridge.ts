// packages/mcp-server/src/bridge/extension-bridge.ts
//
// HTTP loopback bridge for the Chrome extension.
// The extension POSTs captured sessions to /sessions and pings /health
// to know whether the MCP server is running. Bound to 127.0.0.1 only;
// not reachable from the network.

import cors    from "cors";
import express from "express";
import type { AddressInfo } from "node:net";

import { storageBridge }      from "./storage-bridge.js";
import type { StoredSession } from "../types.js";

export const BRIDGE_PORT = 49001; // fixed — extension hardcodes this

interface SyncPayload {
  id?:           string;
  platform?:     string;
  title?:        string;
  messages?:     Array<{ role: string; content: string }>;
  createdAt?:    number;
  updatedAt?:    number;
  messageCount?: number;
  hasCode?:      boolean;
  qualityScore?: number;
}

function isValidPlatform(p: unknown): p is string {
  return typeof p === "string" && /^[a-z0-9_-]{2,32}$/i.test(p);
}

function coerceSession(body: SyncPayload): StoredSession | null {
  if (!body || typeof body.id !== "string" || !Array.isArray(body.messages)) {
    return null;
  }
  if (!isValidPlatform(body.platform)) return null;

  // Filter to a safe shape — drop anything we don't expect.
  const messages = body.messages
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

  const now = Date.now();
  return {
    id:           body.id,
    platform:     body.platform!,
    title:        typeof body.title === "string" ? body.title.slice(0, 500) : body.id,
    messages,
    createdAt:    typeof body.createdAt === "number" ? body.createdAt : now,
    updatedAt:    typeof body.updatedAt === "number" ? body.updatedAt : now,
    messageCount: typeof body.messageCount === "number" ? body.messageCount : messages.length,
    hasCode:      Boolean(body.hasCode),
    qualityScore: typeof body.qualityScore === "number" ? body.qualityScore : undefined,
  };
}

export function startExtensionBridge(port: number = BRIDGE_PORT): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const app = express();

    // [SECURITY] Only chrome-extension:// origins and localhost may post.
    // Wildcards aren't allowed in real CORS — we mirror by checking each origin.
    app.use(cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // same-origin / curl / Node clients
        if (origin.startsWith("chrome-extension://")) return cb(null, true);
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
        cb(new Error(`Origin not allowed: ${origin}`));
      },
      methods: ["GET", "POST", "OPTIONS"],
    }));

    // 50 MB cap — large sessions can be ~few MB; this is a hard upper bound.
    app.use(express.json({ limit: "50mb" }));

    // ── Sync endpoint ──────────────────────────────────────────────────────
    app.post("/sessions", (req, res) => {
      try {
        const session = coerceSession(req.body as SyncPayload);
        if (!session) {
          res.status(400).json({ error: "Invalid session payload" });
          return;
        }
        storageBridge.upsertSession(session);
        console.error(`[CM:bridge] Session synced: ${session.id} (${session.messages.length} messages)`);
        res.json({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[CM:bridge] Sync error:", msg);
        res.status(500).json({ error: msg });
      }
    });

    // ── Health endpoint ────────────────────────────────────────────────────
    app.get("/health", (_req, res) => {
      try {
        const stats = storageBridge.getStats();
        res.json({ ok: true, version: "0.1.0", ...stats });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ ok: false, error: msg });
      }
    });

    // ── /embeddings ─ chunk vectors synced from extension's IDB ────────────
    app.post("/embeddings", (req, res) => {
      try {
        const { sessionId, chunks } = (req.body ?? {}) as {
          sessionId?: unknown;
          chunks?:    unknown;
        };
        if (typeof sessionId !== "string" || !sessionId) {
          res.status(400).json({ error: "sessionId required" });
          return;
        }
        if (!Array.isArray(chunks)) {
          res.status(400).json({ error: "chunks must be an array" });
          return;
        }

        // Coerce + validate each chunk. Drop malformed entries silently —
        // bridge is best-effort; never crash a sync because of one bad row.
        const cleaned = chunks
          .filter((c: unknown): c is Record<string, unknown> => !!c && typeof c === "object")
          .map((c) => {
            const emb = c.embedding;
            const arr = Array.isArray(emb)
              ? emb.filter((n) => typeof n === "number") as number[]
              : null;
            if (!arr || arr.length === 0) return null;
            if (typeof c.id          !== "string") return null;
            if (typeof c.text        !== "string") return null;
            if (typeof c.role        !== "string") return null;
            if (typeof c.chunkIndex   !== "number") return null;
            if (typeof c.messageIndex !== "number") return null;
            return {
              id:           c.id,
              chunkIndex:   c.chunkIndex,
              text:         c.text,
              embedding:    arr,
              role:         c.role,
              messageIndex: c.messageIndex,
              hasCode:      Boolean(c.hasCode),
              language:     typeof c.language === "string" ? c.language : undefined,
            };
          })
          .filter((c): c is NonNullable<typeof c> => c !== null);

        storageBridge.upsertChunkEmbeddings(sessionId, cleaned);
        res.json({ ok: true, count: cleaned.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[CM:bridge] /embeddings error:", msg);
        res.status(500).json({ error: msg });
      }
    });

    // ── /summaries ─ pre-computed tier-1/tier-2 summaries from extension ──
    app.post("/summaries", (req, res) => {
      try {
        const { sessionId, tier, content } = (req.body ?? {}) as {
          sessionId?: unknown;
          tier?:      unknown;
          content?:   unknown;
        };
        if (typeof sessionId !== "string" || !sessionId) {
          res.status(400).json({ error: "sessionId required" });
          return;
        }
        if (typeof tier !== "number" || !Number.isInteger(tier) || tier < 1 || tier > 3) {
          res.status(400).json({ error: "tier must be integer 1-3" });
          return;
        }
        if (typeof content !== "string") {
          res.status(400).json({ error: "content required" });
          return;
        }
        storageBridge.upsertSummary(sessionId, tier, content);
        res.json({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[CM:bridge] /summaries error:", msg);
        res.status(500).json({ error: msg });
      }
    });

    // ── /files ─ user-selected project files from File System panel ───────
    app.post("/files", (req, res) => {
      try {
        const { files } = (req.body ?? {}) as { files?: unknown };
        if (!Array.isArray(files)) {
          res.status(400).json({ error: "files must be an array" });
          return;
        }

        const cleaned = files
          .filter((f: unknown): f is Record<string, unknown> => !!f && typeof f === "object")
          .map((f) => {
            if (typeof f.path    !== "string" || !f.path)    return null;
            if (typeof f.content !== "string")               return null;
            const size = typeof f.size === "number"
              ? f.size
              : Buffer.byteLength(f.content, "utf8");
            return {
              path:     f.path,
              content:  f.content,
              language: typeof f.language === "string" ? f.language : null,
              size,
            };
          })
          .filter((f): f is NonNullable<typeof f> => f !== null);

        storageBridge.upsertSelectedFiles(cleaned);
        res.json({ ok: true, count: cleaned.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[CM:bridge] /files error:", msg);
        res.status(500).json({ error: msg });
      }
    });

    // ── Diagnostic endpoint (counts only — no session content) ─────────────
    app.get("/stats", (_req, res) => {
      try {
        res.json(storageBridge.getStats());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    });

    const server = app.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      // Log to stderr — MCP stdio uses stdout for protocol frames.
      console.error(`[CM:bridge] Extension bridge running on http://127.0.0.1:${addr.port}`);
      resolve({
        port:  addr.port,
        close: () => server.close(),
      });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Another MCP server instance is likely already running.
        // Log and resolve gracefully — the MCP transport itself still works.
        console.error(`[CM:bridge] Port ${port} already in use — extension sync disabled in this instance`);
        resolve({ port: -1, close: () => { /* nothing to close */ } });
        return;
      }
      reject(err);
    });
  });
}
