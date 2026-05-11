import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findTargetPlatformTab, focusTab } from "@/lib/platform-tabs";
import type { ContextSession, Platform } from "@/lib/types";
import ExportMenu from "@/components/ExportMenu";
import { PlatformBadge, PlatformLogo } from "@/components/PlatformLogo";
import MigrationModal from "./MigrationModal";
import { QualityScoreCard } from "./QualityScoreCard";
import type { QualityScore } from "@/lib/quality/migration-scorer";
import { UpgradeModal, type LimitType } from "./UpgradeModal";
import { attentionEngine } from "@/lib/attention-engine";
import { capabilityDetector } from "@/lib/capability-detector";
import { projectReader } from "@/lib/file-system/project-reader";
import { fileContextBuilder } from "@/lib/file-system/context-builder";
import { fileCopier } from "@/lib/file-system/file-copier";
import type { FileTreeNode } from "@/lib/file-system/project-reader";
import { VAULT_URL, DASHBOARD_URL, PRICING_URL } from "@/config/urls";
import { healthMonitor } from "@/lib/capture/health-monitor";
import type { CaptureAlert } from "@/lib/capture/health-monitor";

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
  onSelect: () => void;
  onExportSuccess: (fmt: string) => void;
  onExportError: (text: string) => void;
}

