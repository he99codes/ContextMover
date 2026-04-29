// packages/browser-extension/src/sidebar/AttentionModal.tsx
// Attention Engine migration modal.
// Guides the user through task input, strength selection, and live preview
// before firing a semantic-aware MIGRATE_CONTEXT message to the service worker.

import { useEffect, useRef, useState } from "react";
import { findTargetPlatformTab, focusTab } from "@/lib/platform-tabs";
import { attentionEngine } from "@/lib/attention-engine";
import { summarizeWithAttention } from "@/lib/summarizer";
import type { ContextSession, Platform } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<Platform, string> = {
  claude:     "Claude",
  chatgpt:    "ChatGPT",
  gemini:     "Google Gemini",
  grok:       "xAI Grok",
  perplexity: "Perplexity",
  deepseek:   "DeepSeek",
};

const TASK_CHIPS = [
  "Fix the current bug",
  "Continue implementing the feature",
  "Refactor the code",
  "Write tests",
  "Debug and optimize",
  "Review and critique",
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  session: ContextSession;
  targetPlatform: Platform;
  onClose: () => void;
  onSuccess?: (compressionRatio: number) => void;
}

type EngineState =
  | { status: "idle" }
  | { status: "loading"; progress: number }
  | { status: "ready" }
  | { status: "error"; message: string };

type PreviewState =
  | { status: "idle" }
  | { status: "analyzing" }
  | { status: "done"; compressionRatio: number; highlightedFiles: number; relevantMessages: number; totalMessages: number }
  | { status: "error" };

