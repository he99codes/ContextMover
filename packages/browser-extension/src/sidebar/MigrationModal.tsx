/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

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
// [CM-PROMPT-SNOOZE] coming soon — re-enable when prompt engine ships
// import { promptEngine } from "@/lib/prompt-engine/engine";
import { projectReader } from "@/lib/file-system/project-reader";
import { fileContextBuilder } from "@/lib/file-system/context-builder";
import type { ProjectFile, FileTreeNode } from "@/lib/file-system/project-reader";
// [CM-PROMPT-SNOOZE] coming soon — re-enable when prompt engine ships
// import type { PromptTemplate } from "@/lib/prompt-engine/types";
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
  attentionAvailable?: boolean;
  isPro?: boolean;
  onClose: () => void;
  onSuccess?: (
    tier: 1 | 2 | 3,
    compressionRatio: number,
    chars: number,
    qualityScore?: QualityScore,
    coverageStats?: {
      messagesScored: number
      messagesUsed: number
      categoryCounts: Record<string, number>
    }
  ) => void;
  onLimitReached?: (info: {
    tier: number;
    used: number;
    limit: number;
    daysUntilReset: number;
    upgradeUrl: string;
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

const PLATFORM_UPLOAD_HINTS: Partial<Record<Platform, string>> = {
  claude:     "Click the 📎 button in Claude's chat box, select the downloaded file, then send",
  chatgpt:    "Click the 📎 button in ChatGPT's message box, select the downloaded file, then send",
  gemini:     "Click the + button in Gemini's prompt box, choose the file, then send",
  grok:       "Click the attachment icon in Grok's chat box, select the downloaded file, then send",
  perplexity: "Click the 📎 icon in Perplexity's search box, select the downloaded file, then send",
  deepseek:   "Click the 📎 icon in DeepSeek's chat box, select the downloaded file, then send",
}

function MigrationSuccess({
  migrationFile,
  cacheKey,
  injected,
  injectionError,
  qualityWarning,
  elapsed,
  targetPlatform,
  injectTabId,
  isPro,
  coverageStats,
  onClose
}: {
  migrationFile: {
    filename: string
    charCount: number
    estimatedTokens: number
    tier: number
    platform: string
    sessionTitle: string
  }
  cacheKey: string
  injected: boolean
  injectionError?: string
  qualityWarning?: string
  elapsed: number
  targetPlatform: string
  injectTabId?: number
  isPro?: boolean
  coverageStats?: {
    messagesScored: number
    messagesUsed: number
    categoryCounts: Record<string, number>
  }
  onClose: () => void
}) {
  // ── Download status ──────────────────────────────────────────────────────
  type Status = 'idle' | 'downloading' | 'downloaded'
  const [status, setStatus] = useState<Status>('idle')

  // ── Inject state machine ──────────────────────────────
  type InjectState = 'idle' | 'success' | 'failed'
  const [injectState, setInjectState] = useState<InjectState>('idle')
  // [CM-FIX-4] guard against double-click: true while async sendMessage is in-flight
  const [isInjecting, setIsInjecting] = useState(false)

  const fileRef = useRef<File | null>(null)
  const [fileReady, setFileReady] = useState(false)
  const [fetchError, setFetchError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const sizeKB = Math.round(migrationFile.charCount / 1024)

  // [CM-FIX-2] Log injection failure for developer visibility — not shown in UI
  if (injectionError) console.error("[CM:migration] Auto-inject failed:", injectionError);

  const platformKey = targetPlatform.toLowerCase() as Platform
  const uploadHint =
    PLATFORM_UPLOAD_HINTS[platformKey] ??
    `Use the file-attachment button in ${targetPlatform} to attach the downloaded file`

  async function getFileContent(): Promise<string | null> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'GET_CACHED_FILE', cacheKey },
        (response) => {
          if (response?.success) resolve(response.file.content)
          else resolve(null)
        }
      )
    })
  }

  function deleteCachedFile(): void {
    chrome.runtime.sendMessage(
      { type: 'DELETE_CACHED_FILE', cacheKey },
      () => {}
    )
  }

  function handleDownload(): void {
    if (!fileContent || status === 'downloading') return
    setError(null)
    setStatus('downloading')

    const blob = new Blob([fileContent], { type: 'text/xml' })
    const url = URL.createObjectURL(blob)

    const finish = () => {
      setStatus('downloaded')
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    }
    const fail = (msg: string) => {
      console.warn('[CM:migration] download failed:', msg)
      setError('Download failed — please try again')
      setStatus('idle')
      URL.revokeObjectURL(url)
    }

    try {
      if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
        chrome.downloads.download(
          { url, filename: migrationFile.filename, saveAs: false },
          (downloadId) => {
            const lastError = chrome.runtime.lastError
            if (lastError || downloadId === undefined) {
              fail(lastError?.message ?? 'unknown error')
            } else {
              finish()
            }
          }
        )
      } else {
        const a = document.createElement('a')
        a.href = url
        a.download = migrationFile.filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        finish()
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    let cancelled = false
    async function prefetch() {
      try {
        const content = await getFileContent()
        if (cancelled) return
        if (!content) { setFetchError(true); return }
        setFileContent(content)
        setFileReady(true)
      } catch { if (!cancelled) setFetchError(true) }
    }
    prefetch()
    return () => { cancelled = true }
  }, [])

  // Build (or rebuild) the File object whenever fileContent becomes available.
  // Kept in a ref so onDragStart always reads the current value without
  // triggering extra renders.
  useEffect(() => {
    if (!fileContent) { fileRef.current = null; return }
    fileRef.current = new File(
      [fileContent],
      migrationFile.filename,
      { type: 'text/xml' }
    )
  }, [fileContent, migrationFile.filename])

  // Free the cache slot when the user closes the modal after a successful
  // download — the file is now on disk so the in-memory cache is no longer
  // needed. (The 30-min TTL would catch this anyway.)
  function handleClose(): void {
    if (status === 'downloaded' || injectState === 'success') deleteCachedFile()
    onClose()
  }

  return (
    <div style={{ padding: '4px' }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center',
        gap:'8px', marginBottom:'16px' }}>
        <span style={{ fontSize:'20px' }}>✅</span>
        <div>
          <div style={{ fontSize:'12px', fontWeight:900,
            color:'#00FF88', textTransform:'uppercase',
            letterSpacing:'0.1em' }}>
            Migration complete
          </div>
          <div style={{ fontSize:'10px', color: (!injected && injectionError && !injectTabId) ? '#EF4444' : '#6B6B6B', marginTop:'2px' }}>
            {injected
              ? `Instructions injected into ${targetPlatform} ✓`
              : injectTabId
              ? `Context file ready — click below to inject`
              : injectionError
              // [CM-FIX-2] removed user-facing error: raw injectionError string from SW
              ? `Open ${targetPlatform} and paste the downloaded file`
              : `Open ${targetPlatform} and paste instructions`}
          </div>
          {migrationFile.tier === 2 && coverageStats && (
            <div style={{ fontSize: '10px', color: 'var(--color-text-secondary, #888)', marginTop: '4px' }}>
              Smart summary: {coverageStats.categoryCounts.goals || 0} goals · {coverageStats.categoryCounts.decisions || 0} decisions · {coverageStats.categoryCounts.bugs || 0} bugs · {coverageStats.messagesUsed}/{coverageStats.messagesScored} messages used
            </div>
          )}
        </div>
      </div>

      {/* ── Tier-fallback quality badge ── */}
      {qualityWarning && (
        <div style={{
          marginBottom: '12px',
          padding: '6px 10px',
          background: 'rgba(239,68,68,0.07)',
          border: '1px solid rgba(239,68,68,0.22)',
          borderRadius: '4px',
          fontSize: '9px',
          color: '#EF4444',
          letterSpacing: '0.04em',
          lineHeight: '1.4',
        }}>
          {'⚠️ Context: Compressed — '}{qualityWarning}
        </div>
      )}

      {fetchError ? (
        <div style={{
          background: 'rgba(255,68,68,0.08)',
          border: '2px dashed rgba(255,68,68,0.3)',
          borderRadius: '10px',
          padding: '20px 14px',
          marginBottom: '12px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize:'28px', marginBottom:'8px' }}>⚠️</div>
          <div style={{ fontSize:'11px', fontWeight:900,
            color:'#FF4444', marginBottom:'4px' }}>
            File expired
          </div>
          <div style={{ fontSize:'9px', color:'#6B6B6B' }}>
            Please run migration again
          </div>
        </div>
      ) : !fileReady ? (
        <div style={{
          background: '#111',
          border: '2px dashed #2A2A2A',
          borderRadius: '10px',
          padding: '20px 14px',
          marginBottom: '12px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize:'28px', marginBottom:'8px' }}>⏳</div>
          <div style={{ fontSize:'11px', fontWeight:900,
            color:'#6B6B6B', marginBottom:'4px' }}>
            Preparing file...
          </div>
          <div style={{ fontSize:'9px', color:'#4A4A4A' }}>
            One moment
          </div>
        </div>
      ) : (
        <>
          {/* ── Inject-to-chat button (primary option) ────────────────── */}
          {/* [CM-FIX-4] treat as already-done when SW already injected (e.g. KnowledgeSynthesizer path) */}
          {injectState === 'success' || injected ? (
            <div style={{
              background: 'rgba(0,255,136,0.08)',
              border: '1px solid rgba(0,255,136,0.2)',
              borderRadius: '10px',
              padding: '20px 14px',
              marginBottom: '12px',
              textAlign: 'center'
            }}>
              <div style={{ fontSize: '28px', marginBottom: '8px' }}>🎉</div>
              <div style={{ fontSize: '11px', fontWeight: 900,
                color: '#00FF88', marginBottom: '4px' }}>
                File injected into chat!
              </div>
              <div style={{ fontSize: '9px', color: '#6B6B6B' }}>
                The file was attached — send the message to continue
              </div>
            </div>
          ) : injectState === 'failed' ? (
            <div style={{
              background: 'rgba(0,255,136,0.06)',
              border: '1px solid rgba(0,255,136,0.15)',
              borderRadius: '10px',
              padding: '20px 14px',
              marginBottom: '12px',
              textAlign: 'center'
            }}>
              <div style={{ fontSize: '28px', marginBottom: '8px' }}>⬇️</div>
              <div style={{ fontSize: '11px', fontWeight: 900,
                color: '#00FF88', marginBottom: '4px' }}>
                Auto-inject failed — file downloaded instead
              </div>
              <div style={{ fontSize: '9px', color: '#6B6B6B', lineHeight: 1.5 }}>
                The file was saved to your Downloads folder — attach it
                via the 📎 button in the chat.
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                if (isInjecting) return // [CM-FIX-4] guard against double-click during async
                if (!fileContent || !injectTabId) {
                  handleDownload()
                  setInjectState('failed')
                  return
                }
                setIsInjecting(true) // [CM-FIX-4] disable button immediately while in-flight
                chrome.runtime.sendMessage(
                  {
                    type: 'INJECT_FILE_TO_TAB',
                    tabId: injectTabId,
                    fileName: migrationFile.filename,
                    fileContent,
                  },
                  (response) => {
                    setIsInjecting(false)
                    if (response?.ok) {
                      setInjectState('success')
                      deleteCachedFile()
                    } else {
                      handleDownload()
                      setInjectState('failed')
                    }
                  }
                )
              }}
              disabled={!fileReady || isInjecting}
              style={{
                display: 'block',
                width: '100%',
                background: 'rgba(0,255,136,0.04)',
                border: '2px dashed rgba(0,255,136,0.35)',
                borderRadius: '10px',
                padding: '20px 14px',
                marginBottom: '12px',
                cursor: fileReady ? 'pointer' : 'wait',
                textAlign: 'center',
                transition: 'all 0.15s ease',
              }}
            >
              <div style={{ fontSize: '28px', marginBottom: '8px' }}>📁</div>
              <div style={{ fontSize: '11px', fontWeight: 900,
                color: '#00FF88', marginBottom: '4px' }}>
                Inject file into AI chat
              </div>
              <div style={{ fontSize: '9px', color: '#6B6B6B',
                fontFamily: 'monospace', marginBottom: '4px',
                wordBreak: 'break-all' }}>
                {migrationFile.filename}
              </div>
              <div style={{ fontSize: '9px', color: '#4A4A4A' }}>
                {sizeKB}KB · ~{migrationFile.estimatedTokens.toLocaleString()} tokens
              </div>
            </button>
          )}

          {/* ── Download button ──── */}
          <div style={{ textAlign: 'center', marginBottom: '14px' }}>
            <button
              onClick={handleDownload}
              disabled={status === 'downloading'}
              title="Download file"
              style={{
                background: 'transparent',
                border: '1px solid #2A2A2A',
                borderRadius: '4px',
                color: status === 'downloading' ? '#3A3A3A' : '#6B6B6B',
                fontSize: '9px',
                fontWeight: 700,
                padding: '6px 14px',
                cursor: status === 'downloading' ? 'not-allowed' : 'pointer',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              {status === 'downloading' ? '⏳ Downloading...'
                : status === 'downloaded' ? '✓ Downloaded'
                : '⬇ Download file'}
            </button>
          </div>

          {/* ── Upload hint (shown after manual download) ───────────────── */}
          {status === 'downloaded' && injectState !== 'success' && (
            <div style={{
              background: '#0A0A0A',
              border: '1px solid rgba(0,255,136,0.25)',
              borderRadius: '8px',
              padding: '12px 14px',
              marginBottom: '14px'
            }}>
              <div style={{
                fontSize: '9px', fontWeight: 900, color: '#00FF88',
                textTransform: 'uppercase', letterSpacing: '0.12em',
                marginBottom: '8px'
              }}>
                Now upload to {PLATFORM_LABELS[platformKey] ?? targetPlatform}
              </div>
              <div style={{ fontSize: '11px', color: '#C8C8C8',
                lineHeight: 1.5 }}>
                {uploadHint}
              </div>
            </div>
          )}

          {/* ── Error state ─────────────────────────────────────────────── */}
          {error && (
            <div style={{
              fontSize: '10px', color: '#FF4444',
              marginBottom: '10px', textAlign: 'center'
            }}>
              {error}
            </div>
          )}
        </>
      )}

      <div style={{ fontSize:'9px', color:'#3A3A3A',
        textAlign:'center', marginBottom:'12px' }}>
        File auto-expires in 30 minutes · {(elapsed/1000).toFixed(1)}s
      </div>

      <button onClick={handleClose} style={{
        width:'100%', padding:'10px', background:'transparent',
        border:'1px solid #2A2A2A', borderRadius:'4px',
        color:'#6B6B6B', fontSize:'10px', fontWeight:700,
        cursor:'pointer', textTransform:'uppercase',
        letterSpacing:'0.1em'
      }}>
        Done
      </button>
    </div>
  )
}

export default function MigrationModal({
  session,
  targetPlatform,
  attentionAvailable = true,
  isPro = false,
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
  const [qualityWarning, setQualityWarning] = useState<string | null>(null);
  const [migrationResult, setMigrationResult] = useState<any>(null);
  const [targetTabId, setTargetTabId] = useState<number | null>(null);
  // [CM-TIER-FIX] low hardware pre-flight warning — user decides, not the extension
  const [showHardwareWarning, setShowHardwareWarning] = useState(false);
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const userHasManuallySelected = useRef(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref-copy of qualityWarning — readable synchronously inside the migration
  // response callback (React state updates are async so the state value can
  // lag behind when the response handler fires).
  const qualityWarningRef = useRef<string | null>(null);
  // [CM-PROMPT-SNOOZE] coming soon — re-enable when prompt engine ships
  // const [promptTemplateId, setPromptTemplateId] = useState<string | null>(null);
  // const [promptExpanded, setPromptExpanded] = useState(false);
  // const [allTemplates, setAllTemplates] = useState<{ system: PromptTemplate[]; user: PromptTemplate[] }>({ system: [], user: [] });
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
    const handler = (msg: { type: string; progress?: number; stage?: string; from?: number; to?: number; reason?: string; originalTier?: number; fallbackTier?: number }) => {
      if (msg.type === "MIGRATION_PROGRESS") {
        setMigrateProgress(msg.progress ?? 0);
        setMigrateStage(msg.stage ?? "");
      } else if (msg.type === "TIER_DOWNGRADED") {
        const reason = msg.reason === "timeout" ? "8s timeout" : "slow device";
        setDowngradedToast(`Used Smart Summary (${reason} — Attention Engine skipped)`);
        setTimeout(() => setDowngradedToast(null), 5000);
      } else if (msg.type === "MIGRATION_QUALITY_WARNING") {
        const from = msg.originalTier ?? "?", to = msg.fallbackTier ?? 1;
        const warningText = `Tier ${from}→${to} fallback — context compressed (semantic indexing unavailable)`;
        qualityWarningRef.current = warningText;
        setQualityWarning(warningText);
        setTimeout(() => setQualityWarning(null), 8_000);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // [CM-PROMPT-SNOOZE] coming soon — re-enable when prompt engine ships
  // ── Load prompt templates on mount ──────────────────────────────────────────
  // useEffect(() => {
  //   promptEngine.getAllTemplates()
  //     .then(setAllTemplates)
  //     .catch((err) => console.warn("[MigrationModal] template load failed:", err));
  // }, []);

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
    // [CM-TIER-FIX] reset warning on tier change so it can show again for new session
    setWarningAcknowledged(false);
    setShowHardwareWarning(false);
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
    // [CM-TIER-FIX] low hardware pre-flight warning — user decides, not the extension
    if (tier === 3 && hw?.tier === 'minimal' && !warningAcknowledged) {
      setShowHardwareWarning(true);
      return; // do not start migration yet
    }

    setMigrateState({ status: "migrating" });
    setMigrateProgress(0);
    setMigrateStage("");
    qualityWarningRef.current = null; // reset from any previous migration

    const tab = await findTargetPlatformTab(targetPlatform);
    if (!tab?.id) {
      setMigrateState({
        status: "error",
        message: `Open a ${PLATFORM_LABELS[targetPlatform]} tab, then try again.`,
      });
      return;
    }

    setTargetTabId(tab.id ?? null);
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

    // [CM-PROMPT-SNOOZE] coming soon — re-enable when prompt engine ships
    // Resolve the active template object so the SW can attach it directly
    // (system templates live only in-memory and are never in IndexedDB)
    // const activeTemplate = promptTemplateId
    //   ? ([...allTemplates.system, ...allTemplates.user].find((t) => t.id === promptTemplateId) ?? null)
    //   : null;
    const activeTemplate = null;

    chrome.runtime.sendMessage(
      {
        type: "MIGRATE_CONTEXT",
        payload: {
          sessionId: session.id,
          targetPlatform,
          targetTabId: tab.id,
          tier,
          caveman,
          skipAutoInject: false, // Auto-inject enabled by default; tab is reachable (verified above)
          // [CM-PROMPT-SNOOZE] coming soon — re-enable when prompt engine ships
          // promptTemplateId: promptTemplateId ?? undefined,
          // promptTemplate: activeTemplate
          //   ? { name: activeTemplate.name, content: activeTemplate.content, icon: activeTemplate.icon }
          //   : undefined,
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
        if (response?.error === "limit_reached" && onLimitReached && response.limitData) {
          onLimitReached(response.limitData as {
            tier: number;
            used: number;
            limit: number;
            daysUntilReset: number;
            upgradeUrl: string;
          });
          onClose();
          return;
        }
        // [CM-TIER-FIX] handle Tier 3 specific errors with user-friendly messages
        if (response?.error === "tier3_timeout") {
          setMigrateState({
            status: "error",
            message: response.message || "Attention engine timed out. Try again, or switch to Smart Summary or Full Context."
          });
          return;
        }
        if (response?.error === "tier3_no_chunks") {
          setMigrateState({
            status: "error",
            message: response.message || "Attention engine returned no relevant chunks. Try again or switch to Smart Summary."
          });
          return;
        }
        if (response?.error) {
          // [CM-FIX-2] removed user-facing error: raw response.error from SW
          console.error("[CM:migration] MIGRATE_CONTEXT failed:", response.error);
          setMigrateState({ status: "error", message: "Migration failed — please try again." });
          return;
        }
        if (response?.success) {
          setMigrationResult({ ...response, qualityWarning: qualityWarningRef.current ?? undefined });
          qualityWarningRef.current = null;
          return;
        }
        const chars = (response?.prompt as string | undefined)?.length ?? 0;
        const ratio =
          tier === 3 && preview.status === "done"
            ? preview.compressionRatio
            : (response?.compressionRatio as number | undefined) ?? 0;
        setMigrateState({ status: "success", tier, chars, compressionRatio: ratio });
        onSuccess?.(tier, ratio, chars, response?.qualityScore as QualityScore | undefined, response?.coverageStats);
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
          <div style={{ marginBottom: "8px", padding: "4px 8px", background: "rgba(255,165,0,0.08)", border: "1px solid rgba(255,165,0,0.2)", borderRadius: "4px", fontSize: "8px", color: "#FFA500" }}>
            ⚡ Attention Engine may be slow on your device
          </div>
        )}
        {/* ── Quality-warning toast (tier fallback) ── */}
        {qualityWarning && (
          <div style={{ marginBottom: "6px", padding: "4px 10px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: "4px", fontSize: "9px", color: "#EF4444", letterSpacing: "0.04em" }}>
            {"\u26A0\uFE0F " + qualityWarning}
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
            const disabled = t === 3 && !attentionAvailable;
            return (
              <button
                key={t}
                onClick={() => {
                  if (disabled && t === 3) {
                    chrome.runtime.sendMessage({ type: 'RETRY_MODEL_LOAD' }).catch(() => {});
                  } else if (!disabled) {
                    setTier(t);
                  }
                }}
                disabled={false}
                title={disabled ? "Attention Engine unavailable — click to retry loading" : ""}
                style={{
                  background: disabled ? "#0A0A0A" : "#1A1A1A",
                  border: `1px solid ${active ? "#00FF88" : disabled ? "#1A1A1A" : "#2A2A2A"}`,
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
                  opacity: disabled ? 0.4 : 1,
                }}
                onMouseEnter={(e) => { if (!active && !disabled) (e.currentTarget as HTMLButtonElement).style.borderColor = "#3A3A3A"; }}
                onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.borderColor = disabled ? "#1A1A1A" : "#2A2A2A"; }}
              >
                <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: active ? dot : "#333", flexShrink: 0 }} />
                <div style={{ fontSize: "9px", fontWeight: 900, color: active ? "#00FF88" : disabled ? "#555" : "#888", textTransform: "uppercase", letterSpacing: "0.04em", lineHeight: 1.2 }}>
                  {disabled ? "Attention" : label}
                </div>
                <div style={{ fontSize: "8px", color: active ? "#00CC6A" : disabled ? "#F59E0B" : "#333" }}>{disabled ? "↺ Retry" : speed}</div>
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

        {/* ── [CM-PROMPT-SNOOZE] Prompt Engine section — coming soon ── */}
        <div style={{ marginBottom: "6px" }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            padding: '3px 10px',
            borderRadius: '20px',
            fontSize: '11px',
            fontWeight: 500,
            background: 'var(--color-background-warning)',
            color: 'var(--color-text-warning)',
            opacity: 0.85,
          }}>
            Prompt Engine — Coming Soon
          </div>
        </div>

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

        {/* ── [CM-TIER-FIX] low hardware pre-flight warning ── */}
        {showHardwareWarning && (
          <div style={{ marginBottom: "12px", padding: "12px 14px", background: "rgba(255,165,0,0.08)", border: "1px solid rgba(255,165,0,0.25)", borderRadius: "8px" }}>
            <div style={{ fontSize: "11px", fontWeight: 900, color: "#FFA500", marginBottom: "8px", letterSpacing: "0.06em" }}>
              ⚠️ Heads up
            </div>
            <div style={{ fontSize: "10px", color: "#C8C8C8", lineHeight: 1.5, marginBottom: "12px" }}>
              Attention Migration is processing-heavy. On your current hardware this may take significantly longer than usual.
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => { setWarningAcknowledged(true); setShowHardwareWarning(false); setTier(1); }}
                style={{ flex: 1, height: "28px", padding: "0 10px", background: "#111", border: "1px solid #333", borderRadius: "4px", color: "#888", cursor: "pointer", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}
              >
                Switch to Tier 1
              </button>
              <button
                onClick={() => { setWarningAcknowledged(true); setShowHardwareWarning(false); setTier(2); }}
                style={{ flex: 1, height: "28px", padding: "0 10px", background: "#111", border: "1px solid #333", borderRadius: "4px", color: "#888", cursor: "pointer", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}
              >
                Switch to Tier 2
              </button>
              <button
                onClick={() => { setWarningAcknowledged(true); setShowHardwareWarning(false); handleMigrate(); }}
                style={{ flex: 1, height: "28px", padding: "0 10px", background: "rgba(0,255,136,0.1)", border: "1px solid rgba(0,255,136,0.3)", borderRadius: "4px", color: "#00FF88", cursor: "pointer", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}
              >
                Proceed anyway →
              </button>
            </div>
          </div>
        )}

        {/* ── Migration result / success ── */}
        {migrationResult && (
          <MigrationSuccess
            migrationFile={migrationResult.migrationFile}
            cacheKey={migrationResult.cacheKey}
            injected={migrationResult.injected}
            injectionError={migrationResult.injectionError}
            qualityWarning={migrationResult.qualityWarning}
            elapsed={migrationResult.elapsed}
            targetPlatform={targetPlatform}
            injectTabId={targetTabId ?? undefined}
            isPro={isPro}
            coverageStats={migrationResult.coverageStats}
            onClose={() => { setMigrationResult(null); onClose() }}
          />
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