const SessionCard = memo<SessionCardProps>(function SessionCard({
  session,
  vaultConnected,
  migrationTier,
  onSelect,
  onExportSuccess,
  onExportError,
}) {
  const pColor = PLATFORM_COLORS[session.platform];
  return (
    <div
      key={session.id}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      className="stagger-item group relative block w-full cursor-pointer overflow-hidden rounded-[6px] border bg-[#0A0A0A] px-4 py-4 text-left transition-all duration-200 hover:shadow-[0_0_0_1px_rgba(0,255,136,0.5),0_4px_22px_rgba(0,255,136,0.12),0_0_50px_rgba(0,255,136,0.04)] hover:-translate-y-[2px] hover:bg-[#0D1A0D]"
      style={{ borderColor: `${pColor}25`, boxShadow: `0 1px 0 ${pColor}10` }}
    >
      <span className="absolute inset-y-0 left-0 w-[3px] rounded-l-[6px]" style={{ background: pColor }} />
      <div className="flex items-start gap-2.5 pl-1">
        <div className="min-w-0 flex-1">
          <PlatformBadge platform={session.platform} logoSize={11} />
          <p className="mt-2 truncate text-sm font-semibold text-[#F5F5F5] transition-all duration-200 group-hover:text-[#00FF88] typing-glow">
            {session.title}
          </p>
          <div className="mt-1.5 flex items-center gap-2 text-[10px] uppercase" style={{ letterSpacing: "0.1em", color: "#1A3A1A" }}>
            <span>{session.messages.length} turns</span>
            <span>·</span>
            <span>{formatRelativeTime(session.updatedAt)}</span>
            <span>·</span>
            <span style={{ fontSize: "8px", color: vaultConnected === true ? "#00AA55" : "#4A4A4A" }}>
              {vaultConnected === true ? "🔒 Vault" : "📱 Local"}
            </span>
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
          <ExportMenu
            session={session}
            variant="icon"
            align="right"
            onSuccess={onExportSuccess}
            onError={onExportError}
          />
          <span className="text-[#3A3A3A] transition-colors group-hover:text-[#00FF88]">›</span>
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

type View = "sessions" | "detail";
type StatusTone = "info" | "success" | "error";

export default function Sidebar() {
  const [sessions, setSessions] = useState<ContextSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [selected, setSelected] = useState<ContextSession | null>(null);
  const [view, setView] = useState<View>("sessions");
  const [targetPlatform, setTargetPlatform] = useState<Platform>("claude");
  const [migrationTiers, setMigrationTiers] = useState<Record<string, 1 | 2 | 3>>({});
  const [bridgeStatus, setBridgeStatus] = useState<"ok" | "offline">("offline");
  const [ideContext, setIdeContext] = useState<string | null>(null);
  const [filter, setFilter] = useState<Platform | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(new Set());
  const [statusMessage, setStatusMessage] = useState<{ tone: StatusTone; text: string } | null>(
    null
  );
  const [tick, setTick] = useState(0);
  const [showMigrationModal, setShowMigrationModal] = useState(false);
  const [latestQualityScore, setLatestQualityScore] = useState<QualityScore | null>(null);
  const [qualityStats, setQualityStats] = useState<{ count: number; avgScore: number } | null>(null);
  const [upgradeModal, setUpgradeModal] = useState<{
    open:      boolean;
    limitType: LimitType | null;
    used:      number;
    limit:     number;
  }>({ open: false, limitType: null, used: 0, limit: 0 });
  const [planStatus, setPlanStatus] = useState<{
    plan:      "free" | "pro" | "team";
    isPro:     boolean;
    used?:     number;   // simple migrations used this month
    limit?:    number;   // simple migrations limit
    status?:   string;
    trialEnd?: string | null;
    loaded:    boolean;
  }>({ plan: "free", isPro: false, loaded: false });
  const [vaultConnected, setVaultConnected] = useState<boolean | null>(null);
  const [vaultName, setVaultName] = useState<string | undefined>(undefined);
  // MCP bridge status — green when the local @contextmover/mcp-server is up
  // and listening on 127.0.0.1:49001. Independent from the VS Code IDE bridge.
  const [mcpStatus, setMcpStatus] = useState<{ running: boolean; totalSessions?: number }>({ running: false });
  const [semanticQuery, setSemanticQuery] = useState("");
  const [semanticResults, setSemanticResults] = useState<{ sessionId: string; score: number }[]>([]);
  const loadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const semanticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [captureAlert, setCaptureAlert] = useState<CaptureAlert | null>(null);
  // Ref-stable message handler — avoids re-registering the listener on every render.
  const handleMessageRef = useRef<(msg: { type: string }) => void>();
  // Precomputed summaries — keyed by sessionId, populated on session card click.
  const precomputedSummaries = useRef<Map<string, { cached: boolean }>>(new Map());
  const hardwareTierRef = useRef<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [indexStats, setIndexStats] = useState<IndexStats | null>(null);
  const [indexStatsLoading, setIndexStatsLoading] = useState(false);

  useEffect(() => {
    healthMonitor.getAlerts().then((alerts) => {
      const active = Object.values(alerts)[0] ?? null;
      setCaptureAlert(active);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadSessions();
    void checkBridge();
    void checkVault();
    void checkMcpBridge();

    const clockInterval = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 30_000);

    // Instant refresh on SW broadcast — handler stored in ref so the listener
    // is registered exactly once (empty deps) and always calls the latest closure.
    const stableListener = (msg: { type: string }) => handleMessageRef.current?.(msg);
    chrome.runtime.onMessage.addListener(stableListener);

    return () => {
      window.clearInterval(clockInterval);
      chrome.runtime.onMessage.removeListener(stableListener);
      if (loadDebounceRef.current) clearTimeout(loadDebounceRef.current);
      if (semanticTimerRef.current) clearTimeout(semanticTimerRef.current);
    };
  }, []);

  // Keep handleMessageRef in sync with latest loadSessions closure every render.
  handleMessageRef.current = (msg) => {
    if (msg.type === "SESSIONS_UPDATED") loadSessions();
  };

  // ── One-time hardware detection + model warmup ──────────────────────────────
  // Detect once, memoize in a ref, send WARMUP_MODEL if capable hardware.
  useEffect(() => {
    capabilityDetector.getEffectiveTier()
      .then((tier) => {
        hardwareTierRef.current = tier;
        if (tier !== 'minimal') {
          chrome.runtime.sendMessage({ type: 'WARMUP_MODEL' }).catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  // ── Plan status (Free / Pro / Team) for the header badge ───────────────────
  // Re-fetches whenever `tick` changes — pollSidebar bumps `tick` after every
  // migration so the "X/50" counter updates without a manual refresh.
  useEffect(() => {
    let cancelled = false;
    chrome.runtime.sendMessage({ type: "GET_SUBSCRIPTION_STATUS" })
      .then((res: {
        plan?:     "free" | "pro" | "team";
        isPro?:    boolean;
        usage?:    { simpleMigrations: number };
        limits?:   { simpleMigrations: number | "unlimited" };
        status?:   string;
        trialEnd?: string | null;
      } | undefined) => {
        if (cancelled || !res) return;
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
        });
      })
      .catch(() => {
        if (!cancelled) setPlanStatus((s) => ({ ...s, loaded: true }));
      });
    return () => { cancelled = true; };
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
      console.log("[ContextForge:sidebar] Background preload starting…");
      attentionEngine
        .initialize(undefined, tier)
        .then(() => console.log("[ContextForge:sidebar] Background preload ready"))
        .catch((err) => console.warn("[ContextForge:sidebar] Background preload failed:", err));
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
    chrome.runtime.sendMessage({ type: 'VAULT_GET_STATUS' }, (res) => {
      if (chrome.runtime.lastError) return;
      setVaultConnected(res?.connected === true);
      if (res?.projectName) setVaultName(res.projectName as string);
    });
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
        setSessions(Array.isArray(res) ? res : []);
        setSessionsLoading(false);
      });
    }, 250);
  }

  // ── Precompute summaries in background when user selects a session ────────────
  // Session is already selected/highlighted; we silently ask the SW to run
  // tier-1 + tier-2 summarization now so migration feels instant.
  const warmupSession = useCallback(async (session: ContextSession): Promise<void> => {
    // 1. Trigger background semantic indexing via SW (fire & forget)
    chrome.runtime.sendMessage({ type: 'BACKGROUND_INDEX', sessionId: session.id }).catch(() => {});
    // 2. Precompute tier-2 summary if not already cached
    if (!precomputedSummaries.current.has(session.id)) {
      chrome.runtime.sendMessage(
        { type: 'PRECOMPUTE_SUMMARY', payload: { sessionId: session.id } },
        (result) => {
          if (chrome.runtime.lastError) return;
          if (result?.cached) precomputedSummaries.current.set(session.id, { cached: true });
        }
      );
    }
    // 3. Warm embedding model if hardware can handle it (memoized at mount)
    if (hardwareTierRef.current !== null && hardwareTierRef.current !== 'minimal') {
      chrome.runtime.sendMessage({ type: 'WARMUP_MODEL' }).catch(() => {});
    }
  }, []);

  const handleSessionSelect = useCallback((session: ContextSession) => {
    setSelected(session);
    setShowFullTranscript(false);
    setView('detail');
    warmupSession(session).catch(() => {});
  }, [warmupSession]);

  async function checkBridge() {
    try {
      await fetch("http://localhost:49152/health");
      setBridgeStatus("ok");
      chrome.runtime.sendMessage({ type: "FETCH_IDE_CONTEXT" }, (res) => {
        if (res?.ideContext) {
          setIdeContext(res.ideContext);
        }
      });
    } catch {
      setBridgeStatus("offline");
    }
  }

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
          { url, filename: `contextforge-quality-${dateStr}.txt` },
          (downloadId) => {
            if (chrome.runtime.lastError || !downloadId) {
              triggerAnchorDownload(url, `contextforge-quality-${dateStr}.txt`);
            }
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }
        );
      } catch {
        triggerAnchorDownload(url, `contextforge-quality-${dateStr}.txt`);
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

  const filtered = useMemo(() => {
    const base = filter === "all" ? sessions : sessions.filter((session) => session.platform === filter);
    const query = searchQuery.trim().toLowerCase();

    if (!query) {
      return base;
    }

    return base.filter((session) => {
      const haystack = [
        session.title,
        PLATFORM_LABELS[session.platform],
        ...session.messages.slice(-4).map((message) => message.content),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
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
          <div className="border-b px-4 py-4" style={{ background: `linear-gradient(135deg, ${platformColor}12 0%, #050505 70%)`, borderColor: `${platformColor}20`, boxShadow: `0 1px 0 ${platformColor}12` }}>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setView("sessions"); setExpandedMessages(new Set()); }}
                className="flex shrink-0 items-center gap-1 rounded-[4px] border px-2 py-1 text-[9px] font-black uppercase tracking-widest transition-all hover:-translate-y-px" style={{ borderColor: `${platformColor}30`, background: `${platformColor}08`, color: `${platformColor}BB` }}
              >
                ← Back
              </button>
              <PlatformBadge platform={selected.platform} logoSize={11} />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[#F5F5F5]" title={selected.title}>{selected.title}</span>
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
                onDismiss={() => setLatestQualityScore(null)}
              />
            </div>
          )}

          {/* ── Session stats bar ── */}
          <div className="grid grid-cols-3 divide-x divide-[#0D1A0D] border-b border-[#0D2A0D] text-center" style={{ background: "linear-gradient(to bottom, #070707, #050505)" }}>
            <div className="px-3 py-4">
              <div className="text-[9px] font-black uppercase tracking-[0.25em] text-[#2A6A2A]">Turns</div>
              <div className="mt-1 text-2xl font-bold tabular-nums" style={{ color: platformColor }}>{selected.messages.length}</div>
            </div>
            <div className="px-3 py-4">
              <div className="text-[9px] font-black uppercase tracking-[0.25em] text-[#2A6A2A]">Created</div>
              <div className="mt-0.5 text-[11px] font-medium text-[#F5F5F5]">
                {new Date(selected.createdAt).toLocaleDateString("en", { month: "short", day: "numeric" })}
              </div>
            </div>
            <div className="px-3 py-4" style={{ background: `${platformColor}0A` }}>
              <div className="text-[8px] font-black uppercase tracking-[0.25em] text-[#2A6A2A]">Route</div>
              <div className="mt-0.5 text-[11px] font-semibold text-[#00FF88]">
                {PLATFORM_SHORT[selected.platform]} → {PLATFORM_SHORT[targetPlatform]}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between px-4 pt-4">
            <div className="text-[8px] font-black uppercase tracking-[0.22em] text-[#2A6A2A]">
              {showFullTranscript ? "Full transcript" : "Recent transcript"}
            </div>
            <button
              onClick={() => setShowFullTranscript((value) => !value)}
              className="rounded-[4px] border border-[#1A3A1A] bg-[#080808] px-2 py-1 text-[9px] font-black uppercase tracking-widest text-[#2A6A2A] hover:border-[#00FF88]/30 hover:text-[#00FF88] transition-all"
            >
              {showFullTranscript ? "Show recent" : "Show all"}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {visibleMessages.map((msg, index) => {
              const MAX_LEN = 480;
              const isLong = msg.content.length > MAX_LEN;
              const isExpanded = expandedMessages.has(index);
              const displayContent = isLong && !isExpanded ? msg.content.slice(0, MAX_LEN) : msg.content;
              const isUser = msg.role === "user";
              return (
                <div
                  key={`${msg.role}-${index}-${msg.timestamp}`}
                  className={`rounded-[6px] border text-xs overflow-hidden relative transition-all animate-fade-in ${
                    isUser
                      ? "ml-3 bg-[#0A0A0A]"
                      : "mr-3 bg-[#070E0A]"
                  }`}
                  style={{ borderColor: isUser ? `${platformColor}22` : "rgba(0,255,136,0.15)", boxShadow: isUser ? `0 0 8px ${platformColor}08` : "0 0 8px rgba(0,255,136,0.06)" }}
                >
                  <div className={`flex items-center justify-between gap-2 border-b px-3 py-1.5 ${
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
                  <div className="px-3 py-2 text-[11px] leading-[1.65] text-[#D4D4D4]">
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

          <div className="border-t border-[#0D2A0D] px-4 py-4 space-y-4" style={{ background: "linear-gradient(to top, #050505, #070707)" }}>
            <div>
              <div className="mb-3 text-[9px] font-black uppercase tracking-[0.3em] text-[#2A6A2A]">
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
                      className="flex flex-col items-center gap-1.5 rounded-[5px] border p-3 transition-all duration-200 overflow-hidden hover:-translate-y-0.5 hover:scale-[1.05]"
                      style={isTarget ? {
                        borderColor: `${pc}55`,
                        background: `${pc}12`,
                        boxShadow: `0 0 16px ${pc}30, inset 0 0 10px ${pc}08`,
                      } : {
                        borderColor: "#0D1A0D",
                        background: "#060606",
                      }}
                    >
                      <PlatformLogo platform={platform} size={20} />
                      <div className="text-[9px] font-bold leading-tight uppercase tracking-wider" style={{ color: isTarget ? pc : "#6B6B6B" }}>{PLATFORM_SHORT[platform]}</div>
                      {isTarget && <div className="h-[1.5px] w-full rounded-full animate-xp-fill" style={{ background: `linear-gradient(to right, transparent, ${pc}, transparent)`, boxShadow: `0 0 6px ${pc}` }} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {ideContext && (
              <div className="rounded-[4px] border border-[#00FF88]/20 bg-[#00FF88]/5 px-3 py-2 text-xs text-[#00FF88]/80">
                IDE context attached.
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
            onClose={() => setShowMigrationModal(false)}
            onSuccess={(tier, _compressionRatio, chars, qualityScore) => {
              setShowMigrationModal(false);
              setMigrationTiers((prev) => ({ ...prev, [selected.id]: tier }));
              const tierName = tier === 3 ? "Attention Engine" : tier === 2 ? "Smart Summary" : "Full Context";
              setStatusMessage({ tone: "success", text: `✅ Migrated via ${tierName} · Stayed in your browser` });
              if (qualityScore) setLatestQualityScore(qualityScore);
              void chars; // referenced to avoid unused-var lint
            }}
            onLimitReached={(info) => {
              setUpgradeModal({
                open:      true,
                limitType: info.type,
                used:      info.used,
                limit:     info.limit,
              });
            }}
          />
        )}
        <UpgradeModal
          isOpen={upgradeModal.open}
          onClose={() => setUpgradeModal((s) => ({ ...s, open: false }))}
          limitType={upgradeModal.limitType}
          used={upgradeModal.used}
          limit={upgradeModal.limit}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#050505] text-[#F5F5F5] crt">
      <div className="flex h-full flex-col">
        {/* ── Capture health alert banner ── */}
        {captureAlert && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 12px", background: "rgba(245,158,11,0.08)", borderBottom: "1px solid rgba(245,158,11,0.25)", fontSize: 9, color: "#F59E0B", lineHeight: 1.4 }}>
            <span style={{ flexShrink: 0, marginTop: 1 }}>⚠</span>
            <span style={{ flex: 1 }}>{captureAlert.message}</span>
            <button
              onClick={() => { setCaptureAlert(null); void healthMonitor.clearAlert(captureAlert.platform); }}
              style={{ flexShrink: 0, background: "none", border: "none", color: "#F59E0B", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}
            >×</button>
          </div>
        )}
        {/* Header */}
        <div className="border-b border-[#0D2A0D] px-4 py-4" style={{ background: "linear-gradient(135deg, #050505 0%, #091409 55%, #050505 100%)", boxShadow: "0 1px 0 rgba(0,255,136,0.07)" }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="relative flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[5px] bg-[#00FF88] neon-flicker" style={{ boxShadow: "0 0 16px rgba(0,255,136,0.65), 0 0 32px rgba(0,255,136,0.2)" }}>
                <span className="text-[11px] font-black text-black" style={{ letterSpacing: "-0.04em" }}>CF</span>
                <span className="animate-pulse-green absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[#00FF88]" style={{ boxShadow: "0 0 6px #00FF88" }} />
              </div>
              <div className="flex flex-col gap-px">
                <span className="text-[13px] font-black uppercase neon-flicker" style={{ letterSpacing: "0.18em", color: "#00FF88", textShadow: "0 0 10px rgba(0,255,136,0.45)" }}>ContextForge</span>
                <span className="text-[8px] uppercase" style={{ letterSpacing: "0.22em", color: "#1A3A1A" }}>CMD CENTER v1</span>
                {/* Plan status badge — Free shows usage, Pro/Team shows unlimited */}
                {planStatus.loaded && (
                  planStatus.isPro ? (
                    <button
                      type="button"
                      onClick={() => chrome.tabs.create({ url: `${PRICING_URL.replace("/pricing", "")}/settings/billing` })}
                      title="Manage billing"
                      className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.18em] text-left"
                      style={{ color: "#00FF88", letterSpacing: "0.18em" }}
                    >
                      {planStatus.plan === "team" ? "Team" : "Pro"} ✦{" "}
                      {planStatus.status === "trialing" && planStatus.trialEnd
                        ? `Trial · ${Math.max(0, Math.ceil((new Date(planStatus.trialEnd).getTime() - Date.now()) / 86_400_000))}d left`
                        : "Unlimited"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => chrome.tabs.create({ url: PRICING_URL })}
                      title="Upgrade to Pro"
                      className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.18em] text-left hover:text-[#00FF88]"
                      style={{ color: "#6B6B6B", letterSpacing: "0.18em" }}
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
                onClick={() => { void loadSessions(); }}
                title="Refresh sessions"
                className="flex h-6 w-6 items-center justify-center rounded-[4px] border border-[#1A3A1A] bg-[#060606] text-[#2A6A2A] transition-all duration-200 hover:border-[#00FF88]/50 hover:text-[#00FF88] hover:shadow-[0_0_10px_rgba(0,255,136,0.3)] hover:scale-[1.1]"
              >
                <span className="text-sm">↻</span>
              </button>
              <button
                onClick={() => { void checkBridge(); void loadSessions(); }}
                className={`flex items-center gap-1 rounded-[4px] border px-2 py-1 text-[9px] font-black uppercase tracking-widest transition-all duration-200 ${
                  bridgeStatus === "ok"
                    ? "border-[#00FF88]/30 bg-[#00FF88]/8 text-[#00FF88] shadow-[0_0_12px_rgba(0,255,136,0.25)]"
                    : "border-[#1A3A1A] bg-[#060606] text-[#1A3A1A]"
                }`}
              >
                <span
                  className={bridgeStatus === "ok" ? "animate-pulse-green inline-block h-1.5 w-1.5 rounded-full bg-[#00FF88]" : "inline-block h-1.5 w-1.5 rounded-full bg-[#3A3A3A]"}
                />
                IDE
              </button>
              <button
                onClick={() => void checkVault()}
                title={vaultConnected ? 'Vault connected' : 'Connect personal vault'}
                className={`flex items-center gap-1 rounded-[4px] border px-2 py-1 text-[9px] font-black uppercase tracking-widest transition-all duration-200 ${
                  vaultConnected === true
                    ? 'border-[#00FF88]/30 bg-[#00FF88]/8 text-[#00FF88] shadow-[0_0_12px_rgba(0,255,136,0.25)]'
                    : 'border-[#1A3A1A] bg-[#060606] text-[#1A3A1A]'
                }`}
              >
                <span className={vaultConnected === true ? 'animate-pulse-green inline-block h-1.5 w-1.5 rounded-full bg-[#00FF88]' : 'inline-block h-1.5 w-1.5 rounded-full bg-[#3A3A3A]'} />
                Vault
              </button>
              <button
                onClick={() => {
                  if (mcpStatus.running) {
                    // Already connected — re-probe & flash counter.
                    void checkMcpBridge();
                  } else {
                    // Not running — open setup instructions.
                    chrome.tabs.create({ url: 'https://www.npmjs.com/package/@contextmover/mcp-server' });
                  }
                }}
                title={mcpStatus.running
                  ? `MCP bridge running — ${mcpStatus.totalSessions ?? 0} sessions mirrored. Click to re-probe.`
                  : 'MCP bridge offline. Click for setup (Cursor / Windsurf / Claude Desktop).'}
                className={`flex items-center gap-1 rounded-[4px] border px-2 py-1 text-[9px] font-black uppercase tracking-widest transition-all duration-200 ${
                  mcpStatus.running
                    ? 'border-[#00FF88]/30 bg-[#00FF88]/8 text-[#00FF88] shadow-[0_0_12px_rgba(0,255,136,0.25)]'
                    : 'border-[#1A3A1A] bg-[#060606] text-[#1A3A1A]'
                }`}
              >
                <span className={mcpStatus.running ? 'animate-pulse-green inline-block h-1.5 w-1.5 rounded-full bg-[#00FF88]' : 'inline-block h-1.5 w-1.5 rounded-full bg-[#3A3A3A]'} />
                MCP
              </button>
              <button
                onClick={() => { const opening = !showSettings; setShowSettings(opening); if (opening) { loadIndexStats(); refreshQualityStats(); } }}
                title="Semantic index settings"
                className={`flex h-6 w-6 items-center justify-center rounded-[4px] border transition-all duration-200 ${
                  showSettings
                    ? 'border-[#00FF88]/40 bg-[#00FF88]/10 text-[#00FF88] shadow-[0_0_10px_rgba(0,255,136,0.25)]'
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
              className="mt-2 flex items-center gap-1.5 text-[9px] uppercase transition-colors hover:text-[#00FF88] text-left"
              style={{ letterSpacing: '0.12em', color: '#4A4A4A', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              <span style={{ fontSize: '10px' }}>&#128274;</span>
              <span style={{ color: '#4A4A4A' }}>Local only</span>
              <span style={{ color: '#2A4A2A', marginLeft: '4px' }}>· Connect vault →</span>
            </button>
          )}

          {vaultConnected === true && (
            <div className="mt-2 flex items-center gap-1.5">
              <span style={{ fontSize: '10px' }}>&#128274;</span>
              <span className="text-[9px] uppercase" style={{ letterSpacing: '0.12em', color: '#00FF88' }}>
                Your vault · <span style={{ color: '#6AFF6A' }}>{vaultName ?? 'Personal Vault'}</span>
              </span>
            </div>
          )}

          {vaultConnected === null && (
            <div className="mt-2 flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#1A3A1A]" />
              <span className="text-[9px] uppercase" style={{ letterSpacing: '0.12em', color: '#1A3A1A' }}>Checking vault…</span>
            </div>
          )}

          {leadSession ? (
            <div className="mt-2 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#00FF88] animate-pulse-green" style={{ boxShadow: "0 0 6px #00FF88" }} />
              <span className="text-[9px] uppercase" style={{ letterSpacing: "0.12em", color: "#2A6A2A" }}>
                Online · <span style={{ color: "#6AFF6A" }}>{PLATFORM_LABELS[leadSession.platform]}</span>
                {" · "}{formatRelativeTime(leadSession.updatedAt)}
              </span>
            </div>
          ) : (
            <p className="mt-2 text-[9px] uppercase" style={{ letterSpacing: "0.12em", color: "#1A3A1A" }}>Awaiting signal — open Claude, ChatGPT or Gemini</p>
          )}

          <div className="mt-4 grid grid-cols-3 gap-2">
            {sourceCounts.map(({ platform, count }) => (
              <button
                key={platform}
                onClick={() => setFilter(platform)}
                className="flex flex-col items-center gap-1 rounded-[5px] border py-3 transition-all duration-200 hover:scale-[1.06] hover:-translate-y-0.5"
                style={{
                  borderColor: count > 0 ? `${PLATFORM_COLORS[platform]}40` : "#141414",
                  background: count > 0 ? `${PLATFORM_COLORS[platform]}0E` : "#0A0A0A",
                  boxShadow: count > 0 ? `0 0 8px ${PLATFORM_COLORS[platform]}18` : "none",
                }}
                title={PLATFORM_LABELS[platform]}
              >
                <PlatformLogo platform={platform} size={18} className="mx-auto" />
                <div className="text-[9px] font-black uppercase tabular-nums" style={{ color: count > 0 ? PLATFORM_COLORS[platform] : "#1A2A1A", textShadow: count > 0 ? `0 0 8px ${PLATFORM_COLORS[platform]}60` : "none" }}>{PLATFORM_SHORT[platform]}</div>
                <div className="text-[11px] font-black tabular-nums" style={{ color: count > 0 ? PLATFORM_COLORS[platform] : "#1A2A1A", textShadow: count > 0 ? `0 0 8px ${PLATFORM_COLORS[platform]}60` : "none" }}>{count}</div>
              </button>
            ))}
          </div>
        </div>

        {statusMessage && (
          <div
            className={`mx-3 mt-2 rounded-[4px] border px-3 py-2 text-[10px] font-mono uppercase tracking-wider ${
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

        <div className="px-4 pt-4 space-y-2.5">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search sessions…"
            className="w-full rounded-[5px] border border-[#1A3A1A] bg-[#080808] px-4 py-2.5 text-xs font-mono text-[#F5F5F5] outline-none placeholder:text-[#2A4A2A] focus:border-[#00FF88] focus:shadow-[0_0_0_2px_rgba(0,255,136,0.1)] transition-all"
          />
          <input
            value={semanticQuery}
            onChange={(e) => setSemanticQuery(e.target.value)}
            placeholder="Search by meaning (semantic)…"
            className="w-full rounded-[5px] border border-[#1A1A3A] bg-[#080808] px-4 py-2.5 text-xs font-mono text-[#F5F5F5] outline-none placeholder:text-[#2A2A4A] focus:border-[#6366f1] focus:shadow-[0_0_0_2px_rgba(99,102,241,0.1)] transition-all"
          />
        </div>

        <div className="flex gap-1.5 overflow-x-auto border-b border-[#0D2A0D] px-4 py-3 scrollbar-none" style={{ background: "linear-gradient(to right, #050505, #081208, #050505)" }}>
          {(["all", "claude", "chatgpt", "gemini", "grok", "perplexity", "deepseek"] as const).map((item) => {
            const isActive = filter === item;
            const pColor = item !== "all" ? PLATFORM_COLORS[item] : null;
            const count = item === "all" ? sessions.length : sessions.filter((s) => s.platform === item).length;
            return (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className="whitespace-nowrap rounded-[4px] px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.18em] transition-all duration-150 border hover:-translate-y-px"
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

        {showSettings && (
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
          </div>
        )}
        <div className={showSettings ? 'hidden' : 'flex-1 overflow-y-auto px-4 py-3'}>
          {semanticSessions.length > 0 && (
            <div className="mb-4 space-y-2">
              <div className="pb-2 text-[9px] uppercase tracking-widest text-[#6366f1]">Semantic matches</div>
              {semanticSessions.map(({ session: s, score }) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setSelected(s); setShowFullTranscript(false); setView("detail"); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(s); setShowFullTranscript(false); setView("detail"); } }}
                  className="group relative block w-full cursor-pointer overflow-hidden rounded-[6px] border bg-[#0A0A0A] px-4 py-3.5 text-left transition-all duration-200 hover:shadow-[0_0_0_1px_#6366f1,0_4px_20px_rgba(99,102,241,0.15)] hover:-translate-y-[2px] hover:bg-[#0D0D1A]"
                  style={{ borderColor: `${PLATFORM_COLORS[s.platform]}25`, boxShadow: `0 1px 0 ${PLATFORM_COLORS[s.platform]}10` }}
                >
                  <span className="absolute inset-y-0 left-0 w-[3px] rounded-l-[6px]" style={{ background: PLATFORM_COLORS[s.platform] }} />
                  <div className="flex items-start gap-2.5 pl-1">
                    <div className="min-w-0 flex-1">
                      <PlatformBadge platform={s.platform} logoSize={9} />
                      <p className="mt-1.5 truncate text-xs font-medium text-[#F5F5F5] transition-all duration-200 group-hover:text-[#6366f1]">{s.title}</p>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[#6B6B6B]">
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
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className="overflow-hidden rounded-[6px] border border-[#1A2A1A] bg-[#080808] px-4 py-4"
                >
                  <div className="flex items-center gap-2">
                    <div className="h-4 w-16 rounded-[20px] bg-[#2A2A2A] animate-pulse" />
                  </div>
                  <div className="mt-2 h-3 w-[75%] rounded bg-[#2A2A2A] animate-pulse" />
                  <div className="mt-1.5 h-2.5 w-[40%] rounded bg-[#1F1F1F] animate-pulse" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-[6px] border border-dashed px-4 py-10 text-center animate-fade-in neon-border-pulse" style={{ background: "#070707" }}>
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-[6px] border border-[#00FF88]/30 bg-[#00FF88]/5" style={{ boxShadow: "0 0 16px rgba(0,255,136,0.15)" }}>
                <span className="text-lg">◆</span>
              </div>
              <p className="text-xs font-medium text-[#F5F5F5]">
                {sessions.length === 0 ? "No sessions yet" : "No results"}
              </p>
              <p className="mt-1 text-[10px] text-[#6B6B6B]">
                {sessions.length === 0
                  ? "Visit Claude, ChatGPT, Google Gemini, or xAI Grok."
                  : "Try a different search or filter."}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  vaultConnected={vaultConnected}
                  migrationTier={migrationTiers[session.id]}
                  onSelect={() => handleSessionSelect(session)}
                  onExportSuccess={(fmt) =>
                    setStatusMessage({ tone: "success", text: `Exported as ${fmt.toUpperCase()} — check downloads.` })
                  }
                  onExportError={(text) => setStatusMessage({ tone: "error", text })}
                />
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-[#0D2A0D] px-4 py-3 space-y-2">
          <div
            className="crucible-pulse flex cursor-default flex-col items-center justify-center rounded-[6px] border border-dashed py-5 transition-all hover:scale-[1.01]"
            style={{ borderColor: "rgba(0,255,136,0.2)", background: "rgba(0,255,136,0.018)" }}
          >
            <div className="text-[10px] font-black uppercase tracking-[0.35em] text-[#00FF88]" style={{ textShadow: "0 0 10px rgba(0,255,136,0.55)" }}>
              ⚗ THE CRUCIBLE
            </div>
            <div className="mt-1 text-[9px] uppercase tracking-[0.18em]" style={{ color: "#1A3A1A" }}>
              Drop sessions to merge · Super Memory
            </div>
          </div>
          {/* Quick links */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: DASHBOARD_URL })}
              className="flex-1 rounded-[4px] border border-[#1A3A1A] bg-[#060606] py-1.5 text-[9px] font-black uppercase tracking-widest text-[#2A6A2A] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88]"
            >
              Dashboard ↗
            </button>
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: PRICING_URL })}
              className="flex-1 rounded-[4px] border border-[#1A3A1A] bg-[#060606] py-1.5 text-[9px] font-black uppercase tracking-widest text-[#2A6A2A] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88]"
            >
              Upgrade ⚡
            </button>
          </div>
        </div>
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
        className="rounded-[6px] border border-[#1A2A1A] bg-[#080808] p-4 space-y-3"
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
        className="rounded-[6px] border border-[#1A2A1A] bg-[#080808] p-4 space-y-3"
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
