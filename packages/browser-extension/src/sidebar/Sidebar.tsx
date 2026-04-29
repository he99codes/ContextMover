import React, { useEffect, useMemo, useRef, useState } from "react";
import { findTargetPlatformTab, focusTab } from "@/lib/platform-tabs";
import type { ContextSession, Platform } from "@/lib/types";
import ExportMenu from "@/components/ExportMenu";
import { PlatformBadge, PlatformLogo } from "@/components/PlatformLogo";
import AttentionModal from "./AttentionModal";
import { attentionEngine } from "@/lib/attention-engine";

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
  const [migrating, setMigrating] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<"ok" | "offline">("offline");
  const [ideContext, setIdeContext] = useState<string | null>(null);
  const [filter, setFilter] = useState<Platform | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(new Set());
  const [caveman, setCaveman] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ tone: StatusTone; text: string } | null>(
    null
  );
  const [tick, setTick] = useState(0);
  const [showAttentionModal, setShowAttentionModal] = useState(false);
  const [semanticQuery, setSemanticQuery] = useState("");
  const [semanticResults, setSemanticResults] = useState<{ sessionId: string; score: number }[]>([]);
  const loadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const semanticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadSessions();
    void checkBridge();

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

  async function migrate() {
    if (!selected) return;

    setMigrating(true);
    setStatusMessage({
      tone: "info",
      text: `Routing this ${PLATFORM_LABELS[selected.platform]} context into ${PLATFORM_LABELS[targetPlatform]}...`,
    });

    const tab = await findTargetPlatformTab(targetPlatform);

    if (!tab?.id) {
      setMigrating(false);
      setStatusMessage({
        tone: "error",
        text: `Open a ${PLATFORM_LABELS[targetPlatform]} tab, then try again.`,
      });
      return;
    }

    await focusTab(tab.id);
    // Give the OS/browser a moment to bring the target tab to front before
    // the service worker attempts to send a message to its content script.
    await new Promise((resolve) => setTimeout(resolve, 300));

    chrome.runtime.sendMessage(
      {
        type: "MIGRATE_CONTEXT",
        payload: { sessionId: selected.id, targetPlatform, targetTabId: tab.id, caveman },
      },
      (response) => {
        setMigrating(false);

        if (response?.error) {
          setStatusMessage({ tone: "error", text: response.error });
          return;
        }

        setStatusMessage({
          tone: "success",
          text: `Context from ${PLATFORM_LABELS[selected.platform]} is now staged in ${PLATFORM_LABELS[targetPlatform]}.`,
        });
      }
    );
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
      <div className="flex h-full flex-col overflow-hidden bg-[#0A0A0A] text-[#F5F5F5] animate-slide-up">
        <div className="flex h-full flex-col">
          {/* ── Detail Header ── */}
          <div className="border-b border-[#2A2A2A] px-3 py-2.5" style={{ background: `linear-gradient(135deg, ${platformColor}08 0%, #0A0A0A 60%)` }}>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setView("sessions"); setExpandedMessages(new Set()); }}
                className="flex shrink-0 items-center gap-1 rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-2 py-1 text-[10px] font-medium text-[#6B6B6B] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88]"
              >
                ← Back
              </button>
              <PlatformBadge platform={selected.platform} logoSize={11} />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[#F5F5F5]" title={selected.title}>{selected.title}</span>
            </div>
          </div>

          {statusMessage && (
            <div
              className={`mx-3 mt-3 rounded-[8px] border px-3 py-2 text-xs ${
                statusMessage.tone === "success"
                  ? "border-[#00FF88]/20 bg-[#00FF88]/10 text-[#00FF88]"
                  : statusMessage.tone === "error"
                  ? "border-red-500/20 bg-red-500/10 text-red-400"
                  : "border-[#2A2A2A] bg-[#1A1A1A] text-[#6B6B6B]"
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
          <div className="grid grid-cols-3 divide-x divide-[#2A2A2A] border-b border-[#2A2A2A] text-center">
            <div className="px-2 py-2.5">
              <div className="text-[9px] uppercase tracking-widest text-[#6B6B6B]">Turns</div>
              <div className="mt-0.5 text-xl font-bold tabular-nums" style={{ color: platformColor }}>{selected.messages.length}</div>
            </div>
            <div className="px-2 py-2.5">
              <div className="text-[9px] uppercase tracking-widest text-[#6B6B6B]">Created</div>
              <div className="mt-0.5 text-[11px] font-medium text-[#F5F5F5]">
                {new Date(selected.createdAt).toLocaleDateString("en", { month: "short", day: "numeric" })}
              </div>
            </div>
            <div className="px-2 py-2.5" style={{ background: `${platformColor}08` }}>
              <div className="text-[9px] uppercase tracking-widest text-[#6B6B6B]">Route</div>
              <div className="mt-0.5 text-[11px] font-semibold text-[#00FF88]">
                {PLATFORM_SHORT[selected.platform]} → {PLATFORM_SHORT[targetPlatform]}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between px-3 pt-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-[#6B6B6B]">
              {showFullTranscript ? "Full transcript" : "Recent transcript"}
            </div>
            <button
              onClick={() => setShowFullTranscript((value) => !value)}
              className="rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-2 py-1 text-[10px] font-medium text-[#6B6B6B] hover:border-[#00FF88]/20 hover:text-[#00FF88] transition-colors"
            >
              {showFullTranscript ? "Show recent" : "Show all"}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
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
                      ? "ml-3 bg-[#161616]"
                      : "mr-3 bg-[#0D1A12]"
                  }`}
                  style={{ borderColor: isUser ? `${platformColor}28` : "rgba(0,255,136,0.12)" }}
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

          <div className="border-t border-[#2A2A2A] px-3 py-3 space-y-3">
            <div>
              <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-[#6B6B6B]">
                Route to
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(Object.keys(PLATFORM_LABELS) as Platform[]).map((platform) => {
                  const isTarget = targetPlatform === platform;
                  const pc = PLATFORM_COLORS[platform];
                  return (
                    <button
                      key={platform}
                      onClick={() => setTargetPlatform(platform)}
                      className="flex flex-col items-center gap-1 rounded-[4px] border p-2 transition-all duration-150 hover:scale-[1.03]"
                      style={isTarget ? {
                        borderColor: `${pc}50`,
                        background: `${pc}12`,
                        boxShadow: `0 0 10px ${pc}18`,
                      } : {
                        borderColor: "#2A2A2A",
                        background: "#111111",
                      }}
                    >
                      <PlatformLogo platform={platform} size={16} />
                      <div className="text-[9px] font-medium leading-tight" style={{ color: isTarget ? pc : "#6B6B6B" }}>{PLATFORM_SHORT[platform]}</div>
                      {isTarget && <div className="h-0.5 w-3 rounded-full" style={{ background: pc }} />}
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

            <button
              onClick={() => setCaveman((v) => !v)}
              className="flex w-full items-center justify-between rounded-[4px] border px-3 py-2 text-xs transition-all"
              style={caveman ? {
                borderColor: "#F59E0B40",
                background: "#F59E0B12",
                color: "#F59E0B",
              } : {
                borderColor: "#2A2A2A",
                background: "#1A1A1A",
                color: "#6B6B6B",
              }}
            >
              <span className="font-semibold uppercase tracking-[0.15em] text-[10px]">
                Caveman Mode 🪨
              </span>
              <span
                className="rounded-[3px] px-1.5 py-0.5 text-[9px] font-bold uppercase"
                style={caveman ? { background: "#F59E0B30", color: "#F59E0B" } : { background: "#1F1F1F", color: "#3A3A3A" }}
              >
                {caveman ? "ON" : "OFF"}
              </span>
            </button>

            <div className="flex gap-2">
              <button
                onClick={migrate}
                disabled={migrating}
                className="relative flex flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-[4px] py-2 text-xs font-bold text-black transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
                style={{ background: migrating ? "#00CC6A" : "#00FF88", boxShadow: migrating ? "none" : "0 0 18px rgba(0,255,136,0.25)" }}
              >
                {migrating && <span className="animate-spin text-[10px]">↻</span>}
                {migrating ? "Migrating…" : `Migrate → ${PLATFORM_SHORT[targetPlatform]}`}
                {migrating && (
                  <span className="absolute inset-0 animate-shimmer opacity-30" />
                )}
              </button>
              <button
                onClick={() => setShowAttentionModal(true)}
                disabled={migrating}
                title="Migrate with Attention Engine"
                className="rounded-[4px] border border-[#6366f1]/40 bg-[#6366f1]/10 px-2.5 py-2 text-xs font-semibold text-[#6366f1] transition-all hover:bg-[#6366f1]/20 hover:border-[#6366f1]/60 disabled:opacity-50"
              >
                ⚡
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

            {migrating && (
              <div className="overflow-hidden rounded-full bg-[#1A1A1A]">
                <div className="h-1 w-full animate-pulse bg-[#00FF88]" />
              </div>
            )}
          </div>
        </div>
        {showAttentionModal && selected && (
          <AttentionModal
            session={selected}
            targetPlatform={targetPlatform}
            onClose={() => setShowAttentionModal(false)}
            onSuccess={(ratio) => {
              setShowAttentionModal(false);
              setStatusMessage({ tone: "success", text: `Migrated with Attention Engine (${ratio}% compressed).` });
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0A0A0A] text-[#F5F5F5]">
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="border-b border-[#2A2A2A] px-3 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="relative flex h-6 w-6 items-center justify-center rounded-[4px] bg-[#00FF88]">
                <span className="text-[10px] font-bold text-black">CF</span>
                <span className="animate-pulse-green absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[#00FF88]" />
              </div>
              <span className="text-xs font-semibold text-[#F5F5F5] tracking-tight">ContextForge</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => { void loadSessions(); }}
                title="Refresh sessions"
                className="flex h-6 w-6 items-center justify-center rounded-[4px] border border-[#2A2A2A] text-[#6B6B6B] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88]"
              >
                <span className="text-sm">↻</span>
              </button>
              <button
                onClick={() => { void checkBridge(); void loadSessions(); }}
                className={`flex items-center gap-1 rounded-[4px] border px-2 py-1 text-[10px] font-medium transition-all ${
                  bridgeStatus === "ok"
                    ? "border-[#00FF88]/20 bg-[#00FF88]/8 text-[#00FF88]"
                    : "border-[#2A2A2A] bg-[#1A1A1A] text-[#6B6B6B]"
                }`}
              >
                <span
                  className={bridgeStatus === "ok" ? "animate-pulse-green inline-block h-1.5 w-1.5 rounded-full bg-[#00FF88]" : "inline-block h-1.5 w-1.5 rounded-full bg-[#3A3A3A]"}
                />
                IDE
              </button>
            </div>
          </div>

          {leadSession ? (
            <div className="mt-2 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#00FF88] animate-pulse-green" />
              <span className="text-[10px] text-[#6B6B6B]">
                Last active: <span className="text-[#F5F5F5] font-medium">{PLATFORM_LABELS[leadSession.platform]}</span>
                {" · "}{formatRelativeTime(leadSession.updatedAt)}
              </span>
            </div>
          ) : (
            <p className="mt-2 text-[10px] text-[#6B6B6B]">Open Claude, ChatGPT or Gemini to start capturing.</p>
          )}

          <div className="mt-2.5 grid grid-cols-6 gap-1">
            {sourceCounts.map(({ platform, count }) => (
              <button
                key={platform}
                onClick={() => setFilter(platform)}
                className="flex flex-col items-center gap-0.5 rounded-[4px] border py-1.5 transition-all hover:scale-[1.04]"
                style={{
                  borderColor: count > 0 ? `${PLATFORM_COLORS[platform]}35` : "#1F1F1F",
                  background: count > 0 ? `${PLATFORM_COLORS[platform]}0C` : "#111111",
                }}
                title={PLATFORM_LABELS[platform]}
              >
                <PlatformLogo platform={platform} size={13} className="mx-auto" />
                <div className="text-[10px] font-bold tabular-nums" style={{ color: count > 0 ? PLATFORM_COLORS[platform] : "#3A3A3A" }}>{count}</div>
              </button>
            ))}
          </div>
        </div>

        {statusMessage && (
          <div
            className={`mx-3 mt-2 rounded-[8px] border px-3 py-2 text-xs ${
              statusMessage.tone === "success"
                ? "border-[#00FF88]/20 bg-[#00FF88]/10 text-[#00FF88]"
                : statusMessage.tone === "error"
                ? "border-red-500/20 bg-red-500/10 text-red-400"
                : "border-[#2A2A2A] bg-[#1A1A1A] text-[#6B6B6B]"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>{statusMessage.text}</div>
              <button onClick={() => setStatusMessage(null)} className="opacity-60 hover:opacity-100">×</button>
            </div>
          </div>
        )}

        <div className="px-3 pt-2 space-y-1.5">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search sessions…"
            className="w-full rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-3 py-1.5 text-xs text-[#F5F5F5] outline-none placeholder:text-[#6B6B6B] focus:border-[#00FF88]"
          />
          <input
            value={semanticQuery}
            onChange={(e) => setSemanticQuery(e.target.value)}
            placeholder="Search by meaning (semantic)…"
            className="w-full rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-3 py-1.5 text-xs text-[#F5F5F5] outline-none placeholder:text-[#6B6B6B] focus:border-[#6366f1]"
          />
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-[#2A2A2A] px-3 py-2 scrollbar-none">
          {(["all", "claude", "chatgpt", "gemini", "grok", "perplexity", "deepseek"] as const).map((item) => {
            const isActive = filter === item;
            const pColor = item !== "all" ? PLATFORM_COLORS[item] : null;
            const count = item === "all" ? sessions.length : sessions.filter((s) => s.platform === item).length;
            return (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className="whitespace-nowrap rounded-[4px] px-2.5 py-1 text-[10px] font-medium transition-all duration-150 border"
                style={isActive
                  ? pColor
                    ? { background: `${pColor}18`, borderColor: `${pColor}40`, color: pColor, boxShadow: `0 0 6px ${pColor}20` }
                    : { background: "rgba(0,255,136,0.1)", borderColor: "rgba(0,255,136,0.25)", color: "#00FF88" }
                  : { background: "#1A1A1A", borderColor: "#2A2A2A", color: "#6B6B6B" }
                }
              >
                {item === "all" ? "All" : PLATFORM_SHORT[item]}
                <span className="ml-1 opacity-55">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {semanticSessions.length > 0 && (
            <div className="mb-2 space-y-1">
              <div className="pb-1 text-[9px] uppercase tracking-widest text-[#6366f1]">Semantic matches</div>
              {semanticSessions.map(({ session: s, score }) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setSelected(s); setShowFullTranscript(false); setView("detail"); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(s); setShowFullTranscript(false); setView("detail"); } }}
                  className="group relative block w-full cursor-pointer overflow-hidden rounded-[6px] border bg-[#1A1A1A] px-3 py-2.5 text-left transition-all duration-150 hover:shadow-[0_0_0_1px_#6366f1,0_4px_16px_rgba(99,102,241,0.08)] hover:-translate-y-px"
                  style={{ borderColor: `${PLATFORM_COLORS[s.platform]}30` }}
                >
                  <span className="absolute inset-y-0 left-0 w-[3px] rounded-l-[6px]" style={{ background: PLATFORM_COLORS[s.platform] }} />
                  <div className="flex items-start gap-2.5 pl-1">
                    <div className="min-w-0 flex-1">
                      <PlatformBadge platform={s.platform} logoSize={9} />
                      <p className="mt-1.5 truncate text-xs font-medium text-[#F5F5F5] transition-colors duration-150 group-hover:text-[#6366f1]">{s.title}</p>
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
            <div className="space-y-1.5">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className="overflow-hidden rounded-[6px] border border-[#2A2A2A] bg-[#1A1A1A] px-3 py-2.5"
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
            <div className="rounded-[6px] border border-dashed border-[#2A2A2A] px-4 py-10 text-center animate-fade-in">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-[6px] border border-[#00FF88]/20 bg-[#00FF88]/8">
                <span className="text-lg">⚡</span>
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
            <div className="space-y-1.5">
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
                  className="stagger-item group relative block w-full cursor-pointer overflow-hidden rounded-[6px] border bg-[#1A1A1A] px-3 py-2.5 text-left transition-all duration-150 hover:shadow-[0_0_0_1px_#00FF88,0_4px_16px_rgba(0,255,136,0.08)] hover:-translate-y-px"
                  style={{ borderColor: `${PLATFORM_COLORS[session.platform]}30` }}
                >
                  <span
                    className="absolute inset-y-0 left-0 w-[3px] rounded-l-[6px]"
                    style={{ background: PLATFORM_COLORS[session.platform] }}
                  />
                  <div className="flex items-start gap-2.5 pl-1">
                    <div className="min-w-0 flex-1">
                      <PlatformBadge platform={session.platform} logoSize={9} />
                      <p className="mt-1.5 truncate text-xs font-medium text-[#F5F5F5] transition-colors duration-150 group-hover:text-[#00FF88]">
                        {session.title}
                      </p>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[#6B6B6B]">
                        <span>{session.messages.length} turns</span>
                        <span>·</span>
                        <span>{formatRelativeTime(session.updatedAt)}</span>
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

        <div className="border-t border-[#2A2A2A] px-4 py-2 text-center">
          <span className="text-[9px] text-[#3A3A3A] uppercase tracking-widest">context routing engine</span>
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
