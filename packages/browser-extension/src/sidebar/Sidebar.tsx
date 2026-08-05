/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */
import type { DOMProbeResult } from '@/content/shared';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findTargetPlatformTab, focusTab, detectActivePlatformTab } from "@/lib/platform-tabs";
import { dexieDb } from "@/lib/db";
import type { ContextSession, Platform } from "@/lib/types";
import ExportMenu from "@/components/ExportMenu";
import { PlatformBadge, PlatformLogo } from "@/components/PlatformLogo";
import MigrationModal from "./MigrationModal";
import { MigrationStepper } from "./MigrationStepper";
import SelfHealWizard from "./SelfHealWizard";
import { PerfStatsPanel } from "./PerfStatsPanel";
import KnowledgeSynthesizer from "./components/KnowledgeSynthesizer";
import MultiSessionPicker from "./components/MultiSessionPicker";
import { QualityScoreCard } from "./QualityScoreCard";
import type { QualityScore } from "@/lib/quality/migration-scorer";
import { getUsageStatus, type UsageStatus } from "@/lib/usage-client";
import { getRemoteUpdateInfo } from "@/lib/remote-config";
import { attentionEngine } from "@/lib/attention-engine";
import { capabilityDetector } from "@/lib/capability-detector";
import { projectReader } from "@/lib/file-system/project-reader";
import { fileContextBuilder } from "@/lib/file-system/context-builder";
import { fileCopier } from "@/lib/file-system/file-copier";
import type { FileTreeNode } from "@/lib/file-system/project-reader";
import { VAULT_URL, DASHBOARD_URL, PRICING_URL } from "@/config/urls";

interface IndexStats {
  sessionCount: number;
  indexedCount: number;
  chunkCount: number;
  summaryCount: number;
  cacheCount: number;
  estimatedStorageMB: number;
  modelTier?: string | null;
  modelLabel?: string | null;
}

// ── SessionCard — memoized to prevent re-renders when unrelated state changes ──
interface SessionCardProps {
  session: ContextSession;
  vaultConnected: boolean | null;
  migrationTier?: 1 | 2 | 3;
  driveSourced?: boolean;
  isPendingIndex?: boolean; // [CM-PERSIST-FIX]
  isIndexed?: boolean; // [MEAL-PREP] fully indexed — ready for Tier 3
  hasChunks?: boolean; // [MEAL-PREP] has some chunks but maybe not complete
  // [CM-SOLAR-V2] 1-click quick-migrate (Tier 1, inline).
  isQuickMigrating?: boolean;
  quickMigrateStage?: string;
  quickMigrateProgress?: number;
  onQuickMigrate?: () => void;
  onSelect: () => void;
  onRenaming?: (v: boolean) => void;
}

// ── Engagement badge definitions ─────────────────────────────────────────────
const BADGE_DEV: React.CSSProperties = {
  padding: "1px 5px", borderRadius: "8px", fontSize: "7px",
  fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
  background: "rgba(168,85,247,0.14)", border: "1px solid rgba(168,85,247,0.35)",
  color: "#C084FC",
};
const BADGE_MARATHON: React.CSSProperties = {
  padding: "1px 5px", borderRadius: "8px", fontSize: "7px",
  fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
  background: "rgba(249,115,22,0.14)", border: "1px solid rgba(249,115,22,0.35)",
  color: "#FB923C",
};
const BADGE_DEEP: React.CSSProperties = {
  padding: "1px 5px", borderRadius: "8px", fontSize: "7px",
  fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
  background: "rgba(6,182,212,0.12)", border: "1px solid rgba(6,182,212,0.3)",
  color: "#22D3EE",
};

