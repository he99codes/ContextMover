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
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "16px",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "#1a1a2e",
          border: "1px solid #2e2e4a",
          borderRadius: "12px",
          padding: "24px",
          maxWidth: "460px",
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          color: "#e5e5e5",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
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
            <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#fff", letterSpacing: "-0.01em" }}>
              Attention Engine
            </h2>
            <p style={{ margin: "3px 0 0", fontSize: "11px", color: "#666" }}>
              Semantic task-aware context migration
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "#555",
              cursor: "pointer",
              fontSize: "18px",
              lineHeight: 1,
              padding: "2px 4px",
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
              <span style={{ color: "#6366f1" }}>{engineState.progress}%</span>
            </div>
            <div style={{ background: "#252540", borderRadius: "4px", height: "3px" }}>
              <div
                style={{
                  background: "linear-gradient(90deg, #6366f1, #8b5cf6)",
                  height: "3px",
                  borderRadius: "4px",
                  width: `${engineState.progress}%`,
                  transition: "width 0.3s ease",
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
              background: "#1f1515",
              border: "1px solid #4a2020",
              borderRadius: "6px",
              fontSize: "11px",
              color: "#cd7b7b",
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
              fontSize: "10px",
              fontWeight: 700,
              color: "#666",
              marginBottom: "8px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            What are you focused on?
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
                    borderRadius: "20px",
                    fontSize: "11px",
                    cursor: "pointer",
                    background: active ? "#6366f1" : "#1e1e32",
                    border: `1px solid ${active ? "#6366f1" : "#333"}`,
                    color: active ? "#fff" : "#aaa",
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
              background: "#0d0d1a",
              border: "1px solid #333",
              borderRadius: "6px",
              color: "#e5e5e5",
              fontSize: "13px",
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
              background: "#0d0d1a",
              border: "1px solid #252540",
              borderRadius: "6px",
              fontSize: "12px",
              color: "#666",
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
              background: "#0a1a0f",
              border: "1px solid #1e3d28",
              borderRadius: "6px",
              fontSize: "12px",
            }}
          >
            <div style={{ color: "#5dd87a", fontWeight: 600, marginBottom: "5px" }}>
              ✓ Context analyzed
            </div>
            <div style={{ color: "#999", lineHeight: 1.7 }}>
              Compression:{" "}
              <strong style={{ color: "#e5e5e5" }}>{preview.compressionRatio}% smaller</strong>
              {"  ·  "}
              Highlighted files:{" "}
              <strong style={{ color: "#e5e5e5" }}>{preview.highlightedFiles}</strong>
              {"  ·  "}
              Relevant messages:{" "}
              <strong style={{ color: "#e5e5e5" }}>
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
              background: "#1f1515",
              border: "1px solid #4a2020",
              borderRadius: "6px",
              fontSize: "11px",
              color: "#cd7b7b",
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
          <span style={{ fontSize: "11px", color: "#666", flex: 1 }}>
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
                  borderRadius: "20px",
                  fontSize: "11px",
                  cursor: "pointer",
                  background: active ? "#6366f1" : "#1e1e32",
                  border: `1px solid ${active ? "#6366f1" : "#333"}`,
                  color: active ? "#fff" : "#aaa",
                  textTransform: "capitalize",
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
              fontSize: "12px",
              color: "#777",
            }}
          >
            <input
              type="checkbox"
              checked={caveman}
              onChange={(e) => setCaveman(e.target.checked)}
              style={{ cursor: "pointer", accentColor: "#6366f1" }}
            />
            Caveman mode{" "}
            <span style={{ color: "#444" }}>(ultra-compressed, no filler)</span>
          </label>
        </div>

        {/* ── Error / success banners ── */}
        {migrateState.status === "error" && (
          <div
            style={{
              marginBottom: "14px",
              padding: "8px 12px",
              background: "#1f1515",
              border: "1px solid #4a2020",
              borderRadius: "6px",
              fontSize: "11px",
              color: "#cd7b7b",
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
              background: "#0a1a0f",
              border: "1px solid #1e3d28",
              borderRadius: "6px",
              fontSize: "12px",
              color: "#5dd87a",
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
              background: "#1e1e32",
              border: "1px solid #333",
              borderRadius: "6px",
              color: "#888",
              cursor: "pointer",
              fontSize: "13px",
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
                  ? "#0a1a0f"
                  : isBusy
                  ? "#3d3f7a"
                  : "#6366f1",
              border: "none",
              borderRadius: "6px",
              color: isBusy ? "#888" : "#fff",
              cursor: isBusy || migrateState.status === "success" ? "not-allowed" : "pointer",
              fontSize: "13px",
              fontWeight: 600,
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
