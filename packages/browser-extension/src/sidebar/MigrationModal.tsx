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
import { findTargetPlatformTab, focusTab, openPlatformTab } from "@/lib/platform-tabs";
import { attentionEngine, getHardwareProfile } from "@/lib/attention-engine";
import type { HardwareProfile } from "@/lib/attention-engine";
import { capabilityDetector } from "@/lib/capability-detector";
// [CM-OFFSCREEN-FIX] perfStart for end-to-end migrate_total measurement.
// Records the FULL user-perceived migration time (click → response), which
// the SW-side migrate_tierN cannot capture (it misses message round-trip +
// UI render + precompute). This is the number that matters to users.
import { perfStart } from "@/lib/perf-track";
// [CM-SOLAR-V2] Animated migration stepper.
import { MigrationStepper } from "./MigrationStepper";
// summarizeWithAttention removed — [CM-FIX-PRECOMPUTE] SW now owns this computation
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
  additionalSessions?: ContextSession[];
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
  qualityWarning,
  elapsed,
  targetPlatform,
  targetTabId,
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
  qualityWarning?: string
  elapsed: number
  targetPlatform: string
  targetTabId?: number
  coverageStats?: {
    messagesScored: number
    messagesUsed: number
    categoryCounts: Record<string, number>
  }
  onClose: () => void
}) {
  type InjectState = 'idle' | 'injecting' | 'success' | 'failed' | 'timeout'
  type DlStatus = 'idle' | 'downloading' | 'downloaded'
  const [injectState, setInjectState] = useState<InjectState>('idle')
  const [injectError, setInjectError] = useState<string | null>(null)
  const [dlStatus, setDlStatus] = useState<DlStatus>('idle')
  const [fetchError, setFetchError] = useState(false)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileReady, setFileReady] = useState(false)
  const [showManualFallback, setShowManualFallback] = useState(false)
  const injectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const injectTimedOutRef = useRef(false)
  const INJECT_TIMEOUT_MS = 15_000
  const sizeKB = Math.round(migrationFile.charCount / 1024)
  const platformKey = targetPlatform.toLowerCase() as Platform

  const TIER_BADGE: Record<number, { label: string; color: string }> = {
    1: { label: 'Full Context', color: '#888' },
    2: { label: 'Smart Summary', color: '#00FF88' },
    3: { label: 'Attention Engine', color: '#00D26A' },
  }
  const badge = TIER_BADGE[migrationFile.tier] ?? TIER_BADGE[1]

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await new Promise<{ success: boolean; file?: { content: string } }>((resolve) => {
          chrome.runtime.sendMessage({ type: 'GET_CACHED_FILE', cacheKey }, resolve)
        })
        if (cancelled) return
        if (!r?.success || !r.file?.content) { setFetchError(true); return }
        setFileContent(r.file.content)
        setFileReady(true)
      } catch { if (!cancelled) setFetchError(true) }
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function triggerManualFallback(reason: string, state: 'failed' | 'timeout') {
    if (injectTimerRef.current) { clearTimeout(injectTimerRef.current); injectTimerRef.current = null; }
    injectTimedOutRef.current = true
    setInjectError(reason)
    setInjectState(state)
    setShowManualFallback(true)
  }

  async function handleInject() {
    if (!fileContent || injectState === 'injecting') return
    if (!targetTabId) {
      triggerManualFallback('Target tab not found — no open tab for this platform.', 'failed')
      return
    }
    setInjectState('injecting')
    setInjectError(null)
    setShowManualFallback(false)
    injectTimedOutRef.current = false
    // Start timeout watchdog — if injection takes too long, fall back to manual download
    injectTimerRef.current = setTimeout(() => {
      triggerManualFallback(`Injection timed out after ${INJECT_TIMEOUT_MS / 1000}s — the platform may have blocked the script.`, 'timeout')
    }, INJECT_TIMEOUT_MS)
    try {
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'INJECT_FILE_TO_TAB', tabId: targetTabId, fileName: migrationFile.filename, fileContent },
          (r) => { void chrome.runtime.lastError; resolve((r as { ok: boolean; error?: string } | null) ?? { ok: false, error: 'No response from service worker' }) }
        )
      })
      if (injectTimerRef.current) { clearTimeout(injectTimerRef.current); injectTimerRef.current = null; }
      // Guard: if timeout already fired, don't overwrite state
      if (injectTimedOutRef.current) return
      if (result.ok) {
        setInjectState('success')
      } else {
        triggerManualFallback(result.error ?? 'Injection failed.', 'failed')
      }
    } catch (err) {
      triggerManualFallback(err instanceof Error ? err.message : 'Unknown error', 'failed')
    }
  }

  function handleDownload() {
    if (!fileContent || dlStatus === 'downloading') return
    setDlStatus('downloading')
    const blob = new Blob([fileContent], { type: 'text/xml' })
    const url = URL.createObjectURL(blob)
    const finish = () => { setDlStatus('downloaded'); setTimeout(() => URL.revokeObjectURL(url), 1500) }
    try {
      if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
        chrome.downloads.download({ url, filename: migrationFile.filename, saveAs: false }, (id) => {
          if (chrome.runtime.lastError || id === undefined) { URL.revokeObjectURL(url); setDlStatus('idle') }
          else finish()
        })
      } else {
        const a = document.createElement('a'); a.href = url; a.download = migrationFile.filename
        document.body.appendChild(a); a.click(); document.body.removeChild(a); finish()
      }
    } catch { URL.revokeObjectURL(url); setDlStatus('idle') }
  }

  return (
    <div style={{ padding: '2px' }}>

      {/* ── Success header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(0,255,136,0.1)', border: '1px solid rgba(0,255,136,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>✓</div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 900, color: '#00FF88', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Context ready</div>
          <div style={{ fontSize: 9, color: '#555', marginTop: 1 }}>
            {(elapsed / 1000).toFixed(1)}s · <span style={{ color: badge.color }}>{badge.label}</span>
            {migrationFile.tier === 2 && coverageStats && (
              <> · {coverageStats.messagesUsed}/{coverageStats.messagesScored} msgs</>
            )}
          </div>
        </div>
      </div>

      {/* ── Quality warning ── */}
      {qualityWarning && (
        <div style={{ marginBottom: 10, padding: '5px 8px', background: 'rgba(0,255,136,0.07)', border: '1px solid rgba(0,255,136,0.2)', borderRadius: 4, fontSize: 9, color: '#00FF88' }}>
          ⚠️ {qualityWarning}
        </div>
      )}

      {/* ── File info card ── */}
      <div className="cm-drag-card" style={{
        background: injectState === 'success' ? 'rgba(0,255,136,0.06)' : 'rgba(0,255,136,0.03)',
        border: `1px solid ${injectState === 'success' ? 'rgba(0,255,136,0.5)' : injectState === 'failed' ? 'rgba(255,68,68,0.4)' : 'rgba(0,255,136,0.25)'}`,
        borderRadius: 12, padding: '16px', marginBottom: 12, position: 'relative', overflow: 'hidden',
      }}>
        {injectState !== 'success' && (
          <div style={{ position: 'absolute', left: 0, right: 0, height: 1, background: 'linear-gradient(90deg,transparent,rgba(0,255,136,0.3),transparent)', animation: 'cm-scan-line 3s linear infinite', pointerEvents: 'none' }} />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="cm-file-icon" style={{ flexShrink: 0, width: 42, height: 50, background: '#0A0A0A', border: '1px solid rgba(0,255,136,0.2)', borderRadius: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
            <div style={{ fontSize: 16 }}>📄</div>
            <div style={{ fontSize: 7, color: '#00FF88', fontWeight: 900, letterSpacing: '0.05em' }}>XML</div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 900, color: '#F5F5F5', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {migrationFile.filename}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 2 }}>
              <span style={{ fontSize: 9, color: '#555' }}>{sizeKB} KB</span>
              <span style={{ fontSize: 9, color: '#333' }}>·</span>
              <span style={{ fontSize: 9, color: '#555' }}>~{migrationFile.estimatedTokens.toLocaleString()} tokens</span>
              <span style={{ fontSize: 9, color: '#333' }}>·</span>
              <span style={{ fontSize: 9, color: badge.color }}>{badge.label}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── File expired ── */}
      {fetchError && (
        <div style={{ marginBottom: 12, padding: '12px', background: 'rgba(255,68,68,0.06)', border: '1px solid rgba(255,68,68,0.2)', borderRadius: 8, textAlign: 'center', fontSize: 9, color: '#00FF88' }}>
          ⚠️ File expired from cache — run migration again
        </div>
      )}

      {/* ── Loading ── */}
      {!fileReady && !fetchError && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 5, marginBottom: 12 }}>
          <div className="cm-dot-1" style={{ width: 7, height: 7, borderRadius: '50%', background: '#00FF88' }} />
          <div className="cm-dot-2" style={{ width: 7, height: 7, borderRadius: '50%', background: '#00FF88' }} />
          <div className="cm-dot-3" style={{ width: 7, height: 7, borderRadius: '50%', background: '#00FF88' }} />
        </div>
      )}

      {/* ── Inject success ── */}
      {injectState === 'success' && (
        <div style={{ marginBottom: 12, padding: '12px', background: 'rgba(0,255,136,0.06)', border: '1px solid rgba(0,255,136,0.3)', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 20, marginBottom: 4 }}>🎉</div>
          <div style={{ fontSize: 11, fontWeight: 900, color: '#00FF88', marginBottom: 3 }}>Injected into chat!</div>
          <div style={{ fontSize: 9, color: '#555' }}>The file is attached — send the message to continue</div>
        </div>
      )}

      {/* ── Manual fallback panel (shown on inject fail OR timeout) ── */}
      {showManualFallback && (
        <div style={{ marginBottom: 12, padding: '14px', background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 18 }}>{injectState === 'timeout' ? '⏱️' : '⚠️'}</span>
            <div>
              <div style={{ fontSize: 10, fontWeight: 900, color: '#00D26A', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {injectState === 'timeout' ? 'Injection timed out' : 'Auto-inject failed'}
              </div>
              <div style={{ fontSize: 8, color: '#7A6030', marginTop: 1 }}>
                {injectError}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 9, color: '#A07040', lineHeight: 1.6, marginBottom: 10 }}>
            Download the file and attach it manually to {PLATFORM_LABELS[platformKey] ?? targetPlatform}:
          </div>
          <button
            onClick={handleDownload}
            disabled={dlStatus === 'downloading'}
            style={{
              width: '100%', height: 38, marginBottom: dlStatus === 'downloaded' ? 10 : 0,
              background: dlStatus === 'downloaded' ? 'rgba(0,255,136,0.1)' : 'rgba(245,158,11,0.15)',
              border: `1px solid ${dlStatus === 'downloaded' ? 'rgba(0,255,136,0.4)' : 'rgba(245,158,11,0.5)'}`,
              borderRadius: 7, color: dlStatus === 'downloaded' ? '#00FF88' : '#00D26A',
              fontSize: 10, fontWeight: 900, cursor: dlStatus === 'downloading' ? 'not-allowed' : 'pointer',
              textTransform: 'uppercase', letterSpacing: '0.1em', transition: 'all 0.15s',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            {dlStatus === 'downloading' ? '⏳ Downloading…' : dlStatus === 'downloaded' ? '✓ File downloaded!' : '⬇ Download context file'}
          </button>
          {dlStatus === 'downloaded' && (
            <div style={{ padding: '10px 12px', background: '#0A0A0A', border: '1px solid rgba(0,255,136,0.12)', borderRadius: 6 }}>
              <div style={{ fontSize: 9, fontWeight: 900, color: '#00FF88', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>
                Now attach to {PLATFORM_LABELS[platformKey] ?? targetPlatform}
              </div>
              <div style={{ fontSize: 9, color: '#666', lineHeight: 1.7 }}>
                {PLATFORM_UPLOAD_HINTS[platformKey] ?? `Use the file-attachment button in ${targetPlatform}`}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Primary inject button (hidden when manual fallback is shown) ── */}
      {fileReady && injectState !== 'success' && !showManualFallback && (
        <button
          onClick={() => { void handleInject() }}
          disabled={injectState === 'injecting'}
          style={{
            width: '100%', height: 40, marginBottom: 8,
            background: injectState === 'injecting' ? '#2A2A2A' : 'rgba(0,255,136,0.12)',
            border: '1px solid rgba(0,255,136,0.4)',
            borderRadius: 8, color: '#00FF88',
            fontSize: 10, fontWeight: 900, cursor: injectState === 'injecting' ? 'not-allowed' : 'pointer',
            textTransform: 'uppercase', letterSpacing: '0.12em', transition: 'all 0.15s',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        >
          {injectState === 'injecting' && <span style={{ display: 'inline-block', animation: 'spin 0.7s linear infinite' }}>↻</span>}
          {injectState === 'injecting' ? 'Injecting…' : `⚡ Inject into ${PLATFORM_LABELS[platformKey] ?? targetPlatform}`}
        </button>
      )}

      {/* ── Retry button after failure (shown below fallback panel) ── */}
      {fileReady && showManualFallback && (
        <button
          onClick={() => { setShowManualFallback(false); setDlStatus('idle'); void handleInject() }}
          style={{
            width: '100%', height: 32, marginBottom: 8,
            background: 'transparent', border: '1px solid #2A2A2A',
            borderRadius: 6, color: '#555',
            fontSize: 9, fontWeight: 700, cursor: 'pointer',
            textTransform: 'uppercase', letterSpacing: '0.1em',
          }}
        >
          ↺ Retry auto-inject
        </button>
      )}

      {/* ── Download fallback (quiet, always available when no failure) ── */}
      {fileReady && !showManualFallback && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
          <button
            onClick={handleDownload}
            disabled={dlStatus === 'downloading'}
            style={{ background: 'transparent', border: '1px solid #1E1E1E', borderRadius: 4, color: dlStatus === 'downloaded' ? '#00FF88' : '#444', fontSize: 9, fontWeight: 700, padding: '5px 16px', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.08em', transition: 'color 0.15s' }}
          >
            {dlStatus === 'downloading' ? '⏳ Downloading…' : dlStatus === 'downloaded' ? '✓ Downloaded' : '⬇ Download file'}
          </button>
        </div>
      )}

      {/* ── Manual upload hint after quiet download ── */}
      {dlStatus === 'downloaded' && !showManualFallback && (
        <div style={{ marginBottom: 10, padding: '8px 12px', background: '#0A0A0A', border: '1px solid rgba(0,255,136,0.12)', borderRadius: 6 }}>
          <div style={{ fontSize: 9, fontWeight: 900, color: '#00FF88', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            Attach to {PLATFORM_LABELS[platformKey] ?? targetPlatform}
          </div>
          <div style={{ fontSize: 9, color: '#666', lineHeight: 1.6 }}>
            {PLATFORM_UPLOAD_HINTS[platformKey] ?? `Use the file-attachment button in ${targetPlatform}`}
          </div>
        </div>
      )}

      <button onClick={onClose} style={{ width: '100%', padding: '9px', background: 'transparent', border: '1px solid #1A1A1A', borderRadius: 4, color: '#444', fontSize: 9, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.1em', transition: 'color 0.15s' }}>
        Done
      </button>
    </div>
  )
}

export default function MigrationModal({
  session,
  additionalSessions = [],
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
  const [slowMachineWarning, setSlowMachineWarning] = useState<string | null>(null);
  // [CM-P4-FIX] Dynamic indexing status with queue info and ETA
  const [indexingStatus, setIndexingStatus] = useState<{
    active: boolean;
    queued: number;
    sessionId?: string;
    stage?: string;
    hwTier?: string;
    chunkProgress?: { done: number; total: number };
  } | null>(null);
  const [migrationResult, setMigrationResult] = useState<any>(null);
  const [targetTabId, setTargetTabId] = useState<number | null>(null);
  // [CM-TIER-FIX] low hardware pre-flight warning — user decides, not the extension
  const [showHardwareWarning, setShowHardwareWarning] = useState(false);
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const userHasManuallySelected = useRef(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // [FIX-8] Track migration active state to skip live preview ONNX calls during migration
  const migrationActiveRef = useRef(false);
  // [FIX-10] Store the last successfully computed attention map from the live preview
  // so we can pass it to the SW via MIGRATE_CONTEXT, avoiding a duplicate buildAttentionMap call
  const lastPreviewMapRef = useRef<{ task: string; strength: string; map: unknown } | null>(null);
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
    const handler = (msg: {
      type: string;
      progress?: number;
      stage?: string;
      from?: number;
      to?: number;
      reason?: string;
      originalTier?: number;
      fallbackTier?: number;
      messageCount?: number;
      hwTier?: string;
      // [CM-P4-FIX] INDEXING_STATUS fields
      active?: boolean;
      queued?: number;
      sessionId?: string;
      chunkDone?: number;
      chunkTotal?: number;
    }) => {
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
      } else if (msg.type === "TIER3_SLOW_MACHINE_WARNING") {
        // [CM-P4-FIX] Enhanced warning with dynamic status
        const baseText = `⚡ ${msg.hwTier ?? 'balanced'} hardware detected — ${msg.messageCount} messages`;
        setSlowMachineWarning(baseText);
        setTimeout(() => setSlowMachineWarning(null), 30_000);
      } else if (msg.type === "INDEXING_STATUS") {
        // [CM-P4-FIX] Real-time indexing status updates
        setIndexingStatus({
          active: msg.active ?? false,
          queued: msg.queued ?? 0,
          sessionId: msg.sessionId,
          stage: msg.stage,
          hwTier: msg.hwTier,
          chunkProgress: msg.chunkDone !== undefined && msg.chunkTotal !== undefined
            ? { done: msg.chunkDone, total: msg.chunkTotal }
            : undefined,
        });
        // Auto-clear after 30s if inactive
        if (!msg.active) {
          setTimeout(() => setIndexingStatus(null), 30_000);
        }
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
  // [FIX-8] Listen for MIGRATION_ACTIVE broadcasts from the SW so the sidebar
  // can skip live preview ONNX calls while migration owns the offscreen worker.
  useEffect(() => {
    const handler = (msg: any) => {
      if (msg?.type === 'MIGRATION_ACTIVE') {
        migrationActiveRef.current = !!msg.active;
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  useEffect(() => {
    if (tier !== 3) return;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    if (!task.trim() || engineState.status !== "ready") {
      setPreview({ status: "idle" });
      return;
    }
    // [FIX-8] Skip live preview when migration is in progress — the SW owns the ONNX worker
    if (migrationActiveRef.current) {
      setPreview({ status: "idle" });
      return;
    }
    setPreview({ status: "analyzing" });
    // Longer debounce (1200 ms) on non-weak devices to reduce mid-typing jank.
    previewTimerRef.current = setTimeout(async () => {
      // [FIX-8] Double-check migration hasn't started during the debounce window
      if (migrationActiveRef.current) {
        setPreview({ status: "idle" });
        return;
      }
      try {
        const map = await attentionEngine.buildAttentionMap(session, task, strength);
        const relevantMessages = map.topChunks.filter(
          (c) => c.type === "message" && c.relevanceScore >= map.threshold
        ).length;
        setPreview({ status: "done", compressionRatio: map.compressionRatio, highlightedFiles: map.highlightedFiles.length, relevantMessages });
        // [FIX-10] Store the computed map so handleMigrate can pass it to the SW
        lastPreviewMapRef.current = { task, strength, map };
      } catch {
        setPreview({ status: "error" });
      }
    }, 1200);
    return () => { if (previewTimerRef.current) clearTimeout(previewTimerRef.current); };
  }, [task, strength, engineState.status, session, tier]);

  // [ISSUE-17] Track last migration request to prevent duplicate MIGRATE_CONTEXT sends
  const lastMigrateRequestRef = useRef<{ sessionId: string; tier: number; ts: number } | null>(null);

  // ── Migration handler ───────────────────────────────────────────────────────
  async function handleMigrate() {
    // [CM-TIER-FIX] low hardware pre-flight warning — user decides, not the extension
    if (tier === 3 && hw?.tier === 'minimal' && !warningAcknowledged) {
      setShowHardwareWarning(true);
      return; // do not start migration yet
    }

    // [ISSUE-17] Deduplicate — if same session+tier was requested within 5s, skip
    const now = Date.now();
    const lastReq = lastMigrateRequestRef.current;
    if (lastReq && lastReq.sessionId === session.id && lastReq.tier === tier && now - lastReq.ts < 5000) {
      console.debug('[CM:migration] duplicate MIGRATE_CONTEXT request within 5s — skipping');
      return;
    }
    lastMigrateRequestRef.current = { sessionId: session.id, tier, ts: now };

    setMigrateState({ status: "migrating" });
    setMigrateProgress(0);
    setMigrateStage("");
    qualityWarningRef.current = null; // reset from any previous migration

    const tab = await findTargetPlatformTab(targetPlatform);
    let targetTab = tab;
    if (!targetTab?.id) {
      setMigrateStage(`Opening ${PLATFORM_LABELS[targetPlatform]}…`);
      try {
        targetTab = await openPlatformTab(targetPlatform);
      } catch {
        setMigrateState({
          status: "error",
          message: `Could not open ${PLATFORM_LABELS[targetPlatform]}. Please open it manually and try again.`,
        });
        return;
      }
    }

    if (!targetTab?.id) {
      setMigrateState({
        status: "error",
        message: `Could not open ${PLATFORM_LABELS[targetPlatform]}. Please open it manually and try again.`,
      });
      return;
    }

    setTargetTabId(targetTab.id ?? null);
    await focusTab(targetTab.id!);
    await new Promise((r) => setTimeout(r, 300));

    // [FIX-10] Re-enable precomputedAttentionMap — pass the sidebar's last computed
    // attention map to the SW so it can skip a duplicate buildAttentionMap ONNX call.
    // Only pass it if the task and strength match what the preview computed.
    const precomputedSummary: string | undefined = undefined;
    const previewMap = lastPreviewMapRef.current;
    const precomputedAttentionMap: unknown =
      previewMap && previewMap.task === task && previewMap.strength === strength
        ? previewMap.map
        : undefined;

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

    // [CM-OFFSCREEN-FIX] Measure end-to-end migration time as perceived by the
    // user (from click to response). The SW's migrate_tierN only measures its
    // own handler time; this captures the full round-trip including precompute,
    // message passing, and UI render. This is the number shown in the dashboard
    // as "migrate_total" with SLO=15s.
    const endPerf = perfStart('migrate_total');
    chrome.runtime.sendMessage(
      {
        type: "MIGRATE_CONTEXT",
        payload: {
          sessionId: session.id,
          additionalSessionIds: additionalSessions.length > 0 ? additionalSessions.map((s) => s.id) : undefined,
          targetPlatform,
          targetTabId: targetTab?.id,
          tier,
          caveman,
          skipAutoInject: true, // Always skip — user drags the XML card directly into the LLM chat
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
        // [CM-OFFSCREEN-FIX] Record end-to-end migration time.
        void endPerf({ sessionId: session.id, metadata: { tier, platform: targetPlatform } });
        console.log("[CM:migration] MIGRATE_CONTEXT response:", JSON.stringify(response)?.slice(0, 300));
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
    <>
      <style>{`
        @keyframes neon-amber-glow {
          0%, 100% { text-shadow: 0 0 3px rgba(245,158,11,0.25), 0 0 6px rgba(245,158,11,0.1); opacity: 0.75; }
          50% { text-shadow: 0 0 8px rgba(245,158,11,0.8), 0 0 14px rgba(245,158,11,0.35); opacity: 1; }
        }
        .pulse-glow-amber { animation: neon-amber-glow 2s infinite ease-in-out; }
        @keyframes cm-breathe {
          0%,100%{box-shadow:0 0 0 0 rgba(0,255,136,0),0 8px 32px rgba(0,0,0,0.6);border-color:rgba(0,255,136,0.3);}
          50%{box-shadow:0 0 0 8px rgba(0,255,136,0.05),0 8px 48px rgba(0,255,136,0.12);border-color:rgba(0,255,136,0.65);}
        }
        @keyframes cm-dot-bounce {
          0%,80%,100%{transform:scale(0.6);opacity:0.3;}
          40%{transform:scale(1.1);opacity:1;}
        }
        @keyframes cm-file-float {
          0%,100%{transform:translateY(0px);}
          50%{transform:translateY(-5px);}
        }
        @keyframes cm-scan-line {
          0%{top:0%;opacity:0;}20%{opacity:1;}80%{opacity:1;}100%{top:100%;opacity:0;}
        }
        .cm-dot-1{animation:cm-dot-bounce 1.4s infinite 0s;}
        .cm-dot-2{animation:cm-dot-bounce 1.4s infinite 0.2s;}
        .cm-dot-3{animation:cm-dot-bounce 1.4s infinite 0.4s;}
        .cm-drag-card{animation:cm-breathe 2.4s ease-in-out infinite;}
        .cm-drag-card:hover{cursor:grab;transform:scale(1.01);}
        .cm-file-icon{animation:cm-file-float 2.8s ease-in-out infinite;}
      `}</style>
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
          position: "relative",
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
        {/* [CM-SOLAR-V2] Success flash overlay — gold→orange checkmark scale-in. */}
        {isDone && (
          <div
            className="solar-success-flash"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              zIndex: 50,
              background: "radial-gradient(ellipse 60% 60% at 50% 50%, rgba(0,255,136,0.18), transparent 70%)",
              borderRadius: "8px",
            }}
          >
            <span
              style={{
                fontSize: "48px",
                fontWeight: 900,
                background: "linear-gradient(135deg, #00FF88, #00C853)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
                WebkitTextFillColor: "transparent",
                textShadow: "0 0 24px rgba(0,255,136,0.5)",
                filter: "drop-shadow(0 0 12px rgba(0,210,106,0.4))",
              }}
            >
              ✓
            </span>
          </div>
        )}
        {/* ── Header ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "11px", fontWeight: 900, color: "#00FF88", letterSpacing: "0.18em", textTransform: "uppercase", textShadow: "0 0 10px rgba(0,255,136,0.4)" }}>
              Migrate Context
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: "9px", color: "#00D26A", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              → {PLATFORM_LABELS[targetPlatform]}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "1px solid #2A2A2A", borderRadius: "4px", color: "#00FF88", cursor: "pointer", fontSize: "12px", padding: "2px 6px", transition: "all 0.15s" }}
          >
            ✕
          </button>
        </div>

        {/* ── Migration complete: show drag-drop card exclusively ── */}
        {migrationResult && (
          <MigrationSuccess
            migrationFile={migrationResult.migrationFile}
            cacheKey={migrationResult.cacheKey}
            qualityWarning={migrationResult.qualityWarning}
            elapsed={migrationResult.elapsed}
            targetPlatform={targetPlatform}
            targetTabId={targetTabId ?? undefined}
            coverageStats={migrationResult.coverageStats}
            onClose={() => { setMigrationResult(null); onClose() }}
          />
        )}

        {/* ── Hardware recommendation banner ── */}
        {!migrationResult && hw?.tier === "full" && (
          <div style={{ marginBottom: "6px", padding: "4px 10px", background: "rgba(0,255,136,0.06)", border: "1px solid rgba(0,255,136,0.2)", borderRadius: "4px", fontSize: "9px", color: "#00FF88", letterSpacing: "0.06em", lineHeight: "1" }}>
            {"\uD83D\uDE80 GPU detected (" + (hw.gpuRenderer ?? "GPU") + ") — Full power"}
          </div>
        )}
        {!migrationResult && hw?.tier === "balanced" && (
          <div style={{ marginBottom: "6px", padding: "4px 10px", background: "rgba(0,255,136,0.06)", border: "1px solid rgba(0,255,136,0.2)", borderRadius: "4px", fontSize: "9px", color: "#00FF88", letterSpacing: "0.06em", lineHeight: "1" }}>
            {"\u26A1 " + hw.cores + " cores detected — Balanced mode"}
          </div>
        )}
        {!migrationResult && hw?.tier === "minimal" && (
          <div style={{ marginBottom: "8px", padding: "4px 8px", background: "rgba(255,165,0,0.08)", border: "1px solid rgba(255,165,0,0.2)", borderRadius: "4px", fontSize: "8px", color: "#FFA500" }}>
            ⚡ Attention Engine may be slow on your device
          </div>
        )}
        {/* ── Quality-warning toast (tier fallback) ── */}
        {qualityWarning && (
          <div style={{ marginBottom: "6px", padding: "4px 10px", background: "rgba(0,255,136,0.08)", border: "1px solid rgba(0,255,136,0.25)", borderRadius: "4px", fontSize: "9px", color: "#00FF88", letterSpacing: "0.04em" }}>
            {"\u26A0\uFE0F " + qualityWarning}
          </div>
        )}
        {/* ── Slow-machine Tier 3 warning ── */}
        {slowMachineWarning && (
          <div style={{ marginBottom: "6px", padding: "6px 10px", background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.35)", borderRadius: "4px", fontSize: "9px", color: "#00D26A", letterSpacing: "0.04em", lineHeight: 1.5 }}>
            {"⏳ " + slowMachineWarning}
          </div>
        )}
        {/* [CM-P4-FIX] Dynamic indexing status with queue info and ETA */}
        {indexingStatus?.active && tier === 3 && (
          <div style={{ marginBottom: "6px", padding: "8px 10px", background: "rgba(0,255,136,0.08)", border: "1px solid rgba(0,255,136,0.25)", borderRadius: "4px", fontSize: "9px", color: "#00FF88", letterSpacing: "0.04em", lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>
              ⚡ Indexing session for Attention Engine
            </div>
            <div>
              Hardware: {indexingStatus.hwTier ?? 'balanced'} | Queue: {indexingStatus.queued} session{indexingStatus.queued !== 1 ? 's' : ''}
            </div>
            {indexingStatus.chunkProgress && (
              <div style={{ marginTop: 4 }}>
                Progress: {indexingStatus.chunkProgress.done}/{indexingStatus.chunkProgress.total} chunks
                <div style={{ marginTop: 2, height: 3, background: 'rgba(0,255,136,0.15)', borderRadius: 2 }}>
                  <div style={{ width: `${(indexingStatus.chunkProgress.done / indexingStatus.chunkProgress.total) * 100}%`, height: '100%', background: '#00FF88', borderRadius: 2, transition: 'width 0.3s' }} />
                </div>
              </div>
            )}
            <div style={{ marginTop: 4, opacity: 0.8 }}>
              {/* [CM-QUEUE-FIX] indexingStatus.queued now only reflects the priority queue
                  (background jobs are excluded while paused). queued > 0 means there are
                  additional priority sessions lined up after this one. */}
              {indexingStatus.queued > 0
                ? `⚡ Indexing your session — ${indexingStatus.queued} more in priority queue`
                : 'Indexing your session for fast semantic search...'}
            </div>
          </div>
        )}
        {/* ── Tier-downgrade toast ── */}
        {downgradedToast && (
          <div style={{ marginBottom: "6px", padding: "4px 10px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: "4px", fontSize: "9px", color: "#00D26A", letterSpacing: "0.04em" }}>
            {"\uD83E\uDDE0 " + downgradedToast}
          </div>
        )}

        {/* ── Tier cards ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "4px", marginBottom: "6px" }}>
          {([
            { t: 1 as const, dot: "#666",    label: "Full Context", speed: "Fastest" },
            { t: 2 as const, dot: "#00FF88", label: "Smart",        speed: "Fast"    },
            { t: 3 as const, dot: "#00D26A", label: "▸ Attention", speed: "Smart"   },
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
                <div style={{ fontSize: "8px", color: active ? "#00D26A" : disabled ? "#00D26A" : "#333" }}>{disabled ? "↺ Retry" : speed}</div>
                {t === 3 && active && hw?.tier === "minimal" && (
                  <div style={{ fontSize: "8px", color: "#00D26A", marginTop: "2px", textAlign: "center" }}>
                    ⚠ May take 2+ min
                  </div>
                )}
              </button>
            );
          })}
        </div>


        {/* [CM-SOLAR-V2] Universal animated migration stepper — all tiers. */}
        {migrateState.status === "migrating" && (
          <div style={{ marginBottom: "6px" }}>
            <MigrationStepper stage={migrateStage} progress={migrateProgress} tier={tier} variant="full" />
            <div style={{ width: "100%", background: "#1A1A1A", borderRadius: "4px", height: "3px", overflow: "hidden", marginTop: "4px" }}>
              <div className="solar-progress-fill" style={{ width: migrateProgress + "%", height: "100%", transition: "width 300ms ease", boxShadow: "0 0 8px rgba(0,255,136,0.5)" }} />
            </div>
            {tier === 3 && hw?.tier === "minimal" && (
              <div style={{ fontSize: "8px", color: "#00D26A", marginTop: "4px", textAlign: "center" }}>
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
              <div style={{ background: "linear-gradient(90deg, #00FF88, #00D26A)", height: "2px", borderRadius: "4px", width: `${engineState.progress}%`, transition: "width 0.3s ease", boxShadow: "0 0 6px rgba(0,255,136,0.5)" }} />
            </div>
          </div>
        )}

        {tier === 3 && engineState.status === "error" && (
          <div style={{ marginBottom: "4px", padding: "4px 10px", background: "#110505", border: "1px solid rgba(0,255,136,0.2)", borderRadius: "4px", fontSize: "9px", color: "#F87171", textTransform: "uppercase", letterSpacing: "0.06em" }}>
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
          <div style={{ marginBottom: "6px", padding: "5px 10px", background: "#111", border: "1px solid #2A2A2A", borderRadius: "4px", fontSize: "9px", color: "#00FF88", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            · Analyzing…
          </div>
        )}

        {tier === 3 && preview.status === "done" && (
          <div style={{ marginBottom: "6px", padding: "5px 10px", background: "#060F07", border: "1px solid rgba(0,255,136,0.18)", borderRadius: "4px", fontSize: "9px" }}>
            <span style={{ color: "#00FF88", fontWeight: 900 }}>✓ </span>
            <span style={{ color: "#00FF88" }}>
              <strong style={{ color: "#00FF88" }}>{preview.compressionRatio}% compressed</strong>
              {" · "}<strong style={{ color: "#F5F5F5" }}>{preview.highlightedFiles}</strong> files
              {" · "}<strong style={{ color: "#F5F5F5" }}>{preview.relevantMessages}/{session.messages.length}</strong> msgs
            </span>
          </div>
        )}

        {tier === 3 && preview.status === "error" && (
          <div style={{ marginBottom: "6px", padding: "5px 10px", background: "#110505", border: "1px solid rgba(0,255,136,0.2)", borderRadius: "4px", fontSize: "9px", color: "#F87171", textTransform: "uppercase", letterSpacing: "0.06em" }}>
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
                border: `1px solid ${hasSel && projectContextIncluded ? "rgba(0,255,136,0.3)" : isConn ? "rgba(0,255,136,0.07)" : "#1A1A1A"}`,
                background: hasSel && projectContextIncluded ? "rgba(0,255,136,0.04)" : "#0D0D0D",
              }}>
                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isConn ? 6 : 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 9, fontWeight: 900, color: hasSel && projectContextIncluded ? "#00FF88" : "#555", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                      📁 Project Files
                    </span>
                    {autoScoring && <span style={{ fontSize: 8, color: "#E5E5E5" }}>scanning…</span>}
                    {autoScoredPaths.length > 0 && !autoScoring && (
                      <span style={{ fontSize: 8, color: "#E5E5E5", background: "rgba(99,102,241,0.12)", borderRadius: 3, padding: "1px 5px" }}>✨ auto</span>
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
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#00FF88")}
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
                          style={{ fontSize: 8, color: "#9CA3AF", background: "none", border: "none", cursor: "pointer" }}
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
                              onMouseEnter={(e) => { if (!sel) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,255,136,0.03)"; }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = sel ? "rgba(0,255,136,0.05)" : "transparent"; }}>
                              <span style={{ fontSize: 9, color: sel ? "#00FF88" : "#333", flexShrink: 0 }}>{sel ? "☑" : "☐"}</span>
                              <span style={{ fontSize: 9, color: sel ? "#F5F5F5" : "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{name}</span>
                              {score !== undefined && (
                                <span style={{ fontSize: 7, color: "#E5E5E5", background: "rgba(99,102,241,0.12)", borderRadius: 3, padding: "1px 4px", flexShrink: 0 }}>{Math.round(score * 100)}%</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div style={{ fontSize: 8, color: hasSel ? "#444" : "#333" }}>
                      {hasSel
                        ? <>{projectFiles.length} file{projectFiles.length !== 1 ? "s" : ""} · {fileContextBuilder.formatSize(projectFiles.reduce((s, f) => s + f.size, 0))}{(() => { const w = fileContextBuilder.getTokenWarning(projectFiles, targetPlatform); return w ? <span style={{ color: "#00D26A", marginLeft: 6 }}>{w}</span> : null; })()}</>
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
          <div style={{ marginBottom: "6px", padding: "4px 10px", background: "#110505", border: "1px solid rgba(0,255,136,0.2)", borderRadius: "4px", fontSize: "9px", color: "#F87171", textTransform: "uppercase", letterSpacing: "0.06em" }}>
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

        {/* ── Preparing context animation (shown while migrating) ── */}
        {migrateState.status === "migrating" && !migrationResult && (
          <div style={{ marginBottom: 8, padding: "18px 14px", background: "rgba(0,255,136,0.03)", border: "1px solid rgba(0,255,136,0.15)", borderRadius: 10, textAlign: "center" }}>
            <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 10 }}>
              <div className="cm-dot-1" style={{ width: 8, height: 8, borderRadius: "50%", background: "#00FF88" }} />
              <div className="cm-dot-2" style={{ width: 8, height: 8, borderRadius: "50%", background: "#00FF88" }} />
              <div className="cm-dot-3" style={{ width: 8, height: 8, borderRadius: "50%", background: "#00FF88" }} />
            </div>
            <div style={{ fontSize: 11, fontWeight: 900, color: "#00FF88", textTransform: "uppercase", letterSpacing: "0.14em", marginBottom: 4 }}>Preparing context</div>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.06em" }}>
              {migrateStage || (tier === 3 ? "Running attention engine…" : tier === 2 ? "Extracting smart summary…" : "Building full context…")}
            </div>
            {tier === 3 && migrateProgress > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ width: "100%", background: "#111", borderRadius: 3, height: 2, overflow: "hidden" }}>
                  <div style={{ width: migrateProgress + "%", height: "100%", background: "#00FF88", transition: "width 300ms ease", boxShadow: "0 0 6px rgba(0,255,136,0.5)" }} />
                </div>
                <div style={{ fontSize: 8, color: "#333", marginTop: 3 }}>{migrateProgress}%</div>
              </div>
            )}
          </div>
        )}

        {/* ── Action buttons (hidden while migrating) ── */}
        {migrateState.status !== "migrating" && !migrationResult && (
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={onClose}
              style={{ flex: 1, height: "36px", padding: "0 12px", background: "#111", border: "1px solid #222", borderRadius: "4px", color: "#9CA3AF", cursor: "pointer", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", transition: "all 0.15s" }}
            >
              Cancel
            </button>
            <button
              onClick={handleMigrate}
              disabled={isBusy || isDone}
              className={(!isBusy && !isDone) ? "solar-gradient-bg btn-primary" : ""}
              style={{
                flex: 2, height: "36px", padding: "0 16px",
                background: isDone ? "#060F07" : undefined,
                border: isDone ? "1px solid rgba(0,255,136,0.25)" : "none",
                borderRadius: "4px",
                color: isDone ? "#00FF88" : "#0A0A0A",
                cursor: isDone ? "not-allowed" : "pointer",
                fontSize: "10px", fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.12em",
                boxShadow: !isDone ? "0 0 18px rgba(0,255,136,0.45), 0 0 36px rgba(0,255,136,0.12)" : "none",
                transition: "all 0.15s", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
              }}
            >
              {isDone ? "✓ Done" : MIGRATE_BTN_LABELS[tier]}
            </button>
          </div>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } .cf-chips-row::-webkit-scrollbar { display: none; }`}</style>
    </div>
    </>
    ,
    document.body
  );
}