const SessionCard = memo<SessionCardProps>(function SessionCard({
  session,
  vaultConnected,
  migrationTier,
  driveSourced,
  isPendingIndex, // [CM-PERSIST-FIX]
  isIndexed, // [MEAL-PREP]
  hasChunks, // [MEAL-PREP]
  isQuickMigrating,
  quickMigrateStage,
  quickMigrateProgress,
  onQuickMigrate,
  onSelect,
  onRenaming,
}) {
  const [hovered, setHovered] = useState(false);
  const pColor = PLATFORM_COLORS[session.platform];

  // ── Engagement metrics derived from session data ──────────────────────────
  // Code blocks: count artifacts of type "code" + matched fence pairs in content.
  const codeBlockCount = session.messages.reduce((sum, msg) => {
    const fromArtifacts = msg.artifacts?.filter(a => a.type === "code").length ?? 0;
    const fences = msg.content.match(/```/g)?.length ?? 0;
    return sum + fromArtifacts + Math.floor(fences / 2);
  }, 0);
  const msgCount = session.messages.length;
  const isDevSession = codeBlockCount > 5;
  const isMarathon   = msgCount > 50;
  const isDeepCtx    = !isMarathon && msgCount > 20;

  return (
    <div
      key={session.id}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="stagger-item card-hover relative block w-full cursor-pointer rounded-[4px] border bg-[#0a0a0a] px-2 py-[4px] text-left"
      style={{
        borderColor: hovered ? `${pColor}50` : `${pColor}25`,
        boxShadow: hovered
          ? `0 0 0 1px ${pColor}30, 0 4px 18px ${pColor}20, 0 1px 0 ${pColor}18`
          : `0 1px 0 ${pColor}10`,
        transform: hovered ? "translateY(-1px)" : "translateY(0)",
        transition: "border-color 180ms ease, box-shadow 180ms ease, transform 150ms ease, background 150ms ease",
        background: hovered ? "#111111" : "#0a0a0a",
        overflow: "hidden",
      }}
    >
      <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: pColor }} />
      <div className="flex items-center gap-1 pl-1">
        <div className="min-w-0 flex-1">
          {/* ── Header row: platform badge + drive icon + engagement badges ── */}
          <div className="flex items-center gap-1">
            <PlatformBadge platform={session.platform} logoSize={8} />
            {driveSourced && (
              <span
                title="Synced from Google Drive (captured on another profile)"
                style={{ fontSize: 9, color: "#00FF88", letterSpacing: "0.05em" }}
              >
                ☁
              </span>
            )}
            {isDevSession  && <span style={BADGE_DEV}>Dev Session</span>}
            {isMarathon    && <span style={BADGE_MARATHON}>Marathon</span>}
            {isDeepCtx     && <span style={BADGE_DEEP}>Deep Context</span>}
            {/* [CM-PERSIST-FIX] show indexing status so user knows Tier 3 readiness */}
            {isPendingIndex && (
              <span style={{
                fontSize: '9px',
                color: 'var(--color-text-warning, #00D26A)',
                opacity: 0.85,
                marginLeft: '4px',
                letterSpacing: '0.02em',
              }}>
                ⚡ indexing...
              </span>
            )}
            {isIndexed && !isPendingIndex && (
              <span style={{
                fontSize: '9px',
                color: '#00FF88',
                opacity: 0.9,
                marginLeft: '4px',
                letterSpacing: '0.02em',
                fontWeight: 600,
              }}>
                ✓ indexed
              </span>
            )}
            {!isIndexed && !isPendingIndex && hasChunks && (
              <span style={{
                fontSize: '9px',
                color: '#00D26A',
                opacity: 0.7,
                marginLeft: '4px',
                letterSpacing: '0.02em',
              }}>
                ◐ partial
              </span>
            )}
            {!isIndexed && !isPendingIndex && !hasChunks && (
              <span style={{
                fontSize: '9px',
                color: '#9CA3AF',
                opacity: 0.6,
                marginLeft: '4px',
                letterSpacing: '0.02em',
              }}>
                ○ not indexed
              </span>
            )}
          </div>
          <InlineRename
            session={session}
            displayClassName="truncate text-[11px] font-semibold text-[#F5F5F5] cursor-text"
            inputClassName="w-full bg-transparent border-b border-[#00FF88] text-[11px] font-semibold text-[#F5F5F5] outline-none"
            onRename={(name) => chrome.runtime.sendMessage({ type: "RENAME_SESSION", sessionId: session.id, title: name })}
            stopPropagation
            onEditingChange={onRenaming}
          />
          {/* ── Meta row ── */}
          <div className="flex items-center gap-1 text-[8px] uppercase" style={{ letterSpacing: "0.08em", color: "#00D26A" }}>
            <span>{msgCount} turns</span>
            <span>·</span>
            <span>{formatRelativeTime(session.updatedAt)}</span>
            <span>·</span>
            <span style={{ fontSize: "8px", color: vaultConnected === true ? "#00AA55" : driveSourced ? "#00FF88" : "#9CA3AF" }}>
              {vaultConnected === true ? "🔒 Vault" : driveSourced ? "☁ Drive" : "📱 Local"}
            </span>
            {codeBlockCount > 0 && (
              <>
                <span>·</span>
                <span
                  title={`${codeBlockCount} code block${codeBlockCount !== 1 ? "s" : ""}`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "2px",
                    color: "#E5E5E5", fontWeight: 700, fontSize: "8px",
                  }}
                >
                  <span style={{ fontFamily: "monospace", fontSize: "9px", lineHeight: 1 }}>&lt;/&gt;</span>
                  {codeBlockCount}
                </span>
              </>
            )}
            {migrationTier && (
              <>
                <span>·</span>
                <span style={{
                  padding: "1px 6px",
                  borderRadius: "10px",
                  background: (migrationTier ?? 1) >= 2 ? "rgba(0,255,136,0.12)" : "rgba(0,255,136,0.06)",
                  border: `1px solid ${(migrationTier ?? 1) >= 2 ? "rgba(0,255,136,0.3)" : "#2A2A2A"}`,
                  color: (migrationTier ?? 1) >= 2 ? "#00FF88" : "#666",
                  fontSize: "8px",
                  letterSpacing: "0.06em",
                  fontWeight: 700,
                }}>
                  {migrationTier === 1 ? "Full" : migrationTier === 2 ? "Smart" : "▸ AE"}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {/* [CM-SOLAR-V2] 1-click quick-migrate (Tier 1, inline mini stepper). */}
          {isQuickMigrating ? (
            <div className="flex items-center gap-1.5">
              <MigrationStepper
                stage={quickMigrateStage ?? ""}
                progress={quickMigrateProgress ?? 0}
                tier={1}
                variant="compact"
              />
              <span style={{ display: "inline-block", animation: "spin 0.7s linear infinite", color: "#00FF88", fontSize: "10px" }}>↻</span>
            </div>
          ) : hovered ? (
            <button
              onClick={(e) => { e.stopPropagation(); onQuickMigrate?.(); }}
              title="Quick migrate (Full Context) to active AI tab"
              className="rounded-[3px] border border-[#00FF88]/30 bg-[#00FF88]/10 px-1 text-[10px] text-[#00FF88] transition-all hover:bg-[#00FF88]/20 hover:border-[#00FF88]/50 hover:shadow-[0_0_8px_rgba(0,255,136,0.3)]"
            >
              ⚡
            </button>
          ) : (
            <span style={{
              color: hovered ? "#00FF88" : "#3A3A3A",
              transition: "color 150ms ease",
            }}>›</span>
          )}
        </div>
      </div>
    </div>
  );
}, (prev, next) =>
  prev.session.id === next.session.id &&
  prev.session.updatedAt === next.session.updatedAt &&
  prev.session.messages.length === next.session.messages.length &&
  prev.vaultConnected === next.vaultConnected &&
  prev.migrationTier === next.migrationTier &&
  prev.isQuickMigrating === next.isQuickMigrating &&
  prev.quickMigrateStage === next.quickMigrateStage &&
  prev.quickMigrateProgress === next.quickMigrateProgress
);

const PLATFORM_LABELS: Record<Platform, string> = {
  claude:     "Claude",
  chatgpt:    "ChatGPT",
  gemini:     "Google Gemini",
  grok:       "xAI Grok",
  perplexity: "Perplexity",
  deepseek:   "DeepSeek",
};

const PLATFORM_SHORT: Record<Platform, string> = {
  claude:     "Claude",
  chatgpt:    "ChatGPT",
  gemini:     "Gemini",
  grok:       "Grok",
  perplexity: "Perplexity",
  deepseek:   "DeepSeek",
};

const PLATFORM_COLORS: Record<Platform, string> = {
  claude:     "#E5E5E5",
  chatgpt:    "#E5E5E5",
  gemini:     "#E5E5E5",
  grok:       "#E5E5E5",
  perplexity: "#E5E5E5",
  deepseek:   "#E5E5E5",
};

function getDisplayName(session: ContextSession): string {
  const name = session.customName ?? session.title ?? "Untitled session";
  return name.length > 40 ? name.slice(0, 40) + "…" : name;
}

function InlineRename({
  session,
  displayClassName,
  inputClassName,
  onRename,
  stopPropagation = false,
  onEditingChange,
}: {
  session: ContextSession;
  displayClassName: string;
  inputClassName: string;
  onRename: (name: string) => void;
  stopPropagation?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [hovered, setHovered] = useState(false);
  const display = getDisplayName(session);

  const startEdit = () => {
    setEditing(true);
    setVal(display);
    onEditingChange?.(true);
  };

  const confirmEdit = () => {
    setEditing(false);
    onEditingChange?.(false);
    if (val.trim() && val.trim() !== display) {
      onRename(val.trim());
    }
  };

  const cancelEdit = () => {
    setEditing(false);
    onEditingChange?.(false);
  };

  if (!editing) {
    return (
      <div
        className="flex items-center gap-1 min-w-0"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span
          className={displayClassName}
          title={display}
          onClick={stopPropagation
            ? (e) => { e.stopPropagation(); startEdit(); }
            : startEdit}
        >
          {display}
        </span>
        <button
          title="Rename session"
          onClick={stopPropagation
            ? (e) => { e.stopPropagation(); startEdit(); }
            : startEdit}
          style={{
            flexShrink: 0, color: hovered ? "#00FF88" : "#3A5A3A", background: "none",
            border: "none", cursor: "pointer", fontSize: 15, padding: "0 3px",
            lineHeight: 1, transition: "color 150ms ease",
          }}
        >
          ✏
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-1 min-w-0"
      onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
    >
      <input
        autoFocus
        className={inputClassName}
        style={{ flex: 1, minWidth: 0 }}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); confirmEdit(); }
          else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
        }}
        onBlur={confirmEdit}
      />
      <button
        title="Confirm (Enter)"
        onMouseDown={(e) => { e.preventDefault(); confirmEdit(); }}
        style={{
          flexShrink: 0, color: "#00FF88", background: "none",
          border: "none", cursor: "pointer", fontSize: 14, padding: "0 3px",
          lineHeight: 1,
        }}
      >
        ✓
      </button>
      <button
        title="Cancel (Esc)"
        onMouseDown={(e) => { e.preventDefault(); cancelEdit(); }}
        style={{
          flexShrink: 0, color: "#6B6B6B", background: "none",
          border: "none", cursor: "pointer", fontSize: 14, padding: "0 3px",
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

type View = "sessions" | "detail";
type StatusTone = "info" | "success" | "error";

export default function Sidebar() {
  const [sessions, setSessions] = useState<ContextSession[]>([]);
  // [CM-PERSIST-FIX] tracks sessions with incomplete embeddings
  const [pendingIndexIds, setPendingIndexIds] = useState<Set<string>>(new Set());
  const [indexedIds, setIndexedIds] = useState<Set<string>>(new Set());
  const [hasChunkIds, setHasChunkIds] = useState<Set<string>>(new Set());
  const [syncStatus, setSyncStatus] = useState<{
    direction: 'in' | 'out';
    phase: 'start' | 'done';
    sessionsTotal?: number;
    sessionsSynced?: number;
    indexedCount?: number;
    chunkCount?: number;
    timestamp: number;
  } | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshSuccess, setRefreshSuccess] = useState(false);
  const [selected, setSelected] = useState<ContextSession | null>(null);
  const [view, setView] = useState<View>("sessions");
  const [targetPlatform, setTargetPlatform] = useState<Platform>("claude");
  const [migrationTiers, setMigrationTiers] = useState<Record<string, 1 | 2 | 3>>({});
  const [filter, setFilter] = useState<Platform | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(new Set());
  const [statusMessage, setStatusMessage] = useState<{ tone: StatusTone; text: string } | null>(
    null
  );
  const [tick, setTick] = useState(0);
  const [isRenaming, setIsRenaming] = useState(false);
  const [showMigrationModal, setShowMigrationModal] = useState(false);

  // [CM-SOLAR-V2] 1-click quick-migrate (Tier 1) inline on session cards.
  const [quickMigratingId, setQuickMigratingId] = useState<string | null>(null);
  const [quickMigrateStage, setQuickMigrateStage] = useState("");
  const [quickMigrateProgress, setQuickMigrateProgress] = useState(0);
  const quickMigratingRef = useRef<string | null>(null);

  // [ONNX-KEEPALIVE-L1] Open keepalive port to prevent SW sleep while sidebar is open.
  // This keeps the offscreen doc + ONNX model alive, eliminating 20-40s cold starts.
  useEffect(() => {
    const keepalivePort = chrome.runtime.connect({ name: 'keepalive' });
    return () => {
      keepalivePort.disconnect();
    };
  }, []);

  // [CM-PERSIST-FIX] poll for pending index jobs to show UI indicator
  useEffect(() => {
    const refreshPending = async () => {
      try {
        const jobs = await dexieDb.pendingIndex.toArray()
        setPendingIndexIds(new Set(jobs.map(j => j.sessionId)))
        const hashes = await dexieDb.sessionHashes.toArray()
        const allChunks = await dexieDb.chunkEmbeddings.toArray()
        const chunkSessionIds = new Set(allChunks.map(c => c.sessionId))
        setHasChunkIds(chunkSessionIds)
        // [INDEX-COUNT-FIX] A session is truly indexed only when isComplete=true AND it has chunks.
        // A hash with isComplete=true but 0 chunks is a phantom hash (from Drive sync or interrupted index).
        const hashCompleteIds = new Set(hashes.filter(h => h.isComplete).map(h => h.sessionId))
        const trulyIndexed = new Set([...hashCompleteIds].filter(id => chunkSessionIds.has(id)))
        setIndexedIds(trulyIndexed)
      } catch { /* silently ignore — indicator is non-critical */ }
    }
    void refreshPending()
    // Poll every 10s — fast enough to feel responsive, slow enough to not drain battery
    const interval = setInterval(() => void refreshPending(), 10_000)
    return () => clearInterval(interval)
  }, []);
  const [latestQualityScore, setLatestQualityScore] = useState<QualityScore | null>(null);
  const [latestCoverageStats, setLatestCoverageStats] = useState<any>(null);
  const [qualityStats, setQualityStats] = useState<{ count: number; avgScore: number } | null>(null);

  const [planStatus, setPlanStatus] = useState<{
    plan:      "free" | "pro" | "team";
    isPro:     boolean;
    used?:     number;   // simple migrations used this month
    limit?:    number;   // simple migrations limit
    status?:   string;
    trialEnd?: string | null;
    loaded:    boolean;
    deviceLimitExceeded?: boolean;
    deviceLimitMessage?:  string;
  }>({ plan: "free", isPro: false, loaded: false });
  const [usageStatus, setUsageStatus] = useState<UsageStatus | null>(null);
  const [paywallData, setPaywallData] = useState<{
    tier: number;
    used: number;
    limit: number;
    daysUntilReset: number;
    upgradeUrl: string;
  } | null>(null);
  const [attentionAvailable, setAttentionAvailable] = useState(true);
  const [vaultConnected, setVaultConnected] = useState<boolean | null>(null);
  const [vaultName, setVaultName] = useState<string | undefined>(undefined);
  // MCP bridge status — green when the local @contextmover/mcp-server is up
  // and listening on 127.0.0.1:49001. Independent from the VS Code IDE bridge.
  const [mcpStatus, setMcpStatus] = useState<{ running: boolean; totalSessions?: number }>({ running: false });
  const [driveConnected, setDriveConnected] = useState<boolean | null>(null);
  const [driveSyncing, setDriveSyncing] = useState(false);
  const [semanticQuery, setSemanticQuery] = useState("");
  const [semanticResults, setSemanticResults] = useState<{ sessionId: string; score: number; preview?: string }[]>([]);
  const [semanticPlatformFilter, setSemanticPlatformFilter] = useState<string>("all");
  // [Feature 3] Multi-session migration state
  const [additionalSessionIds, setAdditionalSessionIds] = useState<string[]>([]);
  const [showMultiSessionPicker, setShowMultiSessionPicker] = useState(false);
  const loadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const semanticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSubFetch = useRef<number>(0);
  const activeRenameRef = useRef(false);
  const lastRefreshRef = useRef(0);
  // Ref-stable message handler — avoids re-registering the listener on every render.
  const handleMessageRef = useRef<(msg: { type: string }) => void>();
  // Precomputed summaries — keyed by sessionId, populated on session card click.
  const precomputedSummaries = useRef<Map<string, { cached: boolean }>>(new Map());
  const hardwareTierRef = useRef<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSynthesizer, setShowSynthesizer] = useState(false);
  // [CM-PERF] set true when ONNX model warmup completes — drives the semantic-ready dot
  const [searchReady, setSearchReady] = useState(false);
  const [indexStats, setIndexStats] = useState<IndexStats | null>(null);
  const [indexStatsLoading, setIndexStatsLoading] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [remoteUpdateMessage, setRemoteUpdateMessage] = useState<string | null>(null);
  const [brokenPlatform, setBrokenPlatform] = useState<string | null>(null);
  const [showSelfHeal, setShowSelfHeal] = useState(false);
  const [scrollHint, setScrollHint] = useState<{ platform: string; msgCount: number } | null>(null);
  const [driveMismatchBanner, setDriveMismatchBanner] = useState(false);
  const [sidebarAccessToken, setSidebarAccessToken] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<any | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const handleRunProbe = async () => { setIsProbing(true); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab?.id) { const r = await chrome.runtime.sendMessage({ type: 'RUN_DOM_PROBE', tabId: tab.id }); if (r?.ok) setProbeResult(r.probeResult); } setIsProbing(false); };
  // ── Drive sync state — fetched on mount + when settings panel opens ────────
  const [driveStatus, setDriveStatus] = useState<{
    connected: boolean;
    lastSyncAt: number | null;
    lastSyncCount: number | null;
    sourcedIds: string[];
  }>({ connected: false, lastSyncAt: null, lastSyncCount: null, sourcedIds: [] });
  const [driveBusy, setDriveBusy] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [partialSync, setPartialSync] = useState<{ pct: number; done: number; total: number; phase: string } | null>(null);
  const driveSourcedSet = useMemo(() => new Set(driveStatus.sourcedIds), [driveStatus.sourcedIds]);

  const refreshDriveStatus = useCallback(() => {
    chrome.runtime.sendMessage({ type: "DRIVE_STATUS" }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      setDriveStatus({
        connected: !!res.connected,
        lastSyncAt: typeof res.lastSyncAt === "number" ? res.lastSyncAt : null,
        lastSyncCount: typeof res.lastSyncCount === "number" ? res.lastSyncCount : null,
        sourcedIds: Array.isArray(res.sourcedIds) ? res.sourcedIds : [],
      });
    });
  }, []);

  const connectDrive = useCallback(() => {
    setDriveBusy(true);
    chrome.runtime.sendMessage({ type: "DRIVE_CONNECT" }, (res) => {
      setDriveBusy(false);
      if (chrome.runtime.lastError) return;
      if (res?.connected) refreshDriveStatus();
    });
  }, [refreshDriveStatus]);

  const disconnectDrive = useCallback(() => {
    setDriveBusy(true);
    chrome.runtime.sendMessage({ type: "DRIVE_DISCONNECT" }, () => {
      setDriveBusy(false);
      if (chrome.runtime.lastError) return;
      refreshDriveStatus();
    });
  }, [refreshDriveStatus]);

  const syncDriveNow = useCallback(() => {
    setDriveBusy(true);
    chrome.runtime.sendMessage({ type: "DRIVE_SYNC_NOW" }, () => {
      setDriveBusy(false);
      if (chrome.runtime.lastError) return;
      refreshDriveStatus();
    });
  }, [refreshDriveStatus]);

  const syncBidirectionalNow = useCallback(() => {
    if (driveOpInFlightRef.current) return;
    driveOpInFlightRef.current = true;
    setDriveSyncing(true);
    chrome.runtime.sendMessage({ type: "DRIVE_SYNC_BIDIRECTIONAL" }, () => {
      driveOpInFlightRef.current = false;
      setDriveSyncing(false);
      if (chrome.runtime.lastError) return;
      refreshDriveStatus();
      loadSessions();
    });
  }, [refreshDriveStatus, loadSessions]);

  const wipeDrive = useCallback(() => {
    if (!confirm("This will permanently delete ALL ContextMover data from your Google Drive. This cannot be undone. Continue?")) return;
    setDriveBusy(true);
    // [WIPE-FIX] Timeout fallback — if the SW doesn't respond within 30s,
    // release the busy state so the button isn't permanently stuck.
    const timeout = setTimeout(() => setDriveBusy(false), 30_000);
    chrome.runtime.sendMessage({ type: "DRIVE_WIPE", confirm: true }, (res) => {
      clearTimeout(timeout);
      setDriveBusy(false);
      if (chrome.runtime.lastError) return;
      if (res?.ok) {
        alert(`Wiped ${res.deleted} files from Drive${res.failed ? `, ${res.failed} failed` : ""}.`);
      } else {
        alert(res?.error ?? "Drive wipe failed");
      }
      refreshDriveStatus();
    });
  }, [refreshDriveStatus]);

  const wipeLocalData = useCallback(() => {
    if (!confirm("This will permanently delete ALL local ContextMover data (sessions, chunks, indexes, settings) from this browser. Your login and Drive connection are preserved. This cannot be undone. Continue?")) return;
    setLocalBusy(true);
    // [WIPE-FIX] Timeout fallback — if the SW doesn't respond within 15s,
    // release the busy state so the button isn't permanently stuck.
    const timeout = setTimeout(() => setLocalBusy(false), 15_000);
    chrome.runtime.sendMessage({ type: "WIPE_LOCAL_DATA", confirm: true }, (res) => {
      clearTimeout(timeout);
      setLocalBusy(false);
      if (chrome.runtime.lastError) { alert("Wipe failed: " + chrome.runtime.lastError.message); return; }
      if (res?.ok) {
        alert("All local extension data has been wiped. Your login is preserved.");
        loadSessions();
      } else {
        alert(res?.error ?? "Local wipe failed");
      }
    });
  }, [loadSessions]);

  const handleRenaming = useCallback((v: boolean) => {
    activeRenameRef.current = v;
    setIsRenaming(v);
  }, []);

  useEffect(() => {
    refreshDriveStatus();
  }, [refreshDriveStatus]);
  useEffect(() => {
    if (showSettings) refreshDriveStatus();
  }, [showSettings, refreshDriveStatus]);

  // ── Update check — compare manifest version vs hosted extension-version.json + remote config ──
  useEffect(() => {
    const current = chrome.runtime.getManifest().version;
    fetch("https://contextmover.com/extension-version.json", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { version?: string }) => {
        if (data.version && semverGt(data.version, current)) {
          setUpdateAvailable(data.version);
        }
      })
      .catch(() => {});

    getRemoteUpdateInfo().then((info) => {
      if (info?.forceUpdate && info.message) {
        setRemoteUpdateMessage(info.message);
      }
    }).catch(() => {});
  }, []);


  useEffect(() => {
    loadSessions();
    void checkVault();
    void checkDriveStatus();
    chrome.storage.local.get(["accessToken", "driveProReason"], ({ accessToken, driveProReason }) => {
      if (accessToken) setSidebarAccessToken(accessToken as string);
      if (driveProReason === "drive_mismatch") setDriveMismatchBanner(true);
    });
    // MCP polling disabled — IDE bridge deferred to Phase 2.
    const mcpInterval = 0;
    void fetchSubscriptionStatus(); // once on mount

    // Attention-engine availability (model may be blocked by CSP)
    chrome.runtime.sendMessage({ type: "GET_ATTENTION_STATUS" }, (res) => {
      if (!chrome.runtime.lastError && res?.available === false) {
        setAttentionAvailable(false);
      }
    });

    const clockInterval = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 30_000);

    // Instant refresh on SW broadcast — handler stored in ref so the listener
    // is registered exactly once (empty deps) and always calls the latest closure.
    const stableListener = (msg: { type: string }) => {
      handleMessageRef.current?.(msg);
    };
    chrome.runtime.onMessage.addListener(stableListener);

    // pagehide fires synchronously when the side panel is destroyed (Chrome X
    // button). React's useEffect cleanup is async and may not deliver the message
    // before the context is torn down. This ensures the SW always gets notified.
    const onPageHide = () => {
      chrome.runtime.sendMessage({ type: 'SIDEBAR_CLOSED' }).catch(() => {});
    };
    window.addEventListener('pagehide', onPageHide);

    // [TASK-11] Trigger Drive pull when sidebar regains visibility or focus.
    // Handles: user switches away from sidebar, makes changes in another profile,
    // then returns — pull fires immediately without waiting for 30s periodic alarm.
    let lastVisiblePull = 0;
    const triggerPull = () => {
      const now = Date.now();
      if (now - lastVisiblePull > 5000) {
        lastVisiblePull = now;
        chrome.runtime.sendMessage({ type: 'DRIVE_SYNC_NOW' }).catch(() => {});
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') triggerPull();
    };
    const onFocus = () => triggerPull();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);

    return () => {
      window.clearInterval(clockInterval);
      window.clearInterval(mcpInterval);
      chrome.runtime.onMessage.removeListener(stableListener);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      if (loadDebounceRef.current) clearTimeout(loadDebounceRef.current);
      if (semanticTimerRef.current) clearTimeout(semanticTimerRef.current);
      // Notify toggle button that sidebar closed (covers cases other than unload)
      chrome.runtime.sendMessage({ type: 'SIDEBAR_CLOSED' }).catch(() => {});
    };
  }, []);

  const backfillRan = useRef(false);
  const prevSessionCount = useRef(0);
  useEffect(() => {
    // Reset backfill flag when sessions transition from 0 to non-zero
    // (e.g. after Drive restore following a wipe).
    if (prevSessionCount.current === 0 && sessions.length > 0) {
      backfillRan.current = false;
    }
    prevSessionCount.current = sessions.length;
    if (backfillRan.current || !sessions.length) return;
    backfillRan.current = true;
    void (async () => {
      try {
        const h = await dexieDb.sessionHashes.toArray();
        const c = await dexieDb.chunkEmbeddings.toArray();
        // [INDEX-COUNT-FIX] Match sidebar indexedIds: isComplete=true AND has chunks
        const hashCompleteIds = new Set(h.filter(x => x.isComplete).map(x => x.sessionId));
        const chunkSessionIds = new Set(c.map(x => x.sessionId));
        const trulyIndexed = new Set([...hashCompleteIds].filter(id => chunkSessionIds.has(id)));
        sessions.filter(s => !trulyIndexed.has(s.id) && s.messages.length > 0).forEach(s =>
          chrome.runtime.sendMessage({ type: "BACKGROUND_INDEX", sessionId: s.id }).catch(() => {}));
      } catch {}
    })();
  }, [sessions]);

  // Keep handleMessageRef in sync with latest loadSessions closure every render.
  handleMessageRef.current = (msg: { type: string; pct?: number; done?: number; total?: number; phase?: string; platform?: string; reason?: string; pendingId?: string; sessionTitle?: string; targetPlatform?: string; progress?: number; stage?: string }) => {
    if (msg.type === "SESSIONS_UPDATED") {
      if (!activeRenameRef.current) loadSessions();
    }
    // [CM-SOLAR-V2] Quick-migrate progress (only when a quick-migrate is active).
    if (msg.type === "MIGRATION_PROGRESS" && quickMigratingRef.current) {
      setQuickMigrateProgress(typeof msg.progress === "number" ? msg.progress : 0);
      setQuickMigrateStage(typeof msg.stage === "string" ? msg.stage : "");
    }
    // [FIX] SCRAPER_BROKEN handler removed — false alarms on all LLMs.
    if (msg.type === "CAPTURE_SCROLL_HINT") {
      const p = (msg as { platform?: string; msgCount?: number }).platform ?? "this page";
      const n = (msg as { platform?: string; msgCount?: number }).msgCount ?? 0;
      setScrollHint({ platform: p, msgCount: n });
      setTimeout(() => setScrollHint(null), 20_000);
    }
    if (msg.type === "AUTH_STATE_CHANGED") {
      // Force subscription re-fetch — user signed in or switched accounts.
      chrome.storage.local.get(["accessToken", "driveProReason"], ({ accessToken, driveProReason }) => {
        setSidebarAccessToken(accessToken ? (accessToken as string) : null);
        setDriveMismatchBanner(driveProReason === "drive_mismatch");
      });
      lastSubFetch.current = 0;
      void fetchSubscriptionStatus();
    }
    if (msg.type === "DRIVE_PRO_MISMATCH") {
      setDriveMismatchBanner(true);
      lastSubFetch.current = 0;
      void fetchSubscriptionStatus();
    }
    if (msg.type === "USAGE_WARNING") {
      chrome.storage.local.get("accessToken", ({ accessToken }) => {
        if (accessToken) {
          getUsageStatus(accessToken as string).then((s) => { if (s) setUsageStatus(s); }).catch(() => {});
        }
      });
    }
    if (msg.type === "DRIVE_SYNC_STATUS") {
      const m = msg as { direction?: 'in' | 'out'; phase?: 'start' | 'done'; sessionsTotal?: number; sessionsSynced?: number; indexedCount?: number; chunkCount?: number; timestamp?: number };
      if (m.timestamp) {
        setSyncStatus({
          direction: m.direction ?? 'in',
          phase: m.phase ?? 'done',
          sessionsTotal: m.sessionsTotal,
          sessionsSynced: m.sessionsSynced,
          indexedCount: m.indexedCount,
          chunkCount: m.chunkCount,
          timestamp: m.timestamp,
        });
      }
    }
    if (msg.type === "PARTIAL_SYNC_PROGRESS") {
      const pct   = typeof msg.pct   === "number" ? msg.pct   : 0;
      const done  = typeof msg.done  === "number" ? msg.done  : 0;
      const total = typeof msg.total === "number" ? msg.total : 0;
      const phase = typeof msg.phase === "string" ? msg.phase : "Syncing...";
      if (pct >= 100 || phase === "Done") {
        setPartialSync(null);
      } else {
        setPartialSync({ pct, done, total, phase });
      }
    }
  };

  // ── One-time hardware detection + model warmup ──────────────────────────────
  // [CM-PERF] pre-warm ONNX model on sidebar open so first search/migration has zero wait.
  // Detect once, memoize in a ref, send WARMUP_MODEL if capable hardware.
  // Uses a callback (not .catch()) so we can set searchReady when the model is loaded.
  useEffect(() => {
    capabilityDetector.getEffectiveTier()
      .then((tier) => {
        hardwareTierRef.current = tier;
        if (tier === 'minimal') return; // minimal hardware: skip warmup, keyword-only search
        console.log("[CM:sidebar] pre-warming ONNX model on sidebar open");
        chrome.runtime.sendMessage({ type: 'WARMUP_MODEL' }, (res) => {
          if (chrome.runtime.lastError || !res?.ok) return;
          // skipped=true means model was already warm (idempotency) — still mark ready
          setSearchReady(true);
        });
      })
      .catch(() => {});
  }, []);

  // ── Plan status (Free / Pro / Team) for the header badge ───────────────────
  // Cached for 5 minutes to prevent repeated polling.
  const SUBSCRIPTION_CACHE_MS = 5 * 60 * 1000;

  async function fetchSubscriptionStatus() {
    const now = Date.now();
    if (now - lastSubFetch.current < SUBSCRIPTION_CACHE_MS) return;
    lastSubFetch.current = now;
    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_SUBSCRIPTION_STATUS" }) as {
        plan?:     "free" | "pro" | "team";
        isPro?:    boolean;
        usage?:    { simpleMigrations: number };
        limits?:   { simpleMigrations: number | "unlimited" };
        status?:   string;
        trialEnd?: string | null;
        deviceLimitExceeded?: boolean;
        message?:  string;
      } | undefined;
      if (!res) return;
      const used  = res.usage?.simpleMigrations;
      const limit = res.limits?.simpleMigrations;
      setPlanStatus({
        plan:     res.plan ?? "free",
        isPro:    Boolean(res.isPro),
        used,
        limit:    typeof limit === "number" ? limit : undefined,
        status:   res.status,
        trialEnd: res.trialEnd ?? null,
        loaded:   true,
        deviceLimitExceeded: res.deviceLimitExceeded ?? false,
        deviceLimitMessage:  res.message,
      });
    } catch {
      setPlanStatus((s) => ({ ...s, loaded: true }));
    }
  }

  // ── Usage status for sidebar meter ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let consecutiveFailures = 0;
    async function load() {
      const { accessToken } = await chrome.storage.local.get("accessToken");
      if (!accessToken || cancelled) return;
      const status = await getUsageStatus(accessToken as string);
      if (cancelled) return;
      if (status) {
        consecutiveFailures = 0;
        setUsageStatus(status);
      } else {
        consecutiveFailures++;
      }
    }
    load();
    // Refresh every 5 min, with exponential backoff on failures (max 30 min).
    const intervalId = window.setInterval(() => {
      if (!cancelled) {
        const backoffMs = Math.min(consecutiveFailures * 5 * 60_000, 30 * 60_000);
        if (backoffMs > 0) return; // skip this tick — backoff active
        void load();
      }
    }, 5 * 60_000);
    // Retry when accessToken appears or refreshes — covers the case where
    // the sidebar mounts before sign-in completes (otherwise the call fires
    // with no token and the route returns 401).
    const onStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area === "local" && changes.accessToken && !cancelled) {
        consecutiveFailures = 0;
        void load();
      }
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      chrome.storage.onChanged.removeListener(onStorageChange);
    };
  }, []);

  // ── Silent background preload of Attention Engine ───────────────────────────
  // Warming up the model (~23 MB download on first run) while the user is
  // browsing sessions means zero wait time when they open MigrationModal tier 3.
  // Runs only if the detector thinks the device can handle it (not minimal).
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled || attentionEngine.initialized) return;
      const tier = await capabilityDetector.getEffectiveTier().catch(() => "balanced" as const);
      if (tier === "minimal") return; // Skip preload on very weak devices.
      console.log("[ContextMover:sidebar] Background preload starting…");
      attentionEngine
        .initialize(undefined, tier)
        .then(() => console.log("[ContextMover:sidebar] Background preload ready"))
        .catch((err) => console.warn("[ContextMover:sidebar] Background preload failed:", err));
    }, 1200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // ── Pre-index the selected session when entering detail view ─────────────────
  useEffect(() => {
    if (view !== "detail" || !selected) return;
    if (!attentionEngine.initialized || !searchReady) return;
    attentionEngine.indexSession(selected).catch(() => { /* ignore */ });
  }, [view, selected, searchReady]);

  useEffect(() => {
    if (semanticTimerRef.current) clearTimeout(semanticTimerRef.current);
    if (!semanticQuery.trim() || semanticQuery.length < 3) {
      setSemanticResults([]);
      return;
    }
    setSemanticResults([]);
    semanticTimerRef.current = setTimeout(async () => {
      try {
        if (!attentionEngine.initialized) await attentionEngine.initialize();
        const filters: { platform?: string } = {};
        if (semanticPlatformFilter !== "all") filters.platform = semanticPlatformFilter;
        const chunks = await attentionEngine.semanticSearch(semanticQuery, 10, filters);
        const sessionMap = new Map<string, { score: number; preview: string }>();
        for (const c of chunks) {
          const prev = sessionMap.get(c.sessionId);
          if (!prev || c.relevanceScore > prev.score) {
            const previewText = c.content.slice(0, 120).replace(/\n+/g, " ").trim();
            sessionMap.set(c.sessionId, { score: c.relevanceScore, preview: previewText });
          }
        }
        setSemanticResults(
          [...sessionMap.entries()]
            .sort((a, b) => b[1].score - a[1].score)
            .map(([sessionId, { score, preview }]) => ({ sessionId, score, preview }))
        );
      } catch { setSemanticResults([]); }
    }, 300);
    return () => { if (semanticTimerRef.current) clearTimeout(semanticTimerRef.current); };
  }, [semanticQuery, semanticPlatformFilter]);

  function checkVault() {
    chrome.runtime.sendMessage({ type: 'VAULT_GET_STATUS' }, (res) => {
      if (chrome.runtime.lastError) return;
      setVaultConnected(res?.connected === true);
      if (res?.projectName) setVaultName(res.projectName as string);
    });
  }

  function checkDriveStatus() {
    chrome.runtime.sendMessage({ type: 'DRIVE_STATUS' }, (res) => {
      if (chrome.runtime.lastError) return;
      setDriveConnected(res?.connected === true);
    });
  }

  // Synchronous re-entry guard — setDriveSyncing is async (React batches state
  // updates), so two click events within the same tick can both pass an
  // `if (driveSyncing) return` check. The ref is updated synchronously and
  // closes that window completely.
  const driveOpInFlightRef = useRef(false);
  function handleDriveButton() {
    if (driveOpInFlightRef.current) return;
    driveOpInFlightRef.current = true;
    setDriveSyncing(true);
    const done = () => {
      driveOpInFlightRef.current = false;
      setDriveSyncing(false);
    };
    if (!driveConnected) {
      chrome.runtime.sendMessage({ type: 'DRIVE_CONNECT' }, (res) => {
        if (chrome.runtime.lastError) { done(); return; }
        setDriveConnected(res?.connected === true);
        done();
      });
    } else {
      chrome.runtime.sendMessage({ type: 'DRIVE_SYNC_NOW' }, () => {
        if (chrome.runtime.lastError) { done(); return; }
        done();
      });
    }
  }

  // Probe the local ContextMover MCP server health endpoint via the service
  // worker (CORS-restricted from a sidebar page, the SW does the fetch).
  function checkMcpBridge() {
    chrome.runtime.sendMessage({ type: 'CHECK_MCP_BRIDGE' }, (res) => {
      if (chrome.runtime.lastError) { setMcpStatus({ running: false }); return; }
      setMcpStatus({
        running:       Boolean(res?.running),
        totalSessions: typeof res?.totalSessions === 'number' ? res.totalSessions : undefined,
      });
    });
  }

  function loadSessions() {
    // Collapse rapid bursts into a single GET_SESSIONS call after 250 ms quiet
    if (loadDebounceRef.current) clearTimeout(loadDebounceRef.current);
    loadDebounceRef.current = setTimeout(() => {
      chrome.runtime.sendMessage({ type: "GET_SESSIONS" }, (res) => {
        void chrome.runtime.lastError; // suppress unchecked error if SW asleep
        if (Array.isArray(res)) setSessions(res);
        setSessionsLoading(false);
      });
    }, 250);
  }

  function handleRefreshClick() {
    if (isRefreshing || activeRenameRef.current) return;
    if (Date.now() - lastRefreshRef.current < 2000) return;
    lastRefreshRef.current = Date.now();
    setIsRefreshing(true);
    if (loadDebounceRef.current) clearTimeout(loadDebounceRef.current);
    const timeout = setTimeout(() => setIsRefreshing(false), 5000);
    chrome.runtime.sendMessage({ type: "GET_SESSIONS", force: true }, (res) => {
      void chrome.runtime.lastError;
      clearTimeout(timeout);
      if (Array.isArray(res)) {
        setSessions(res);
        setRefreshSuccess(true);
        setTimeout(() => setRefreshSuccess(false), 600);
      }
      setSessionsLoading(false);
      setIsRefreshing(false);
    });
    // Also force-refresh subscription/plan status so grant/revoke/reset from
    // the admin panel is immediately reflected without waiting 5 minutes.
    lastSubFetch.current = 0;
    void fetchSubscriptionStatus();
    if (driveConnected) {
      chrome.runtime.sendMessage({ type: "DRIVE_SYNC_NOW" }).catch(() => {});
    }
  }

  // ── Precompute summaries in background when user selects a session ────────────
  // Session is already selected/highlighted; we silently ask the SW to run
  // tier-1 + tier-2 summarization now so migration feels instant.
  // Track which sessions we've already sent BACKGROUND_INDEX for this sidebar session.
  // Prevents re-queuing an index job every time the user clicks the same session.
  const indexRequestedSessions = useRef(new Set<string>());

  const warmupSession = useCallback(async (session: ContextSession): Promise<void> => {
    // 1. Trigger background semantic indexing — only once per session per sidebar session.
    //    The SW's backgroundIndex has its own in-flight dedup, but skipping here avoids
    //    the message round-trip entirely for sessions the user re-clicks.
    if (hardwareTierRef.current !== 'minimal' && !indexRequestedSessions.current.has(session.id)) {
      indexRequestedSessions.current.add(session.id);
      chrome.runtime.sendMessage({ type: 'BACKGROUND_INDEX', sessionId: session.id }).catch(() => {});
    }
    // 2. Precompute tier-2 summary if not already cached (already gated by ref)
    if (!precomputedSummaries.current.has(session.id)) {
      chrome.runtime.sendMessage(
        { type: 'PRECOMPUTE_SUMMARY', payload: { sessionId: session.id } },
        (result) => {
          if (chrome.runtime.lastError) return;
          if (result?.cached) precomputedSummaries.current.set(session.id, { cached: true });
        }
      );
    }
    // 3. Warm embedding model only if not already warm — searchReady=true means model is hot.
    //    Without this guard, every session click sends WARMUP_MODEL even when ONNX is loaded.
    if (!searchReady && hardwareTierRef.current !== null && hardwareTierRef.current !== 'minimal') {
      chrome.runtime.sendMessage({ type: 'WARMUP_MODEL' }).catch(() => {});
    }
  }, [searchReady]);

  const handleSessionSelect = useCallback((session: ContextSession) => {
    setSelected(session);
    setShowFullTranscript(false);
    setView('detail');
    warmupSession(session).catch(() => {});
    // GET_SESSIONS caps message content at 2000 chars to prevent UI freeze.
    // Fetch full session content now so the detail view and migration have
    // complete message data.
    chrome.runtime.sendMessage({ type: "GET_SESSION", sessionId: session.id }, (full) => {
      if (chrome.runtime.lastError || !full) return;
      setSelected((prev) => prev?.id === session.id ? full : prev);
    });
  }, [warmupSession]);

  // [CM-SOLAR-V2] 1-click quick-migrate: auto-detect active AI tab, run Tier 1 inline.
  const handleQuickMigrate = useCallback(async (session: ContextSession) => {
    if (quickMigratingRef.current) return; // prevent double-click
    quickMigratingRef.current = session.id;
    setQuickMigratingId(session.id);
    setQuickMigrateProgress(0);
    setQuickMigrateStage("");

    // 1. Auto-detect the active AI tab; fall back to session's source platform.
    let targetPlatform: Platform = session.platform;
    let tab: chrome.tabs.Tab | undefined;
    const detected = await detectActivePlatformTab();
    if (detected) {
      targetPlatform = detected.platform;
      tab = detected.tab;
    } else {
      tab = await findTargetPlatformTab(session.platform);
    }
    if (!tab?.id) {
      setStatusMessage({ tone: "error", text: `Open an AI tab (Claude, ChatGPT, etc.) then try again.` });
      quickMigratingRef.current = null;
      setQuickMigratingId(null);
      return;
    }

    // 2. Focus the target tab so injection lands in the right place.
    // [CM-FLASH] Skip the 250ms sleep — the tab is already active.
    await focusTab(tab.id);

    // 3. Fire MIGRATE_CONTEXT with tier: 1 (Full Context) + flash mode.
    chrome.runtime.sendMessage(
      {
        type: "MIGRATE_CONTEXT",
        payload: {
          sessionId: session.id,
          targetPlatform,
          targetTabId: tab.id,
          tier: 1 as const,
          skipAutoInject: false,
          flash: true,
        },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatusMessage({ tone: "error", text: "Quick-migrate failed — please try again." });
        } else if (response?.error === "limit_reached") {
          setStatusMessage({ tone: "error", text: "Daily limit reached — upgrade for more migrations." });
        } else if (response?.error) {
          setStatusMessage({ tone: "error", text: "Quick-migrate failed — please try again." });
        } else if (response?.success) {
          setMigrationTiers((prev) => ({ ...prev, [session.id]: 1 }));
          setStatusMessage({ tone: "success", text: "✅ Quick-migrated (Full Context) · Stayed in your browser" });
        }
        quickMigratingRef.current = null;
        setQuickMigratingId(null);
        setQuickMigrateProgress(0);
        setQuickMigrateStage("");
      }
    );
  }, []);

  function loadIndexStats() {
    setIndexStatsLoading(true);
    chrome.runtime.sendMessage({ type: 'GET_INDEX_STATS' }, (res) => {
      setIndexStatsLoading(false);
      if (chrome.runtime.lastError || !res?.ok) return;
      setIndexStats(res.stats as IndexStats);
    });
  }

  function clearSemanticIndex() {
    if (!window.confirm('Sessions will be re-indexed on next capture. Continue?')) return;
    chrome.runtime.sendMessage({ type: 'CLEAR_SEMANTIC_INDEX' }, () => {
      if (chrome.runtime.lastError) return;
      setIndexStats(null);
      setShowSettings(false);
      setStatusMessage({ tone: 'success', text: '🧠 Semantic index cleared — re-indexes on next capture.' });
    });
  }

  // ── Migration Quality handlers ──────────────────────────────────────────────
  function refreshQualityStats() {
    chrome.runtime.sendMessage({ type: "GET_QUALITY_STATS" }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) return;
      setQualityStats({ count: resp.count ?? 0, avgScore: resp.avgScore ?? 0 });
    });
  }

  function downloadQualityReport() {
    chrome.runtime.sendMessage({ type: "GET_QUALITY_REPORT", payload: {} }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok || !resp.report) {
        setStatusMessage({ tone: "error", text: "Could not generate quality report." });
        return;
      }
      const blob = new Blob([resp.report as string], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);
      // Prefer chrome.downloads when available; fall back to anchor click
      // (works inside the side-panel where chrome.downloads sometimes refuses).
      try {
        chrome.downloads?.download(
          { url, filename: `contextmover-quality-${dateStr}.txt` },
          (downloadId) => {
            if (chrome.runtime.lastError || !downloadId) {
              triggerAnchorDownload(url, `contextmover-quality-${dateStr}.txt`);
            }
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }
        );
      } catch {
        triggerAnchorDownload(url, `contextmover-quality-${dateStr}.txt`);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setStatusMessage({ tone: "success", text: "📊 Quality report downloaded." });
    });
  }

  function clearQualityHistory() {
    if (!window.confirm("Delete all stored migration quality scores? This cannot be undone.")) return;
    chrome.runtime.sendMessage({ type: "CLEAR_QUALITY_HISTORY" }, () => {
      if (chrome.runtime.lastError) return;
      setQualityStats({ count: 0, avgScore: 0 });
      setStatusMessage({ tone: "success", text: "Quality history cleared." });
    });
  }

  async function deleteSession(id: string) {
    await chrome.runtime.sendMessage({ type: "DELETE_SESSION", sessionId: id });
    setSessions((prev) => prev.filter((session) => session.id !== id));
    setStatusMessage({ tone: "info", text: "Session removed from the archive." });

    if (selected?.id === id) {
      setSelected(null);
      setView("sessions");
    }
  }

  // ── Deduplicated session list (shared by filtered, sourceCounts, filter badges) ─
  const dedupedSessions = useMemo(() => {
    // Deduplicate sessions by ID (keep latest updatedAt)
    const dedupedById = Array.from(
      sessions.reduce((map, session) => {
        const existing = map.get(session.id);
        if (!existing || session.updatedAt > existing.updatedAt) {
          map.set(session.id, session);
        }
        return map;
      }, new Map<string, ContextSession>()).values()
    );

    // Note: Content-based deduplication removed - session IDs are already unique per URL.
    // Showing all captured sessions in sidebar for full visibility.
    return dedupedById;
  }, [sessions]);

  const filtered = useMemo(() => {
    const base = filter === "all" ? dedupedSessions : dedupedSessions.filter((session) => session.platform === filter);
    const query = searchQuery.trim().toLowerCase();

    let result = base;
    if (query) {
      result = base.filter((session) => {
        const haystack = [
          session.customName,
          session.title,
          PLATFORM_LABELS[session.platform],
          ...session.messages.slice(-4).map((message) => message.content),
        ]
          .join(" ")
          .toLowerCase();

        return haystack.includes(query);
      });
    }

    // Sort by updatedAt descending (newest first)
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [filter, searchQuery, dedupedSessions]);

  const sourceCounts = useMemo(
    () =>
      (Object.keys(PLATFORM_LABELS) as Platform[]).map((platform) => ({
        platform,
        count: dedupedSessions.filter((session) => session.platform === platform).length,
      })),
    [dedupedSessions]
  );
  const leadSession = dedupedSessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

  const semanticSessions = useMemo(
    () =>
      semanticResults
        .map(({ sessionId, score, preview }) => {
          const session = sessions.find((s) => s.id === sessionId);
          return session ? { session, score, preview } : null;
        })
        .filter((x): x is { session: ContextSession; score: number; preview: string | undefined } => x !== null),
    [semanticResults, sessions]
  );

  // [Feature 3] Resolve additional session objects for migration
  const additionalSessions = useMemo(
    () => additionalSessionIds
      .map((id) => sessions.find((s) => s.id === id))
      .filter((s): s is ContextSession => s !== undefined),
    [additionalSessionIds, sessions]
  );

  void tick;

  if (view === "detail" && selected) {
    const visibleMessages = showFullTranscript ? selected.messages : selected.messages.slice(-6);
    const platformColor = PLATFORM_COLORS[selected.platform];

    return (
      <div className="relative flex h-full flex-col overflow-hidden bg-[#050505] text-[#F5F5F5] animate-slide-up crt">
        <div className="flex h-full flex-col">
          {/* ── Detail Header ── */}
          <div className="border-b px-3 py-2" style={{ background: `linear-gradient(135deg, ${platformColor}12 0%, #050505 70%)`, borderColor: `${platformColor}20`, boxShadow: `0 1px 0 ${platformColor}12` }}>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setView("sessions"); setExpandedMessages(new Set()); loadSessions(); }}
                className="flex shrink-0 items-center gap-1 rounded-[4px] border px-2 py-1 text-[9px] font-black uppercase tracking-widest transition-all hover:-translate-y-px" style={{ borderColor: `${platformColor}30`, background: `${platformColor}08`, color: `${platformColor}BB` }}
              >
                ← Back
              </button>
              <PlatformBadge platform={selected.platform} logoSize={11} />
              <InlineRename
                key={selected.id}
                session={selected}
                displayClassName="min-w-0 flex-1 truncate text-xs font-semibold text-[#F5F5F5] cursor-text"
                inputClassName="min-w-0 flex-1 bg-transparent border-b border-[#00FF88] text-xs font-semibold text-[#F5F5F5] outline-none"
                onRename={(name) => chrome.runtime.sendMessage({ type: "RENAME_SESSION", sessionId: selected.id, title: name })}
              />
            </div>
          </div>

          {statusMessage && (
            <div
              className={`mx-3 mt-3 rounded-[4px] border px-3 py-2 text-[10px] font-mono uppercase tracking-wider ${
                statusMessage.tone === "success"
                  ? "border-[#00FF88]/25 bg-[#00FF88]/6 text-[#00FF88]"
                  : statusMessage.tone === "error"
                  ? "border-[#00FF88]/25 bg-[#00FF88]/6 text-[#00FF88]"
                  : "border-[#2A2A2A] bg-[#080808] text-[#00D26A]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>{statusMessage.text}</div>
                <button
                  onClick={() => setStatusMessage(null)}
                  className="text-[10px] uppercase tracking-[0.18em] opacity-60"
                >
                  ×
                </button>
              </div>
            </div>
          )}

          {latestQualityScore && (
            <div className="mx-3">
              <QualityScoreCard
                score={latestQualityScore}
                coverageStats={latestCoverageStats}
                onDismiss={() => { setLatestQualityScore(null); setLatestCoverageStats(null); }}
              />
            </div>
          )}

          {/* ── Session stats bar ── */}
          <div className="grid grid-cols-3 divide-x divide-[#0A0A0A] border-b border-[#2A2A2A] text-center" style={{ background: "linear-gradient(to bottom, #070707, #050505)" }}>
            <div className="px-2 py-1.5">
              <div className="text-[9px] font-black uppercase tracking-[0.25em] text-[#00FF88]">Turns</div>
              <div className="mt-0.5 text-sm font-bold tabular-nums" style={{ color: platformColor }}>{selected.messages.length}</div>
            </div>
            <div className="px-2 py-1.5">
              <div className="text-[9px] font-black uppercase tracking-[0.25em] text-[#00FF88]">Created</div>
              <div className="mt-0.5 text-[11px] font-medium text-[#F5F5F5]">
                {new Date(selected.createdAt).toLocaleDateString("en", { month: "short", day: "numeric" })}
              </div>
            </div>
            <div className="px-2 py-1.5" style={{ background: `${platformColor}0A` }}>
              <div className="text-[9px] font-black uppercase tracking-[0.25em] text-[#00FF88]">Route</div>
              <div className="mt-0.5 text-[11px] font-semibold text-[#00FF88]">
                {PLATFORM_SHORT[selected.platform]} → {PLATFORM_SHORT[targetPlatform]}
              </div>
            </div>
          </div>

          {/* [Feature 3] Additional session chips — DISABLED (Coming in v3) */}
          {false && additionalSessions.length > 0 && (
            <div className="flex flex-wrap gap-1 px-3 pt-2">
              {additionalSessions.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5"
                  style={{
                    borderColor: `${PLATFORM_COLORS[s.platform]}40`,
                    background: `${PLATFORM_COLORS[s.platform]}0A`,
                  }}
                >
                  <PlatformBadge platform={s.platform} logoSize={7} />
                  <span className="max-w-[80px] truncate text-[8px] font-medium text-[#D4D4D4]">
                    {s.title}
                  </span>
                  <button
                    onClick={() => setAdditionalSessionIds((prev) => prev.filter((id) => id !== s.id))}
                    className="text-[9px] text-[#6B6B6B] transition-colors hover:text-[#FF4444]"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* [Feature 3] Add another session — Coming in v3 */}
          <div className="px-3 pt-1.5">
            <div
              className="flex items-center gap-1.5 rounded-[4px] border border-[#1A1A2A] px-2 py-1 text-[9px] font-bold text-[#9CA3AF] cursor-not-allowed opacity-60"
              title="Multi-session migration is coming in v3"
            >
              <span className="text-[#E5E5E5]/50">+ Add another session</span>
              <span className="ml-auto rounded-[2px] bg-[#E5E5E5]/10 px-1 py-0.5 text-[7px] font-black uppercase tracking-wider text-[#E5E5E5]/60">
                Soon
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between px-4 pt-2">
            <div className="text-[10px] font-black uppercase tracking-[0.22em] text-[#00FF88]">
              {showFullTranscript ? "Full transcript" : "Recent transcript"}
            </div>
            <button
              onClick={() => setShowFullTranscript((value) => !value)}
              className="rounded-[4px] border border-[#1A1A1A] bg-[#080808] px-2 py-1 text-[9px] font-black uppercase tracking-widest text-[#00FF88] hover:border-[#00FF88]/30 hover:text-[#00FF88] transition-all"
            >
              {showFullTranscript ? "Show recent" : "Show all"}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
            {visibleMessages.map((msg, index) => {
              const MAX_LEN = 480;
              const isLong = msg.content.length > MAX_LEN;
              const isExpanded = expandedMessages.has(index);
              const displayContent = isLong && !isExpanded ? msg.content.slice(0, MAX_LEN) : msg.content;
              const isUser = msg.role === "user";
              return (
                <div
                  key={`${msg.role}-${index}-${msg.timestamp}`}
                  className={`rounded-[6px] border text-[11px] overflow-hidden relative transition-all animate-fade-in ${
                    isUser
                      ? "ml-3 bg-[#0A0A0A]"
                      : "mr-3 bg-[#070E0A]"
                  }`}
                  style={{ borderColor: isUser ? `${platformColor}22` : "rgba(0,255,136,0.15)", boxShadow: isUser ? `0 0 8px ${platformColor}08` : "0 0 8px rgba(0,255,136,0.06)" }}
                >
                  <div className={`flex items-center justify-between gap-2 border-b px-2 py-1 ${
                    isUser ? "border-[#2A2A2A]" : "border-[#00FF88]/10"
                  }`}>
                    <div className={`flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.2em] ${
                      isUser ? "text-[#6B6B6B]" : "text-[#00FF88]"
                    }`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${
                        isUser ? "bg-[#6B6B6B]" : "bg-[#00FF88] animate-pulse-green"
                      }`} />
                      {isUser ? "You" : "AI"}
                    </div>
                    <div className="text-[9px] text-[#3A3A3A]">{formatRelativeTime(msg.timestamp)}</div>
                  </div>
                  <div className="px-2 py-1.5 text-[11px] leading-[1.65] text-[#D4D4D4]">
                    {renderMd(displayContent)}
                    {isLong && !isExpanded && (
                      <span className="text-[#3A3A3A]"> …</span>
                    )}
                  </div>
                  {isLong && (
                    <button
                      onClick={() => setExpandedMessages((prev) => {
                        const next = new Set(prev);
                        isExpanded ? next.delete(index) : next.add(index);
                        return next;
                      })}
                      className="w-full border-t border-[#2A2A2A] py-1 text-[9px] uppercase tracking-widest text-[#3A3A3A] transition-colors hover:text-[#00FF88]"
                    >
                      {isExpanded ? "▲ collapse" : `▼ +${msg.content.length - MAX_LEN} chars`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="border-t border-[#2A2A2A] px-4 py-2 space-y-2" style={{ background: "linear-gradient(to top, #050505, #070707)" }}>
            <div>
              <div className="mb-1.5 text-[10px] font-black uppercase tracking-[0.3em] text-[#00FF88]">
                ◈ Route to
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(PLATFORM_LABELS) as Platform[]).map((platform) => {
                  const isTarget = targetPlatform === platform;
                  const pc = PLATFORM_COLORS[platform];
                  return (
                    <button
                      key={platform}
                      onClick={() => setTargetPlatform(platform)}
                      className="flex flex-col items-center gap-1 rounded-[5px] border p-1.5 transition-all duration-200 overflow-hidden hover:-translate-y-0.5 hover:scale-[1.05]"
                      style={isTarget ? {
                        borderColor: `${pc}55`,
                        background: `${pc}12`,
                        boxShadow: `0 0 16px ${pc}30, inset 0 0 10px ${pc}08`,
                      } : {
                        borderColor: "#0A0A0A",
                        background: "#060606",
                      }}
                    >
                      <PlatformLogo platform={platform} size={16} />
                      <div className="text-[10px] font-bold leading-tight uppercase tracking-wider" style={{ color: isTarget ? pc : "#6B6B6B" }}>{PLATFORM_SHORT[platform]}</div>
                      {isTarget && <div className="h-[1.5px] w-full rounded-full animate-xp-fill" style={{ background: `linear-gradient(to right, transparent, ${pc}, transparent)`, boxShadow: `0 0 6px ${pc}` }} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {selected
              && selected.messages.length < 15
              && !selected.metadata?.authoritative
              && (
              <div style={{
                background: 'rgba(245,158,11,0.08)',
                border: '1px solid rgba(245,158,11,0.25)',
                borderRadius: '6px',
                padding: '6px 10px',
                marginBottom: '8px',
                fontSize: '10px',
                color: '#00D26A',
                lineHeight: 1.5
              }}>
                ⚠️ Only {selected.messages.length} messages captured.
                <br />
                Scroll to the top of the conversation to load all messages,
                then the extension will capture them automatically.
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setShowMigrationModal(true)}
                className="solar-gradient-bg btn-primary relative flex flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-[5px] py-3 text-[11px] font-black uppercase tracking-widest text-black transition-all hover:scale-[1.02] hover:-translate-y-px active:scale-[0.98]"
                style={{ boxShadow: "0 0 22px rgba(0,255,136,0.5), 0 0 44px rgba(0,255,136,0.15)" }}
              >
                Migrate → {PLATFORM_SHORT[targetPlatform]}
              </button>
              <ExportMenu
                session={selected}
                variant="icon"
                align="right"
                isPro={planStatus.isPro}
                onLocked={() =>
                  chrome.tabs.create({ url: PRICING_URL })
                }
                onSuccess={(fmt) =>
                  setStatusMessage({
                    tone: "success",
                    text: `Exported as ${fmt.toUpperCase()} — check your downloads.`,
                  })
                }
                onError={(text) => setStatusMessage({ tone: "error", text })}
              />
              <button
                onClick={() => deleteSession(selected.id)}
                className="rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-3 text-xs font-medium text-[#6B6B6B] transition hover:border-[#00FF88]/30 hover:bg-[#00FF88]/10 hover:text-[#00FF88]"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
        {showMigrationModal && selected && (
          <MigrationModal
            session={selected}
            additionalSessions={additionalSessions}
            targetPlatform={targetPlatform}
            attentionAvailable={attentionAvailable}
            isPro={planStatus.isPro}
            onClose={() => setShowMigrationModal(false)}
            onSuccess={(tier, _compressionRatio, chars, qualityScore, coverageStats) => {
              setShowMigrationModal(false);
              setMigrationTiers((prev) => ({ ...prev, [selected.id]: tier }));
              const tierName = tier === 3 ? "Attention Engine" : tier === 2 ? "Smart Summary" : "Full Context";
              setStatusMessage({ tone: "success", text: `✅ Migrated via ${tierName} · Stayed in your browser` });
              if (qualityScore) setLatestQualityScore(qualityScore);
              if (coverageStats) setLatestCoverageStats(coverageStats);
              void chars; // referenced to avoid unused-var lint
            }}
            onLimitReached={(info) => {
              setPaywallData(info);
              setShowMigrationModal(false);
            }}
          />
        )}
        {usageStatus && <UsageMeter status={usageStatus} />}
        {paywallData && (
          <PaywallModal
            limitData={paywallData}
            onClose={() => setPaywallData(null)}
          />
        )}
        {false && showMultiSessionPicker && (
          <MultiSessionPicker
            sessions={sessions}
            excludeIds={[selected?.id, ...additionalSessionIds].filter(Boolean) as string[]}
            onAdd={(ids) => {
              setAdditionalSessionIds((prev) => [...prev, ...ids].slice(0, 5));
              setShowMultiSessionPicker(false);
            }}
            onClose={() => setShowMultiSessionPicker(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#050505] text-[#F5F5F5] crt">
      {/* [CM-SOLAR-V2] Radial orange-glow wash at the top of the sidebar. */}
      <div className="solar-radial-wash pointer-events-none absolute inset-x-0 top-0 h-24 z-0" />
      <style>{`
        @keyframes neon-amber-glow {
          0%, 100% { text-shadow: 0 0 3px rgba(245,158,11,0.25), 0 0 6px rgba(245,158,11,0.1); opacity: 0.75; }
          50% { text-shadow: 0 0 8px rgba(245,158,11,0.8), 0 0 14px rgba(245,158,11,0.35); opacity: 1; }
        }
        @keyframes neon-green-glow {
          0%, 100% { text-shadow: 0 0 3px rgba(0,255,136,0.15), 0 0 6px rgba(0,255,136,0.05); opacity: 0.75; }
          50% { text-shadow: 0 0 8px rgba(0,255,136,0.6), 0 0 12px rgba(0,255,136,0.25); opacity: 1; }
        }
        .pulse-glow-amber {
          animation: neon-amber-glow 2s infinite ease-in-out;
        }
        .pulse-glow-green {
          animation: neon-green-glow 2s infinite ease-in-out;
        }
      `}</style>
      <div className="flex h-full flex-col">
        <SyncStatusBar status={syncStatus} indexedCount={indexedIds.size} totalSessions={dedupedSessions.length} driveConnected={driveConnected === true} onSync={syncBidirectionalNow} syncing={driveSyncing} />
        {/* ── Self-heal wizard overlay ── */}
        {showSelfHeal && (
          <SelfHealWizard
            initialPlatform={brokenPlatform as any ?? "gemini"}
            onClose={() => setShowSelfHeal(false)}
            accessToken={sidebarAccessToken}
          />
        )}
        {/* ── Drive mismatch banner ── */}
        {driveMismatchBanner && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 12px", background: "rgba(255,68,68,0.08)", borderBottom: "1px solid rgba(255,68,68,0.25)", fontSize: 9, color: "#FF6666", lineHeight: 1.5 }}>
            <span style={{ flexShrink: 0 }}>⚠</span>
            <span style={{ flex: 1 }}>
              Drive account mismatch — Pro revoked on this profile. Reconnect the master Drive account used by your subscription owner.
            </span>
            <button
              onClick={() => setDriveMismatchBanner(false)}
              style={{ flexShrink: 0, background: "none", border: "none", color: "#FF6666", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0, marginTop: -1 }}
              title="Dismiss"
            >×</button>
          </div>
        )}
        {/* ── Broken scraper banner ── */}
        {brokenPlatform && !showSelfHeal && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "rgba(255,170,0,0.07)", borderBottom: "1px solid rgba(255,170,0,0.2)", fontSize: 9, color: "#FFAA00", lineHeight: 1.4 }}>
            <span style={{ flexShrink: 0 }}>⚠</span>
            <span style={{ flex: 1 }}>{brokenPlatform} scraper appears broken — messages may not be captured</span>
            <button
              onClick={() => setShowSelfHeal(true)}
              style={{ flexShrink: 0, background: "rgba(255,170,0,0.15)", border: "1px solid rgba(255,170,0,0.4)", color: "#FFAA00", cursor: "pointer", fontSize: 9, borderRadius: 4, padding: "2px 8px", fontFamily: "monospace" }}
            >Fix it</button>
            <button
              onClick={() => setBrokenPlatform(null)}
              style={{ flexShrink: 0, background: "none", border: "none", color: "#FFAA00", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}
            >×</button>
          </div>
        )}
        {/* ── Incomplete capture scroll hint banner ── */}
        {scrollHint && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 12px", background: "rgba(56,189,248,0.07)", borderBottom: "1px solid rgba(56,189,248,0.2)", fontSize: 9, color: "#38BDF8", lineHeight: 1.5 }}>
            <span style={{ flexShrink: 0, fontSize: 12, marginTop: 1 }}>↕</span>
            <span style={{ flex: 1 }}>
              <strong>Scroll hint —</strong> ContextMover captured only {scrollHint.msgCount} message{scrollHint.msgCount !== 1 ? "s" : ""} on <strong>{scrollHint.platform}</strong>.
              {" "}If this conversation is longer, <strong>slowly scroll from top to bottom</strong> on that tab so the extension can collect all messages.
            </span>
            <button
              onClick={() => setScrollHint(null)}
              style={{ flexShrink: 0, background: "none", border: "none", color: "#38BDF8", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0, marginTop: -1 }}
              title="Dismiss"
            >×</button>
          </div>
        )}
        {/* ── Update available banner ── */}
        {updateAvailable && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "rgba(0,255,136,0.07)", borderBottom: "1px solid rgba(0,255,136,0.2)", fontSize: 9, color: "#00D26A", lineHeight: 1.4 }}>
            <span style={{ flexShrink: 0 }}>↑</span>
            <span style={{ flex: 1 }}>v{updateAvailable} available — Chrome will auto-update on next restart</span>
            <button
              onClick={() => setUpdateAvailable(null)}
              style={{ flexShrink: 0, background: "none", border: "none", color: "#00D26A", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}
            >×</button>
          </div>
        )}
        {remoteUpdateMessage && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "rgba(255,170,0,0.07)", borderBottom: "1px solid rgba(255,170,0,0.2)", fontSize: 9, color: "#FFAA00", lineHeight: 1.4 }}>
            <span style={{ flexShrink: 0 }}>⚡</span>
            <span style={{ flex: 1 }}>{remoteUpdateMessage}</span>
            <button
              onClick={() => setRemoteUpdateMessage(null)}
              style={{ flexShrink: 0, background: "none", border: "none", color: "#FFAA00", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}
            >×</button>
          </div>
        )}
        {/* Header */}
        <div className="border-b border-[#2A2A2A] px-2 py-[3px]" style={{ background: "linear-gradient(135deg, #040404 0%, #071207 55%, #040404 100%)", boxShadow: "0 1px 0 rgba(0,255,136,0.07)" }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <img
                src={chrome.runtime.getURL("logo.png")}
                alt="ContextMover"
                style={{ height: 17, display: "block", width: "auto", filter: "drop-shadow(0 0 4px rgba(0,255,136,0.35))" }}
              />
              <div className="flex flex-col gap-0">
                <span className="text-[10px] font-black neon-flicker solar-gradient-text" style={{ letterSpacing: "0.04em" }}>ContextMover</span>
                <span className="text-[6px] uppercase" style={{ letterSpacing: "0.2em", color: "#00D26A" }}>CMD CENTER v1</span>
                {/* Plan status badge — Free shows usage, Pro/Team shows unlimited */}
                {planStatus.loaded && (
                  planStatus.isPro ? (
                    <button
                      type="button"
                      onClick={() => chrome.tabs.create({ url: `${PRICING_URL.replace("/pricing", "")}/settings/billing` })}
                      title="Manage billing"
                      className="text-[8px] font-bold uppercase tracking-[0.14em] text-left"
                      style={{ color: "#00FF88", letterSpacing: "0.14em" }}
                    >
                      {planStatus.plan === "team" ? "Team" : "Pro"} ✦ Unlimited
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => chrome.tabs.create({ url: PRICING_URL })}
                      title="Upgrade to Pro"
                      className="text-[8px] font-bold uppercase tracking-[0.14em] text-left hover:text-[#00FF88]"
                      style={{ color: "#6B6B6B", letterSpacing: "0.14em" }}
                    >
                      Free
                      {typeof planStatus.used === "number" && typeof planStatus.limit === "number"
                        ? ` · ${planStatus.used}/${planStatus.limit}`
                        : ""}
                    </button>
                  )
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleRefreshClick}
                disabled={isRefreshing || isRenaming}
                title="Refresh sessions"
                className={`flex h-5 w-5 items-center justify-center rounded-[3px] border transition-all duration-200 ${
                  refreshSuccess
                    ? 'border-[#00FF88]/60 bg-[#00FF88]/10 text-[#00FF88]'
                    : 'border-[#1A1A1A] bg-[#060606] text-[#00FF88] hover:border-[#00FF88]/50 hover:text-[#00FF88]'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <span className={`text-sm${isRefreshing ? ' animate-spin' : ''}`}>↻</span>
              </button>
              <button
                onClick={() => void checkVault()}
                title={vaultConnected ? 'Vault connected' : 'Connect personal vault'}
                className={`flex items-center gap-0.5 rounded-[3px] border px-1 py-0 text-[8px] font-black uppercase tracking-wide transition-all duration-200 ${
                  vaultConnected === true
                    ? 'border-[#00FF88]/30 bg-[#00FF88]/8 text-[#00FF88]'
                    : 'border-[#1A1A1A] bg-[#060606] text-[#00D26A]'
                }`}
              >
                <span className={vaultConnected === true ? 'animate-pulse-green inline-block h-1 w-1 rounded-full bg-[#00FF88]' : 'inline-block h-1 w-1 rounded-full bg-[#3A3A3A]'} />
                Vault
              </button>
              <button
                onClick={handleDriveButton}
                disabled={driveSyncing}
                title={driveConnected ? 'Drive connected — click to sync now' : 'Connect Google Drive for cross-device sync'}
                className={`flex items-center gap-0.5 rounded-[3px] border px-1 py-0 text-[8px] font-black uppercase tracking-wide transition-all duration-200 ${
                  driveSyncing
                    ? 'border-[#1A1A1A] bg-[#060606] text-[#00D26A] opacity-60 cursor-not-allowed'
                    : driveConnected === true
                      ? 'border-[#00FF88]/30 bg-[#00FF88]/8 text-[#00FF88]'
                      : 'border-[#1A1A1A] bg-[#060606] text-[#00D26A] hover:text-[#00FF88]'
                }`}
              >
                <span className={driveConnected === true && !driveSyncing ? 'animate-pulse-green inline-block h-1 w-1 rounded-full bg-[#00FF88]' : 'inline-block h-1 w-1 rounded-full bg-[#3A3A3A]'} />
                {driveSyncing ? 'Syncing…' : driveConnected === true ? 'Drive ✓' : 'Drive'}
              </button>
              <button
                type="button"
                disabled
                title="MCP / IDE bridge — coming in Phase 2. Cursor, Windsurf, Claude Desktop and Continue support are in active development."
                className="flex items-center gap-0.5 rounded-[3px] border border-[#2A2A2A] bg-[#060606] px-1 py-0 text-[8px] font-black uppercase tracking-wide text-[#3A3A3A] cursor-not-allowed opacity-70"
              >
                <span className="inline-block h-1 w-1 rounded-full bg-[#3A3A3A]" />
                MCP
              </button>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                <button
                  // [CM-KS-SNOOZE] coming soon — re-enable when KS ships
                  // onClick={() => { setShowSynthesizer((s) => !s); setShowSettings(false); }}
                  disabled
                  title="Knowledge Synthesizer — Coming Soon"
                  className={`flex h-5 w-5 items-center justify-center rounded-[3px] border transition-all duration-200 cursor-not-allowed opacity-50 ${
                    showSynthesizer
                      ? 'border-purple-500/40 bg-purple-500/10 text-white'
                      : 'border-[#1A1A1A] bg-[#060606] text-[#E5E5E5]'
                  }`}
                >
                  <span className="text-[11px]">⚡</span>
                </button>
                <div className="pulse-glow-amber" style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '2px',
                  padding: '1px 4px',
                  borderRadius: '10px',
                  fontSize: '7px',
                  fontWeight: 500,
                  background: 'var(--color-background-warning)',
                  color: 'var(--color-text-warning)',
                  whiteSpace: 'nowrap',
                  border: '1px solid rgba(245,158,11,0.3)',
                }}>
                  Coming Soon
                </div>
              </div>
              <button
                onClick={() => { const opening = !showSettings; setShowSettings(opening); if (opening) { setShowSynthesizer(false); loadIndexStats(); refreshQualityStats(); } }}
                title="Semantic index settings"
                className={`flex h-5 w-5 items-center justify-center rounded-[3px] border transition-all duration-200 ${
                  showSettings
                    ? 'border-[#00FF88]/40 bg-[#00FF88]/10 text-[#00FF88]'
                    : 'border-[#1A1A1A] bg-[#060606] text-[#00FF88] hover:border-[#00FF88]/40 hover:text-[#00FF88]'
                }`}
              >
                <span className="text-[11px]">⚙</span>
              </button>
            </div>
          </div>

          {vaultConnected === false && (
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: VAULT_URL })}
              className="mt-0.5 flex items-center gap-1 text-[9px] uppercase transition-colors hover:text-[#00FF88] text-left"
              style={{ letterSpacing: '0.1em', color: '#9CA3AF', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              <span style={{ fontSize: '9px' }}>&#128274;</span>
              <span style={{ color: '#9CA3AF' }}>Local only</span>
              <span style={{ color: '#00D26A', marginLeft: '2px' }}>· Connect vault →</span>
            </button>
          )}

          {vaultConnected === true && (
            <div className="mt-0.5 flex items-center gap-1">
              <span style={{ fontSize: '9px' }}>&#128274;</span>
              <span className="text-[9px] uppercase" style={{ letterSpacing: '0.1em', color: '#00FF88' }}>
                Your vault · <span style={{ color: '#6AFF6A' }}>{vaultName ?? 'Personal Vault'}</span>
              </span>
            </div>
          )}

          {vaultConnected === null && (
            <div className="mt-0.5 flex items-center gap-1">
              <span className="inline-block h-1 w-1 rounded-full bg-[#1A1A1A]" />
              <span className="text-[9px] uppercase" style={{ letterSpacing: '0.1em', color: '#00D26A' }}>Checking vault…</span>
            </div>
          )}

          {partialSync && (
            <div className="mt-1 rounded-[3px] border border-[#00FF88]/15 bg-[#00FF88]/5 px-2 py-1">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[8px] uppercase tracking-widest" style={{ color: "#00FF88" }}>{partialSync.phase}</span>
                <span className="text-[8px]" style={{ color: "#00FF88" }}>{partialSync.done}/{partialSync.total}</span>
              </div>
              <div className="h-[3px] w-full rounded-full bg-[#2A2A2A] overflow-hidden">
                <div className="h-full rounded-full bg-[#00FF88] transition-all duration-300" style={{ width: `${partialSync.pct}%` }} />
              </div>
            </div>
          )}

          {leadSession ? (
            <div className="mt-0.5 flex items-center gap-1">
              <span className="h-1 w-1 flex-shrink-0 rounded-full bg-[#00FF88] animate-pulse-green" style={{ boxShadow: "0 0 4px #00FF88" }} />
              <span className="text-[9px] uppercase" style={{ letterSpacing: "0.12em", color: "#00FF88" }}>
                Online · <span style={{ color: "#6AFF6A" }}>{PLATFORM_LABELS[leadSession.platform]}</span>
                {" · "}{formatRelativeTime(leadSession.updatedAt)}
              </span>
            </div>
          ) : (
            <p className="mt-0.5 text-[9px] uppercase" style={{ letterSpacing: "0.12em", color: "#00D26A" }}>Awaiting signal — open Claude, ChatGPT or Gemini</p>
          )}
          {/* [MEAL-PREP] Indexed counter */}
          <div className="mt-0.5 flex items-center gap-1">
            <span className="text-[9px] uppercase" style={{ letterSpacing: "0.1em", color: "#4ADE80" }}>Indexed:</span>
            <span className="text-[9px] tabular-nums font-semibold" style={{ color: indexedIds.size > 0 ? "#00FF88" : "#3A6A3A" }}>
              {(() => {
                // [FIX-16] indexedIds is built from ALL Dexie sessionHashes/chunkEmbeddings
                // rows, which can include orphaned entries for sessions no longer present
                // (deleted, merged, or from stale Drive-synced data) — inflating the count
                // past dedupedSessions.length (observed as "8/5 indexed"). Intersect with
                // the currently known session list so the numerator can never exceed it.
                const visibleIndexedCount = dedupedSessions.filter(s => indexedIds.has(s.id)).length;
                return `${visibleIndexedCount}/${dedupedSessions.length}`;
              })()}
            </span>
            {(() => {
              const visibleIndexedCount = dedupedSessions.filter(s => indexedIds.has(s.id)).length;
              return visibleIndexedCount < dedupedSessions.length && (
                <span className="text-[8px]" style={{ color: "#00D26A", opacity: 0.7 }}>
                  · {dedupedSessions.length - visibleIndexedCount} pending
                </span>
              );
            })()}
          </div>

          <div className="mt-1 grid grid-cols-3 gap-1">
            {sourceCounts.map(({ platform, count }) => (
              <button
                key={platform}
                onClick={() => setFilter(platform)}
                className="flex flex-col items-center justify-center rounded-[4px] border py-0.5 transition-all duration-200 hover:scale-[1.04]"
                style={{
                  borderColor: count > 0 ? `${PLATFORM_COLORS[platform]}40` : "#141414",
                  background: count > 0 ? `${PLATFORM_COLORS[platform]}0E` : "#0a0a0a",
                  boxShadow: count > 0 ? `0 0 6px ${PLATFORM_COLORS[platform]}10` : "none",
                  height: '34px',
                }}
                title={PLATFORM_LABELS[platform]}
              >
                <div className="flex items-center gap-1">
                  <PlatformLogo platform={platform} size={10} />
                  <span className="text-[8px] font-black uppercase tracking-wider" style={{ color: count > 0 ? PLATFORM_COLORS[platform] : "#555" }}>
                    {PLATFORM_SHORT[platform]}
                  </span>
                </div>
                <div className="text-[11px] font-bold leading-tight" style={{ color: count > 0 ? PLATFORM_COLORS[platform] : "#333" }}>
                  {count}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Free tier usage bar ── */}
        {planStatus.loaded && !planStatus.isPro && usageStatus && (
          <div style={{ display: "flex", gap: "12px", padding: "4px 8px", fontSize: "10px", color: "#444", fontFamily: "monospace" }}>
            <span>FC {usageStatus.usage.tier1.used}/{usageStatus.usage.tier1.limit}</span>
            <span>SS {usageStatus.usage.tier2.used}/{usageStatus.usage.tier2.limit}</span>
            <span>AT {usageStatus.usage.tier3.used}/{usageStatus.usage.tier3.limit}</span>
          </div>
        )}

        {statusMessage && (
          <div
            className={`mx-2 mt-1 rounded-[4px] border px-2 py-1 text-[9px] font-mono uppercase tracking-wider ${
              statusMessage.tone === "success"
                ? "border-[#00FF88]/25 bg-[#00FF88]/6 text-[#00FF88]"
                : statusMessage.tone === "error"
                ? "border-[#00FF88]/25 bg-[#00FF88]/6 text-[#00FF88]"
                : "border-[#2A2A2A] bg-[#080808] text-[#00D26A]"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>{statusMessage.text}</div>
              <button onClick={() => setStatusMessage(null)} className="opacity-60 hover:opacity-100">×</button>
            </div>
          </div>
        )}

        <div className="px-3 pt-1 space-y-1">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search sessions…"
            className="w-full rounded-[4px] border border-[#1A1A1A] bg-[#0a0a0a] px-2 py-1 text-[10px] font-mono text-[#F5F5F5] outline-none placeholder:text-[#00D26A] focus:border-[#00FF88] focus:shadow-[0_0_0_2px_rgba(0,255,136,0.1)] transition-all"
          />
          <div style={{ position: "relative" }}>
            <input
              value={semanticQuery}
              onChange={(e) => setSemanticQuery(e.target.value)}
              placeholder="Search by meaning (semantic)…"
              className="w-full rounded-[4px] border border-[#1A1A1A] bg-[#0a0a0a] px-2 py-1 text-[10px] font-mono text-[#F5F5F5] outline-none placeholder:text-[#E5E5E5] focus:border-[#E5E5E5] focus:shadow-[0_0_0_2px_rgba(99,102,241,0.1)] transition-all"
            />
            {searchReady && (
              <span style={{ position: "absolute", right: "6px", top: "50%", transform: "translateY(-50%)", fontSize: "10px", color: "#888", pointerEvents: "none" }}>● semantic ready</span>
            )}
          </div>
          {/* Semantic platform filter pills */}
          <div className="flex gap-1 overflow-x-auto scrollbar-none" style={{ paddingBottom: "2px" }}>
            {["all", "claude", "chatgpt", "gemini", "grok", "perplexity", "deepseek"].map((p) => {
              const isActive = semanticPlatformFilter === p;
              const pColor = p !== "all" ? PLATFORM_COLORS[p as Platform] : null;
              return (
                <button
                  key={p}
                  onClick={() => setSemanticPlatformFilter(p)}
                  className="whitespace-nowrap rounded-[3px] px-1.5 py-0.5 text-[7px] font-black uppercase tracking-[0.12em] transition-all border"
                  style={isActive
                    ? pColor
                      ? { background: `${pColor}18`, borderColor: `${pColor}45`, color: pColor }
                      : { background: "rgba(99,102,241,0.15)", borderColor: "rgba(99,102,241,0.4)", color: "#E5E5E5" }
                    : { background: "#080808", borderColor: "#1A1A2A", color: "#3A3A4A" }
                  }
                >
                  {p === "all" ? "All" : PLATFORM_SHORT[p as Platform]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-[#2A2A2A] px-3 py-0.5 scrollbar-none" style={{ background: "linear-gradient(to right, #050505, #081208, #050505)" }}>
          {(["all", "claude", "chatgpt", "gemini", "grok", "perplexity", "deepseek"] as const).map((item) => {
            const isActive = filter === item;
            const pColor = item !== "all" ? PLATFORM_COLORS[item] : null;
            const count = item === "all" ? dedupedSessions.length : dedupedSessions.filter((s) => s.platform === item).length;
            return (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className="whitespace-nowrap rounded-[3px] px-1.5 py-0.5 text-[8px] font-black uppercase tracking-[0.16em] transition-all duration-150 border hover:-translate-y-px"
                style={isActive
                  ? pColor
                    ? { background: `${pColor}18`, borderColor: `${pColor}45`, color: pColor, boxShadow: `0 0 10px ${pColor}28` }
                    : { background: "rgba(0,255,136,0.1)", borderColor: "rgba(0,255,136,0.3)", color: "#00FF88", boxShadow: "0 0 10px rgba(0,255,136,0.25)" }
                  : { background: "#080808", borderColor: "#2A2A2A", color: "#00D26A" }
                }
              >
                {item === "all" ? "All" : PLATFORM_SHORT[item]}
                <span className="ml-1 opacity-55">{count}</span>
              </button>
            );
          })}
        </div>

        {showSettings && !showSynthesizer && (
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {/* ── Scraper Health ── */}
            <ScraperHealthPanel
              onLaunchWizard={(platform) => {
                setBrokenPlatform(platform);
                setShowSelfHeal(true);
              }}
            />

            <DriveSyncPanel
              status={driveStatus}
              busy={driveBusy}
              onConnect={connectDrive}
              onDisconnect={disconnectDrive}
              onSyncNow={syncDriveNow}
              onWipe={wipeDrive}
            />

            <LocalDataPanel onWipe={wipeLocalData} busy={localBusy} />

            <PerfStatsPanel />
          </div>
        )}
        {driveConnected === false && !showSettings && !showSynthesizer && (
          <div className="mx-1.5 mt-1 rounded-[4px] border border-amber-500/30 bg-gray-1000/10 px-2 py-1.5 flex items-center gap-1.5">
            <span className="text-[9px] text-gray-400">⚠</span>
            <span className="text-[8px] text-gray-400/90 flex-1 leading-tight">Conversations are device-only and will be erased on logout.</span>
            <button
              onClick={connectDrive}
              className="rounded-[2px] border border-white/40 bg-gray-1000/15 px-1.5 py-0.5 text-[7px] font-bold uppercase tracking-wider text-gray-400 hover:bg-gray-1000/25"
            >
              Connect Drive
            </button>
          </div>
        )}
        <div className={(showSettings || showSynthesizer) ? 'hidden' : 'relative flex-1 overflow-y-auto px-1.5 py-1 space-y-1'}>
          {isRefreshing && (
            <div style={{
              position: "absolute", inset: 0,
              background: "rgba(5,5,5,0.7)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 10,
            }}>
              <div className="animate-pulse" style={{
                width: 6, height: 6, borderRadius: "50%",
                background: "#00FF88",
              }} />
            </div>
          )}
          {semanticSessions.length > 0 && (
            <div className="mb-1.5 space-y-1">
              <div className="pb-0.5 text-[7px] uppercase tracking-widest text-[#E5E5E5]">Semantic matches</div>
              {semanticSessions.map(({ session: s, score, preview }) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setSelected(s); setShowFullTranscript(false); setView("detail"); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(s); setShowFullTranscript(false); setView("detail"); } }}
                  className="group relative block w-full cursor-pointer overflow-hidden rounded-[4px] border bg-[#0a0a0a] px-1.5 py-1 text-left transition-all duration-200 hover:bg-[#111122]"
                  style={{ borderColor: `${PLATFORM_COLORS[s.platform]}25`, boxShadow: `0 1px 0 ${PLATFORM_COLORS[s.platform]}10` }}
                >
                  <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: PLATFORM_COLORS[s.platform] }} />
                  <div className="flex items-center gap-1 pl-1">
                    <div className="min-w-0 flex-1">
                      <PlatformBadge platform={s.platform} logoSize={8} />
                      <p className="truncate text-[10px] font-medium text-[#F5F5F5] transition-colors group-hover:text-[#E5E5E5]">{s.title}</p>
                      <div className="flex items-center gap-1 text-[8px] text-[#6B6B6B]">
                        <span>{s.messages.length} turns</span>
                        <span>·</span>
                        <span className="font-semibold text-[#E5E5E5]">{Math.round(score * 100)}% match</span>
                      </div>
                      {preview && (
                        <p className="mt-0.5 text-[8px] text-[#9CA3AF] leading-tight line-clamp-2" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                          {preview}
                        </p>
                      )}
                    </div>
                    <span className="text-[#3A3A3A] transition-colors group-hover:text-[#E5E5E5]">›</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {sessionsLoading ? (
            <div className="space-y-1">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className="overflow-hidden rounded-[4px] border border-[#2A2A2A] bg-[#0a0a0a] px-1.5 py-1"
                >
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-12 rounded-[20px] bg-[#2A2A2A] animate-pulse" />
                  </div>
                  <div className="mt-1 h-2.5 w-[75%] rounded bg-[#2A2A2A] animate-pulse" />
                  <div className="mt-1 h-2 w-[40%] rounded bg-[#1F1F1F] animate-pulse" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-[6px] border border-dashed px-3 py-4 text-center animate-fade-in neon-border-pulse" style={{ background: "#070707" }}>
              <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-[6px] border border-[#00FF88]/30 bg-[#00FF88]/5" style={{ boxShadow: "0 0 16px rgba(0,255,136,0.15)" }}>
                <span className="text-base">◆</span>
              </div>
              <p className="text-[11px] font-medium text-[#F5F5F5]">
                {sessions.length === 0 ? "No sessions yet" : "No results"}
              </p>
              <p className="mt-0.5 text-[9px] text-[#6B6B6B]">
                {sessions.length === 0
                  ? "Visit Claude, ChatGPT, Google Gemini, or xAI Grok."
                  : "Try a different search or filter."}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  vaultConnected={vaultConnected}
                  migrationTier={migrationTiers[session.id]}
                  driveSourced={driveSourcedSet.has(session.id)}
                  isPendingIndex={pendingIndexIds.has(session.id)} // [CM-PERSIST-FIX]
                  isIndexed={indexedIds.has(session.id)} // [MEAL-PREP]
                  hasChunks={hasChunkIds.has(session.id)} // [MEAL-PREP]
                  isQuickMigrating={quickMigratingId === session.id}
                  quickMigrateStage={quickMigratingId === session.id ? quickMigrateStage : ""}
                  quickMigrateProgress={quickMigratingId === session.id ? quickMigrateProgress : 0}
                  onQuickMigrate={() => void handleQuickMigrate(session)}
                  onSelect={() => handleSessionSelect(session)}
                  onRenaming={handleRenaming}
                />
              ))}
            </div>
          )}
        </div>

        {showSynthesizer && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <KnowledgeSynthesizer />
          </div>
        )}

        {/* ── MCP IDE bridge status (Add-on 6) ────────────────────────────── */}
        <MCPStatusPanel />

        <div className="border-t border-[#2A2A2A] px-2 py-0.5 space-y-0.5">
          <div
            className="crucible-pulse flex cursor-default items-center justify-center rounded-[4px] border border-dashed py-0.5 transition-all hover:scale-[1.01]"
            style={{ borderColor: "rgba(0,255,136,0.2)", background: "rgba(0,255,136,0.018)" }}
          >
            <div style={{ fontSize: "5px", fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.3em", color: "#00FF88", textShadow: "0 0 8px rgba(0,255,136,0.5)" }}>
              ⚗ THE CRUCIBLE
            </div>
            <div style={{ marginLeft: "6px", fontSize: "5px", textTransform: "uppercase", letterSpacing: "0.14em", color: "#00D26A" }}>
              Drop sessions to merge · Super Memory
            </div>
          </div>
          {/* Quick links */}
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: DASHBOARD_URL })}
              className="flex-1 rounded-[3px] border border-[#1A1A1A] bg-[#060606] py-px text-[7px] font-black uppercase tracking-widest text-[#00FF88] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88]"
            >
              Dashboard ↗
            </button>
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: PRICING_URL })}
              className="flex-1 rounded-[3px] border border-[#1A1A1A] bg-[#060606] py-px text-[7px] font-black uppercase tracking-widest text-[#00FF88] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88]"
            >
              Upgrade ⚡
            </button>
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: "https://contextmover.com/support#bug-report" })}
              title="Report a bug"
              className="rounded-[3px] border border-[#1A1A1A] bg-[#060606] px-1.5 py-px text-[7px] font-black uppercase tracking-widest text-[#00FF88] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88]"
            >
              Bug ⚠
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MCPStatusPanel (Add-on 6) — rich IDE bridge status with platform breakdown
//   + copy-config buttons. Polls the SW every 10 s while sidebar is open.
// ─────────────────────────────────────────────────────────────────────────────

interface MCPHealthSnapshot {
  running:        boolean;
  totalSessions?: number;
  platforms?:     Record<string, number>;
  lastUpdated?:   number | null;
  version?:       string;
}

const MCP_IDE_CONFIG = JSON.stringify(
  { mcpServers: { contextmover: { command: "npx", args: ["-y", "@contextmover/mcp-server"] } } },
  null,
  2
);

function MCPStatusPanel() {
  const [status, setStatus]     = useState<MCPHealthSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [toast, setToast]       = useState<string | null>(null);

  // MCP polling disabled — IDE bridge deferred to Phase 2.

  function copyConfig() {
    navigator.clipboard.writeText(MCP_IDE_CONFIG).then(() => {
      setToast("Config copied — paste into your IDE's MCP config file");
      window.setTimeout(() => setToast(null), 2500);
    }).catch(() => {
      setToast("Copy failed");
      window.setTimeout(() => setToast(null), 1500);
    });
  }

  const running = status?.running === true;
  const total   = status?.totalSessions ?? 0;
  const last    = status?.lastUpdated ?? null;
  const platforms = status?.platforms ?? {};

  return (
    <div style={{ borderTop: "1px solid #2A2A2A", padding: "1px 6px", background: "#040404" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        <span style={{ width: 3, height: 3, borderRadius: "50%", background: "#3A3A3A", flexShrink: 0 }} />
        <span style={{ fontSize: 6, fontWeight: 700, color: "#3A3A3A", textTransform: "uppercase", letterSpacing: "0.18em", flex: 1 }}>
          IDE Bridge
        </span>
        <span className="pulse-glow-green" style={{
          fontSize: 6, fontWeight: 900, color: "rgba(0,255,136,0.4)", textTransform: "uppercase",
          letterSpacing: "0.14em", border: "1px solid rgba(0,255,136,0.15)", borderRadius: 3, padding: "1px 3px", background: "rgba(0,255,136,0.02)",
        }}>
          Coming Soon
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SemanticIndexPanel — shows index stats + clear button in the settings panel
// ─────────────────────────────────────────────────────────────────────────────

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[10px] text-[#86EFAC]">{label}</span>
      <span className="text-[10px] font-semibold tabular-nums" style={{ color: "#00CC66" }}>{value}</span>
    </div>
  );
}

function SemanticIndexPanel({
  stats,
  loading,
  onClear,
}: {
  stats: IndexStats | null;
  loading: boolean;
  onClear: () => void;
}) {
  return (
    <div className="rounded-[6px] border border-[#2A2A2A] bg-[#080808] px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-[#4ADE80]">🧠</span>
        <span className="text-[9px] font-bold text-[#888] flex-1">Semantic Index</span>
        {loading && <span className="text-[8px] text-[#00FF88] animate-pulse">Loading…</span>}
        {!loading && stats && (
          <span className="text-[8px] text-[#4A8A4A] tabular-nums">
            {stats.indexedCount}/{stats.sessionCount} indexed · ~{stats.estimatedStorageMB} MB
          </span>
        )}
      </div>
      <button
        onClick={onClear}
        className="w-full rounded-[3px] border border-[#00FF88]/20 bg-[#00FF88]/5 py-1 text-[8px] font-black uppercase tracking-widest text-[#00FF88] transition-all hover:border-[#00FF88]/40 hover:bg-[#00FF88]/10 hover:text-[#00D26A]"
      >
        Clear Index
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DriveSyncPanel — Google Drive cross-profile sync (settings panel)
// ─────────────────────────────────────────────────────────────────────────────

function DriveSyncPanel({
  status,
  busy,
  onConnect,
  onDisconnect,
  onSyncNow,
  onWipe,
}: {
  status: {
    connected: boolean;
    lastSyncAt: number | null;
    lastSyncCount: number | null;
    sourcedIds: string[];
  };
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSyncNow: () => void;
  onWipe: () => void;
}) {
  const relative = (ts: number | null): string => {
    if (!ts) return 'never';
    const d = Date.now() - ts;
    if (d < 60_000) return 'just now';
    if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
  };

  return (
    <div className="rounded-[6px] border border-[#2A2A2A] bg-[#080808] px-3 py-2 space-y-1.5">
      {/* Header row */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-[#3A5A7A]">☁</span>
        <span className="text-[9px] font-bold text-[#888] flex-1">Drive Sync</span>
        {status.connected ? (
          <span className="text-[8px] text-[#00FF88]">
            {busy ? 'Syncing…' : `Last sync ${relative(status.lastSyncAt)}`}
          </span>
        ) : (
          <span className="text-[8px] text-[#555]">Not connected</span>
        )}
      </div>
      {/* Action row */}
      {!status.connected ? (
        <button
          onClick={onConnect}
          disabled={busy}
          className="w-full rounded-[3px] border border-[rgba(0,255,136,0.3)] bg-[rgba(0,255,136,0.06)] py-1 text-[8px] font-black uppercase tracking-widest text-[#00FF88] transition-all hover:border-[rgba(0,255,136,0.5)] hover:bg-[rgba(0,255,136,0.12)] disabled:opacity-50"
        >
          {busy ? 'Connecting…' : 'Connect Google Drive'}
        </button>
      ) : (
        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            <button
              onClick={onSyncNow}
              disabled={busy}
              className="flex-1 rounded-[3px] border border-[rgba(0,255,136,0.3)] bg-[rgba(0,255,136,0.06)] py-1 text-[8px] font-black uppercase tracking-widest text-[#00FF88] transition-all hover:border-[rgba(0,255,136,0.5)] disabled:opacity-50"
            >
              Sync now
            </button>
            <button
              onClick={onDisconnect}
              disabled={busy}
              className="flex-1 rounded-[3px] border border-[#FF4444]/20 bg-[#FF4444]/5 py-1 text-[8px] font-black uppercase tracking-widest text-[#FF4444] transition-all hover:border-[#FF4444]/40 hover:bg-[#FF4444]/10 hover:text-[#00FF88] disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
          <button
            onClick={onWipe}
            disabled={busy}
            className="w-full rounded-[3px] border border-[#FF4444]/30 bg-[#FF4444]/10 py-1 text-[8px] font-bold uppercase tracking-widest text-[#FF4444] transition-all hover:border-[#FF4444]/50 hover:bg-[#FF4444]/15 disabled:opacity-50"
          >
            Wipe all Drive data
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LocalDataPanel — wipe all local extension data (preserves auth/login)
// ─────────────────────────────────────────────────────────────────────────────

function LocalDataPanel({ onWipe, busy }: { onWipe: () => void; busy: boolean }) {
  return (
    <div className="rounded-[6px] border border-[#FF4444]/20 bg-[#080808] px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-[#FF4444]/70">🗑</span>
        <span className="text-[9px] font-bold text-[#888] flex-1">Local Data</span>
        <span className="text-[8px] text-[#555]">Sessions, chunks, indexes</span>
      </div>
      <p className="text-[8px] text-[#666] leading-tight">
        Permanently deletes all ContextMover data stored in this browser (IndexedDB + chrome.storage). Your login and Drive connection are preserved.
      </p>
      <button
        onClick={onWipe}
        disabled={busy}
        className="w-full rounded-[3px] border border-[#FF4444]/20 bg-[#FF4444]/5 py-1 text-[8px] font-black uppercase tracking-widest text-[#FF4444] transition-all hover:border-[#FF4444]/40 hover:bg-[#FF4444]/10 disabled:opacity-50"
      >
        {busy ? "Wiping…" : "Wipe all extension data"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ScraperHealthPanel — manual self-heal wizard launcher in settings panel
// ─────────────────────────────────────────────────────────────────────────────

const SCRAPER_PLATFORMS = ["gemini", "claude", "chatgpt", "grok", "deepseek", "perplexity"] as const;

function ScraperHealthPanel({ onLaunchWizard }: { onLaunchWizard: (platform: string) => void }) {
  const [selected, setSelected] = React.useState<string>("gemini");
  return (
    <div className="rounded-[6px] border border-[#2A2A2A] bg-[#080808] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-[#4ADE80]">🩺</span>
        <span className="text-[9px] font-bold text-[#888] flex-1">Scraper Health</span>
        <select
          value={selected}
          onChange={e => setSelected(e.target.value)}
          className="rounded-[3px] border border-[#1A1A1A] bg-[#0A0A0A] text-[#909090] text-[9px] px-1.5 py-0.5 outline-none focus:border-[#00FF88]/40"
        >
          {SCRAPER_PLATFORMS.map(p => (
            <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
          ))}
        </select>
        <button
          onClick={() => onLaunchWizard(selected)}
          className="rounded-[3px] border border-[#00FF88]/25 bg-[#00FF88]/5 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-[#00FF88] transition-all hover:border-[#00FF88]/50 hover:bg-[#00FF88]/10 whitespace-nowrap"
        >
          Run
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// QualityStatsPanel — aggregate scorecard + report download (settings panel)
// ─────────────────────────────────────────────────────────────────────────────

function QualityStatsPanel({
  stats,
  onRefresh,
  onDownload,
  onClear,
}: {
  stats: { count: number; avgScore: number } | null;
  onRefresh: () => void;
  onDownload: () => void;
  onClear: () => void;
}) {
  // Refresh once on mount so the panel never shows stale "—" if the parent
  // hadn't yet pre-loaded.
  useEffect(() => {
    if (stats === null) onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const count = stats?.count ?? 0;
  const avg = stats?.avgScore ?? 0;
  return (
    <div className="space-y-4">
      <div className="text-[9px] font-black uppercase tracking-[0.3em] text-[#00FF88]">📊 Migration Quality</div>
      <div
        className="rounded-[6px] border border-[#2A2A2A] bg-[#080808] p-4 space-y-2"
        style={{ boxShadow: "0 0 20px rgba(0,255,136,0.04)" }}
      >
        <div className="flex items-center gap-2 border-b border-[#2A2A2A] pb-2">
          <span className="text-base">📊</span>
          <span className="text-[11px] font-bold text-[#F5F5F5]">Migration Quality</span>
        </div>

        {count === 0 ? (
          <div className="py-2 text-[10px] text-[#3A3A3A]">
            No migrations scored yet — run a migration to populate this panel.
          </div>
        ) : (
          <div className="space-y-0.5">
            <StatRow label="Avg score" value={`${avg}/100`} />
            <StatRow label="Migrations tracked" value={count.toLocaleString()} />
          </div>
        )}

        <button
          onClick={onDownload}
          className="mt-1 w-full rounded-[4px] border border-[#00FF88]/30 bg-[#00FF88]/5 py-2 text-[9px] font-black uppercase tracking-widest text-[#00FF88] transition-all hover:border-[#00FF88]/50 hover:bg-[#00FF88]/10"
        >
          Download Report .txt
        </button>
        <button
          onClick={onClear}
          disabled={count === 0}
          className="w-full rounded-[4px] border border-[#00FF88]/20 bg-[#00FF88]/5 py-2 text-[9px] font-black uppercase tracking-widest text-[#00FF88] transition-all hover:border-[#00FF88]/40 hover:bg-[#00FF88]/10 hover:text-[#00D26A] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Clear History
        </button>
      </div>
      <p className="text-[9px] leading-relaxed" style={{ color: "#2A2A2A" }}>
        Quality scores are computed locally after every migration. The downloaded .txt is a plain-text engine-evaluation report — share it with the team to surface compression / retention regressions.
      </p>
    </div>
  );
}

// Anchor-tag download fallback for environments where chrome.downloads
// is unavailable (e.g. inside the side-panel context on some Chrome versions).
function triggerAnchorDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 0);
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**"))
      return <strong key={i} className="font-semibold text-[#F5F5F5]">{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`"))
      return <code key={i} className="rounded px-1 py-0.5 bg-[#1F1F1F] font-mono text-[#00FF88] text-[10px]">{p.slice(1, -1)}</code>;
    if (p.startsWith("*") && p.endsWith("*"))
      return <em key={i} className="italic text-[#B0B0B0]">{p.slice(1, -1)}</em>;
    return <span key={i}>{p}</span>;
  });
}

function renderMd(text: string): React.ReactNode {
  if (!text) return null;
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        if (line.startsWith("### "))
          return <p key={i} className="mt-1.5 mb-0.5 text-[11px] font-bold text-[#F5F5F5]">{renderInline(line.slice(4))}</p>;
        if (line.startsWith("## "))
          return <p key={i} className="mt-1.5 mb-0.5 text-[12px] font-bold text-[#F5F5F5]">{renderInline(line.slice(3))}</p>;
        if (line.startsWith("# "))
          return <p key={i} className="mt-2 mb-1 text-[13px] font-bold text-[#F5F5F5]">{renderInline(line.slice(2))}</p>;
        if (line.startsWith("```") || line === "```")
          return <div key={i} className="my-1 h-px bg-[#2A2A2A]" />;
        if (line === "..." || line === "…")
          return <div key={i} className="my-0.5 text-center text-[10px] text-[#3A3A3A]">· · ·</div>;
        if (!line.trim())
          return <div key={i} className="h-1.5" />;
        if (line.trimStart().startsWith("{") || line.trimStart().startsWith("["))
          return <code key={i} className="block rounded-[3px] bg-[#111] px-2 py-0.5 font-mono text-[9px] text-[#6B6B6B] whitespace-pre-wrap break-all">{line}</code>;
        return <p key={i} className="leading-[1.65]">{renderInline(line)}</p>;
      })}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast — lightweight notification that auto-dismisses
// ─────────────────────────────────────────────────────────────────────────────

interface ToastMsg { text: string; kind: "success" | "error"; }

function Toast({ msg, onDone }: { msg: ToastMsg; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2000);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div
      style={{
        position: "absolute",
        bottom: 8,
        left: 8,
        right: 8,
        zIndex: 9998,
        padding: "6px 10px",
        borderRadius: 5,
        fontSize: 10,
        fontWeight: 700,
        background: msg.kind === "success" ? "rgba(0,255,136,0.12)" : "rgba(0,255,136,0.12)",
        border: `1px solid ${msg.kind === "success" ? "rgba(0,255,136,0.35)" : "rgba(0,255,136,0.35)"}`,
        color: msg.kind === "success" ? "#00FF88" : "#F87171",
        pointerEvents: "none",
      }}
    >
      {msg.text}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ContextMenu — right-click menu on a file row
// ─────────────────────────────────────────────────────────────────────────────

interface ContextMenuProps {
  x: number;
  y: number;
  fileName: string;
  filePath: string;
  onClose: () => void;
  onCopyContent: () => void;
  onCopyForClaude: () => void;
  onCopyForChatGPT: () => void;
  onCopyPath: () => void;
  onDownload: () => void;
  onSelect: () => void;
}

function ContextMenu({
  x, y, fileName, onClose,
  onCopyContent, onCopyForClaude, onCopyForChatGPT,
  onCopyPath, onDownload, onSelect,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("mousedown", handle); document.removeEventListener("keydown", handleKey); };
  }, [onClose]);

  const item = (label: string, action: () => void) => (
    <button
      key={label}
      onMouseDown={(e) => { e.stopPropagation(); action(); onClose(); }}
      style={{
        display: "block", width: "100%", textAlign: "left",
        padding: "5px 10px", fontSize: 10, background: "none",
        border: "none", color: "#888", cursor: "pointer",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#00FF88"; (e.currentTarget as HTMLElement).style.background = "rgba(0,255,136,0.07)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "#888"; (e.currentTarget as HTMLElement).style.background = "none"; }}
    >
      {label}
    </button>
  );

  const divider = <div style={{ height: 1, background: "#2A2A2A", margin: "3px 0" }} />;

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed", left: x, top: y, zIndex: 9999,
        background: "#1A1A1A", border: "1px solid #2A2A2A",
        borderRadius: 8, padding: "4px 0",
        boxShadow: "0 8px 32px rgba(0,0,0,0.8)",
        minWidth: 180,
      }}
    >
      <div style={{ padding: "4px 10px 5px", fontSize: 10, color: "#00FF88", fontWeight: 900 }}>{fileName}</div>
      {divider}
      {item("📋 Copy content", onCopyContent)}
      {item("📋 Copy for Claude", onCopyForClaude)}
      {item("📋 Copy for ChatGPT", onCopyForChatGPT)}
      {item("📋 Copy path", onCopyPath)}
      {divider}
      {item("⬇  Download file", onDownload)}
      {item("☑  Select file", onSelect)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProjectPanel — file system access panel for migration context
// ─────────────────────────────────────────────────────────────────────────────

interface ProjectPanelProps {
  tree: FileTreeNode[];
  connected: boolean;
  rootName: string;
  filter: string;
  expanded: Set<string>;
  selectedCount: number;
  selectedSize: number;
  panelOpen: boolean;
  contextAdded: boolean;
  targetPlatform: Platform;
  onConnect: () => Promise<void>;
  onDisconnect: () => void;
  onRefresh: () => Promise<void>;
  onToggleNode: (path: string) => void;
  onToggleExpand: (path: string) => void;
  onFilterChange: (v: string) => void;
  onTogglePanel: () => void;
  onAddToMigration: () => void;
  autoSelectScores?: Map<string, number>;
  autoSelectActive?: boolean;
  onClearAutoSelect?: () => void;
}

// ── FileTreeRow ────────────────────────────────────────────────────────────

function FileTreeRow({
  node,
  indent,
  expanded,
  filterText,
  onToggleNode,
  onToggleExpand,
  isSelected,
  onInlineCopy,
  onContextMenu,
  autoScores,
}: {
  node: FileTreeNode;
  indent: number;
  expanded: Set<string>;
  filterText: string;
  onToggleNode: (p: string) => void;
  onToggleExpand: (p: string) => void;
  isSelected: (p: string) => boolean;
  onInlineCopy: (p: string) => void;
  onContextMenu: (e: React.MouseEvent, p: string) => void;
  autoScores?: Map<string, number>;
}) {
  const paddingLeft = 8 + indent * 12;
  const [hovered, setHovered] = useState(false);

  const matchesFilter = (n: FileTreeNode): boolean => {
    if (!filterText) return true;
    if (n.name.toLowerCase().includes(filterText.toLowerCase())) return true;
    if (n.kind === "directory" && n.children) return n.children.some(matchesFilter);
    return false;
  };

  if (!matchesFilter(node)) return null;

  const isDir = node.kind === "directory";
  const isExp = expanded.has(node.path);
  const sel = isSelected(node.path);

  return (
    <>
      <div
        className="flex items-center gap-1 cursor-pointer rounded-[3px] transition-colors"
        style={{ paddingLeft, paddingRight: 8, paddingTop: 3, paddingBottom: 3,
          background: hovered ? "#1F1F1F" : "transparent" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => isDir ? onToggleExpand(node.path) : onToggleNode(node.path)}
        onContextMenu={(e) => { if (!isDir) { e.preventDefault(); onContextMenu(e, node.path); } }}
      >
        {isDir ? (
          <>
            <span className="text-[10px] text-[#444] w-3 shrink-0 select-none">{isExp ? "▼" : "▶"}</span>
            <span className="text-[11px] text-[#666] truncate flex-1">{node.name}/</span>
          </>
        ) : (
          <>
            <button
              className={`w-3 h-3 shrink-0 rounded-[2px] border flex items-center justify-center transition-all ${
                sel ? "bg-[#00FF88] border-[#00FF88]" : "border-[#333] bg-transparent hover:border-[#00FF88]/50"
              }`}
              onClick={(e) => { e.stopPropagation(); onToggleNode(node.path); }}
              aria-label={sel ? "Deselect" : "Select"}
            >
              {sel && <span className="text-[7px] text-black font-black leading-none">✓</span>}
            </button>
            <span className={`text-[11px] truncate flex-1 ${sel ? "text-[#00FF88]" : "#888"}`} style={{ color: sel ? "#00FF88" : "#888" }}>
              {node.name}
            </span>
            {node.language && node.language !== "plaintext" && (
              <span className="shrink-0 rounded-[3px] bg-[#1A1A1A] px-1 py-0.5 text-[8px] text-[#444]">
                {node.language.slice(0, 3)}
              </span>
            )}
            {node.size !== undefined && (
              <span className="shrink-0 text-[8px] text-[#333] ml-1">
                {node.size < 1024 ? `${node.size}B` : `${(node.size / 1024).toFixed(1)}K`}
              </span>
            )}
            {/* Auto-detect relevance score badge */}
            {autoScores?.has(node.path) && (
              <span style={{ fontSize: 7, color: "#E5E5E5", background: "rgba(99,102,241,0.15)", borderRadius: 3, padding: "1px 4px", flexShrink: 0 }}>
                {Math.round((autoScores.get(node.path)! * 100))}%
              </span>
            )}
            {/* Inline copy — hover only */}
            <button
              onClick={(e) => { e.stopPropagation(); onInlineCopy(node.path); }}
              title="Copy content (Ctrl+C)"
              style={{
                opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none",
                background: "none", border: "none", cursor: "pointer",
                fontSize: 10, color: "#444", padding: "0 2px",
                transition: "opacity 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#00FF88")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#444")}
            >
              📋
            </button>
          </>
        )}
      </div>
      {isDir && isExp && node.children?.map((child) => (
        <FileTreeRow
          key={child.path}
          node={child}
          indent={indent + 1}
          expanded={expanded}
          filterText={filterText}
          onToggleNode={onToggleNode}
          onToggleExpand={onToggleExpand}
          isSelected={isSelected}
          onInlineCopy={onInlineCopy}
          onContextMenu={onContextMenu}
          autoScores={autoScores}
        />
      ))}
    </>
  );
}

// ── ProjectPanel ────────────────────────────────────────────────────────────

function ProjectPanel({
  tree,
  connected,
  rootName,
  filter,
  expanded,
  selectedCount,
  selectedSize,
  panelOpen,
  contextAdded,
  targetPlatform,
  onConnect,
  onDisconnect,
  onRefresh,
  onToggleNode,
  onToggleExpand,
  onFilterChange,
  onTogglePanel,
  onAddToMigration,
  autoSelectScores,
  autoSelectActive,
  onClearAutoSelect,
}: ProjectPanelProps) {
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [copyOk, setCopyOk] = useState(false);
  const [dlOk, setDlOk] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [formatOk, setFormatOk] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const showToast = (text: string, kind: ToastMsg["kind"] = "success") =>
    setToast({ text, kind });

  const flash = (setter: (v: boolean) => void) => {
    setter(true);
    setTimeout(() => setter(false), 1500);
  };

  const formatSize = (b: number) =>
    b < 1024 ? `${b}B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)}KB` : `${(b / (1024 * 1024)).toFixed(1)}MB`;

  const tokens = Math.ceil(selectedSize / 4);
  const tokenLevel = fileCopier.getTokenWarningLevel(tokens);
  const tokenColor = tokenLevel === "safe" ? "#00FF88" : tokenLevel === "warning" ? "#00D26A" : "#00FF88";
  const tokenDot = tokenLevel === "safe" ? "🟢" : tokenLevel === "warning" ? "🟡" : "🔴";

  // ── read selected files helper ─────────────────────────────────────────────
  const readSelected = async () => {
    const files = await projectReader.readSelectedFiles();
    if (files.length === 0) throw new Error("No files readable");
    return files;
  };

  // ── copy raw ───────────────────────────────────────────────────────────────
  const handleCopy = async () => {
    try {
      const files = await readSelected();
      await fileCopier.copyRaw(files);
      flash(setCopyOk);
      showToast(`📋 Copied ${files.length} file${files.length !== 1 ? "s" : ""} to clipboard`);
    } catch {
      showToast("❌ Clipboard not available", "error");
    }
  };

  // ── download ───────────────────────────────────────────────────────────────
  const handleDownload = async () => {
    try {
      const files = await readSelected();
      if (files.length === 1) {
        await fileCopier.downloadFile(files[0]);
        showToast(`⬇ Downloaded ${files[0].name}`);
      } else {
        await fileCopier.downloadAsZip(files);
        showToast(`⬇ Downloaded ${files.length} files as zip`);
      }
      flash(setDlOk);
    } catch {
      showToast("❌ Download failed", "error");
    }
  };

  // ── format for platform ────────────────────────────────────────────────────
  const handleFormat = async (platform: "claude" | "chatgpt" | "gemini" | "grok") => {
    setFormatOpen(false);
    try {
      const files = await readSelected();
      await fileCopier.copyForPlatform(files, platform);
      flash(setFormatOk);
      const label = platform === "claude" ? "Claude" : platform === "chatgpt" ? "ChatGPT"
        : platform === "gemini" ? "Google Gemini" : "xAI Grok";
      showToast(`📋 Copied for ${label} — paste directly into chat`);
    } catch {
      showToast("❌ Clipboard not available", "error");
    }
  };

  // ── inline copy (single file without selecting) ────────────────────────────
  const handleInlineCopy = async (path: string) => {
    try {
      const file = await projectReader.readFile(path);
      await fileCopier.copyRaw([file]);
      showToast(`📋 Copied ${file.name}`);
    } catch {
      showToast("❌ Clipboard not available", "error");
    }
  };

  // ── context menu actions ───────────────────────────────────────────────────
  const ctxFile = ctxMenu ? projectReader.tree : null;
  void ctxFile;

  const ctxActions = ctxMenu
    ? {
        onCopyContent: async () => {
          try {
            const f = await projectReader.readFile(ctxMenu.path);
            await fileCopier.copyRaw([f]);
            showToast(`📋 Copied ${f.name}`);
          } catch { showToast("❌ Clipboard not available", "error"); }
        },
        onCopyForClaude: async () => {
          try {
            const f = await projectReader.readFile(ctxMenu.path);
            await fileCopier.copyForPlatform([f], "claude");
            showToast("📋 Copied for Claude");
          } catch { showToast("❌ Clipboard not available", "error"); }
        },
        onCopyForChatGPT: async () => {
          try {
            const f = await projectReader.readFile(ctxMenu.path);
            await fileCopier.copyForPlatform([f], "chatgpt");
            showToast("📋 Copied for ChatGPT");
          } catch { showToast("❌ Clipboard not available", "error"); }
        },
        onCopyPath: async () => {
          try {
            await navigator.clipboard.writeText(ctxMenu.path);
            showToast("📋 Copied path");
          } catch { showToast("❌ Clipboard not available", "error"); }
        },
        onDownload: async () => {
          try {
            const f = await projectReader.readFile(ctxMenu.path);
            await fileCopier.downloadFile(f);
            showToast(`⬇ Downloaded ${f.name}`);
          } catch { showToast("❌ Download failed", "error"); }
        },
        onSelect: () => onToggleNode(ctxMenu.path),
      }
    : null;

  // ── keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!connected || !panelRef.current) return;
    const el = panelRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (selectedCount === 0) return;
      if (e.ctrlKey && !e.shiftKey && e.key === "c") { e.preventDefault(); void handleCopy(); }
      if (e.ctrlKey && e.shiftKey && e.key === "C") { e.preventDefault(); void handleFormat("claude"); }
      if (e.ctrlKey && e.key === "d") { e.preventDefault(); void handleDownload(); }
      if (e.ctrlKey && e.key === "a") { e.preventDefault(); projectReader.selectAll(); onToggleNode("__all__"); }
      if (e.key === "Escape") { projectReader.clearAll(); onToggleNode("__clear__"); }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, selectedCount]);

  if (!connected) {
    return (
      <div className="mx-3 mt-2 mb-1 rounded-[6px] border border-[#2A2A2A] bg-[#080808]">
        <div className="flex items-center justify-between px-3 py-2 border-b border-[#2A2A2A]">
          <span className="text-[9px] font-black uppercase tracking-[0.18em] text-[#00D26A]">📁 Project Context</span>
        </div>
        <div className="px-3 py-3 text-center">
          <p className="text-[10px] text-[#444] mb-2 leading-relaxed">Connect your project folder to include files in migration.</p>
          <button
            onClick={() => void onConnect()}
            className="rounded-[4px] border border-[#1A1A1A] bg-[#060606] px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-[#00FF88] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88] hover:shadow-[0_0_10px_rgba(0,255,136,0.15)]"
          >
            + Connect Folder
          </button>
          <p className="mt-1.5 text-[8px] text-[#2A2A2A]">Works with any editor · No install needed</p>
        </div>
      </div>
    );
  }

  const btnBase: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 4, height: 28,
    padding: "0 8px", borderRadius: 4, border: "1px solid #2A2A2A",
    background: "#1A1A1A", color: "#888", fontSize: 9, fontWeight: 900,
    textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer",
    transition: "all 0.15s ease", whiteSpace: "nowrap",
  };
  const btnOk: React.CSSProperties = { ...btnBase, background: "rgba(0,255,136,0.12)", borderColor: "rgba(0,255,136,0.35)", color: "#00FF88" };

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      style={{ outline: "none" }}
      className="mx-3 mt-2 mb-1 rounded-[6px] border border-[#2A2A2A] bg-[#080808] relative"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#2A2A2A]">
        <button
          onClick={onTogglePanel}
          className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.14em] text-[#00D26A] hover:text-[#00FF88] transition-colors"
        >
          <span className="text-[8px]">{panelOpen ? "▼" : "▶"}</span>
          <span>📁 {rootName}</span>
        </button>
        <div className="flex items-center gap-1">
          <button onClick={() => void onRefresh()} title="Refresh (re-read folder)" className="flex h-5 w-5 items-center justify-center rounded-[3px] border border-[#1A1A1A] text-[#00D26A] hover:text-[#00FF88] hover:border-[#00FF88]/40 transition-all text-[10px]">↻</button>
          <button onClick={onDisconnect} title="Disconnect folder" className="flex h-5 w-5 items-center justify-center rounded-[3px] border border-[#1A1A1A] text-[#3A3A3A] hover:text-[#FF4444] hover:border-[#FF4444]/30 transition-all text-[10px]">✕</button>
        </div>
      </div>

      {panelOpen && (
        <>
          {/* Bulk controls + filter row */}
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#111]">
            <button
              onClick={() => { projectReader.selectAll(); onToggleNode("__all__"); }}
              title="Select all (Ctrl+A)"
              style={{ ...btnBase, padding: "0 6px", fontSize: 8, height: 22 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,255,136,0.4)"; (e.currentTarget as HTMLElement).style.color = "#00FF88"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "#2A2A2A"; (e.currentTarget as HTMLElement).style.color = "#888"; }}
            >☑ All</button>
            <button
              onClick={() => { projectReader.clearAll(); onToggleNode("__clear__"); }}
              title="Clear selection (Escape)"
              style={{ ...btnBase, padding: "0 6px", fontSize: 8, height: 22 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,255,136,0.4)"; (e.currentTarget as HTMLElement).style.color = "#00FF88"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "#2A2A2A"; (e.currentTarget as HTMLElement).style.color = "#888"; }}
            >☐ None</button>
            <input
              value={filter}
              onChange={(e) => onFilterChange(e.target.value)}
              placeholder="🔍 Filter…"
              className="flex-1 min-w-0 rounded-[3px] border border-[#2A2A2A] bg-[#050505] px-2 py-[3px] text-[10px] font-mono text-[#F5F5F5] outline-none placeholder:text-[#2A2A2A] focus:border-[#00FF88]/40 transition-all"
            />
          </div>

          {/* File tree — scrollable */}
          <div className="max-h-[180px] overflow-y-auto py-1">
            {tree.length === 0 ? (
              <p className="px-3 py-2 text-[9px] text-[#333]">Empty folder</p>
            ) : (
              tree.map((node) => (
                <FileTreeRow
                  key={node.path}
                  node={node}
                  indent={0}
                  expanded={expanded}
                  filterText={filter}
                  onToggleNode={onToggleNode}
                  onToggleExpand={onToggleExpand}
                  isSelected={(p) => projectReader.isSelected(p)}
                  onInlineCopy={handleInlineCopy}
                  onContextMenu={(e, path) => setCtxMenu({ x: e.clientX, y: e.clientY, path })}
                  autoScores={autoSelectScores}
                />
              ))
            )}
          </div>

          {/* Action bar — shown only when files selected */}
          <div className="border-t border-[#111] px-2 py-2">
            {selectedCount > 0 ? (
              <>
                {/* Auto-detect indicator */}
                {autoSelectActive && (
                  <div style={{
                    marginBottom: 8, padding: "5px 8px", borderRadius: 5,
                    border: "1px solid rgba(99,102,241,0.4)",
                    background: "rgba(99,102,241,0.07)",
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                  }}>
                    <span style={{ fontSize: 9, color: "#E5E5E5" }}>
                      ✨ {selectedCount} file{selectedCount !== 1 ? "s" : ""} auto-detected from session
                    </span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={onClearAutoSelect}
                        style={{ fontSize: 8, color: "#9CA3AF", background: "none", border: "none", cursor: "pointer" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#00FF88")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "#555")}
                        title="Clear auto-selection"
                      >Clear</button>
                    </div>
                  </div>
                )}
                {/* Token count row */}
                <div className="flex items-center justify-between mb-2">
                  <span style={{ fontSize: 9, color: "#9CA3AF" }}>
                    ☑ {selectedCount} file{selectedCount !== 1 ? "s" : ""} · {formatSize(selectedSize)} · <span style={{ color: tokenColor }}>~{tokens.toLocaleString()} tokens {tokenDot}</span>
                  </span>
                  <button
                    onClick={() => { projectReader.clearAll(); onToggleNode("__clear__"); }}
                    style={{ fontSize: 8, color: "#3A3A3A", background: "none", border: "none", cursor: "pointer" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#00FF88")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "#3A3A3A")}
                  >
                    Clear all
                  </button>
                </div>

                {/* 4-button action row */}
                <div style={{ display: "flex", gap: 4, position: "relative" }}>
                  {/* Copy */}
                  <button
                    onClick={() => void handleCopy()}
                    title="Copy raw content (Ctrl+C)"
                    style={copyOk ? btnOk : btnBase}
                    onMouseEnter={(e) => { if (!copyOk) { (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,255,136,0.4)"; (e.currentTarget as HTMLElement).style.color = "#00FF88"; } }}
                    onMouseLeave={(e) => { if (!copyOk) { (e.currentTarget as HTMLElement).style.borderColor = "#2A2A2A"; (e.currentTarget as HTMLElement).style.color = "#888"; } }}
                  >
                    {copyOk ? "✅" : "📋"} Copy
                  </button>

                  {/* Download */}
                  <button
                    onClick={() => void handleDownload()}
                    title="Download file(s) (Ctrl+D)"
                    style={dlOk ? btnOk : btnBase}
                    onMouseEnter={(e) => { if (!dlOk) { (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,255,136,0.4)"; (e.currentTarget as HTMLElement).style.color = "#00FF88"; } }}
                    onMouseLeave={(e) => { if (!dlOk) { (e.currentTarget as HTMLElement).style.borderColor = "#2A2A2A"; (e.currentTarget as HTMLElement).style.color = "#888"; } }}
                  >
                    {dlOk ? "✅" : "⬇"} Save
                  </button>

                  {/* Format dropdown */}
                  <div style={{ position: "relative" }}>
                    <button
                      onClick={() => setFormatOpen((v) => !v)}
                      title="Copy formatted for specific AI (Ctrl+Shift+C for Claude)"
                      style={formatOk ? btnOk : { ...btnBase, borderColor: formatOpen ? "rgba(0,255,136,0.4)" : "#2A2A2A", color: formatOpen ? "#00FF88" : "#888" }}
                    >
                      {formatOk ? "✅" : "🤖"} Format ▾
                    </button>
                    {formatOpen && (
                      <div
                        style={{
                          position: "absolute", bottom: "calc(100% + 4px)", left: 0, zIndex: 9999,
                          background: "#1A1A1A", border: "1px solid #2A2A2A", borderRadius: 6,
                          padding: "4px 0", minWidth: 150,
                          boxShadow: "0 8px 24px rgba(0,0,0,0.8)",
                        }}
                      >
                        <div style={{ padding: "4px 10px 5px", fontSize: 9, color: "#9CA3AF", fontWeight: 900, textTransform: "uppercase" }}>Copy for…</div>
                        {(["Claude", "ChatGPT", "Google Gemini", "xAI Grok"] as const).map((label) => {
                          const key = label === "Claude" ? "claude" : label === "ChatGPT" ? "chatgpt" : label === "Google Gemini" ? "gemini" : "grok";
                          return (
                            <button
                              key={key}
                              onClick={() => void handleFormat(key as "claude" | "chatgpt" | "gemini" | "grok")}
                              style={{ display: "block", width: "100%", textAlign: "left", padding: "5px 10px", fontSize: 10, background: "none", border: "none", color: "#888", cursor: "pointer" }}
                              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#00FF88"; (e.currentTarget as HTMLElement).style.background = "rgba(0,255,136,0.07)"; }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "#888"; (e.currentTarget as HTMLElement).style.background = "none"; }}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Add to migration */}
                  <button
                    onClick={onAddToMigration}
                    title="Add to next migration context"
                    style={contextAdded
                      ? { ...btnOk, marginLeft: "auto" }
                      : { ...btnBase, marginLeft: "auto", background: contextAdded ? undefined : "rgba(0,255,136,0.08)", borderColor: "rgba(0,255,136,0.2)", color: "#00BB66" }}
                    onMouseEnter={(e) => { if (!contextAdded) { (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,255,136,0.5)"; (e.currentTarget as HTMLElement).style.color = "#00FF88"; } }}
                    onMouseLeave={(e) => { if (!contextAdded) { (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,255,136,0.2)"; (e.currentTarget as HTMLElement).style.color = "#00BB66"; } }}
                  >
                    {contextAdded ? `✓ Added` : `➕ Add`}
                  </button>
                </div>
              </>
            ) : (
              <p style={{ fontSize: 9, color: "#2A2A2A" }}>Select files to copy, download, or add to migration</p>
            )}
          </div>
        </>
      )}

      {/* Toast */}
      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

      {/* Context menu */}
      {ctxMenu && ctxActions && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          fileName={ctxMenu.path.split("/").pop() ?? ctxMenu.path}
          filePath={ctxMenu.path}
          onClose={() => setCtxMenu(null)}
          onCopyContent={() => void ctxActions.onCopyContent()}
          onCopyForClaude={() => void ctxActions.onCopyForClaude()}
          onCopyForChatGPT={() => void ctxActions.onCopyForChatGPT()}
          onCopyPath={() => void ctxActions.onCopyPath()}
          onDownload={() => void ctxActions.onDownload()}
          onSelect={() => { ctxActions.onSelect(); setCtxMenu(null); }}
        />
      )}

      {/* Format dropdown outside-click dismissal */}
      {formatOpen && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 9998 }}
          onClick={() => setFormatOpen(false)}
        />
      )}
    </div>
  );
}



// ── UsageMeter ──────────────────────────────────────────────────────────────

function UsageMeter({ status }: { status: UsageStatus }) {
  if (status.unlimited) {
    return (
      <div style={{ fontSize: "9px", color: "#00FF88", textAlign: "center", padding: "6px 0" }}>
        ✦ Pro — Unlimited migrations
      </div>
    );
  }

  const tiers = [
    { key: "tier1" as const, label: "Full Context" },
    { key: "tier2" as const, label: "Summary" },
    { key: "tier3" as const, label: "Attention" },
  ];

  return (
    <div style={{ padding: "10px 12px", borderBottom: "1px solid #1A1A1A", marginBottom: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <span style={{ fontSize: "9px", color: "#6B6B6B", textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Free plan usage
        </span>
        <span style={{ fontSize: "9px", color: "#9CA3AF" }}>
          Resets in {status.daysUntilReset}d
        </span>
      </div>
      {tiers.map(({ key, label }) => {
        const t = status.usage[key];
        const pct = t.limit > 0 ? Math.min((t.used / t.limit) * 100, 100) : 0;
        const color = pct >= 100 ? "#00FF88" : pct >= 80 ? "#00D26A" : "#00FF88";
        return (
          <div key={key} style={{ marginBottom: "6px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
              <span style={{ fontSize: "9px", color: "#6B6B6B" }}>{label}</span>
              <span style={{ fontSize: "9px", color: pct >= 100 ? "#00FF88" : "#4A4A4A" }}>
                {t.used}/{t.limit}
              </span>
            </div>
            <div style={{ height: "3px", background: "#1A1A1A", borderRadius: "2px", overflow: "hidden" }}>
              <div style={{ height: "100%", width: pct + "%", background: color, borderRadius: "2px", transition: "width 0.3s ease" }} />
            </div>
          </div>
        );
      })}
      <a href="https://contextmover.com/pricing" target="_blank" rel="noreferrer"
        style={{ display: "block", marginTop: "10px", padding: "7px", background: "transparent",
          border: "1px solid #2A2A2A", borderRadius: "4px", color: "#6B6B6B", fontSize: "9px",
          fontWeight: 700, textAlign: "center", textDecoration: "none", textTransform: "uppercase",
          letterSpacing: "0.1em", cursor: "pointer" }}>
        Upgrade to Pro ↗
      </a>
    </div>
  );
}

// ── PaywallModal ─────────────────────────────────────────────────────────────

function PaywallModal({
  limitData,
  onClose,
}: {
  limitData: {
    tier: number;
    used: number;
    limit: number;
    daysUntilReset: number;
    upgradeUrl: string;
  };
  onClose: () => void;
}) {
  const tierNames: Record<number, string> = {
    1: "Full Context",
    2: "Smart Summary",
    3: "Attention Engine",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: "16px" }}>
      <div style={{ background: "#111", border: "1px solid #2A2A2A", borderRadius: "12px",
        padding: "24px", maxWidth: "280px", width: "100%" }}>
        <div style={{ fontSize: "28px", textAlign: "center", marginBottom: "12px" }}>🔒</div>
        <div style={{ fontSize: "13px", fontWeight: 900, color: "#F5F5F5",
          textAlign: "center", marginBottom: "8px" }}>
          Monthly limit reached
        </div>
        <div style={{ fontSize: "10px", color: "#6B6B6B", textAlign: "center",
          lineHeight: 1.6, marginBottom: "20px" }}>
          You&apos;ve used all {limitData.limit} free {tierNames[limitData.tier]} migrations this month.
          <br />
          Resets in {limitData.daysUntilReset} days.
        </div>
        <a href={limitData.upgradeUrl} target="_blank" rel="noreferrer"
          style={{ display: "block", padding: "12px", background: "#00FF88", border: "none",
            borderRadius: "6px", color: "#0A0A0A", fontSize: "12px", fontWeight: 900,
            textAlign: "center", textDecoration: "none", textTransform: "uppercase",
            letterSpacing: "0.1em", boxShadow: "0 0 20px rgba(0,255,136,0.3)",
            marginBottom: "10px", cursor: "pointer" }}>
          Upgrade to Pro
        </a>
        <button onClick={onClose}
          style={{ width: "100%", padding: "10px", background: "transparent",
            border: "1px solid #2A2A2A", borderRadius: "4px", color: "#6B6B6B",
            fontSize: "10px", fontWeight: 700, cursor: "pointer", textTransform: "uppercase" }}>
          Maybe later
        </button>
      </div>
    </div>
  );
}
function formatRelativeTime(timestamp: number) {
  const diff = Date.now() - timestamp;

  if (diff < 60_000) {
    return "just now";
  }

  if (diff < 3_600_000) {
    return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  }

  if (diff < 86_400_000) {
    return `${Math.max(1, Math.floor(diff / 3_600_000))}h ago`;
  }

  return `${Math.max(1, Math.floor(diff / 86_400_000))}d ago`;
}

// ── SyncStatusBar: shows real-time Drive sync status + sync button ──────────
function SyncStatusBar({ status, indexedCount, totalSessions, driveConnected, onSync, syncing }: {
  status: { direction: 'in' | 'out'; phase: 'start' | 'done'; sessionsTotal?: number; sessionsSynced?: number; indexedCount?: number; chunkCount?: number; timestamp: number } | null;
  indexedCount: number;
  totalSessions: number;
  driveConnected: boolean;
  onSync: () => void;
  syncing: boolean;
}) {
  if (!driveConnected) return null;

  const isSyncingIn = status?.direction === 'in';
  const isDone = status?.phase === 'done';
  const ageSec = status ? Math.round((Date.now() - status.timestamp) / 1000) : 999;
  const showStatus = status && ageSec <= 60;

  const synced = status?.sessionsSynced ?? 0;
  const total = status?.sessionsTotal ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((synced / total) * 100)) : 0;

  return (
    <div className="border-b border-[#2A2A2A] px-2 py-[2px]" style={{ minHeight: 18, background: '#040404' }}>
      <div className="flex items-center gap-1.5">
        {showStatus ? (
          <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: isSyncingIn ? '#00CC66' : '#4ADE80' }}>
            {isSyncingIn ? '↓ Sync In' : '↑ Sync Out'}
          </span>
        ) : (
          <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: '#00FF88' }}>
            Drive
          </span>
        )}
        {showStatus && isDone ? (
          <span className="text-[8px] tabular-nums" style={{ color: '#86EFAC' }}>
            {synced} sess{' · '}{status!.indexedCount ?? 0} idx{' · '}{status!.chunkCount ?? 0} chunks
          </span>
        ) : showStatus && total > 0 ? (
          <span className="text-[8px] tabular-nums animate-pulse" style={{ color: '#00FF88' }}>
            {synced}/{total} sessions…
          </span>
        ) : showStatus ? (
          <span className="text-[8px] animate-pulse" style={{ color: '#00FF88' }}>syncing…</span>
        ) : null}
        <span className="flex-1" />
        <span className="text-[8px] font-semibold tabular-nums" style={{ color: '#00CC66' }}>
          {indexedCount}/{totalSessions} indexed
        </span>
        <button
          onClick={onSync}
          disabled={syncing}
          title="Sync now — pull from Drive + push new local sessions to Drive"
          className="flex items-center gap-0.5 rounded-[3px] border px-1 py-[1px] text-[8px] font-bold uppercase tracking-wide transition-all duration-200"
          style={{
            borderColor: syncing ? '#2D3748' : 'rgba(0,204,102,0.3)',
            background: syncing ? '#060606' : 'rgba(0,204,102,0.08)',
            color: syncing ? '#4B5563' : '#00CC66',
            cursor: syncing ? 'not-allowed' : 'pointer',
            opacity: syncing ? 0.6 : 1,
          }}
        >
          {syncing ? '⟳' : '↻'} Sync
        </button>
      </div>
      {showStatus && !isDone && total > 0 && (
        <div className="mt-[1px] h-[2px] w-full rounded-full bg-[#2A2A2A] overflow-hidden">
          <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: isSyncingIn ? '#00CC66' : '#00FF88' }} />
        </div>
      )}
    </div>
  );
}

// ── semverGt: returns true if `a` is strictly greater than `b` ───────────────
function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}
