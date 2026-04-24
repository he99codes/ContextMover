import { useEffect, useMemo, useState } from "react";
import { findTargetPlatformTab, focusTab } from "@/lib/platform-tabs";
import type { ContextSession, Platform } from "@/lib/types";

const PLATFORM_LABELS: Record<Platform, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok",
};

const PLATFORM_SHORT: Record<Platform, string> = {
  claude: "CL",
  chatgpt: "GPT",
  gemini: "GM",
  grok: "GK",
};

const PLATFORM_GLOWS: Record<Platform, string> = {
  claude: "from-green-500/30 via-green-400/10 to-transparent",
  chatgpt: "from-green-500/30 via-green-300/10 to-transparent",
  gemini: "from-green-600/30 via-green-300/10 to-transparent",
  grok: "from-green-500/25 via-green-300/10 to-transparent",
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
  const [statusMessage, setStatusMessage] = useState<{ tone: StatusTone; text: string } | null>(
    null
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void loadSessions();
    void checkBridge();

    const sessionInterval = window.setInterval(() => {
      void loadSessions();
    }, 5000);

    const clockInterval = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 30000);

    // Instant refresh: service worker broadcasts SESSIONS_UPDATED after every
    // capture so the list updates in real-time without waiting for the poll.
    const onMessage = (msg: { type: string }) => {
      if (msg.type === "SESSIONS_UPDATED") void loadSessions();
    };
    chrome.runtime.onMessage.addListener(onMessage);

    return () => {
      window.clearInterval(sessionInterval);
      window.clearInterval(clockInterval);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  async function loadSessions() {
    chrome.runtime.sendMessage({ type: "GET_SESSIONS" }, (res) => {
      setSessions(Array.isArray(res) ? res : []);
    });
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
        payload: { sessionId: selected.id, targetPlatform, targetTabId: tab.id },
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

  void tick;

  if (view === "detail" && selected) {
    const visibleMessages = showFullTranscript ? selected.messages : selected.messages.slice(-6);

    return (
      <div className="relative flex h-full flex-col overflow-hidden bg-[#0a0a0a] text-green-50">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(34,197,94,0.18),_transparent_30%),linear-gradient(180deg,_#0d120d_0%,_#080c08_54%,_#030703_100%)]" />
        <div className="relative flex h-full flex-col">
          <div className="border-b border-green-300/10 px-4 py-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setView("sessions")}
                className="rounded-full border border-green-400/20 bg-black/20 px-2.5 py-1 text-sm font-semibold text-green-100/80 transition hover:border-green-400/40 hover:bg-green-500/10"
              >
                Back
              </button>
              <span className="rounded-full border border-green-400/15 bg-green-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-green-300">
                Source: {PLATFORM_LABELS[selected.platform]}
              </span>
              <span className="truncate text-sm font-semibold text-white">{selected.title}</span>
            </div>
          </div>

          {statusMessage && (
            <div
              className={`mx-4 mt-3 rounded-[18px] border px-3 py-2 text-xs ${
                statusMessage.tone === "success"
                  ? "border-green-400/20 bg-green-500/10 text-green-50"
                  : statusMessage.tone === "error"
                  ? "border-red-300/20 bg-red-500/10 text-red-100"
                  : "border-green-300/10 bg-white/[0.04] text-green-100/80"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>{statusMessage.text}</div>
                <button
                  onClick={() => setStatusMessage(null)}
                  className="text-[10px] uppercase tracking-[0.18em] opacity-60"
                >
                  close
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 border-b border-green-300/10 px-4 py-3 text-center">
            <div className="rounded-2xl border border-green-300/10 bg-white/[0.03] px-2 py-2">
              <div className="text-[10px] uppercase tracking-[0.18em] text-green-300/45">Turns</div>
              <div className="mt-1 text-lg font-semibold text-white">{selected.messages.length}</div>
            </div>
            <div className="rounded-2xl border border-green-300/10 bg-white/[0.03] px-2 py-2">
              <div className="text-[10px] uppercase tracking-[0.18em] text-green-300/45">Created</div>
              <div className="mt-1 text-xs font-medium text-green-100/80">
                {new Date(selected.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div className="rounded-2xl border border-green-300/10 bg-green-500/10 px-2 py-2">
              <div className="text-[10px] uppercase tracking-[0.18em] text-green-300/45">Route</div>
              <div className="mt-1 text-xs font-medium text-white">
                {`${PLATFORM_LABELS[selected.platform]} -> ${PLATFORM_LABELS[targetPlatform]}`}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between px-4 pt-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-green-300/45">
              {showFullTranscript ? "Full transcript" : "Recent transcript"}
            </div>
            <button
              onClick={() => setShowFullTranscript((value) => !value)}
              className="rounded-full border border-green-400/15 bg-black/20 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-green-100/80"
            >
              {showFullTranscript ? "Show recent" : "Show all"}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {visibleMessages.map((msg, index) => (
              <div
                key={`${msg.role}-${index}-${msg.timestamp}`}
                className={`rounded-[22px] border px-3 py-3 text-xs shadow-[0_14px_34px_rgba(0,0,0,0.2)] ${
                  msg.role === "user"
                    ? "ml-6 border-green-400/18 bg-green-500/10 text-green-50"
                    : "mr-6 border-green-300/10 bg-white/[0.04] text-green-100/82"
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-green-300/55">
                    {msg.role === "user" ? "User prompt" : "Assistant reply"}
                  </div>
                  <div className="text-[10px] text-green-100/40">{formatRelativeTime(msg.timestamp)}</div>
                </div>
                <div className="whitespace-pre-wrap leading-6">{msg.content}</div>
              </div>
            ))}
          </div>

          <div className="border-t border-green-300/10 px-4 py-4 space-y-3 bg-black/20">
            <div>
              <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-green-300/45">
                Send This Context To
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(PLATFORM_LABELS) as Platform[]).map((platform) => (
                  <button
                    key={platform}
                    onClick={() => setTargetPlatform(platform)}
                    className={`relative overflow-hidden rounded-[18px] border px-3 py-3 text-left transition ${
                      targetPlatform === platform
                        ? "border-green-400/35 bg-green-500/10 text-white"
                        : "border-green-300/10 bg-white/[0.03] text-green-100/75 hover:border-green-400/20"
                    }`}
                  >
                    <div
                      className={`absolute inset-0 bg-gradient-to-br ${PLATFORM_GLOWS[platform]} opacity-90`}
                    />
                    <div className="relative flex items-center justify-between">
                      <span className="text-xs font-semibold">{PLATFORM_LABELS[platform]}</span>
                      <span className="text-[10px] uppercase tracking-[0.18em] text-green-100/55">
                        {PLATFORM_SHORT[platform]}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {ideContext && (
              <div className="rounded-2xl border border-green-400/15 bg-green-500/10 px-3 py-2 text-xs text-green-100/85">
                IDE context is attached and will travel with this session.
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={migrate}
                disabled={migrating}
                className="flex-1 rounded-full bg-green-500 py-2 text-xs font-semibold text-black transition hover:bg-green-400 disabled:opacity-50"
              >
                {migrating ? "Migrating..." : `Migrate To ${PLATFORM_LABELS[targetPlatform]}`}
              </button>
              <button
                onClick={() => deleteSession(selected.id)}
                className="rounded-full border border-green-400/15 bg-black/20 px-3 text-xs font-semibold text-green-100/75 transition hover:border-red-300/30 hover:bg-red-400/10 hover:text-red-100"
              >
                Delete
              </button>
            </div>

            {migrating && (
              <div className="overflow-hidden rounded-full bg-black/20">
                <div className="h-1.5 w-full animate-pulse bg-gradient-to-r from-green-500 via-green-400 to-green-500" />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#0a0a0a] text-green-50">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(34,197,94,0.18),_transparent_30%),radial-gradient(circle_at_75%_10%,_rgba(134,239,172,0.08),_transparent_18%),linear-gradient(180deg,_#0d120d_0%,_#080c08_54%,_#030703_100%)]" />
      <div className="relative flex h-full flex-col">
        <div className="border-b border-green-300/10 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-green-400/15 bg-green-500/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.26em] text-green-300">
                <span className="h-2 w-2 rounded-full bg-green-500 shadow-[0_0_16px_rgba(34,197,94,0.7)]" />
                ContextForge
              </div>
              <h1 className="mt-3 font-serif text-2xl leading-none text-white">Context stream</h1>
              <p className="mt-2 text-xs leading-5 text-green-100/60">
                {leadSession
                  ? `Top capture is from ${PLATFORM_LABELS[leadSession.platform]}.`
                  : "Open an AI tab to start capturing context."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { void loadSessions(); }}
                title="Refresh sessions"
                className="flex h-7 w-7 items-center justify-center rounded-full border border-green-500/30 bg-green-500/10 text-base text-green-400 transition hover:bg-green-500/20 hover:text-green-300 active:scale-95"
              >
                ↻
              </button>
              <button
                onClick={() => {
                  void checkBridge();
                  void loadSessions();
                }}
                className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
                  bridgeStatus === "ok"
                    ? "bg-green-500/15 text-green-300"
                    : "bg-white/10 text-green-100/70"
                }`}
              >
                {bridgeStatus === "ok" ? "IDE Linked" : "IDE Offline"}
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-4 gap-2">
            {sourceCounts.map(({ platform, count }) => (
              <div
                key={platform}
                className="rounded-2xl border border-green-300/10 bg-white/[0.03] px-2 py-2 text-center"
              >
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-green-300/50">
                  {PLATFORM_SHORT[platform]}
                </div>
                <div className="mt-1 text-base font-semibold text-white">{count}</div>
              </div>
            ))}
          </div>
        </div>

        {statusMessage && (
          <div
            className={`mx-3 mt-3 rounded-[18px] border px-3 py-2 text-xs ${
              statusMessage.tone === "success"
                ? "border-green-400/20 bg-green-500/10 text-green-50"
                : statusMessage.tone === "error"
                ? "border-red-300/20 bg-red-500/10 text-red-100"
                : "border-green-300/10 bg-white/[0.04] text-green-100/80"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>{statusMessage.text}</div>
              <button
                onClick={() => setStatusMessage(null)}
                className="text-[10px] uppercase tracking-[0.18em] opacity-60"
              >
                close
              </button>
            </div>
          </div>
        )}

        <div className="px-3 pt-3">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search context by title, agent, or recent content"
            className="w-full rounded-2xl border border-green-300/10 bg-white/[0.03] px-3 py-2 text-sm text-green-50 outline-none placeholder:text-green-100/30 focus:border-green-400/30"
          />
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-green-300/10 px-3 py-2">
          {(["all", "claude", "chatgpt", "gemini", "grok"] as const).map((item) => (
            <button
              key={item}
              onClick={() => setFilter(item)}
              className={`whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-semibold transition ${
                filter === item
                  ? "bg-green-500 text-black"
                  : "bg-white/[0.04] text-green-100/70 hover:bg-white/[0.07]"
              }`}
            >
              {item === "all" ? "All sources" : PLATFORM_LABELS[item]}
              <span className="ml-1 opacity-70">
                {item === "all"
                  ? sessions.length
                  : sessions.filter((session) => session.platform === item).length}
              </span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {filtered.length === 0 ? (
            <div className="rounded-[28px] border border-dashed border-green-400/20 bg-white/[0.03] px-4 py-10 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-green-400/15 bg-green-500/10 text-lg text-green-400">
                C
              </div>
              <p className="text-sm font-medium text-white">
                {sessions.length === 0 ? "No captured sessions in this stream." : "No results for this filter."}
              </p>
              <p className="mt-2 text-xs leading-5 text-green-100/55">
                {sessions.length === 0
                  ? "Visit ChatGPT, Claude, Gemini, or Grok to build a migration-ready archive."
                  : "Try a different search or switch the active platform filter."}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((session) => (
                <button
                  key={session.id}
                  onClick={() => {
                    setSelected(session);
                    setShowFullTranscript(false);
                    setView("detail");
                  }}
                  className="group relative block w-full overflow-hidden rounded-[24px] border border-green-300/10 bg-white/[0.035] px-4 py-3 text-left transition hover:border-green-400/25 hover:bg-white/[0.05]"
                >
                  <div
                    className={`absolute inset-0 bg-gradient-to-br ${PLATFORM_GLOWS[session.platform]} opacity-75`}
                  />
                  <div className="relative flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-green-400/15 bg-black/20 text-[11px] font-semibold uppercase tracking-[0.18em] text-green-100">
                      {PLATFORM_SHORT[session.platform]}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded-full border border-green-400/15 bg-black/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-green-300">
                          from {PLATFORM_LABELS[session.platform]}
                        </span>
                        <span className="text-[10px] text-green-100/45">
                          {formatRelativeTime(session.updatedAt)}
                        </span>
                      </div>
                      <p className="mt-2 truncate text-sm font-semibold text-white">{session.title}</p>
                      <p className="mt-1 text-[11px] text-green-100/60">
                        {session.messages.length} turns ready to migrate
                      </p>
                    </div>
                    <span className="pt-1 text-green-100/35 transition group-hover:text-green-100/70">
                      &gt;
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-green-300/10 px-4 py-2 text-center">
          <span className="text-[10px] text-green-100/35">local-first context routing engine</span>
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
