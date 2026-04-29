import { useEffect, useMemo, useRef, useState } from "react";
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
  const [selected, setSelected] = useState<ContextSession | null>(null);
  const [view, setView] = useState<View>("sessions");
  const [targetPlatform, setTargetPlatform] = useState<Platform>("claude");
  const [migrating, setMigrating] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<"ok" | "offline">("offline");
  const [ideContext, setIdeContext] = useState<string | null>(null);
  const [filter, setFilter] = useState<Platform | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showFullTranscript, setShowFullTranscript] = useState(false);
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

  // ── Background engine warm-up ────────────────────────────────────────────
  // Start model initialization 2 s after the sidebar loads (UI settles first).
  // By the time the user opens AttentionModal the model is already in memory.
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (!attentionEngine.initialized) {
        attentionEngine.initialize().catch(() => { /* silent */ });
      }
    }, 2_000);
    return () => window.clearTimeout(id);
  }, []);

  // ── Background session pre-indexing ──────────────────────────────────────
  // Index the selected session 1 s after it is chosen so the AttentionModal
  // live-preview triggers instantly (indexSession is idempotent).
  useEffect(() => {
    if (!selected) return;
    const id = window.setTimeout(async () => {
      try {
        if (!attentionEngine.initialized) await attentionEngine.initialize();
        await attentionEngine.indexSession(selected);
      } catch { /* silent */ }
    }, 1_000);
    return () => window.clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

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
  const leadSession = filtered[0] ?? sessions[0] ?? null;

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
          <div className="border-b border-[#2A2A2A] px-3 py-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setView("sessions")}
                className="flex items-center gap-1 rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-2 py-1 text-[11px] font-medium text-[#6B6B6B] transition-all hover:border-[#00FF88]/30 hover:text-[#00FF88]"
              >
                ← Back
              </button>
              <PlatformBadge platform={selected.platform} logoSize={10} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#F5F5F5]">{selected.title}</span>
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

          <div className="grid grid-cols-3 gap-2 border-b border-[#2A2A2A] px-3 py-3 text-center">
            <div className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] px-2 py-2">
              <div className="text-[10px] uppercase tracking-[0.18em] text-[#6B6B6B]">Turns</div>
              <div className="mt-1 text-lg font-semibold text-[#F5F5F5]">{selected.messages.length}</div>
            </div>
            <div className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] px-2 py-2">
              <div className="text-[10px] uppercase tracking-[0.18em] text-[#6B6B6B]">Created</div>
              <div className="mt-1 text-xs font-medium text-[#F5F5F5]/80">
                {new Date(selected.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div className="rounded-[8px] border border-[#00FF88]/20 bg-[#00FF88]/5 px-2 py-2">
              <div className="text-[10px] uppercase tracking-[0.18em] text-[#6B6B6B]">Route</div>
              <div className="mt-1 text-xs font-medium text-[#F5F5F5]">
                {`${PLATFORM_SHORT[selected.platform]} → ${PLATFORM_SHORT[targetPlatform]}`}
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

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
            {visibleMessages.map((msg, index) => (
              <div
                key={`${msg.role}-${index}-${msg.timestamp}`}
                className={`rounded-[8px] border px-3 py-2.5 text-xs overflow-hidden relative ${
                  msg.role === "user"
                    ? "ml-4 bg-[#1A1A1A] text-[#F5F5F5]"
                    : "mr-4 border-[#00FF88]/10 bg-[#00FF88]/5 text-[#F5F5F5]/90"
                }`}
                style={msg.role === "user" ? { borderColor: `${platformColor}30` } : {}}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${
                    msg.role === "user" ? "text-[#6B6B6B]" : "text-[#00FF88]"
                  }`}>
                    {msg.role === "user" ? "You" : "Assistant"}
                  </div>
                  <div className="text-[10px] text-[#6B6B6B]">{formatRelativeTime(msg.timestamp)}</div>
                </div>
                <div className="whitespace-pre-wrap leading-5">{msg.content}</div>
              </div>
            ))}
          </div>

          <div className="border-t border-[#2A2A2A] px-3 py-3 space-y-3">
            <div>
              <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-[#6B6B6B]">
                Route to
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {(Object.keys(PLATFORM_LABELS) as Platform[]).map((platform) => (
                  <button
                    key={platform}
                    onClick={() => setTargetPlatform(platform)}
                    className="rounded-[4px] border px-2.5 py-2 text-left transition-all"
                    style={targetPlatform === platform ? {
                      borderColor: `${PLATFORM_COLORS[platform]}40`,
                      background: `${PLATFORM_COLORS[platform]}15`,
                      color: PLATFORM_COLORS[platform],
                    } : {
                      borderColor: "#2A2A2A",
                      background: "#1A1A1A",
                      color: "#6B6B6B",
                    }}
                  >
                    <div className="text-xs font-semibold">{PLATFORM_LABELS[platform]}</div>
                    <div className="text-[9px] uppercase tracking-wider opacity-60 mt-0.5">{PLATFORM_SHORT[platform]}</div>
                  </button>
                ))}
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
                Caveman mode
              </span>
              <span className="text-[10px] opacity-70">
                {caveman ? "ON — compress + blunt" : "OFF"}
              </span>
            </button>

            <div className="flex gap-2">
              <button
                onClick={migrate}
                disabled={migrating}
                className="flex-1 rounded-[4px] bg-[#00FF88] py-2 text-xs font-semibold text-black transition-all hover:bg-[#00CC6A] hover:shadow-[0_0_14px_rgba(0,255,136,0.3)] hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
              >
                {migrating ? "Migrating..." : `→ ${PLATFORM_LABELS[targetPlatform]}`}
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

          <p className="mt-2 text-[11px] text-[#6B6B6B]">
            {leadSession
              ? `Latest: ${PLATFORM_LABELS[leadSession.platform]}`
              : "Open an AI tab to start capturing."}
          </p>

          <div className="mt-2.5 grid grid-cols-3 gap-1">
            {sourceCounts.map(({ platform, count }) => (
              <div
                key={platform}
                className="rounded-[4px] border px-1 py-1.5 text-center transition-all"
                style={{
                  borderColor: count > 0 ? `${PLATFORM_COLORS[platform]}30` : "#1F1F1F",
                  background: count > 0 ? `${PLATFORM_COLORS[platform]}0A` : "#111111",
                }}
              >
                <PlatformLogo platform={platform} size={10} className="mx-auto" />
                <div className="mt-0.5 text-[11px] font-bold" style={{ color: count > 0 ? "#F5F5F5" : "#3A3A3A" }}>{count}</div>
              </div>
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
                {item === "all" ? "All" : PLATFORM_LABELS[item]}
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
          {filtered.length === 0 ? (
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