type MigrateState =
  | { status: "idle" }
  | { status: "migrating" }
  | { status: "success"; compressionRatio: number }
  | { status: "error"; message: string };

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function AttentionModal({ session, targetPlatform, onClose, onSuccess }: Props) {
  const [engineState, setEngineState] = useState<EngineState>({ status: "idle" });
  const [task, setTask] = useState("");
  const [strength, setStrength] = useState<"light" | "strict">("light");
  const [caveman, setCaveman] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [migrateState, setMigrateState] = useState<MigrateState>({ status: "idle" });
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Initialize engine on mount ──────────────────────────────────────────────
  useEffect(() => {
    if (attentionEngine.initialized) {
      setEngineState({ status: "ready" });
      return;
    }

    setEngineState({ status: "loading", progress: 0 });
    attentionEngine
      .initialize((progress) => {
        setEngineState({ status: "loading", progress });
      })
      .then(() => setEngineState({ status: "ready" }))
      .catch((err) => {
        console.warn("[AttentionModal] engine init failed:", err);
        setEngineState({
          status: "error",
          message: "Engine unavailable — keyword fallback will be used",
        });
      });
  }, []);

  // ── Debounced live preview whenever task / strength changes ─────────────────
  useEffect(() => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);

    if (!task.trim() || engineState.status !== "ready") {
      setPreview({ status: "idle" });
      return;
    }

    setPreview({ status: "analyzing" });
    previewTimerRef.current = setTimeout(async () => {
      try {
        await attentionEngine.indexSession(session);
        const map = await attentionEngine.buildAttentionMap(session, task, strength);
        const relevantMessages = map.topChunks.filter(
          (c) => c.type === "message" && c.relevanceScore >= map.threshold
        ).length;
        setPreview({
          status: "done",
          compressionRatio: map.compressionRatio,
          highlightedFiles: map.highlightedFiles.length,
          relevantMessages,
          totalMessages: session.messages.length,
        });
      } catch {
        setPreview({ status: "error" });
      }
    }, 600);

    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    };
  }, [task, strength, engineState.status, session]);

  // ── Migration handler ───────────────────────────────────────────────────────
  async function handleMigrate() {
    setMigrateState({ status: "migrating" });

    const tab = await findTargetPlatformTab(targetPlatform);
    if (!tab?.id) {
      setMigrateState({
        status: "error",
        message: `Open a ${PLATFORM_LABELS[targetPlatform]} tab, then try again.`,
      });
      return;
    }

    await focusTab(tab.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Pre-compute the attention summary HERE in the sidebar (persistent page)
    // so the service worker never has to re-download the 23 MB model or
    // re-index the session.  The sidebar's engine is already initialized and
    // the session is already indexed from the live-preview step.
    let precomputedSummary: string | undefined;
    let precomputedAttentionMap: unknown;
    const taskText = task.trim();
    if (taskText && attentionEngine.initialized) {
      try {
        const result = await summarizeWithAttention(
          session.messages,
          taskText,
          strength,
          session
        );
        precomputedSummary = result.summary;
        precomputedAttentionMap = result.attentionMap;
      } catch (err) {
        console.warn("[AttentionModal] pre-computation failed, service worker will recompute:", err);
      }
    }

    chrome.runtime.sendMessage(
      {
        type: "MIGRATE_CONTEXT",
        payload: {
          sessionId: session.id,
          targetPlatform,
          targetTabId: tab.id,
          caveman,
          useAttentionEngine: true,
          task: taskText || undefined,
          strength,
          precomputedSummary,
          precomputedAttentionMap,
        },
      },
      (response) => {
        if (response?.error) {
          setMigrateState({ status: "error", message: response.error });
          return;
        }
        const ratio = preview.status === "done" ? preview.compressionRatio : 0;
        setMigrateState({ status: "success", compressionRatio: ratio });
        onSuccess?.(ratio);
      }
    );
  }

  const isBusy =
    migrateState.status === "migrating" || engineState.status === "loading";

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.9)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "16px",
        backdropFilter: "blur(4px)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "#050505",
          border: "1px solid rgba(0,255,136,0.18)",
          borderRadius: "6px",
          padding: "24px",
          maxWidth: "460px",
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          color: "#F5F5F5",
          boxShadow: "0 0 0 1px rgba(0,255,136,0.06), 0 24px 80px rgba(0,0,0,0.9), 0 0 60px rgba(0,255,136,0.04)",
          fontFamily: "'SF Mono','Fira Code',monospace",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: "20px",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "13px", fontWeight: 900, color: "#00FF88", letterSpacing: "0.18em", textTransform: "uppercase", textShadow: "0 0 12px rgba(0,255,136,0.45)" }}>
              Attention Engine
            </h2>
            <p style={{ margin: "3px 0 0", fontSize: "10px", color: "#1A4A1A", letterSpacing: "0.15em", textTransform: "uppercase" }}>
              Semantic task-aware context migration
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "1px solid #1A2A1A",
              borderRadius: "4px",
              color: "#2A6A2A",
              cursor: "pointer",
              fontSize: "14px",
              lineHeight: 1,
              padding: "3px 6px",
              transition: "all 0.15s",
            }}
          >
            ✕
          </button>
        </div>

        {/* ── Engine initialisation progress ── */}
        {engineState.status === "loading" && (
          <div style={{ marginBottom: "16px" }}>
            <div
              style={{
                fontSize: "11px",
                color: "#888",
                marginBottom: "6px",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>Loading semantic engine…</span>
              <span style={{ color: "#00FF88", fontWeight: 700 }}>{engineState.progress}%</span>
            </div>
            <div style={{ background: "#0A1A0A", borderRadius: "4px", height: "3px", border: "1px solid #1A3A1A" }}>
              <div
                style={{
                  background: "linear-gradient(90deg, #00FF88, #00CC6A)",
                  height: "3px",
                  borderRadius: "4px",
                  width: `${engineState.progress}%`,
                  transition: "width 0.3s ease",
                  boxShadow: "0 0 8px rgba(0,255,136,0.5)",
                }}
              />
            </div>
          </div>
        )}

        {engineState.status === "error" && (
          <div
            style={{
              marginBottom: "16px",
              padding: "8px 12px",
              background: "#0A0505",
              border: "1px solid rgba(239,68,68,0.2)",
              borderRadius: "4px",
              fontSize: "10px",
              color: "#F87171",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            ⚠ {engineState.message}
          </div>
        )}

        {/* ── Task input ── */}
        <div style={{ marginBottom: "16px" }}>
          <label
            style={{
              display: "block",
              fontSize: "9px",
              fontWeight: 900,
              color: "#2A6A2A",
              marginBottom: "8px",
              textTransform: "uppercase",
              letterSpacing: "0.22em",
            }}
          >
            ◈ What are you focused on?
          </label>

          {/* Quick-select chips */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginBottom: "10px" }}>
            {TASK_CHIPS.map((chip) => {
              const active = task === chip;
              return (
                <button
                  key={chip}
                  onClick={() => setTask(active ? "" : chip)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "3px",
                    fontSize: "10px",
                    fontWeight: 700,
                    cursor: "pointer",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    background: active ? "#6366f1" : "#080808",
                    border: `1px solid ${active ? "#6366f1" : "#1A2A1A"}`,
                    color: active ? "#fff" : "#2A4A2A",
                    transition: "all 0.15s",
                  }}
                >
                  {chip}
                </button>
              );
            })}
          </div>

          {/* Free-text */}
          <input
            type="text"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Or describe your task…"
            style={{
              width: "100%",
              padding: "9px 12px",
              background: "#050505",
              border: "1px solid #1A2A1A",
              borderRadius: "4px",
              color: "#F5F5F5",
              fontSize: "12px",
              fontFamily: "'SF Mono','Fira Code',monospace",
              boxSizing: "border-box",
              outline: "none",
            }}
          />
        </div>

        {/* ── Live preview ── */}
        {preview.status === "analyzing" && (
          <div
            style={{
              marginBottom: "14px",
              padding: "10px 12px",
              background: "#050505",
              border: "1px solid #1A2A1A",
              borderRadius: "4px",
              fontSize: "10px",
              color: "#2A6A2A",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            🔍 Analyzing session…
          </div>
        )}

        {preview.status === "done" && (
          <div
            style={{
              marginBottom: "14px",
              padding: "10px 12px",
              background: "#050F07",
              border: "1px solid rgba(0,255,136,0.2)",
              borderRadius: "4px",
              fontSize: "11px",
              boxShadow: "inset 0 0 12px rgba(0,255,136,0.03)",
            }}
          >
            <div style={{ color: "#00FF88", fontWeight: 900, marginBottom: "5px", textShadow: "0 0 8px rgba(0,255,136,0.4)" }}>
              ✓ Context analyzed
            </div>
            <div style={{ color: "#2A6A2A", lineHeight: 1.7, fontSize: "11px" }}>
              Compression:{" "}
              <strong style={{ color: "#00FF88" }}>{preview.compressionRatio}% smaller</strong>
              {"  ·  "}
              Highlighted files:{" "}
              <strong style={{ color: "#F5F5F5" }}>{preview.highlightedFiles}</strong>
              {"  ·  "}
              Relevant messages:{" "}
              <strong style={{ color: "#F5F5F5" }}>
                {preview.relevantMessages}/{preview.totalMessages}
              </strong>
            </div>
          </div>
        )}

        {preview.status === "error" && (
          <div
            style={{
              marginBottom: "14px",
              padding: "8px 12px",
              background: "#0A0505",
              border: "1px solid rgba(239,68,68,0.2)",
              borderRadius: "4px",
              fontSize: "10px",
              color: "#F87171",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Preview unavailable — will migrate with keyword fallback
          </div>
        )}

        {/* ── Strength toggle ── */}
        <div
          style={{
            marginBottom: "12px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span style={{ fontSize: "9px", fontWeight: 900, color: "#2A6A2A", flex: 1, textTransform: "uppercase", letterSpacing: "0.18em" }}>
            Compression strength
          </span>
          {(["light", "strict"] as const).map((s) => {
            const active = strength === s;
            return (
              <button
                key={s}
                onClick={() => setStrength(s)}
                style={{
                  padding: "5px 14px",
                  borderRadius: "3px",
                  fontSize: "10px",
                  fontWeight: 700,
                  cursor: "pointer",
                  background: active ? "#6366f1" : "#080808",
                  border: `1px solid ${active ? "#6366f1" : "#1A2A1A"}`,
                  color: active ? "#fff" : "#2A4A2A",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  transition: "all 0.15s",
                }}
              >
                {s}
              </button>
            );
          })}
        </div>

        {/* ── Caveman toggle ── */}
        <div style={{ marginBottom: "20px" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              cursor: "pointer",
              fontSize: "11px",
              color: "#2A5A2A",
            }}
          >
            <input
              type="checkbox"
              checked={caveman}
              onChange={(e) => setCaveman(e.target.checked)}
              style={{ cursor: "pointer", accentColor: "#00FF88" }}
            />
            Caveman Mode 🪨{" "}
            <span style={{ color: "#1A3A1A" }}>(ultra-compressed, no filler)</span>
          </label>
        </div>

        {/* ── Error / success banners ── */}
        {migrateState.status === "error" && (
          <div
            style={{
              marginBottom: "14px",
              padding: "8px 12px",
              background: "#0A0505",
              border: "1px solid rgba(239,68,68,0.2)",
              borderRadius: "4px",
              fontSize: "10px",
              color: "#F87171",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {migrateState.message}
          </div>
        )}

        {migrateState.status === "success" && (
          <div
            style={{
              marginBottom: "14px",
              padding: "10px 12px",
              background: "#050F07",
              border: "1px solid rgba(0,255,136,0.2)",
              borderRadius: "4px",
              fontSize: "11px",
              color: "#00FF88",
              fontWeight: 700,
              textShadow: "0 0 8px rgba(0,255,136,0.35)",
            }}
          >
            ✓ Context migrated to {PLATFORM_LABELS[targetPlatform]}!
            {migrateState.compressionRatio > 0 && (
              <span style={{ color: "#666", marginLeft: "4px" }}>
                ({migrateState.compressionRatio}% compressed)
              </span>
            )}
          </div>
        )}

        {/* ── Action buttons ── */}
        <div style={{ display: "flex", gap: "10px" }}>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: "10px",
              background: "#080808",
              border: "1px solid #1A2A1A",
              borderRadius: "4px",
              color: "#2A4A2A",
              cursor: "pointer",
              fontSize: "10px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              transition: "all 0.15s",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleMigrate}
            disabled={isBusy || migrateState.status === "success"}
            style={{
              flex: 2,
              padding: "10px 16px",
              background:
                migrateState.status === "success"
                  ? "#050F07"
                  : isBusy
                  ? "#1e1e3a"
                  : "#6366f1",
              border: migrateState.status === "success" ? "1px solid rgba(0,255,136,0.2)" : "none",
              borderRadius: "4px",
              color: isBusy ? "#3A3A6A" : migrateState.status === "success" ? "#00FF88" : "#fff",
              cursor: isBusy || migrateState.status === "success" ? "not-allowed" : "pointer",
              fontSize: "11px",
              fontWeight: 900,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              boxShadow: (!isBusy && migrateState.status !== "success") ? "0 0 20px rgba(99,102,241,0.4), 0 0 40px rgba(99,102,241,0.1)" : "none",
              transition: "all 0.15s",
            }}
          >
            {migrateState.status === "migrating"
              ? "Migrating…"
              : migrateState.status === "success"
              ? "✓ Done"
              : "Migrate with Attention Engine"}
          </button>
        </div>
      </div>
    </div>
  );
}
