/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/sidebar/components/KnowledgeSynthesizer.tsx

import { useState, useCallback } from "react";
import ProGate from "../ProGate";
import { attentionEngine, type AttentionChunk } from "@/lib/attention-engine";
import { findTargetPlatformTab } from "@/lib/platform-tabs";
import { db, dexieDb } from "@/lib/db";
import type { Platform, ContextSession } from "@/lib/types";

const PLATFORMS: Platform[] = ["claude", "chatgpt", "gemini", "grok", "perplexity", "deepseek"];
const PLATFORM_LABELS: Record<Platform, string> = {
  claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini",
  grok: "Grok", perplexity: "Perplexity", deepseek: "DeepSeek",
};

const SCAN_CSS = `
@keyframes ks-scan{0%,100%{box-shadow:0 0 0 1px rgba(0,255,136,0.2)}50%{box-shadow:0 0 0 1px rgba(0,255,136,0.85),0 0 18px rgba(0,255,136,0.22)}}
.ks-scanning{border-color:rgba(0,255,136,0.6)!important;animation:ks-scan 1.1s ease-in-out infinite}
@keyframes ks-pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.ks-pulse{animation:ks-pulse 1.3s ease-in-out infinite}
`;

// [CM-KS-SNOOZE] coming soon — re-enable when KS ships
// async function runKeywordSearch(q: string): Promise<AttentionChunk[]> {
//   const allSessions = await db.sessions.toArray();
//   console.log('[KS:keyword] allSessions count:', allSessions.length);
//   const qLower = q.toLowerCase();
//   const results: AttentionChunk[] = [];
//   for (const session of allSessions) {
//     console.log('[KS:keyword] session', session.id, 'messages:', session.messages?.length ?? 'NO MESSAGES FIELD');
//     for (const msg of session.messages) {
//       if (msg.content.toLowerCase().includes(qLower)) {
//         results.push({
//           id: `kw-${session.id}-${msg.timestamp}`,
//           sessionId: session.id,
//           role: msg.role as "user" | "assistant",
//           content: msg.content.slice(0, 500),
//           embedding: [],
//           relevanceScore: 0.5,
//           type: "message" as const,
//           timestamp: msg.timestamp,
//         });
//       }
//     }
//   }
//   return results.slice(0, 15);
// }

// ── ChunkCard ────────────────────────────────────────────────────────────────

// [CM-KS-SNOOZE] coming soon — re-enable when KS ships
// function ChunkCard({ chunk, onDismiss }: { chunk: AttentionChunk; onDismiss: () => void }) {
//   const isCode      = chunk.type === "code";
//   const borderColor = isCode ? "rgba(6,182,212,0.4)" : "rgba(168,85,247,0.35)";
//   const tagColor    = isCode ? "#22D3EE" : "#C084FC";
// 
//   return (
//     <div style={{ position: "relative", border: `1px solid ${borderColor}`, background: "#0a0a0a", borderRadius: "5px", padding: "6px 7px" }}>
//       <button
//         onClick={onDismiss}
//         aria-label="Remove chunk"
//         style={{ position: "absolute", top: "3px", right: "4px", background: "none", border: "none", color: "#3A3A3A", fontSize: "10px", lineHeight: 1, padding: "0 2px", cursor: "pointer" }}
//         onMouseEnter={(e) => { e.currentTarget.style.color = "#FF4444"; }}
//         onMouseLeave={(e) => { e.currentTarget.style.color = "#3A3A3A"; }}
//       >×</button>
// 
//       <div style={{ display: "flex", alignItems: "center", gap: "3px", marginBottom: "3px", paddingRight: "14px" }}>
//         {isCode && chunk.language && (
//           <span style={{ fontSize: "6px", fontFamily: "monospace", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.12em", color: tagColor, background: isCode ? "rgba(6,182,212,0.08)" : "rgba(168,85,247,0.08)", border: `1px solid ${isCode ? "rgba(6,182,212,0.22)" : "rgba(168,85,247,0.22)"}`, borderRadius: "3px", padding: "1px 3px" }}>
//             {chunk.language}
//           </span>
//         )}
//         <span style={{ fontSize: "6px", color: "#6B6B6B", fontFamily: "monospace" }}>{chunk.role}</span>
//         <span style={{ fontSize: "6px", color: "#3A3A3A" }}>·</span>
//         <span style={{ fontSize: "6px", color: "#3A3A3A", fontFamily: "monospace" }}>{new Date(chunk.timestamp).toLocaleDateString()}</span>
//         {typeof chunk.relevanceScore === "number" && (
//           <>
//             <span style={{ fontSize: "6px", color: "#3A3A3A" }}>·</span>
//             <span style={{ fontSize: "6px", color: tagColor, fontFamily: "monospace" }}>{Math.round(chunk.relevanceScore * 100)}%</span>
//           </>
//         )}
//       </div>
// 
//       <p style={{ fontSize: "7px", color: "#9A9A9A", lineHeight: 1.55, margin: 0, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const, overflow: "hidden", wordBreak: "break-word" as const, fontFamily: isCode ? "monospace" : "inherit" }}>
//         {chunk.content}
//       </p>
//     </div>
//   );
// }

