/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */
import type { DOMProbeResult } from '@/content/shared';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findTargetPlatformTab, focusTab } from "@/lib/platform-tabs";
import { dexieDb } from "@/lib/db";
import type { ContextSession, Platform } from "@/lib/types";
import ExportMenu from "@/components/ExportMenu";
import { PlatformBadge, PlatformLogo } from "@/components/PlatformLogo";
import MigrationModal from "./MigrationModal";
import KnowledgeSynthesizer from "./components/KnowledgeSynthesizer";
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
import { fetchSubscriptionStatus as fetchSubStatusShared, invalidateSubscriptionCache } from "./subscription-cache";
import { safeSendMessage } from "./safe-messaging";

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
      className="stagger-item relative block w-full cursor-pointer rounded-[4px] border bg-[#0a0a0a] px-2 py-[4px] text-left"
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
                style={{ fontSize: 9, color: "#5AA9FF", letterSpacing: "0.05em" }}
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
                color: 'var(--color-text-warning, #F59E0B)',
                opacity: 0.85,
                marginLeft: '4px',
                letterSpacing: '0.02em',
              }}>
                ⚡ indexing...
              </span>
            )}
          </div>
          <InlineRename
            session={session}
            displayClassName="truncate text-[11px] font-semibold text-[#F5F5F5] cursor-text"
            inputClassName="w-full bg-transparent border-b border-[#00FF88] text-[11px] font-semibold text-[#F5F5F5] outline-none"
            onRename={(name) => safeSendMessage({ type: "RENAME_SESSION", sessionId: session.id, title: name })}
            stopPropagation
            onEditingChange={onRenaming}
          />
          {/* ── Meta row ── */}
          <div className="flex items-center gap-1 text-[8px] uppercase" style={{ letterSpacing: "0.08em", color: "#2A4A2A" }}>
            <span>{msgCount} turns</span>
            <span>·</span>
            <span>{formatRelativeTime(session.updatedAt)}</span>
            <span>·</span>
            <span style={{ fontSize: "8px", color: vaultConnected === true ? "#00AA55" : "#4A4A4A" }}>
              {vaultConnected === true ? "🔒 Vault" : "📱 Local"}
            </span>
            {codeBlockCount > 0 && (
              <>
                <span>·</span>
                <span
                  title={`${codeBlockCount} code block${codeBlockCount !== 1 ? "s" : ""}`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "2px",
                    color: "#6366F1", fontWeight: 700, fontSize: "8px",
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
                  background: (migrationTier ?? 1) >= 2 ? "rgba(0,255,136,0.12)" : "rgba(255,255,255,0.06)",
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
          <span style={{
            color: hovered ? "#00FF88" : "#3A3A3A",
            transition: "color 150ms ease",
          }}>›</span>
        </div>
      </div>
    </div>
  );
}, (prev, next) =>
  prev.session.id === next.session.id &&
  prev.session.updatedAt === next.session.updatedAt &&
  prev.session.messages.length === next.session.messages.length &&
  prev.vaultConnected === next.vaultConnected &&
  prev.migrationTier === next.migrationTier
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
  claude:     "#D97706",
  chatgpt:    "#10B981",
  gemini:     "#6366F1",
  grok:       "#E5E5E5",
  perplexity: "#20B2AA",
  deepseek:   "#4C8BF5",
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
        {hovered && (
          <button
            title="Rename session"
            onClick={stopPropagation
              ? (e) => { e.stopPropagation(); startEdit(); }
              : startEdit}
            style={{
              flexShrink: 0, color: "#4A6A4A", background: "none",
              border: "none", cursor: "pointer", fontSize: 9, padding: 0,
              lineHeight: 1,
            }}
          >
            ✏
          </button>
        )}
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
          border: "none", cursor: "pointer", fontSize: 10, padding: "0 2px",
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
          border: "none", cursor: "pointer", fontSize: 10, padding: "0 2px",
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

  // [CM-PERSIST-FIX] poll for pending index jobs to show UI indicator
  useEffect(() => {
    const refreshPending = async () => {
      try {
        const jobs = await dexieDb.pendingIndex.toArray()
        setPendingIndexIds(new Set(jobs.map(j => j.sessionId)))
      } catch { /* silently ignore — indicator is non-critical */ }
    }
    void refreshPending()
    // Poll every 30s — fast enough to feel responsive, slow enough to not drain battery
    const interval = setInterval(() => void refreshPending(), 30_000)
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
  const [semanticResults, setSemanticResults] = useState<{ sessionId: string; score: number }[]>([]);
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
  const [partialSync, setPartialSync] = useState<{ pct: number; done: number; total: number; phase: string } | null>(null);
  const driveSourcedSet = useMemo(() => new Set(driveStatus.sourcedIds), [driveStatus.sourcedIds]);

  const refreshDriveStatus = useCallback(() => {
    safeSendMessage<{ connected?: boolean; lastSyncAt?: number; lastSyncCount?: number; sourcedIds?: string[] }>({ type: "DRIVE_STATUS" }, (res) => {
      if (!res) return;
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
    safeSendMessage<{ connected?: boolean }>({ type: "DRIVE_CONNECT" }, (res) => {
      setDriveBusy(false);
      if (!res) return;
      if (res?.connected) refreshDriveStatus();
    });
  }, [refreshDriveStatus]);

  const disconnectDrive = useCallback(() => {
    setDriveBusy(true);
    safeSendMessage({ type: "DRIVE_DISCONNECT" }, () => {
      setDriveBusy(false);
      refreshDriveStatus();
    });
  }, [refreshDriveStatus]);

  const syncDriveNow = useCallback(() => {
    setDriveBusy(true);
    safeSendMessage({ type: "DRIVE_SYNC_NOW" }, () => {
      setDriveBusy(false);
      refreshDriveStatus();
    });
  }, [refreshDriveStatus]);

  const handleRenaming = useCallback((v: boolean) => {
    activeRenameRef.current = v;
    setIsRenaming(v);
  }, []);

  useEffect(() => {
    refreshDriveStatus();
    // Chunk 28: refresh drive status every 30s for accurate sync indicator.
    const driveRefreshInterval = setInterval(refreshDriveStatus, 30_000);
    return () => clearInterval(driveRefreshInterval);
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
    // Chunk 24: Open keepalive port so SW stays alive while sidebar is open.
    let keepalivePort: chrome.runtime.Port | null = null;
    try {
      keepalivePort = chrome.runtime.connect({ name: "sidebar-keepalive" });
    } catch { /* SW may be starting — non-fatal */ }
    // MCP polling disabled — IDE bridge deferred to Phase 2.
    const mcpInterval = 0;
    void fetchSubscriptionStatus(); // once on mount

    // Attention-engine availability (model may be blocked by CSP)
    safeSendMessage<{ available?: boolean }>({ type: "GET_ATTENTION_STATUS" }, (res) => {
      if (res?.available === false) {
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

    return () => {
      window.clearInterval(clockInterval);
      window.clearInterval(mcpInterval);
      chrome.runtime.onMessage.removeListener(stableListener);
      window.removeEventListener('pagehide', onPageHide);
      if (loadDebounceRef.current) clearTimeout(loadDebounceRef.current);
      if (semanticTimerRef.current) clearTimeout(semanticTimerRef.current);
      keepalivePort?.disconnect();
      // Notify toggle button that sidebar closed (covers cases other than unload)
      chrome.runtime.sendMessage({ type: 'SIDEBAR_CLOSED' }).catch(() => {});
    };
  }, []);

  // Keep handleMessageRef in sync with latest loadSessions closure every render.
  handleMessageRef.current = (msg: { type: string; pct?: number; done?: number; total?: number; phase?: string; platform?: string; reason?: string; pendingId?: string; sessionTitle?: string; targetPlatform?: string }) => {
    if (msg.type === "SESSIONS_UPDATED") {
      if (!activeRenameRef.current) loadSessions();
    }
    if (msg.type === "SCRAPER_BROKEN") {
      // [CM-FIX-2] removed user-facing error: "[p] UI changed! Scraper broken. Update pending."
      // Internal selector failure — irrelevant to users, devs can see it in DevTools.
      const p = msg.platform ?? "unknown";
      console.error(`[CM:sidebar] SCRAPER_BROKEN on ${p} — remote config will auto-refresh selectors`);
    }
    if (msg.type === "AUTH_STATE_CHANGED") {
      // Force subscription re-fetch — user signed in or switched accounts.
      invalidateSubscriptionCache();
      void fetchSubscriptionStatus();
    }
    if (msg.type === "USAGE_WARNING") {
      chrome.storage.local.get("accessToken", ({ accessToken }) => {
        if (accessToken) {
          getUsageStatus(accessToken as string).then((s) => { if (s) setUsageStatus(s); }).catch(() => {});
        }
      });
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
        safeSendMessage<{ ok?: boolean; skipped?: boolean }>({ type: 'WARMUP_MODEL' }, (res) => {
          if (!res?.ok) return;
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
    const res = await fetchSubStatusShared();
    if (!res) return;
    try {
      const r = res as {
        plan?:     "free" | "pro" | "team";
        isPro?:    boolean;
        usage?:    { simpleMigrations: number };
        limits?:   { simpleMigrations: number | "unlimited" };
        status?:   string;
        trialEnd?: string | null;
        deviceLimitExceeded?: boolean;
        message?:  string;
      } | undefined;
      if (!r) return;
      const used  = r.usage?.simpleMigrations;
      const limit = r.limits?.simpleMigrations;
      setPlanStatus({
        plan:     r.plan ?? "free",
        isPro:    Boolean(r.isPro),
        used,
        limit:    typeof limit === "number" ? limit : undefined,
        status:   r.status,
        trialEnd: r.trialEnd ?? null,
        loaded:   true,
        deviceLimitExceeded: r.deviceLimitExceeded ?? false,
        deviceLimitMessage:  r.message,
      });
    } catch {
      setPlanStatus((s) => ({ ...s, loaded: true }));
    }
  }

  // ── Usage status for sidebar meter ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { accessToken } = await chrome.storage.local.get("accessToken");
      if (!accessToken || cancelled) return;
      const status = await getUsageStatus(accessToken as string);
      if (!cancelled) setUsageStatus(status);
    }
    load();
    // Retry when accessToken appears or refreshes — covers the case where
    // the sidebar mounts before sign-in completes (otherwise the call fires
    // with no token and the route returns 401).
    const onStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area === "local" && changes.accessToken && !cancelled) void load();
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onStorageChange);
    };
  }, [tick]);

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
    if (!attentionEngine.initialized) return;
    attentionEngine.indexSession(selected).catch(() => { /* ignore */ });
  }, [view, selected]);

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
        const chunks = await attentionEngine.semanticSearch(semanticQuery, 10);
        const scoreMap = new Map<string, number>();
        for (const c of chunks) {
          const prev = scoreMap.get(c.sessionId) ?? 0;
          if (c.relevanceScore > prev) scoreMap.set(c.sessionId, c.relevanceScore);
        }
        setSemanticResults(
          [...scoreMap.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([sessionId, score]) => ({ sessionId, score }))
        );
      } catch { setSemanticResults([]); }
    }, 300);
    return () => { if (semanticTimerRef.current) clearTimeout(semanticTimerRef.current); };
  }, [semanticQuery]);

  function checkVault() {
    safeSendMessage<{ connected?: boolean; projectName?: string }>({ type: 'VAULT_GET_STATUS' }, (res) => {
      if (!res) return;
      setVaultConnected(res?.connected === true);
      if (res?.projectName) setVaultName(res.projectName as string);
    });
  }

  function checkDriveStatus() {
    safeSendMessage<{ connected?: boolean }>({ type: 'DRIVE_STATUS' }, (res) => {
      if (!res) return;
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
      safeSendMessage<{ connected?: boolean }>({ type: 'DRIVE_CONNECT' }, (res) => {
        if (!res) { done(); return; }
        setDriveConnected(res?.connected === true);
        done();
      });
    } else {
      safeSendMessage({ type: 'DRIVE_SYNC_NOW' }, () => {
        done();
      });
    }
  }

  // Probe the local ContextMover MCP server health endpoint via the service
  // worker (CORS-restricted from a sidebar page, the SW does the fetch).
  function checkMcpBridge() {
    safeSendMessage<{ running?: boolean; totalSessions?: number }>({ type: 'CHECK_MCP_BRIDGE' }, (res) => {
      if (!res) { setMcpStatus({ running: false }); return; }
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
      safeSendMessage({ type: "GET_SESSIONS" }, (res) => {
        setSessions(Array.isArray(res) ? res : []);
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
    safeSendMessage({ type: "GET_SESSIONS", force: true }, (res) => {
      clearTimeout(timeout);
      setSessions(Array.isArray(res) ? res : []);
      setSessionsLoading(false);
      setIsRefreshing(false);
      setRefreshSuccess(true);
      setTimeout(() => setRefreshSuccess(false), 600);
    });
    // Also force-refresh subscription/plan status so grant/revoke/reset from
    // the admin panel is immediately reflected without waiting 5 minutes.
    invalidateSubscriptionCache();
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
      safeSendMessage<{ cached?: boolean }>(
        { type: 'PRECOMPUTE_SUMMARY', payload: { sessionId: session.id } },
        (result) => {
          if (!result) return;
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
    safeSendMessage<ContextSession>({ type: "GET_SESSION", sessionId: session.id }, (full) => {
      if (!full) return;
      setSelected((prev) => prev?.id === session.id ? full : prev);
    });
  }, [warmupSession]);

  function loadIndexStats() {
    setIndexStatsLoading(true);
    safeSendMessage<{ ok?: boolean; stats?: IndexStats }>({ type: 'GET_INDEX_STATS' }, (res) => {
      setIndexStatsLoading(false);
      if (!res?.ok) return;
      setIndexStats(res.stats as IndexStats);
    });
  }

  function clearSemanticIndex() {
    if (!window.confirm('Sessions will be re-indexed on next capture. Continue?')) return;
    safeSendMessage({ type: 'CLEAR_SEMANTIC_INDEX' }, () => {
      setIndexStats(null);
      setShowSettings(false);
      setStatusMessage({ tone: 'success', text: '🧠 Semantic index cleared — re-indexes on next capture.' });
    });
  }

  // ── Migration Quality handlers ──────────────────────────────────────────────
  function refreshQualityStats() {
    safeSendMessage<{ ok?: boolean; count?: number; avgScore?: number }>({ type: "GET_QUALITY_STATS" }, (resp) => {
      if (!resp?.ok) return;
      setQualityStats({ count: resp.count ?? 0, avgScore: resp.avgScore ?? 0 });
    });
  }

  function downloadQualityReport() {
    safeSendMessage<{ ok?: boolean; report?: string }>({ type: "GET_QUALITY_REPORT", payload: {} }, (resp) => {
      if (!resp?.ok || !resp.report) {
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
    safeSendMessage({ type: "CLEAR_QUALITY_HISTORY" }, () => {
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

  const filtered = useMemo(() => {
    // Deduplicate sessions by ID (keep latest updatedAt)
    const deduped = Array.from(
      sessions.reduce((map, session) => {
        const existing = map.get(session.id);
        if (!existing || session.updatedAt > existing.updatedAt) {
          map.set(session.id, session);
        }
        return map;
      }, new Map<string, ContextSession>()).values()
    );

    const base = filter === "all" ? deduped : deduped.filter((session) => session.platform === filter);
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
  }, [filter, searchQuery, sessions]);

  const sourceCounts = useMemo(
    () =>
      (Object.keys(PLATFORM_LABELS) as Platform[]).map((platform) => ({
        platform,
        count: sessions.filter((session) => session.platform === platform).length,
      })),
    [sessions]
  );
  const leadSession = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

  const semanticSessions = useMemo(
    () =>
      semanticResults
        .map(({ sessionId, score }) => {
          const session = sessions.find((s) => s.id === sessionId);
          return session ? { session, score } : null;
        })
        .filter((x): x is { session: ContextSession; score: number } => x !== null),
    [semanticResults, sessions]
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
                onClick={() => { setView("sessions"); setExpandedMessages(new Set()); }}
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
                onRename={(name) => safeSendMessage({ type: "RENAME_SESSION", sessionId: selected.id, title: name })}
              />
            </div>
          </div>

          {statusMessage && (
            <div
              className={`mx-3 mt-3 rounded-[4px] border px-3 py-2 text-[10px] font-mono uppercase tracking-wider ${
                statusMessage.tone === "success"
                  ? "border-[#00FF88]/25 bg-[#00FF88]/6 text-[#00FF88]"
                  : statusMessage.tone === "error"
                  ? "border-red-500/25 bg-red-500/6 text-red-400"
                  : "border-[#1A2A1A] bg-[#080808] text-[#2A5A2A]"
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
          <div className="grid grid-cols-3 divide-x divide-[#0D1A0D] border-b border-[#0D2A0D] text-center" style={{ background: "linear-gradient(to bottom, #070707, #050505)" }}>
            <div className="px-2 py-1.5">
              <div className="text-[9px] font-black uppercase tracking-[0.25em] text-[#2A6A2A]">Turns</div>
              <div className="mt-0.5 text-sm font-bold tabular-nums" style={{ color: platformColor }}>{selected.messages.length}</div>
            </div>
            <div className="px-2 py-1.5">
              <div className="text-[9px] font-black uppercase tracking-[0.25em] text-[#2A6A2A]">Created</div>
              <div className="mt-0.5 text-[11px] font-medium text-[#F5F5F5]">
                {new Date(selected.createdAt).toLocaleDateString("en", { month: "short", day: "numeric" })}
              </div>
            </div>
            <div className="px-2 py-1.5" style={{ background: `${platformColor}0A` }}>
              <div className="text-[9px] font-black uppercase tracking-[0.25em] text-[#2A6A2A]">Route</div>
              <div className="mt-0.5 text-[11px] font-semibold text-[#00FF88]">
                {PLATFORM_SHORT[selected.platform]} → {PLATFORM_SHORT[targetPlatform]}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between px-4 pt-2">
            <div className="text-[10px] font-black uppercase tracking-[0.22em] text-[#2A6A2A]">
              {showFullTranscript ? "Full transcript" : "Recent transcript"}
            </div>
            <button
              onClick={() => setShowFullTranscript((value) => !value)}
              className="rounded-[4px] border border-[#1A3A1A] bg-[#080808] px-2 py-1 text-[9px] font-black uppercase tracking-widest text-[#2A6A2A] hover:border-[#00FF88]/30 hover:text-[#00FF88] transition-all"
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

          <div className="border-t border-[#0D2A0D] px-4 py-2 space-y-2" style={{ background: "linear-gradient(to top, #050505, #070707)" }}>
            <div>
              <div className="mb-1.5 text-[10px] font-black uppercase tracking-[0.3em] text-[#2A6A2A]">
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
                        borderColor: "#0D1A0D",
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
                color: '#F59E0B',
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
                className="relative flex flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-[5px] py-3 text-[11px] font-black uppercase tracking-widest text-black transition-all hover:scale-[1.02] hover:-translate-y-px active:scale-[0.98]"
                style={{ background: "#00FF88", boxShadow: "0 0 22px rgba(0,255,136,0.5), 0 0 44px rgba(0,255,136,0.15)" }}
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
                className="rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-3 text-xs font-medium text-[#6B6B6B] transition hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
        {showMigrationModal && selected && (
          <MigrationModal
            session={selected}
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
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#050505] text-[#F5F5F5] crt">
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
        {/* ── Update available banner ── */}
        {updateAvailable && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "rgba(0,210,106,0.07)", borderBottom: "1px solid rgba(0,210,106,0.2)", fontSize: 9, color: "#00D26A", lineHeight: 1.4 }}>
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
        <div className="border-b border-[#0D2A0D] px-2 py-[3px]" style={{ background: "linear-gradient(135deg, #040404 0%, #071207 55%, #040404 100%)", boxShadow: "0 1px 0 rgba(0,255,136,0.07)" }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <img
                src={chrome.runtime.getURL("logo.png")}
                alt="ContextMover"
                style={{ height: 17, display: "block", width: "auto", filter: "drop-shadow(0 0 4px rgba(0,255,136,0.35))" }}
              />
              <div className="flex flex-col gap-0">
                <span className="text-[10px] font-black neon-flicker" style={{ letterSpacing: "0.04em", color: "#00FF88", textShadow: "0 0 8px rgba(0,255,136,0.4)" }}>ContextMover</span>
                <span className="text-[6px] uppercase" style={{ letterSpacing: "0.2em", color: "#2A5A2A" }}>CMD CENTER v1</span>
                {/* Device limit exceeded warning — clickable to manage devices */}
                {planStatus.loaded && planStatus.deviceLimitExceeded && (
                  <button
                    type="button"
                    onClick={() => chrome.tabs.create({ url: `${PRICING_URL.replace("/pricing", "")}/settings/billing` })}
                    title={planStatus.deviceLimitMessage ?? "Pro active on 5 devices. Click to manage devices."}
                    className="text-[8px] font-bold uppercase tracking-[0.1em] text-red-400 hover:text-red-300 text-left"
                  >
                    ⚠ Device limit — manage →
                  </button>
                )}
                {/* Plan status badge — Free shows usage, Pro/Team shows unlimited */}
                {planStatus.loaded && !planStatus.deviceLimitExceeded && (
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
                    : 'border-[#1A3A1A] bg-[#060606] text-[#2A6A2A] hover:border-[#00FF88]/50 hover:text-[#00FF88]'
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
                    : 'border-[#1A3A1A] bg-[#060606] text-[#1A3A1A]'
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
                    ? 'border-[#1A3A1A] bg-[#060606] text-[#1A3A1A] opacity-60 cursor-not-allowed'
                    : driveConnected === true
                      ? 'border-[#00FF88]/30 bg-[#00FF88]/8 text-[#00FF88]'
                      : 'border-[#1A3A1A] bg-[#060606] text-[#1A3A1A] hover:text-[#2A6A2A]'
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
                      ? 'border-purple-500/40 bg-purple-500/10 text-purple-400'
                      : 'border-[#1A3A1A] bg-[#060606] text-[#2A2A4A]'
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
                    : 'border-[#1A3A1A] bg-[#060606] text-[#2A6A2A] hover:border-[#00FF88]/40 hover:text-[#00FF88]'
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
              style={{ letterSpacing: '0.1em', color: '#4A4A4A', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              <span style={{ fontSize: '9px' }}>&#128274;</span>
              <span style={{ color: '#4A4A4A' }}>Local only</span>
              <span style={{ color: '#2A4A2A', marginLeft: '2px' }}>· Connect vault →</span>
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
              <span className="inline-block h-1 w-1 rounded-full bg-[#1A3A1A]" />
              <span className="text-[9px] uppercase" style={{ letterSpacing: '0.1em', color: '#1A3A1A' }}>Checking vault…</span>
            </div>
          )}

          {partialSync && (
            <div className="mt-1 rounded-[3px] border border-[#00FF88]/15 bg-[#00FF88]/5 px-2 py-1">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[8px] uppercase tracking-widest" style={{ color: "#00FF88" }}>{partialSync.phase}</span>
                <span className="text-[8px]" style={{ color: "#2A6A2A" }}>{partialSync.done}/{partialSync.total}</span>
              </div>
              <div className="h-[3px] w-full rounded-full bg-[#0D2A0D] overflow-hidden">
                <div className="h-full rounded-full bg-[#00FF88] transition-all duration-300" style={{ width: `${partialSync.pct}%` }} />
              </div>
            </div>
          )}

          {leadSession ? (
            <div className="mt-0.5 flex items-center gap-1">
              <span className="h-1 w-1 flex-shrink-0 rounded-full bg-[#00FF88] animate-pulse-green" style={{ boxShadow: "0 0 4px #00FF88" }} />
              <span className="text-[9px] uppercase" style={{ letterSpacing: "0.12em", color: "#2A6A2A" }}>
                Online · <span style={{ color: "#6AFF6A" }}>{PLATFORM_LABELS[leadSession.platform]}</span>
                {" · "}{formatRelativeTime(leadSession.updatedAt)}
              </span>
            </div>
          ) : (
            <p className="mt-0.5 text-[9px] uppercase" style={{ letterSpacing: "0.12em", color: "#1A3A1A" }}>Awaiting signal — open Claude, ChatGPT or Gemini</p>
          )}

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
                ? "border-red-500/25 bg-red-500/6 text-red-400"
                : "border-[#1A2A1A] bg-[#080808] text-[#2A5A2A]"
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
            className="w-full rounded-[4px] border border-[#1A3A1A] bg-[#0a0a0a] px-2 py-1 text-[10px] font-mono text-[#F5F5F5] outline-none placeholder:text-[#2A4A2A] focus:border-[#00FF88] focus:shadow-[0_0_0_2px_rgba(0,255,136,0.1)] transition-all"
          />
          <div style={{ position: "relative" }}>
            <input
              value={semanticQuery}
              onChange={(e) => setSemanticQuery(e.target.value)}
              placeholder="Search by meaning (semantic)…"
              className="w-full rounded-[4px] border border-[#1A1A3A] bg-[#0a0a0a] px-2 py-1 text-[10px] font-mono text-[#F5F5F5] outline-none placeholder:text-[#2A2A4A] focus:border-[#6366f1] focus:shadow-[0_0_0_2px_rgba(99,102,241,0.1)] transition-all"
            />
            {/* [CM-PERF] semantic ready indicator — appears after ONNX model warms up */}
            {searchReady && (
              <span style={{ position: "absolute", right: "6px", top: "50%", transform: "translateY(-50%)", fontSize: "10px", color: "#888", pointerEvents: "none" }}>● semantic ready</span>
            )}
          </div>
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-[#0D2A0D] px-3 py-0.5 scrollbar-none" style={{ background: "linear-gradient(to right, #050505, #081208, #050505)" }}>
          {(["all", "claude", "chatgpt", "gemini", "grok", "perplexity", "deepseek"] as const).map((item) => {
            const isActive = filter === item;
            const pColor = item !== "all" ? PLATFORM_COLORS[item] : null;
            const count = item === "all" ? sessions.length : sessions.filter((s) => s.platform === item).length;
            return (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className="whitespace-nowrap rounded-[3px] px-1.5 py-0.5 text-[8px] font-black uppercase tracking-[0.16em] transition-all duration-150 border hover:-translate-y-px"
                style={isActive
                  ? pColor
                    ? { background: `${pColor}18`, borderColor: `${pColor}45`, color: pColor, boxShadow: `0 0 10px ${pColor}28` }
                    : { background: "rgba(0,255,136,0.1)", borderColor: "rgba(0,255,136,0.3)", color: "#00FF88", boxShadow: "0 0 10px rgba(0,255,136,0.25)" }
                  : { background: "#080808", borderColor: "#1A2A1A", color: "#2A4A2A" }
                }
              >
                {item === "all" ? "All" : PLATFORM_SHORT[item]}
                <span className="ml-1 opacity-55">{count}</span>
              </button>
            );
          })}
        </div>

        {showSettings && !showSynthesizer && (
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            <SemanticIndexPanel
              stats={indexStats}
              loading={indexStatsLoading}
              onClear={clearSemanticIndex}
            />
            <QualityStatsPanel
              stats={qualityStats}
              onRefresh={refreshQualityStats}
              onDownload={downloadQualityReport}
              onClear={clearQualityHistory}
            />
            <DriveSyncPanel
              status={driveStatus}
              busy={driveBusy}
              onConnect={connectDrive}
              onDisconnect={disconnectDrive}
              onSyncNow={syncDriveNow}
            />
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
              <div className="pb-0.5 text-[7px] uppercase tracking-widest text-[#6366f1]">Semantic matches</div>
              {semanticSessions.map(({ session: s, score }) => (
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
                      <p className="truncate text-[10px] font-medium text-[#F5F5F5] transition-colors group-hover:text-[#6366f1]">{s.title}</p>
                      <div className="flex items-center gap-1 text-[8px] text-[#6B6B6B]">
                        <span>{s.messages.length} turns</span>
                        <span>·</span>
                        <span className="font-semibold text-[#6366f1]">{Math.round(score * 100)}% match</span>
                      </div>
                    </div>
                    <span className="text-[#3A3A3A] transition-colors group-hover:text-[#6366f1]">›</span>
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
                  className="overflow-hidden rounded-[4px] border border-[#1A2A1A] bg-[#0a0a0a] px-1.5 py-1"
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

        <div className="border-t border-[#0D2A0D] px-2 py-0.5 space-y-0.5">
          <div
            className="crucible-pulse flex cursor-default items-center justify-center rounded-[4px] border border-dashed py-0.5 transition-all hover:scale-[1.01]"
            style={{ borderColor: "rgba(0,255,136,0.2)", background: "rgba(0,255,136,0.018)" }}
          >
            <div style={{ fontSize: "5px", fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.3em", color: "#00FF88", textShadow: "0 0 8px rgba(0,255,136,0.5)" }}>
              ⚗ THE CRUCIBLE
            </div>
            <div style={{ marginLeft: "6px", fontSize: "5px", textTransform: "uppercase", letterSpacing: "0.14em", color: "#1A3A1A" }}>
              Drop sessions to merge · Super Memory
            </div>
          </div>
          {/* Quick links */}
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: DASHBOARD_URL })}
              className="flex-1 rounded-[3px] border border-[#1A3A1A] bg-[#060606] py-px text-[7px] font-black uppercase tracking-widest text-[#2A6A2A] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88]"
            >
              Dashboard ↗
            </button>
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: PRICING_URL })}
              className="flex-1 rounded-[3px] border border-[#1A3A1A] bg-[#060606] py-px text-[7px] font-black uppercase tracking-widest text-[#2A6A2A] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88]"
            >
              Upgrade ⚡
            </button>
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: "https://contextmover.com/support#bug-report" })}
              title="Report a bug"
              className="rounded-[3px] border border-[#1A3A1A] bg-[#060606] px-1.5 py-px text-[7px] font-black uppercase tracking-widest text-[#2A6A2A] transition-all hover:border-[#EF4444]/30 hover:text-[#EF4444]"
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
    <div style={{ borderTop: "1px solid #0D2A0D", padding: "1px 6px", background: "#040404" }}>
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
      <span className="text-[10px] text-[#4A6A4A]">{label}</span>
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
    <div className="space-y-4">
      <div className="text-[9px] font-black uppercase tracking-[0.3em] text-[#2A6A2A]">⚙ Semantic Index</div>
      <div
        className="rounded-[6px] border border-[#1A2A1A] bg-[#080808] p-4 space-y-2"
        style={{ boxShadow: "0 0 20px rgba(0,255,136,0.04)" }}
      >
        <div className="flex items-center gap-2 border-b border-[#0D2A0D] pb-2">
          <span className="text-base">🧠</span>
          <span className="text-[11px] font-bold text-[#F5F5F5]">Semantic Index</span>
        </div>

        {loading && (
          <div className="py-2 text-[10px] text-[#2A6A2A] animate-pulse">Loading stats…</div>
        )}
        {!loading && !stats && (
          <div className="py-2 text-[10px] text-[#3A3A3A]">No data — capture a session to start indexing.</div>
        )}
        {!loading && stats && (
          <div className="space-y-0.5">
            <StatRow
              label="Sessions indexed"
              value={`${stats.indexedCount.toLocaleString()} / ${stats.sessionCount.toLocaleString()}`}
            />
            <StatRow label="Chunks stored" value={stats.chunkCount.toLocaleString()} />
            <StatRow label="Storage used" value={`~${stats.estimatedStorageMB} MB`} />
            <StatRow label="Cached summaries" value={stats.summaryCount.toLocaleString()} />
            <StatRow label="Cached prompts" value={stats.cacheCount.toLocaleString()} />
            {stats.modelLabel && (
              <StatRow label="Model" value={stats.modelLabel} />
            )}
          </div>
        )}

        <button
          onClick={onClear}
          className="mt-1 w-full rounded-[4px] border border-red-500/20 bg-red-500/5 py-2 text-[9px] font-black uppercase tracking-widest text-red-400 transition-all hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300"
        >
          Clear Index
        </button>
      </div>
      <p className="text-[9px] leading-relaxed" style={{ color: "#2A3A2A" }}>
        Clearing removes embeddings, summaries and prompt cache — not your sessions. Re-indexing happens automatically on next capture.
      </p>
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
}) {
  const relative = (ts: number | null): string => {
    if (!ts) return 'never';
    const d = Date.now() - ts;
    if (d < 60_000) return 'just now';
    if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} hr ago`;
    return `${Math.floor(d / 86_400_000)} d ago`;
  };

  return (
    <div className="space-y-4">
      <div className="text-[9px] font-black uppercase tracking-[0.3em] text-[#2A6A2A]">☁ Drive Sync</div>
      <div
        className="rounded-[6px] border border-[#1A2A1A] bg-[#080808] p-4 space-y-2"
        style={{ boxShadow: "0 0 20px rgba(90,169,255,0.04)" }}
      >
        {!status.connected ? (
          // STATE A — Not connected
          <>
            <div className="flex items-center gap-2 border-b border-[#0D2A0D] pb-2">
              <span className="text-base">📱</span>
              <span className="text-[11px] font-bold text-[#F5F5F5]">Sessions on this device only</span>
            </div>
            <p className="text-[10px] leading-relaxed" style={{ color: "#9A9A9A" }}>
              Connect Google Drive to sync sessions across all your Chrome profiles.
              Your data is stored in a private folder in your own Drive — only this
              extension can access it. Your data never passes through our servers.
            </p>
            <p className="text-[9px] leading-relaxed rounded-[4px] border border-[rgba(90,169,255,0.15)] bg-[rgba(90,169,255,0.05)] px-2 py-1.5" style={{ color: "#7A9ABB" }}>
              ⚠️ Cross-profile sync requires the <strong>same Google account</strong> in every profile.
              Different Google accounts are always separate silos.
            </p>
            <button
              onClick={onConnect}
              disabled={busy}
              className="mt-1 w-full rounded-[4px] border border-[rgba(90,169,255,0.35)] bg-[rgba(90,169,255,0.08)] py-2 text-[9px] font-black uppercase tracking-widest text-[#5AA9FF] transition-all hover:border-[rgba(90,169,255,0.6)] hover:bg-[rgba(90,169,255,0.15)] disabled:opacity-50"
            >
              {busy ? 'Connecting…' : 'Connect Google Drive'}
            </button>
          </>
        ) : busy ? (
          // STATE B — Connected, syncing
          <>
            <div className="flex items-center gap-2 border-b border-[#0D2A0D] pb-2">
              <span className="text-base">☁</span>
              <span className="text-[11px] font-bold text-[#F5F5F5]">Google Drive connected</span>
            </div>
            <div className="py-2 text-[10px] text-[#5AA9FF] animate-pulse">Syncing…</div>
          </>
        ) : (
          // STATE C — Connected, synced
          <>
            <div className="flex items-center gap-2 border-b border-[#0D2A0D] pb-2">
              <span className="text-base">☁</span>
              <span className="text-[11px] font-bold text-[#F5F5F5]">Google Drive connected</span>
            </div>
            <div className="space-y-0.5">
              <StatRow label="Last sync" value={relative(status.lastSyncAt)} />
              <StatRow
                label="Sessions synced"
                value={status.lastSyncCount != null ? String(status.lastSyncCount) : '—'}
              />
              <StatRow label="From other profiles" value={String(status.sourcedIds.length)} />
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={onSyncNow}
                disabled={busy}
                className="flex-1 rounded-[4px] border border-[rgba(90,169,255,0.35)] bg-[rgba(90,169,255,0.08)] py-2 text-[9px] font-black uppercase tracking-widest text-[#5AA9FF] transition-all hover:border-[rgba(90,169,255,0.6)] hover:bg-[rgba(90,169,255,0.15)] disabled:opacity-50"
              >
                Sync now
              </button>
              <button
                onClick={onDisconnect}
                disabled={busy}
                className="flex-1 rounded-[4px] border border-red-500/20 bg-red-500/5 py-2 text-[9px] font-black uppercase tracking-widest text-red-400 transition-all hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          </>
        )}
      </div>
      <p className="text-[9px] leading-relaxed" style={{ color: "#2A3A2A" }}>
        Sessions captured on this profile sync to your private appdata folder.
        Sessions from other Chrome profiles signed into the <strong style={{ color: "#3A5A3A" }}>same Google account</strong> appear
        here with a ☁ badge. Different Google accounts are always separate silos.
        Disconnecting clears Drive state — your local sessions stay on this device.
      </p>
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
      <div className="text-[9px] font-black uppercase tracking-[0.3em] text-[#2A6A2A]">📊 Migration Quality</div>
      <div
        className="rounded-[6px] border border-[#1A2A1A] bg-[#080808] p-4 space-y-2"
        style={{ boxShadow: "0 0 20px rgba(0,255,136,0.04)" }}
      >
        <div className="flex items-center gap-2 border-b border-[#0D2A0D] pb-2">
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
          className="w-full rounded-[4px] border border-red-500/20 bg-red-500/5 py-2 text-[9px] font-black uppercase tracking-widest text-red-400 transition-all hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Clear History
        </button>
      </div>
      <p className="text-[9px] leading-relaxed" style={{ color: "#2A3A2A" }}>
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
        background: msg.kind === "success" ? "rgba(0,255,136,0.12)" : "rgba(239,68,68,0.12)",
        border: `1px solid ${msg.kind === "success" ? "rgba(0,255,136,0.35)" : "rgba(239,68,68,0.35)"}`,
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
              <span style={{ fontSize: 7, color: "#818CF8", background: "rgba(99,102,241,0.15)", borderRadius: 3, padding: "1px 4px", flexShrink: 0 }}>
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
  const tokenColor = tokenLevel === "safe" ? "#00FF88" : tokenLevel === "warning" ? "#F59E0B" : "#EF4444";
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
      <div className="mx-3 mt-2 mb-1 rounded-[6px] border border-[#1A2A1A] bg-[#080808]">
        <div className="flex items-center justify-between px-3 py-2 border-b border-[#1A2A1A]">
          <span className="text-[9px] font-black uppercase tracking-[0.18em] text-[#2A4A2A]">📁 Project Context</span>
        </div>
        <div className="px-3 py-3 text-center">
          <p className="text-[10px] text-[#444] mb-2 leading-relaxed">Connect your project folder to include files in migration.</p>
          <button
            onClick={() => void onConnect()}
            className="rounded-[4px] border border-[#1A3A1A] bg-[#060606] px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-[#2A6A2A] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88] hover:shadow-[0_0_10px_rgba(0,255,136,0.15)]"
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
      className="mx-3 mt-2 mb-1 rounded-[6px] border border-[#1A2A1A] bg-[#080808] relative"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#1A2A1A]">
        <button
          onClick={onTogglePanel}
          className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.14em] text-[#2A5A2A] hover:text-[#00FF88] transition-colors"
        >
          <span className="text-[8px]">{panelOpen ? "▼" : "▶"}</span>
          <span>📁 {rootName}</span>
        </button>
        <div className="flex items-center gap-1">
          <button onClick={() => void onRefresh()} title="Refresh (re-read folder)" className="flex h-5 w-5 items-center justify-center rounded-[3px] border border-[#1A3A1A] text-[#2A4A2A] hover:text-[#00FF88] hover:border-[#00FF88]/40 transition-all text-[10px]">↻</button>
          <button onClick={onDisconnect} title="Disconnect folder" className="flex h-5 w-5 items-center justify-center rounded-[3px] border border-[#1A3A1A] text-[#3A3A3A] hover:text-red-400 hover:border-red-500/30 transition-all text-[10px]">✕</button>
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
              className="flex-1 min-w-0 rounded-[3px] border border-[#1A2A1A] bg-[#050505] px-2 py-[3px] text-[10px] font-mono text-[#F5F5F5] outline-none placeholder:text-[#2A3A2A] focus:border-[#00FF88]/40 transition-all"
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
                    <span style={{ fontSize: 9, color: "#818CF8" }}>
                      ✨ {selectedCount} file{selectedCount !== 1 ? "s" : ""} auto-detected from session
                    </span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={onClearAutoSelect}
                        style={{ fontSize: 8, color: "#555", background: "none", border: "none", cursor: "pointer" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#EF4444")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "#555")}
                        title="Clear auto-selection"
                      >Clear</button>
                    </div>
                  </div>
                )}
                {/* Token count row */}
                <div className="flex items-center justify-between mb-2">
                  <span style={{ fontSize: 9, color: "#555" }}>
                    ☑ {selectedCount} file{selectedCount !== 1 ? "s" : ""} · {formatSize(selectedSize)} · <span style={{ color: tokenColor }}>~{tokens.toLocaleString()} tokens {tokenDot}</span>
                  </span>
                  <button
                    onClick={() => { projectReader.clearAll(); onToggleNode("__clear__"); }}
                    style={{ fontSize: 8, color: "#3A3A3A", background: "none", border: "none", cursor: "pointer" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#EF4444")}
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
                        <div style={{ padding: "4px 10px 5px", fontSize: 9, color: "#555", fontWeight: 900, textTransform: "uppercase" }}>Copy for…</div>
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
              <p style={{ fontSize: 9, color: "#2A3A2A" }}>Select files to copy, download, or add to migration</p>
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
        <span style={{ fontSize: "9px", color: "#4A4A4A" }}>
          Resets in {status.daysUntilReset}d
        </span>
      </div>
      {tiers.map(({ key, label }) => {
        const t = status.usage[key];
        const pct = t.limit > 0 ? Math.min((t.used / t.limit) * 100, 100) : 0;
        const color = pct >= 100 ? "#FF4444" : pct >= 80 ? "#F59E0B" : "#00FF88";
        return (
          <div key={key} style={{ marginBottom: "6px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
              <span style={{ fontSize: "9px", color: "#6B6B6B" }}>{label}</span>
              <span style={{ fontSize: "9px", color: pct >= 100 ? "#FF4444" : "#4A4A4A" }}>
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
