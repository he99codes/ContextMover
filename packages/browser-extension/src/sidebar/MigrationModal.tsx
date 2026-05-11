// packages/browser-extension/src/sidebar/MigrationModal.tsx
// Unified 3-tier migration modal.
// Tier 1: Full Context — fast verbatim, Tier 2: Smart Summary — auto-extracted,
// Tier 3: Attention Engine — semantic task-aware.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { findTargetPlatformTab, focusTab } from "@/lib/platform-tabs";
import { attentionEngine, getHardwareProfile } from "@/lib/attention-engine";
import type { HardwareProfile } from "@/lib/attention-engine";
import { capabilityDetector } from "@/lib/capability-detector";
import { summarizeWithAttention } from "@/lib/summarizer";
import { promptEngine } from "@/lib/prompt-engine/engine";
import { projectReader } from "@/lib/file-system/project-reader";
import { fileContextBuilder } from "@/lib/file-system/context-builder";
import type { ProjectFile, FileTreeNode } from "@/lib/file-system/project-reader";
import type { PromptTemplate } from "@/lib/prompt-engine/types";
import type { ContextSession, Platform } from "@/lib/types";
import type { QualityScore } from "@/lib/quality/migration-scorer";
import { PROMPTS_URL } from "@/config/urls";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const LAST_TIER_KEY = "contextmover_last_tier";

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

const TIER_LABELS: Record<1 | 2 | 3, string> = {
  1: "Full Context",
  2: "Smart Summary",
  3: "Attention Engine",
};

const MIGRATE_BTN_LABELS: Record<1 | 2 | 3, string> = {
  1: "Migrate Full Context",
  2: "Migrate Smart Summary",
  3: "Migrate with Attention Engine",
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  session: ContextSession;
  targetPlatform: Platform;
  onClose: () => void;
  onSuccess?: (
    tier: 1 | 2 | 3,
    compressionRatio: number,
    chars: number,
    qualityScore?: QualityScore
  ) => void;
  onLimitReached?: (info: {
    type: "simple" | "smart" | "attention";
    used: number;
    limit: number;
  }) => void;
}

type EngineState =
  | { status: "idle" }
  | { status: "loading"; progress: number }
  | { status: "ready" }
  | { status: "error"; message: string };

type PreviewState =
  | { status: "idle" }
  | { status: "analyzing" }
  | { status: "done"; compressionRatio: number; highlightedFiles: number; relevantMessages: number }
  | { status: "error" };