// ── KnowledgeSynthesizer ─────────────────────────────────────────────────────

export default function KnowledgeSynthesizer() {
  // [CM-KS-SNOOZE] coming soon — re-enable when KS ships
  /*
  const [query,          setQuery]          = useState("");
  const [isSearching,    setIsSearching]    = useState(false);
  const [chunks,         setChunks]         = useState<AttentionChunk[]>([]);
  const [targetPlatform, setTargetPlatform] = useState<Platform>("claude");
  const [isMigrating,    setIsMigrating]    = useState(false);
  const [migrateResult,  setMigrateResult]  = useState<{ ok: boolean; msg: string } | null>(null);
  const [isFallback,     setIsFallback]     = useState(false);
  const [hasSearched,    setHasSearched]    = useState(false);
  // [CM-FIX-5] tracks how many messages/chunks were searched so UI can show full scope
  const [searchScope,    setSearchScope]    = useState<{ sessions: number; messages: number; chunks: number } | null>(null);
  // [CM-FIX-5] fixed incomplete index trigger — now tracks per-session queued count
  const [indexingQueued, setIndexingQueued] = useState(0);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || isSearching) return;
    setIsSearching(true);
    setChunks([]);
    setMigrateResult(null);
    setIsFallback(false);
    setIndexingQueued(0);
    try {
      // [CM-FIX-5] compute search scope so UI can show "Searching across N messages"
      const allSessions = await db.sessions.toArray();
      const totalMessages = allSessions.reduce((sum, s) => sum + (s.messages?.length ?? 0), 0);
      const indexedChunks = await dexieDb.chunkEmbeddings.count();
      setSearchScope({ sessions: allSessions.length, messages: totalMessages, chunks: indexedChunks });
      console.log(`[KS] scope — sessions=${allSessions.length} messages=${totalMessages} indexed_chunks=${indexedChunks}`);

      // [CM-FIX-5] fixed incomplete index trigger — now checks per-session, not just empty table.
      // Query sessionHashes for all known session IDs; any session missing an entry is un-indexed
      // (new capture since last indexing run, or first-time use).
      if (allSessions.length > 0) {
        const indexedIds = new Set(
          (await dexieDb.sessionHashes.toArray()).map((h) => h.sessionId)
        );
        const unindexed = allSessions.filter((s) => !indexedIds.has(s.id));
        if (unindexed.length > 0) {
          for (const s of unindexed) {
            chrome.runtime.sendMessage({ type: "BACKGROUND_INDEX", sessionId: s.id }).catch(() => {});
          }
          setIndexingQueued(unindexed.length);
          console.log(`[KS] queued ${unindexed.length}/${allSessions.length} session(s) for background indexing`);
        }
      }

      const results = await attentionEngine.semanticSearch(q, 15);
      console.log('[KS] semantic results:', results.length);
      if (results.length > 0) {
        setChunks(results);
        setIsFallback(false);
      } else {
        const kwChunks = await runKeywordSearch(q);
        console.log('[KS] keyword results:', kwChunks.length);
        setChunks(kwChunks);
        setIsFallback(kwChunks.length > 0);
      }
    } catch (err) {
      console.warn("[KnowledgeSynthesizer] semantic search failed, falling back to keyword search:", err);
      try {
        const kwChunks = await runKeywordSearch(q);
        console.log('[KS] keyword results (catch):', kwChunks.length);
        setChunks(kwChunks);
        setIsFallback(kwChunks.length > 0);
      } catch {
        // keyword search also failed — leave chunks empty
      }
    } finally {
      setHasSearched(true);
      setIsSearching(false);
    }
  }, [query, isSearching]);

  const removeChunk = useCallback((id: string) => {
    setChunks((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const handleMigrate = useCallback(async () => {
    if (isMigrating || chunks.length === 0) return;
    setIsMigrating(true);
    setMigrateResult(null);

    const aggregatedContent = chunks.map((c) => c.content).join("\n\n---\n\n");
    const now       = Date.now();
    const virtualId = `custom-${now}`;

    const virtualSession: ContextSession = {
      id:        virtualId,
      platform:  targetPlatform,
      title:     `Synthesized: ${query.slice(0, 60)}`,
      messages:  [{ role: "user", content: aggregatedContent, timestamp: now }],
      createdAt: now,
      updatedAt: now,
    };

    try {
      await db.sessions.put(virtualSession);

      let targetTabId: number | undefined;
      try {
        const tab = await findTargetPlatformTab(targetPlatform);
        targetTabId = tab?.id;
      } catch { // SW will find a tab on its own
      }

      chrome.runtime.sendMessage(
        { type: "MIGRATE_CONTEXT", payload: { sessionId: virtualId, targetPlatform, targetTabId, tier: 1 } },
        (response) => {
          void chrome.runtime.lastError;
          void db.sessions.delete(virtualId).catch(() => {});
          const isErr = response?.success === false || (typeof response?.error === "string" && response.error);
          // [CM-FIX-2] removed user-facing error: raw response.error from SW
          if (isErr) console.error("[CM:synthesizer] migration failed:", response?.error);
          setMigrateResult(isErr
            ? { ok: false, msg: "Migration failed — open a target tab and retry" }
            : { ok: true,  msg: "✓ Context injected — switch to the target tab" }
          );
          setIsMigrating(false);
        }
      );
    } catch (err) {
      void db.sessions.delete(virtualId).catch(() => {});
      // [CM-FIX-2] removed user-facing error: raw err.message from caught exception
      console.error("[CM:synthesizer] migration exception:", err);
      setMigrateResult({ ok: false, msg: "Migration failed — please try again." });
      setIsMigrating(false);
    }
  }, [isMigrating, chunks, targetPlatform, query]);
  */

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '16px', textAlign: 'center' }}>
      <style>{`
        @keyframes neon-amber-glow {
          0%, 100% { text-shadow: 0 0 3px rgba(245,158,11,0.25), 0 0 6px rgba(245,158,11,0.1); opacity: 0.75; }
          50% { text-shadow: 0 0 8px rgba(245,158,11,0.8), 0 0 14px rgba(245,158,11,0.35); opacity: 1; }
        }
        .pulse-glow-amber {
          animation: neon-amber-glow 2s infinite ease-in-out;
        }
      `}</style>
      <div className="pulse-glow-amber" style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '3px 10px',
        borderRadius: '20px',
        fontSize: '11px',
        fontWeight: 500,
        background: 'var(--color-background-warning)',
        color: 'var(--color-text-warning)',
        border: '1px solid rgba(245,158,11,0.3)',
      }}>
        Knowledge Synthesizer — Coming Soon
      </div>
    </div>
  );
}
