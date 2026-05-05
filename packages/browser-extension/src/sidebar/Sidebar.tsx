import React, { useEffect, useMemo, useRef, useState } from "react";
import { findTargetPlatformTab, focusTab } from "@/lib/platform-tabs";
import type { ContextSession, Platform } from "@/lib/types";
import ExportMenu from "@/components/ExportMenu";
import { PlatformBadge, PlatformLogo } from "@/components/PlatformLogo";
import MigrationModal from "./MigrationModal";
import { attentionEngine } from "@/lib/attention-engine";
import { capabilityDetector } from "@/lib/capability-detector";

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
  const [vaultConnected, setVaultConnected] = useState<boolean | null>(null);
  const [vaultName, setVaultName] = useState<string | undefined>(undefined);
  const [semanticQuery, setSemanticQuery] = useState("");
  const [semanticResults, setSemanticResults] = useState<{ sessionId: string; score: number }[]>([]);
  const loadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const semanticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadSessions();
    void checkBridge();
    void checkVault();

    // Poll at 30 s — SESSIONS_UPDATED events already handle real-time updates.
    // Frequent polling was the main cause of GET_SESSIONS storms.
    const sessionInterval = window.setInterval(() => {
      loadSessions();
    }, 30_000);

    const clockInterval = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 30_000);

    // Instant refresh on SW broadcast, debounced so rapid captures
    // (e.g. a 150-msg session upsert) don’t fire 140 GET_SESSIONS calls.
    const onMessage = (msg: { type: string }) => {
      if (msg.type === "SESSIONS_UPDATED") loadSessions();
    };
    chrome.runtime.onMessage.addListener(onMessage);

    return () => {
      window.clearInterval(sessionInterval);
      window.clearInterval(clockInterval);
      chrome.runtime.onMessage.removeListener(onMessage);
      if (loadDebounceRef.current) clearTimeout(loadDebounceRef.current);
      if (semanticTimerRef.current) clearTimeout(semanticTimerRef.current);
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
      console.log("[ContextForge:sidebar] Background preload starting…");
      attentionEngine
        .initialize(undefined, tier)
        .then(() => console.log("[ContextForge:sidebar] Background preload ready"))
        .catch((err) => console.warn("[ContextForge:sidebar] Background preload failed:", err));
    }, 1200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // ── Pre-index the selected session when entering detail view ─────────────────
  // This makes tier-3 live preview / migration near-instant because indexSession
  // becomes a no-op (same message count) when the user types their task.
  useEffect(() => {
    if (view !== "detail" || !selected) return;
    if (!attentionEngine.initialized) return;
    // Fire-and-forget: any error is silently ignored.
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
            onSuccess={(tier, _compressionRatio, chars) => {
              setShowMigrationModal(false);
              setMigrationTiers((prev) => ({ ...prev, [selected.id]: tier }));
              const tierName = tier === 3 ? "Attention Engine" : tier === 2 ? "Smart Summary" : "Full Context";
              setStatusMessage({ tone: "success", text: `Migrated via ${tierName} — ${chars.toLocaleString()} chars injected.` });
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#050505] text-[#F5F5F5] crt">
      <div className="flex h-full flex-col">
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
            </div>
          </div>

          {vaultConnected === false && (
            <a
              href="https://contextforge.app/settings/vault"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 flex items-center gap-1.5 text-[9px] uppercase transition-colors hover:text-[#00FF88]"
              style={{ letterSpacing: '0.12em', color: '#1A3A1A' }}
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#1A3A1A]" />
              Sessions stored locally · Connect vault →
            </a>
          )}

          {vaultConnected === true && (
            <div className="mt-2 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#00FF88]" style={{ boxShadow: '0 0 6px #00FF88' }} />
              <span className="text-[9px] uppercase" style={{ letterSpacing: '0.12em', color: '#2A6A2A' }}>
                Vault syncing · <span style={{ color: '#6AFF6A' }}>{vaultName ?? 'Personal Vault'}</span>
              </span>
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

        <div className="flex-1 overflow-y-auto px-4 py-3">
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
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setSelected(session);
                    setShowFullTranscript(false);
                    setView("detail");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(session);
                      setShowFullTranscript(false);
                      setView("detail");
                    }
                  }}
                  className="stagger-item group relative block w-full cursor-pointer overflow-hidden rounded-[6px] border bg-[#0A0A0A] px-4 py-4 text-left transition-all duration-200 hover:shadow-[0_0_0_1px_rgba(0,255,136,0.5),0_4px_22px_rgba(0,255,136,0.12),0_0_50px_rgba(0,255,136,0.04)] hover:-translate-y-[2px] hover:bg-[#0D1A0D]"
                  style={{ borderColor: `${PLATFORM_COLORS[session.platform]}25`, boxShadow: `0 1px 0 ${PLATFORM_COLORS[session.platform]}10` }}
                >
                  <span
                    className="absolute inset-y-0 left-0 w-[3px] rounded-l-[6px]"
                    style={{ background: PLATFORM_COLORS[session.platform] }}
                  />
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
                        {migrationTiers[session.id] && (
                          <>
                            <span>·</span>
                            <span style={{
                              padding: "1px 6px",
                              borderRadius: "10px",
                              background: (migrationTiers[session.id] ?? 1) >= 2 ? "rgba(0,255,136,0.12)" : "rgba(255,255,255,0.06)",
                              border: `1px solid ${(migrationTiers[session.id] ?? 1) >= 2 ? "rgba(0,255,136,0.3)" : "#2A2A2A"}`,
                              color: (migrationTiers[session.id] ?? 1) >= 2 ? "#00FF88" : "#666",
                              fontSize: "8px",
                              letterSpacing: "0.06em",
                              fontWeight: 700,
                            }}>
                              {migrationTiers[session.id] === 1 ? "Full" : migrationTiers[session.id] === 2 ? "Smart" : "▸ AE"}
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
                        onSuccess={(fmt) =>
                          setStatusMessage({ tone: "success", text: `Exported as ${fmt.toUpperCase()} — check downloads.` })
                        }
                        onError={(text) => setStatusMessage({ tone: "error", text })}
                      />
                      <span className="text-[#3A3A3A] transition-colors group-hover:text-[#00FF88]">›</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-[#0D2A0D] px-4 py-3">
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
        </div>
      </div>
    </div>
  );
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