type MigrateState =
  | { status: "idle" }
  | { status: "migrating" }
  | { status: "success"; tier: 1 | 2 | 3; chars: number; compressionRatio: number }
  | { status: "error"; message: string };

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function MigrationModal({
  session,
  targetPlatform,
  onClose,
  onSuccess,
  onLimitReached,
}: Props) {
  const savedTier = (): 1 | 2 | 3 => {
    try {
      const v = Number(localStorage.getItem(LAST_TIER_KEY));
      if (v === 1 || v === 2 || v === 3) return v;
    } catch { /* ignore */ }
    return 2;
  };

  const [tier, setTierRaw] = useState<1 | 2 | 3>(savedTier);
  const [caveman, setCaveman] = useState(false);
  const [task, setTask] = useState("");
  const [strength, setStrength] = useState<"light" | "strict">("light");
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [engineState, setEngineState] = useState<EngineState>({ status: "idle" });
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [migrateState, setMigrateState] = useState<MigrateState>({ status: "idle" });
  const [isWeakDevice, setIsWeakDevice] = useState(false);
  const [preindexed, setPreindexed] = useState(false);
  const [migrateProgress, setMigrateProgress] = useState(0);
  const [migrateStage, setMigrateStage] = useState("");
  const [downgradedToast, setDowngradedToast] = useState<string | null>(null);
  const userHasManuallySelected = useRef(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Prompt Engine state
  const [promptTemplateId, setPromptTemplateId] = useState<string | null>(null);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [allTemplates, setAllTemplates] = useState<{ system: PromptTemplate[]; user: PromptTemplate[] }>({ system: [], user: [] });
  // Project files state
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [projectContextIncluded, setProjectContextIncluded] = useState(true);
  const [autoScoredPaths, setAutoScoredPaths] = useState<{ path: string; score: number }[]>([]);
  const [autoScoring, setAutoScoring] = useState(false);
  const taskAutoRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [modalProjectTree, setModalProjectTree] = useState<FileTreeNode[]>(() =>
    projectReader.isConnected ? projectReader.tree : []
  );

  // ── Lock body scroll while modal is open ────────────────────────────────────
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // ── Detect weak device + load hardware profile on mount ────────────────────
  useEffect(() => {
    capabilityDetector.getEffectiveTier()
      .then((t) => setIsWeakDevice(t === "minimal"))
      .catch(() => setIsWeakDevice(false));
    getHardwareProfile().then((profile) => {
      setHw(profile);
      if (!userHasManuallySelected.current) {
        const saved = Number(localStorage.getItem(LAST_TIER_KEY));
        if (saved !== 1 && saved !== 2 && saved !== 3) {
          setTierRaw(profile.recommendedMigrationTier);
        }
      }
    }).catch(() => { /* ignore — hardware detection is best-effort */ });
  }, []);

  // ── Listen for migration progress + downgrade events ────────────────────────
  useEffect(() => {
    const handler = (msg: { type: string; progress?: number; stage?: string; from?: number; to?: number; reason?: string }) => {
      if (msg.type === "MIGRATION_PROGRESS") {
        setMigrateProgress(msg.progress ?? 0);
        setMigrateStage(msg.stage ?? "");
      } else if (msg.type === "TIER_DOWNGRADED") {
        const reason = msg.reason === "timeout" ? "8s timeout" : "slow device";
        setDowngradedToast(`Used Smart Summary (${reason} — Attention Engine skipped)`);
        setTimeout(() => setDowngradedToast(null), 5000);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // ── Load prompt templates on mount ──────────────────────────────────────────
  useEffect(() => {
    promptEngine.getAllTemplates()
      .then(setAllTemplates)
      .catch((err) => console.warn("[MigrationModal] template load failed:", err));
  }, []);

  // ── Snapshot project files when modal opens ─────────────────────────────────
  useEffect(() => {
    if (projectReader.isConnected && projectReader.getSelectedCount() > 0) {
      projectReader.readSelectedFiles()
        .then(setProjectFiles)
        .catch(() => setProjectFiles([]));
    } else {
      setProjectFiles([]);
    }
    return () => { if (taskAutoRef.current) clearTimeout(taskAutoRef.current); };
  }, []);

  // ── Session-based auto-detect on open (if folder connected, no files yet) ────
  useEffect(() => {
    if (!projectReader.isConnected || projectReader.getSelectedCount() > 0) return;
    if (!attentionEngine.initialized) return;
    void (async () => {
      const query = session.messages.slice(-30).map((m) => m.content).join(" ").slice(0, 3000);
      if (query.trim().length < 20) return;
      setAutoScoring(true);
      try {
        const sections = await attentionEngine.findRelevantFileSections(query);
        if (!sections.length) return;
        const fileScores = new Map<string, number>();
        for (const s of sections) {
          if (!s.file) continue;
          const cur = fileScores.get(s.file) ?? 0;
          if (s.relevanceScore > cur) fileScores.set(s.file, s.relevanceScore);
        }
        const allScored = Array.from(fileScores.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const autoSelect = allScored.filter(([, sc]) => sc > 0.15).slice(0, 6);
        setAutoScoredPaths(allScored.map(([path, score]) => ({ path, score })));
        if (autoSelect.length > 0) {
          projectReader.setSelection(autoSelect.map(([p]) => p));
          setModalProjectTree([...projectReader.tree]);
          setProjectContextIncluded(true);
          const files = await projectReader.readSelectedFiles();
          setProjectFiles(files);
        }
      } catch { /* ignore */ } finally { setAutoScoring(false); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Live file auto-detect as user types the task ──────────────────────────
  useEffect(() => {
    if (taskAutoRef.current) clearTimeout(taskAutoRef.current);
    if (!task.trim() || task.length < 8 || !projectReader.isConnected) return;
    taskAutoRef.current = setTimeout(async () => {
      if (!attentionEngine.initialized) return;
      setAutoScoring(true);
      try {
        const sections = await attentionEngine.findRelevantFileSections(task);
        if (sections.length === 0) return;
        const fileScores = new Map<string, number>();
        for (const s of sections) {
          if (!s.file) continue;
          const cur = fileScores.get(s.file) ?? 0;
          if (s.relevanceScore > cur) fileScores.set(s.file, s.relevanceScore);
        }
        const allScored = Array.from(fileScores.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const autoSelect = allScored.filter(([, sc]) => sc > 0.15).slice(0, 6);
        setAutoScoredPaths(allScored.map(([path, score]) => ({ path, score })));
        if (autoSelect.length > 0) {
          projectReader.setSelection(autoSelect.map(([p]) => p));
          setModalProjectTree([...projectReader.tree]);
          const files = await projectReader.readSelectedFiles();
          setProjectFiles(files);
          setProjectContextIncluded(true);
        }
      } catch { /* ignore */ } finally { setAutoScoring(false); }
    }, 400);
    return () => { if (taskAutoRef.current) clearTimeout(taskAutoRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  function setTier(t: 1 | 2 | 3) {
    userHasManuallySelected.current = true;
    setTierRaw(t);
    try { localStorage.setItem(LAST_TIER_KEY, String(t)); } catch { /* ignore */ }
    setMigrateState({ status: "idle" });
    setPreview({ status: "idle" });
  }

  // ── Init attention engine when tier 3 is selected ──────────────────────────
  useEffect(() => {
    if (tier !== 3) return;
    // If sidebar already preloaded the engine, jump straight to ready.
    if (attentionEngine.initialized) {
      setEngineState({ status: "ready" });
      // Warm the session index so typing the task is instant.
      if (!preindexed) {
        attentionEngine.indexSession(session)
          .then(() => setPreindexed(true))
          .catch(() => { /* ignore */ });
      }
      return;
    }
    setEngineState({ status: "loading", progress: 0 });
    attentionEngine
      .initialize((p) => setEngineState({ status: "loading", progress: p }))
      .then(() => {
        setEngineState({ status: "ready" });
        attentionEngine.indexSession(session)
          .then(() => setPreindexed(true))
          .catch(() => { /* ignore */ });
      })
      .catch((err) => {
        console.warn("[MigrationModal] engine init failed:", err);
        setEngineState({ status: "error", message: "Engine unavailable — keyword fallback will be used" });
      });
  }, [tier, session, preindexed]);

  // ── Debounced live preview (tier 3 only) ────────────────────────────────────
  // DISABLED on weak devices: embedding the task query on every keystroke
  // freezes the UI on slow CPUs. The full attention map is still computed
  // when the user clicks Migrate.
  useEffect(() => {
    if (tier !== 3) return;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    if (!task.trim() || engineState.status !== "ready") {
      setPreview({ status: "idle" });
      return;
    }
    setPreview({ status: "analyzing" });
    // Longer debounce (1200 ms) on non-weak devices to reduce mid-typing jank.
    previewTimerRef.current = setTimeout(async () => {
      try {
        const map = await attentionEngine.buildAttentionMap(session, task, strength);
        const relevantMessages = map.topChunks.filter(
          (c) => c.type === "message" && c.relevanceScore >= map.threshold
        ).length;
        setPreview({ status: "done", compressionRatio: map.compressionRatio, highlightedFiles: map.highlightedFiles.length, relevantMessages });
      } catch {
        setPreview({ status: "error" });
      }
    }, 1200);
    return () => { if (previewTimerRef.current) clearTimeout(previewTimerRef.current); };
  }, [task, strength, engineState.status, session, tier]);

  // ── Auto-dismiss on success ─────────────────────────────────────────────────
  useEffect(() => {
    if (migrateState.status !== "success") return;
    dismissTimerRef.current = setTimeout(() => onClose(), 3000);
    return () => { if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current); };
  }, [migrateState.status, onClose]);

  // ── Migration handler ───────────────────────────────────────────────────────
  async function handleMigrate() {
    setMigrateState({ status: "migrating" });
    setMigrateProgress(0);
    setMigrateStage("");

    const tab = await findTargetPlatformTab(targetPlatform);
    if (!tab?.id) {
      setMigrateState({
        status: "error",
        message: `Open a ${PLATFORM_LABELS[targetPlatform]} tab, then try again.`,
      });
      return;
    }

    await focusTab(tab.id);
    await new Promise((r) => setTimeout(r, 300));

    let precomputedSummary: string | undefined;
    let precomputedAttentionMap: unknown;

    if (tier === 3 && task.trim() && attentionEngine.initialized) {
      try {
        const result = await summarizeWithAttention(session.messages, task.trim(), strength, session);
        precomputedSummary = result.summary;
        precomputedAttentionMap = result.attentionMap;
      } catch (err) {
        console.warn("[MigrationModal] pre-computation failed, service worker will recompute:", err);
      }
    }

    // Build project context block if files are selected and user hasn't removed it
    let projectContext: string | null = null;
    if (projectContextIncluded && projectFiles.length > 0) {
      const treeText = projectReader.buildFileTreeText();
      projectContext = fileContextBuilder.buildProjectContext(
        projectFiles,
        projectReader.rootName,
        treeText,
        targetPlatform,
      );
    }

    chrome.runtime.sendMessage(
      {
        type: "MIGRATE_CONTEXT",
        payload: {
          sessionId: session.id,
          targetPlatform,
          targetTabId: tab.id,
          tier,
          caveman,
          promptTemplateId: promptTemplateId ?? undefined,
          projectContext,
          ...(tier === 3 && {
            useAttentionEngine: true,
            task: task.trim() || undefined,
            strength,
            precomputedSummary,
            precomputedAttentionMap,
          }),
        },
      },
      (response) => {
        if (response?.error === "LIMIT_REACHED" && onLimitReached) {
          onLimitReached({
            type:  response.type  as "simple" | "smart" | "attention",
            used:  response.used  as number,
            limit: response.limit as number,
          });
          onClose();
          return;
        }
        if (response?.error) {
          setMigrateState({ status: "error", message: response.error });
          return;
        }
        const chars = (response?.prompt as string | undefined)?.length ?? 0;
        const ratio =
          tier === 3 && preview.status === "done"
            ? preview.compressionRatio
            : (response?.compressionRatio as number | undefined) ?? 0;
        setMigrateState({ status: "success", tier, chars, compressionRatio: ratio });
        onSuccess?.(tier, ratio, chars, response?.qualityScore as QualityScore | undefined);
      }
    );
  }

  const isBusy = migrateState.status === "migrating" || engineState.status === "loading";
  const isDone = migrateState.status === "success";

  // ── Render ───────────────────────────────────────────────────────────────────
  // Portal to document.body so the overlay escapes the sidebar's animate-slide-up
  // transform ancestor, which would otherwise break position:fixed centering.
  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.88)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "16px",
        backdropFilter: "blur(4px)",
        overflow: "hidden",
        overscrollBehavior: "contain",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onWheel={(e) => { e.stopPropagation(); }}
      onTouchMove={(e) => { e.stopPropagation(); }}
    >
      <div
        style={{
          background: "#0A0A0A",
          border: "1px solid rgba(0,255,136,0.14)",
          borderRadius: "8px",
          padding: "12px",
          maxWidth: "480px",
          width: "100%",
          maxHeight: "min(680px, calc(100vh - 40px))",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          color: "#F5F5F5",
          fontFamily: "Inter, 'SF Pro Display', sans-serif",
          boxShadow: "0 0 0 1px rgba(0,255,136,0.05), 0 24px 80px rgba(0,0,0,0.9)",
        }}
      >
        {/* ── Header ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "11px", fontWeight: 900, color: "#00FF88", letterSpacing: "0.18em", textTransform: "uppercase", textShadow: "0 0 10px rgba(0,255,136,0.4)" }}>
              Migrate Context
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: "9px", color: "#2A5A2A", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              → {PLATFORM_LABELS[targetPlatform]}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "1px solid #1A2A1A", borderRadius: "4px", color: "#2A6A2A", cursor: "pointer", fontSize: "12px", padding: "2px 6px", transition: "all 0.15s" }}
          >
            ✕
          </button>
        </div>

        {/* ── Hardware recommendation banner ── */}
        {hw?.tier === "full" && (
          <div style={{ marginBottom: "6px", padding: "4px 10px", background: "rgba(0,255,136,0.06)", border: "1px solid rgba(0,255,136,0.2)", borderRadius: "4px", fontSize: "9px", color: "#00FF88", letterSpacing: "0.06em", lineHeight: "1" }}>
            {"\uD83D\uDE80 GPU detected (" + (hw.gpuRenderer ?? "GPU") + ") — Full power"}
          </div>
        )}
        {hw?.tier === "balanced" && (
          <div style={{ marginBottom: "6px", padding: "4px 10px", background: "rgba(0,255,136,0.06)", border: "1px solid rgba(0,255,136,0.2)", borderRadius: "4px", fontSize: "9px", color: "#00FF88", letterSpacing: "0.06em", lineHeight: "1" }}>
            {"\u26A1 " + hw.cores + " cores detected — Balanced mode"}
          </div>
        )}
        {hw?.tier === "minimal" && (
          <div style={{ marginBottom: "6px", padding: "4px 10px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: "4px", fontSize: "9px", color: "#F59E0B", letterSpacing: "0.06em", lineHeight: "1" }}>
            ⚠ Slow device — Smart Summary recommended. Attention Engine may take 2+ min.
          </div>
        )}
        {/* ── Tier-downgrade toast ── */}
        {downgradedToast && (
          <div style={{ marginBottom: "6px", padding: "4px 10px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: "4px", fontSize: "9px", color: "#F59E0B", letterSpacing: "0.04em" }}>
            {"\uD83E\uDDE0 " + downgradedToast}
          </div>
        )}

        {/* ── Tier cards ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "4px", marginBottom: "6px" }}>
          {([
            { t: 1 as const, dot: "#666",    label: "Full Context", speed: "Fastest" },
            { t: 2 as const, dot: "#00FF88", label: "Smart",        speed: "Fast"    },
            { t: 3 as const, dot: "#F59E0B", label: "▸ Attention", speed: "Smart"   },
          ] as const).map(({ t, dot, label, speed }) => {
            const active = tier === t;
            return (
              <button
                key={t}
                onClick={() => setTier(t)}
                style={{
                  background: "#1A1A1A",
                  border: `1px solid ${active ? "#00FF88" : "#2A2A2A"}`,
                  borderRadius: "6px",
                  padding: "4px 6px",
                  cursor: "pointer",
                  textAlign: "center",
                  transition: "border-color 0.15s ease",
                  boxShadow: active ? "0 0 8px rgba(0,255,136,0.18), inset 0 0 6px rgba(0,255,136,0.04)" : "none",
                  outline: "none",
                  height: "44px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "3px",
                }}
                onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.borderColor = "#3A3A3A"; }}
                onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.borderColor = "#2A2A2A"; }}
              >
                <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: active ? dot : "#333", flexShrink: 0 }} />
                <div style={{ fontSize: "9px", fontWeight: 900, color: active ? "#00FF88" : "#888", textTransform: "uppercase", letterSpacing: "0.04em", lineHeight: 1.2 }}>
                  {label}
                </div>
                <div style={{ fontSize: "8px", color: active ? "#00CC6A" : "#333" }}>{speed}</div>
                {t === 3 && active && hw?.tier === "minimal" && (
                  <div style={{ fontSize: "8px", color: "#F59E0B", marginTop: "2px", textAlign: "center" }}>
                    ⚠ May take 2+ min
                  </div>
                )}
              </button>
            );
          })}
        </div>


        {/* ── Tier 3: migration progress bar ── */}
        {tier === 3 && migrateState.status === "migrating" && (
          <div style={{ marginBottom: "6px" }}>
            <div style={{ width: "100%", background: "#1A1A1A", borderRadius: "4px", height: "4px", overflow: "hidden" }}>
              <div style={{ width: migrateProgress + "%", height: "100%", background: "#00FF88", transition: "width 300ms ease", boxShadow: "0 0 8px rgba(0,255,136,0.5)" }} />
            </div>
            <div style={{ fontSize: "9px", color: "#6B6B6B", marginTop: "4px", textAlign: "center" }}>
              {migrateStage || "Processing..."} ({migrateProgress}%)
            </div>
            {hw?.tier === "minimal" && (
              <div style={{ fontSize: "8px", color: "#F59E0B", marginTop: "2px", textAlign: "center" }}>
                Will auto-switch to Smart Summary if not done in 8s
              </div>
            )}
          </div>
        )}

        {/* ── Tier 3: engine init progress ── */}
        {tier === 3 && engineState.status === "loading" && (
          <div style={{ marginBottom: "4px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "9px", color: "#666", marginBottom: "4px" }}>
              <span>Loading semantic engine…</span>
              <span style={{ color: "#00FF88", fontWeight: 700 }}>{engineState.progress}%</span>
            </div>
            <div style={{ background: "#111", borderRadius: "4px", height: "2px" }}>
              <div style={{ background: "linear-gradient(90deg, #00FF88, #00CC6A)", height: "2px", borderRadius: "4px", width: `${engineState.progress}%`, transition: "width 0.3s ease", boxShadow: "0 0 6px rgba(0,255,136,0.5)" }} />
            </div>
          </div>
        )}

        {tier === 3 && engineState.status === "error" && (
          <div style={{ marginBottom: "4px", padding: "4px 10px", background: "#110505", border: "1px solid rgba(239,68,68,0.2)", borderRadius: "4px", fontSize: "9px", color: "#F87171", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            ⚠ {engineState.message}
          </div>
        )}

        {/* ── Tier 3: task input ── */}
        {tier === 3 && (
          <div style={{ marginBottom: "6px" }}>
            <div className="cf-chips-row" style={{ display: "flex", flexWrap: "nowrap", overflowX: "auto", gap: "4px", marginBottom: "4px", scrollbarWidth: "none", height: "24px", alignItems: "center" }}>
              {TASK_CHIPS.map((chip) => {
                const active = task === chip;
                return (
                  <button
                    key={chip}
                    onClick={() => setTask(active ? "" : chip)}
                    style={{
                      flexShrink: 0,
                      padding: "2px 7px",
                      borderRadius: "4px",
                      fontSize: "8px",
                      fontWeight: 700,
                      cursor: "pointer",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      background: active ? "rgba(0,255,136,0.12)" : "#111",
                      border: `1px solid ${active ? "rgba(0,255,136,0.4)" : "#222"}`,
                      color: active ? "#00FF88" : "#555",
                      transition: "all 0.15s",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {chip}
                  </button>
                );
              })}
            </div>
            <input
              type="text"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Or describe your task…"
              style={{ width: "100%", padding: "3px 8px", height: "28px", background: "#111", border: "1px solid #222", borderRadius: "4px", color: "#F5F5F5", fontSize: "10px", fontFamily: "Inter, sans-serif", boxSizing: "border-box", outline: "none" }}
            />
          </div>
        )}

        {/* ── Tier 3: live preview ── */}
        {tier === 3 && preview.status === "analyzing" && (
          <div style={{ marginBottom: "6px", padding: "5px 10px", background: "#111", border: "1px solid #1A2A1A", borderRadius: "4px", fontSize: "9px", color: "#2A6A2A", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            · Analyzing…
          </div>
        )}

        {tier === 3 && preview.status === "done" && (
          <div style={{ marginBottom: "6px", padding: "5px 10px", background: "#060F07", border: "1px solid rgba(0,255,136,0.18)", borderRadius: "4px", fontSize: "9px" }}>
            <span style={{ color: "#00FF88", fontWeight: 900 }}>✓ </span>
            <span style={{ color: "#2A6A2A" }}>
              <strong style={{ color: "#00FF88" }}>{preview.compressionRatio}% compressed</strong>
              {" · "}<strong style={{ color: "#F5F5F5" }}>{preview.highlightedFiles}</strong> files
              {" · "}<strong style={{ color: "#F5F5F5" }}>{preview.relevantMessages}/{session.messages.length}</strong> msgs
            </span>
          </div>
        )}

        {tier === 3 && preview.status === "error" && (
          <div style={{ marginBottom: "6px", padding: "5px 10px", background: "#110505", border: "1px solid rgba(239,68,68,0.2)", borderRadius: "4px", fontSize: "9px", color: "#F87171", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Preview unavailable — keyword fallback
          </div>
        )}

        {/* ── Tier 3: strength + GPU on one row ── */}
        {tier === 3 && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
            {(["light", "strict"] as const).map((s) => {
              const active = strength === s;
              return (
                <button
                  key={s}
                  onClick={() => setStrength(s)}
                  style={{
                    padding: "3px 10px",
                    borderRadius: "4px",
                    fontSize: "9px",
                    fontWeight: 700,
                    cursor: "pointer",
                    background: active ? "rgba(0,255,136,0.12)" : "#111",
                    border: `1px solid ${active ? "rgba(0,255,136,0.4)" : "#222"}`,
                    color: active ? "#00FF88" : "#555",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    transition: "all 0.15s",
                  }}
                >
                  {s}
                </button>
              );
            })}
            <div style={{ flex: 1 }} />
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "3px",
                padding: "3px 8px",
                borderRadius: "20px",
                fontSize: "8px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                background: hw?.hasWebGPU ? "rgba(0,255,136,0.1)" : "#111",
                border: `1px solid ${hw?.hasWebGPU ? "rgba(0,255,136,0.3)" : "#222"}`,
                color: hw?.hasWebGPU ? "#00FF88" : "#555",
              }}
            >
              {hw?.hasWebGPU ? "▸ GPU" : "□ CPU"}
            </span>
          </div>
        )}

        {/* ── Prompt Engine section ── */}
        {(() => {
          const selectedTemplate = promptTemplateId
            ? ([...allTemplates.system, ...allTemplates.user].find((t) => t.id === promptTemplateId) ?? null)
            : null;
          return (
            <div style={{ marginBottom: "6px" }}>
              {/* Collapsed row */}
              <button
                onClick={() => setPromptExpanded((v) => !v)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "4px 10px", height: "32px", borderRadius: "5px", cursor: "pointer",
                  border: `1px solid ${selectedTemplate ? "rgba(0,255,136,0.35)" : "#222"}`,
                  background: selectedTemplate ? "rgba(0,255,136,0.05)" : "#111",
                  outline: "none", transition: "all 0.15s ease",
                }}
              >
                <span style={{ fontSize: "9px", fontWeight: 900, color: selectedTemplate ? "#00FF88" : "#888", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  ⚙ Prompt Engine
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                  <span style={{ fontSize: "9px", color: selectedTemplate ? "#00FF88" : "#555", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selectedTemplate ? `${selectedTemplate.icon} ${selectedTemplate.name}` : "None"}
                  </span>
                  <span style={{ fontSize: "8px", color: "#444" }}>{promptExpanded ? "▲" : "▼"}</span>
                </div>
              </button>

              {/* Expanded panel */}
              {promptExpanded && (
                <div style={{ marginTop: "4px", padding: "8px 10px", border: "1px solid #1A1A1A", borderRadius: "5px", background: "#0D0D0D" }}>
                  <div style={{ fontSize: "9px", fontWeight: 700, color: "#555", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "5px" }}>Template</div>
                  <select
                    value={promptTemplateId ?? ""}
                    onChange={(e) => {
                      if (e.target.value === "__create") {
                        chrome.tabs.create({ url: PROMPTS_URL });
                        return;
                      }
                      setPromptTemplateId(e.target.value || null);
                    }}
                    style={{ width: "100%", padding: "4px 8px", background: "#111", border: "1px solid #2A2A2A", borderRadius: "4px", color: "#F5F5F5", fontSize: "10px", outline: "none", cursor: "pointer", fontFamily: "Inter, sans-serif" }}
                  >
                    <option value="">─── None ───</option>
                    <optgroup label="─── System Templates ───">
                      {allTemplates.system.map((t) => (
                        <option key={t.id} value={t.id}>{t.icon} {t.name}</option>
                      ))}
                    </optgroup>
                    {allTemplates.user.length > 0 && (
                      <optgroup label="─── My Templates ───">
                        {allTemplates.user.map((t) => (
                          <option key={t.id} value={t.id}>{t.icon} {t.name}</option>
                        ))}
                      </optgroup>
                    )}
                    <option value="__create">+ Create template</option>
                  </select>

                  {/* Preview */}
                  {selectedTemplate ? (
                    <>
                      <div style={{ marginTop: "5px", padding: "5px 8px", background: "#111", border: "1px solid #1A1A1A", borderRadius: "4px", fontSize: "9px", color: "#6B6B6B", fontStyle: "italic", lineHeight: 1.5 }}>
                        {selectedTemplate.content.slice(0, 100)}&hellip;
                      </div>
                      {selectedTemplate.tags.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "3px", marginTop: "4px" }}>
                          {selectedTemplate.tags.map((tag) => (
                            <span key={tag} style={{ padding: "1px 5px", borderRadius: "3px", background: "#1A1A1A", border: "1px solid #2A2A2A", fontSize: "8px", color: "#555" }}>{tag}</span>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ marginTop: "5px", fontSize: "9px", color: "#444", fontStyle: "italic" }}>
                      No prompt template — migrating context only
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => chrome.tabs.create({ url: PROMPTS_URL })}
                    style={{ display: "block", marginTop: "6px", fontSize: "9px", color: "#00FF88", background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "none" }}
                  >
                    Manage templates →
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Caveman toggle — all tiers ── */}
        <div style={{ marginBottom: "6px" }}>
          <button
            onClick={() => setCaveman((v) => !v)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "4px 10px",
              height: "32px",
              borderRadius: "5px",
              border: `1px solid ${caveman ? "rgba(0,255,136,0.35)" : "#222"}`,
              background: caveman ? "rgba(0,255,136,0.07)" : "#111",
              cursor: "pointer",
              transition: "all 0.15s ease",
              outline: "none",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "9px", fontWeight: 900, color: caveman ? "#00FF88" : "#888", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Caveman Mode
              </span>
              <span style={{ fontSize: "8px", color: "#444" }}>— removes filler</span>
            </div>
            <div style={{ position: "relative", width: "28px", height: "16px", borderRadius: "8px", background: caveman ? "#00FF88" : "#222", transition: "background 0.2s ease", flexShrink: 0 }}>
              <div style={{ position: "absolute", top: "2px", left: caveman ? "12px" : "2px", width: "12px", height: "12px", borderRadius: "50%", background: caveman ? "#0A0A0A" : "#555", transition: "left 0.2s ease" }} />
            </div>
          </button>
        </div>

        {/* ── Project Files — just before migrate ── */}
        {(() => {
          const isConn = projectReader.isConnected;
          const hasSel = projectFiles.length > 0;
          const flattenTree = (nodes: FileTreeNode[]): FileTreeNode[] => {
            const out: FileTreeNode[] = [];
            const walk = (ns: FileTreeNode[]) => {
              for (const n of ns) {
                if (n.kind === "file") out.push(n);
                else if (n.children) walk(n.children);
              }
            };
            walk(nodes);
            return out;
          };
          const handleConnectFolder = async () => {
            try {
              const tree = await projectReader.openFolder();
              setModalProjectTree(tree);
              setProjectFiles([]);
              setAutoScoredPaths([]);
              const all = await projectReader.readAllFiles();
              if (!all.length) return;
              setAutoScoring(true);
              try {
                await attentionEngine.indexProjectFiles(all);
                const q = task.trim().length >= 8
                  ? task
                  : session.messages.slice(-30).map((m) => m.content).join(" ").slice(0, 3000);
                if (q.trim().length < 8) return;
                const sections = await attentionEngine.findRelevantFileSections(q);
                if (!sections.length) return;
                const fileScores = new Map<string, number>();
                for (const s of sections) {
                  if (!s.file) continue;
                  const cur = fileScores.get(s.file) ?? 0;
                  if (s.relevanceScore > cur) fileScores.set(s.file, s.relevanceScore);
                }
                const allScored = Array.from(fileScores.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
                const autoSelect = allScored.filter(([, sc]) => sc > 0.15).slice(0, 6);
                setAutoScoredPaths(allScored.map(([path, score]) => ({ path, score })));
                if (autoSelect.length > 0) {
                  projectReader.setSelection(autoSelect.map(([p]) => p));
                  setModalProjectTree([...projectReader.tree]);
                  setProjectContextIncluded(true);
                  const files = await projectReader.readSelectedFiles();
                  setProjectFiles(files);
                }
              } finally { setAutoScoring(false); }
            } catch { /* user cancelled */ }
          };
          const handleDisconnectFolder = () => {
            projectReader.disconnect();
            setModalProjectTree([]);
            setProjectFiles([]);
            setAutoScoredPaths([]);
          };
          const handleToggleFile = (path: string) => {
            projectReader.toggleSelect(path);
            setModalProjectTree([...projectReader.tree]);
            setAutoScoredPaths([]);
            projectReader.readSelectedFiles().then(setProjectFiles).catch(() => {});
          };
          const flat = flattenTree(modalProjectTree);
          const scoredSet = new Set(autoScoredPaths.map((s) => s.path));
          const sorted = [
            ...autoScoredPaths.map(({ path, score }) => ({ path, name: path.split("/").pop() ?? path, score })),
            ...flat.filter((f) => !scoredSet.has(f.path)).map((f) => ({ path: f.path, name: f.name, score: undefined })),
          ];
          return (
            <div style={{ marginBottom: 6 }}>
              <div style={{
                padding: "6px 10px", borderRadius: 5, transition: "all 0.15s",
                border: `1px solid ${hasSel && projectContextIncluded ? "rgba(0,255,136,0.3)" : isConn ? "rgba(255,255,255,0.07)" : "#1A1A1A"}`,
                background: hasSel && projectContextIncluded ? "rgba(0,255,136,0.04)" : "#0D0D0D",
              }}>
                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isConn ? 6 : 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 9, fontWeight: 900, color: hasSel && projectContextIncluded ? "#00FF88" : "#555", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                      📁 Project Files
                    </span>
                    {autoScoring && <span style={{ fontSize: 8, color: "#818CF8" }}>scanning…</span>}
                    {autoScoredPaths.length > 0 && !autoScoring && (
                      <span style={{ fontSize: 8, color: "#818CF8", background: "rgba(99,102,241,0.12)", borderRadius: 3, padding: "1px 5px" }}>✨ auto</span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {hasSel && (
                      <button type="button" onClick={() => setProjectContextIncluded((v) => !v)}
                        style={{ fontSize: 8, color: projectContextIncluded ? "#00FF88" : "#555", background: "none", border: "none", padding: 0, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        {projectContextIncluded ? "✓ Included" : "○ Excluded"}
                      </button>
                    )}
                    {isConn && (
                      <button type="button" onClick={handleDisconnectFolder} title="Disconnect"
                        style={{ fontSize: 11, color: "#333", background: "none", border: "none", cursor: "pointer", lineHeight: 1 }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#EF4444")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "#333")}>×</button>
                    )}
                  </div>
                </div>
                {/* Not connected */}
                {!isConn && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button type="button" onClick={handleConnectFolder} style={{
                      fontSize: 9, color: "#00FF88", background: "rgba(0,255,136,0.06)",
                      border: "1px solid rgba(0,255,136,0.2)", borderRadius: 4,
                      padding: "4px 10px", cursor: "pointer", fontWeight: 700,
                      letterSpacing: "0.06em", textTransform: "uppercase",
                    }}>+ Connect Folder</button>
                    <span style={{ fontSize: 8, color: "#333" }}>auto-detect files from your task</span>
                  </div>
                )}
                {/* Connected */}
                {isConn && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: 8, color: "#444", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 100 }}>
                        📁 {projectReader.rootName}
                      </span>
                      {([["☑ All", () => { projectReader.selectAll(); setModalProjectTree([...projectReader.tree]); setAutoScoredPaths([]); projectReader.readSelectedFiles().then(setProjectFiles).catch(() => {}); }],
                         ["☐ None", () => { projectReader.clearAll(); setModalProjectTree([...projectReader.tree]); setAutoScoredPaths([]); setProjectFiles([]); }]] as [string, () => void][]).map(([label, fn]) => (
                        <button key={label} type="button" onClick={fn}
                          style={{ fontSize: 8, color: "#555", background: "none", border: "none", cursor: "pointer" }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = "#F5F5F5")}
                          onMouseLeave={(e) => (e.currentTarget.style.color = "#555")}>{label}</button>
                      ))}
                    </div>
                    {sorted.length === 0 ? (
                      <div style={{ fontSize: 9, color: "#333", paddingBottom: 2 }}>No files indexed</div>
                    ) : (
                      <div style={{ maxHeight: 112, overflowY: "auto", marginBottom: 4 }}>
                        {sorted.map(({ path, name, score }) => {
                          const sel = projectReader.isSelected(path);
                          return (
                            <div key={path} onClick={() => handleToggleFile(path)}
                              style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 4px", cursor: "pointer", borderRadius: 3, background: sel ? "rgba(0,255,136,0.05)" : "transparent" }}
                              onMouseEnter={(e) => { if (!sel) (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.03)"; }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = sel ? "rgba(0,255,136,0.05)" : "transparent"; }}>
                              <span style={{ fontSize: 9, color: sel ? "#00FF88" : "#333", flexShrink: 0 }}>{sel ? "☑" : "☐"}</span>
                              <span style={{ fontSize: 9, color: sel ? "#F5F5F5" : "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{name}</span>
                              {score !== undefined && (
                                <span style={{ fontSize: 7, color: "#818CF8", background: "rgba(99,102,241,0.12)", borderRadius: 3, padding: "1px 4px", flexShrink: 0 }}>{Math.round(score * 100)}%</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div style={{ fontSize: 8, color: hasSel ? "#444" : "#333" }}>
                      {hasSel
                        ? <>{projectFiles.length} file{projectFiles.length !== 1 ? "s" : ""} · {fileContextBuilder.formatSize(projectFiles.reduce((s, f) => s + f.size, 0))}{(() => { const w = fileContextBuilder.getTokenWarning(projectFiles, targetPlatform); return w ? <span style={{ color: "#F59E0B", marginLeft: 6 }}>{w}</span> : null; })()}</>
                        : autoScoring ? "Scanning…" : "Select files or type task to auto-detect"}
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })()}

        {/* ── Error banner ── */}
        {migrateState.status === "error" && (
          <div style={{ marginBottom: "6px", padding: "4px 10px", background: "#110505", border: "1px solid rgba(239,68,68,0.2)", borderRadius: "4px", fontSize: "9px", color: "#F87171", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {migrateState.message}
          </div>
        )}

        {/* ── Success banner ── */}
        {migrateState.status === "success" && (
          <div style={{ marginBottom: "6px", padding: "5px 10px", background: "#060F07", border: "1px solid rgba(0,255,136,0.25)", borderRadius: "5px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "3px" }}>
              <span style={{ fontSize: "14px" }}>✓</span>
              <span style={{ fontSize: "10px", fontWeight: 900, color: "#00FF88", textShadow: "0 0 8px rgba(0,255,136,0.4)" }}>Context migrated!</span>
            </div>
            <div style={{ fontSize: "9px", color: "#2A6A2A" }}>
              <strong style={{ color: "#F5F5F5" }}>{migrateState.chars.toLocaleString()} chars</strong>
              {migrateState.compressionRatio > 0 && <> · <strong style={{ color: "#00FF88" }}>{migrateState.compressionRatio}% of original</strong></>}
              {" · "}Tier: <span style={{ color: "#00FF88" }}>{TIER_LABELS[migrateState.tier]}</span>
            </div>
            <div style={{ marginTop: "4px", fontSize: "8px", color: "#333" }}>Auto-closing in 3s…</div>
          </div>
        )}

        {/* ── Action buttons ── */}
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={onClose}
            style={{ flex: 1, height: "36px", padding: "0 12px", background: "#111", border: "1px solid #222", borderRadius: "4px", color: "#555", cursor: "pointer", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", transition: "all 0.15s" }}
          >
            Cancel
          </button>
          <button
            onClick={handleMigrate}
            disabled={isBusy || isDone}
            style={{
              flex: 2,
              height: "36px",
              padding: "0 16px",
              background: isDone ? "#060F07" : isBusy ? "#0D2A0D" : "#00FF88",
              border: isDone ? "1px solid rgba(0,255,136,0.25)" : "none",
              borderRadius: "4px",
              color: isDone ? "#00FF88" : isBusy ? "#2A6A2A" : "#0A0A0A",
              cursor: isBusy || isDone ? "not-allowed" : "pointer",
              fontSize: "10px",
              fontWeight: 900,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              boxShadow: (!isBusy && !isDone) ? "0 0 18px rgba(0,255,136,0.45), 0 0 36px rgba(0,255,136,0.12)" : "none",
              transition: "all 0.15s",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
            }}
          >
            {migrateState.status === "migrating" && (
              <span style={{ display: "inline-block", animation: "spin 0.7s linear infinite" }}>↻</span>
            )}
            {migrateState.status === "migrating"
              ? "Migrating…"
              : isDone
              ? "✓ Done"
              : MIGRATE_BTN_LABELS[tier]}
          </button>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } .cf-chips-row::-webkit-scrollbar { display: none; }`}</style>
    </div>,
    document.body
  );
}
