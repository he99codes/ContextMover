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
import { db } from "@/lib/db";
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

// ── ChunkCard ────────────────────────────────────────────────────────────────

function ChunkCard({ chunk, onDismiss }: { chunk: AttentionChunk; onDismiss: () => void }) {
  const isCode      = chunk.type === "code";
  const borderColor = isCode ? "rgba(6,182,212,0.4)" : "rgba(168,85,247,0.35)";
  const tagColor    = isCode ? "#22D3EE" : "#C084FC";

  return (
    <div style={{ position: "relative", border: `1px solid ${borderColor}`, background: "#0a0a0a", borderRadius: "5px", padding: "8px 10px" }}>
      <button
        onClick={onDismiss}
        aria-label="Remove chunk"
        style={{ position: "absolute", top: "4px", right: "6px", background: "none", border: "none", color: "#3A3A3A", fontSize: "14px", lineHeight: 1, padding: "0 2px", cursor: "pointer" }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "#FF6B6B"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "#3A3A3A"; }}
      >×</button>

      <div style={{ display: "flex", alignItems: "center", gap: "5px", marginBottom: "5px", paddingRight: "18px" }}>
        {isCode && chunk.language && (
          <span style={{ fontSize: "8px", fontFamily: "monospace", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.12em", color: tagColor, background: isCode ? "rgba(6,182,212,0.08)" : "rgba(168,85,247,0.08)", border: `1px solid ${isCode ? "rgba(6,182,212,0.22)" : "rgba(168,85,247,0.22)"}`, borderRadius: "3px", padding: "1px 5px" }}>
            {chunk.language}
          </span>
        )}
        <span style={{ fontSize: "9px", color: "#6B6B6B", fontFamily: "monospace" }}>{chunk.role}</span>
        <span style={{ fontSize: "9px", color: "#3A3A3A" }}>·</span>
        <span style={{ fontSize: "9px", color: "#3A3A3A", fontFamily: "monospace" }}>{new Date(chunk.timestamp).toLocaleDateString()}</span>
        {typeof chunk.relevanceScore === "number" && (
          <>
            <span style={{ fontSize: "9px", color: "#3A3A3A" }}>·</span>
            <span style={{ fontSize: "9px", color: tagColor, fontFamily: "monospace" }}>{Math.round(chunk.relevanceScore * 100)}%</span>
          </>
        )}
      </div>

      <p style={{ fontSize: "10px", color: "#9A9A9A", lineHeight: 1.55, margin: 0, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const, overflow: "hidden", wordBreak: "break-word" as const, fontFamily: isCode ? "monospace" : "inherit" }}>
        {chunk.content}
      </p>
    </div>
  );
}

// ── KnowledgeSynthesizer ─────────────────────────────────────────────────────

export default function KnowledgeSynthesizer() {
  const [query,          setQuery]          = useState("");
  const [isSearching,    setIsSearching]    = useState(false);
  const [chunks,         setChunks]         = useState<AttentionChunk[]>([]);
  const [targetPlatform, setTargetPlatform] = useState<Platform>("claude");
  const [isMigrating,    setIsMigrating]    = useState(false);
  const [migrateResult,  setMigrateResult]  = useState<{ ok: boolean; msg: string } | null>(null);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || isSearching) return;
    setIsSearching(true);
    setChunks([]);
    setMigrateResult(null);
    try {
      const results = await attentionEngine.semanticSearch(q, 15);
      setChunks(results);
    } catch (err) {
      console.error("[KnowledgeSynthesizer] search failed:", err);
    } finally {
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
      } catch { /* SW will find a tab on its own */ }

      chrome.runtime.sendMessage(
        { type: "MIGRATE_CONTEXT", payload: { sessionId: virtualId, targetPlatform, targetTabId, tier: 1 } },
        (response) => {
          void chrome.runtime.lastError;
          void db.sessions.delete(virtualId).catch(() => {});
          const isErr = response?.success === false || (typeof response?.error === "string" && response.error);
          setMigrateResult(isErr
            ? { ok: false, msg: typeof response?.error === "string" ? response.error : "Migration failed — open a target tab and retry" }
            : { ok: true,  msg: "✓ Context injected — switch to the target tab" }
          );
          setIsMigrating(false);
        }
      );
    } catch (err) {
      void db.sessions.delete(virtualId).catch(() => {});
      setMigrateResult({ ok: false, msg: err instanceof Error ? err.message : "Migration failed" });
      setIsMigrating(false);
    }
  }, [isMigrating, chunks, targetPlatform, query]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "#050505" }}>
      <style>{SCAN_CSS}</style>

      <ProGate>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>

          {/* Header */}
          <div style={{ flexShrink: 0, borderBottom: "1px solid #0D0D1A", padding: "8px 12px 6px", background: "linear-gradient(135deg,#040408 0%,#07070F 55%,#040408 100%)", boxShadow: "0 1px 0 rgba(168,85,247,0.08)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" }}>
              <span style={{ fontSize: "11px", color: "#C084FC", textShadow: "0 0 8px rgba(168,85,247,0.5)" }}>⚡</span>
              <span style={{ fontSize: "10px", fontWeight: 900, letterSpacing: "0.06em", color: "#F5F5F5" }}>Knowledge Synthesizer</span>
              <span style={{ fontSize: "7px", fontFamily: "monospace", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.18em", color: "#C084FC", background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.25)", borderRadius: "3px", padding: "1px 4px" }}>Pro</span>
            </div>
            <p style={{ margin: 0, fontSize: "9px", color: "#4A4A6A", letterSpacing: "0.08em" }}>Assemble context across all indexed sessions</p>
          </div>

          {/* Search HUD */}
          <div style={{ flexShrink: 0, padding: "10px 12px 6px" }}>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)", fontSize: "12px", color: "#C084FC", fontFamily: "monospace", fontWeight: 700, pointerEvents: "none" as const }}>›</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
                placeholder="Synthesize topics across all sessions (e.g., 'Supabase Auth setup')..."
                disabled={isSearching}
                className={isSearching ? "ks-scanning" : ""}
                style={{ width: "100%", boxSizing: "border-box" as const, background: "#060606", border: "1px solid #1A1A2A", borderRadius: "4px", padding: "7px 30px 7px 22px", fontSize: "10px", fontFamily: "monospace", color: "#F5F5F5", outline: "none", transition: "border-color 0.2s" }}
                onFocus={(e) => { if (!isSearching) e.currentTarget.style.borderColor = "rgba(168,85,247,0.5)"; }}
                onBlur={(e)  => { if (!isSearching) e.currentTarget.style.borderColor = "#1A1A2A"; }}
              />
              <button
                onClick={() => void handleSearch()}
                disabled={isSearching || !query.trim()}
                style={{ position: "absolute", right: "6px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: isSearching ? "#C084FC" : "#4A4A6A", padding: "0 2px", opacity: !query.trim() ? 0.3 : 1 }}
                title="Search (Enter)"
              >{isSearching ? "⟳" : "⏎"}</button>
            </div>
          </div>

          {/* Platform selector */}
          <div style={{ flexShrink: 0, padding: "0 12px 8px", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "9px", textTransform: "uppercase" as const, letterSpacing: "0.12em", color: "#2A2A4A", whiteSpace: "nowrap" as const }}>Inject into</span>
            <select
              value={targetPlatform}
              onChange={(e) => setTargetPlatform(e.target.value as Platform)}
              style={{ flex: 1, background: "#060606", border: "1px solid #1A1A2A", borderRadius: "3px", padding: "3px 6px", fontSize: "9px", fontFamily: "monospace", color: "#A0A0C0", outline: "none", cursor: "pointer" }}
            >
              {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
            </select>
            {chunks.length > 0 && (
              <span style={{ fontSize: "9px", color: "#4A4A6A", whiteSpace: "nowrap" as const }}>{chunks.length} chunk{chunks.length !== 1 ? "s" : ""}</span>
            )}
          </div>

          {/* Staging area */}
          <div style={{ flex: 1, overflowY: "auto", padding: "0 12px", minHeight: 0 }}>

            {/* Empty — no search yet */}
            {chunks.length === 0 && !isSearching && !query.trim() && (
              <div style={{ textAlign: "center", paddingTop: "32px" }}>
                <div style={{ width: "36px", height: "36px", borderRadius: "8px", border: "1px solid rgba(168,85,247,0.18)", background: "rgba(168,85,247,0.04)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px" }}>
                  <span style={{ fontSize: "16px", color: "rgba(168,85,247,0.4)" }}>◈</span>
                </div>
                <p style={{ fontSize: "10px", color: "#4A4A6A", margin: 0, lineHeight: 1.65 }}>
                  Search across all your indexed sessions.<br />Results appear as composable context chunks.
                </p>
              </div>
            )}

            {/* Empty — searched, no results */}
            {chunks.length === 0 && !isSearching && query.trim() && (
              <div style={{ textAlign: "center", paddingTop: "24px" }}>
                <p style={{ fontSize: "10px", color: "#3A3A3A", margin: "0 0 4px" }}>No indexed chunks matched <span style={{ color: "#6B6B6B" }}>"{query}"</span></p>
                <p style={{ fontSize: "9px", color: "#2A2A2A", margin: 0 }}>Ensure sessions are indexed via the Attention Engine.</p>
              </div>
            )}

            {/* Scanning skeletons */}
            {isSearching && (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", paddingTop: "8px" }}>
                {([1, 0.65, 0.4] as number[]).map((opacity, i) => (
                  <div key={i} className="ks-pulse" style={{ height: i === 0 ? "54px" : "44px", borderRadius: "5px", border: "1px solid rgba(168,85,247,0.18)", background: "#0a0a0a", opacity, animationDelay: `${i * 0.18}s` }} />
                ))}
              </div>
            )}

            {/* Chunk cards */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", paddingBottom: "6px" }}>
              {chunks.map((chunk) => (
                <ChunkCard key={chunk.id} chunk={chunk} onDismiss={() => removeChunk(chunk.id)} />
              ))}
            </div>
          </div>

          {/* Sticky CTA */}
          {chunks.length > 0 && (
            <div style={{ flexShrink: 0, borderTop: "1px solid #0D0D1A", padding: "8px 12px", background: "#050505" }}>
              <button
                onClick={() => void handleMigrate()}
                disabled={isMigrating}
                style={{ width: "100%", padding: "9px 12px", background: isMigrating ? "#0D1A0D" : "#00FF88", border: "none", borderRadius: "4px", color: isMigrating ? "#00FF88" : "#0A0A0A", fontSize: "10px", fontWeight: 900, textTransform: "uppercase" as const, letterSpacing: "0.13em", cursor: isMigrating ? "not-allowed" : "pointer", boxShadow: isMigrating ? "none" : "0 0 18px rgba(0,255,136,0.3)", transition: "all 0.2s", opacity: isMigrating ? 0.7 : 1 }}
              >
                {isMigrating ? "Compiling Context…" : `Migrate Custom Context (${chunks.length} chunk${chunks.length !== 1 ? "s" : ""})`}
              </button>
              {migrateResult && (
                <p style={{ margin: "5px 0 0", fontSize: "9px", fontFamily: "monospace", textAlign: "center", color: migrateResult.ok ? "#00FF88" : "#FF6B6B" }}>
                  {migrateResult.msg}
                </p>
              )}
            </div>
          )}

        </div>
      </ProGate>
    </div>
  );
}
