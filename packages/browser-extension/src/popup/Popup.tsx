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

const PLATFORM_TONES: Record<Platform, string> = {
  claude: "from-orange-500/30 via-amber-400/10 to-transparent",
  chatgpt: "from-orange-400/30 via-orange-300/10 to-transparent",
  gemini: "from-orange-600/30 via-amber-300/10 to-transparent",
  grok: "from-orange-500/25 via-yellow-300/10 to-transparent",
};

type StatusTone = "info" | "success" | "error";

type BridgeState =
  | { state: "checking" }
  | { state: "offline" }
  | {
    state: "ok";
    workspaceName: string | null;
    openFilesCount: number;
    workspaceFilesCount: number;
    diagnosticsCount: number;
  };

export default function Popup() {
  const [sessions, setSessions] = useState<ContextSession[]>([]);
  const [migrating, setMigrating] = useState<string | null>(null);
  const [targetPlatform, setTargetPlatform] = useState<Platform>("claude");
  const [bridgeStatus, setBridgeStatus] = useState<BridgeState>({ state: "checking" });
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ tone: StatusTone; text: string } | null>(
    null
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void initializePopup();

    const loadInterval = window.setInterval(() => {
      void loadSessions();
    }, 4000);

    const clockInterval = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 30000);

    return () => {
      window.clearInterval(loadInterval);
      window.clearInterval(clockInterval);
    };
  }, []);

  async function initializePopup() {
    chrome.runtime.sendMessage({ type: "SYNC_OPEN_TABS" }, () => {
      void loadSessions();
    });
    await checkBridge();
  }

  async function loadSessions() {
    chrome.runtime.sendMessage({ type: "GET_SESSIONS" }, (res) => {
      setSessions(Array.isArray(res) ? res : []);
    });
  }

  async function checkBridge() {
    try {
      const response = await fetch("http://localhost:49152/health");
      if (!response.ok) {
        throw new Error("Bridge health check failed");
      }

      const health = await response.json();
      setBridgeStatus({
        state: "ok",
        workspaceName: health.workspaceName ?? null,
        openFilesCount: Number(health.openFilesCount ?? 0),
        workspaceFilesCount: Number(health.workspaceFilesCount ?? 0),
        diagnosticsCount: Number(health.diagnosticsCount ?? 0),
      });
    } catch {
      setBridgeStatus({ state: "offline" });
    }
  }

  async function migrateSession(sessionId: string) {
    setMigrating(sessionId);
    setStatusMessage({
      tone: "info",
      text: `Preparing migration into ${PLATFORM_LABELS[targetPlatform]}...`,
    });

    const tab = await findTargetPlatformTab(targetPlatform);

    if (!tab?.id) {
      setMigrating(null);
      setStatusMessage({
        tone: "error",
        text: `Open a ${PLATFORM_LABELS[targetPlatform]} tab, then try again.`,
      });
      return;
    }

    await focusTab(tab.id);

    chrome.runtime.sendMessage(
      {
        type: "MIGRATE_CONTEXT",
        payload: {
          sessionId,
          targetPlatform,
          targetTabId: tab.id,
        },
      },
      (response) => {
        setMigrating(null);

        if (response?.error) {
          setStatusMessage({ tone: "error", text: response.error });
          return;
        }

        const sourcePlatform =
          sessions.find((session) => session.id === sessionId)?.platform ?? "chatgpt";
        setStatusMessage({
          tone: "success",
          text: `Context from ${PLATFORM_LABELS[sourcePlatform]} is now staged inside ${PLATFORM_LABELS[targetPlatform]}.`,
        });
      }
    );
  }

  async function deleteSession(sessionId: string) {
    await chrome.runtime.sendMessage({ type: "DELETE_SESSION", sessionId });
    setSessions((prev) => prev.filter((session) => session.id !== sessionId));
    setStatusMessage({ tone: "info", text: "Session removed from the local archive." });
  }

  function openSidebar() {
    // Use type assertion for sidePanel API (types may be outdated)
    const sidePanel = chrome.sidePanel as unknown as {
      setPath?: (options: { path: string }) => Promise<void>;
      open: (options: { windowId?: number }) => Promise<void>;
    };

    if (sidePanel.setPath && sidePanel.open) {
      sidePanel.setPath({ path: "src/sidebar/index.html" }).then(() => {
        sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      }).catch(() => {
        // Fallback: open extension page in new tab
        chrome.tabs.create({ url: "src/sidebar/index.html" });
      });
    } else {
      // Fallback for older Chrome versions
      chrome.tabs.create({ url: "src/sidebar/index.html" });
    }
  }

  const totalMessages = sessions.reduce(
    (count, session) => count + session.messages.length,
    0
  );

  const sourceBreakdown = useMemo(
    () =>
      (Object.keys(PLATFORM_LABELS) as Platform[]).map((platform) => ({
        platform,
        count: sessions.filter((session) => session.platform === platform).length,
      })),
    [sessions]
  );

  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    if (!query) {
      return sessions;
    }

    return sessions.filter((session) => {
      const haystack = [
        session.title,
        PLATFORM_LABELS[session.platform],
        ...session.messages.slice(-4).map((message) => message.content),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [searchQuery, sessions]);

  const leadSession = sessions[0];
  const sourceHeadline = leadSession
    ? `Latest context from ${PLATFORM_LABELS[leadSession.platform]}`
    : "Waiting for context capture";
  const bridgeSummary =
    bridgeStatus.state === "ok"
      ? bridgeStatus.workspaceName
        ? `VS Code connected to ${bridgeStatus.workspaceName}`
        : "VS Code connected"
      : bridgeStatus.state === "offline"
        ? "VS Code connection offline"
        : "Checking VS Code bridge";

  void tick;

  return (
    <div className="relative w-[390px] overflow-hidden bg-[#090603] text-orange-50">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(251,146,60,0.30),_transparent_34%),radial-gradient(circle_at_80%_18%,_rgba(255,196,112,0.16),_transparent_22%),linear-gradient(180deg,_#17100b_0%,_#0d0906_46%,_#050302_100%)]" />
      <div className="absolute inset-x-6 top-20 h-28 rounded-full bg-orange-500/10 blur-3xl" />

      <div className="relative flex min-h-[680px] flex-col">
        <header className="border-b border-orange-200/10 px-5 pb-5 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-300/15 bg-orange-400/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-orange-200">
                <span className="h-2 w-2 rounded-full bg-orange-400 shadow-[0_0_16px_rgba(251,146,60,0.8)]" />
                ContextForge
              </div>
              <h1 className="max-w-[250px] font-serif text-[30px] leading-none text-white">
                Migration deck
              </h1>
              <p className="mt-3 max-w-[280px] text-sm leading-6 text-orange-100/70">
                {sourceHeadline}. Route it into your next agent without losing the thread.
              </p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={openSidebar}
                className="rounded-full border border-orange-300/20 bg-orange-500/20 px-3 py-1.5 text-[11px] font-semibold text-orange-100 transition hover:border-orange-300/40 hover:bg-orange-500/30"
              >
                Sidebar
              </button>
              <button
                onClick={() => {
                  void loadSessions();
                  void checkBridge();
                }}
                className="rounded-full border border-orange-300/20 bg-black/20 px-3 py-1.5 text-[11px] font-semibold text-orange-100 transition hover:border-orange-300/40 hover:bg-orange-400/10"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-[24px] border border-orange-200/10 bg-white/[0.03] px-4 py-4 shadow-[0_16px_40px_rgba(0,0,0,0.25)]">
              <div className="text-[10px] uppercase tracking-[0.26em] text-orange-200/50">
                Sessions
              </div>
              <div className="mt-2 text-3xl font-semibold text-white">{sessions.length}</div>
              <div className="mt-1 text-xs text-orange-100/55">context capsules captured</div>
            </div>
            <div className="rounded-[24px] border border-orange-200/10 bg-orange-500/10 px-4 py-4 shadow-[0_16px_40px_rgba(0,0,0,0.25)]">
              <div className="text-[10px] uppercase tracking-[0.26em] text-orange-200/60">
                Messages
              </div>
              <div className="mt-2 text-3xl font-semibold text-white">{totalMessages}</div>
              <div className="mt-1 text-xs text-orange-100/55">
                total turns available to migrate
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-[26px] border border-orange-200/10 bg-black/25 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.24em] text-orange-200/50">
                  VS Code Link
                </div>
                <div className="mt-1 text-sm font-medium text-white">
                  {bridgeSummary}
                </div>
                {bridgeStatus.state === "ok" && (
                  <div className="mt-2 text-xs text-orange-100/60">
                    {bridgeStatus.workspaceFilesCount} workspace files indexed •{" "}
                    {bridgeStatus.openFilesCount} open tabs •{" "}
                    {bridgeStatus.diagnosticsCount} diagnostics
                  </div>
                )}
              </div>
              <span
                className={`rounded-full px-3 py-1 text-[11px] font-semibold ${bridgeStatus.state === "ok"
                  ? "bg-orange-400/15 text-orange-200"
                  : "bg-white/10 text-orange-100/70"
                  }`}
              >
                {bridgeStatus.state === "ok"
                  ? "VS Connected"
                  : bridgeStatus.state === "offline"
                    ? "VS Offline"
                    : "Checking"}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-2">
              {sourceBreakdown.map(({ platform, count }) => (
                <div
                  key={platform}
                  className="rounded-2xl border border-orange-200/10 bg-white/[0.03] px-2 py-2 text-center"
                >
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-200/55">
                    {PLATFORM_SHORT[platform]}
                  </div>
                  <div className="mt-1 text-lg font-semibold text-white">{count}</div>
                </div>
              ))}
            </div>
          </div>
        </header>

        <section className="px-5 py-4">
          {statusMessage && (
            <div
              className={`mb-4 rounded-[22px] border px-4 py-3 text-sm ${statusMessage.tone === "success"
                ? "border-orange-300/20 bg-orange-400/10 text-orange-50"
                : statusMessage.tone === "error"
                  ? "border-red-300/20 bg-red-500/10 text-red-100"
                  : "border-orange-200/10 bg-white/[0.04] text-orange-100/80"
                }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>{statusMessage.text}</div>
                <button
                  onClick={() => setStatusMessage(null)}
                  className="text-[10px] uppercase tracking-[0.2em] opacity-60 transition hover:opacity-100"
                >
                  close
                </button>
              </div>
            </div>
          )}

          <div className="mb-2 text-[10px] uppercase tracking-[0.28em] text-orange-200/45">
            Route Context To
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(Object.keys(PLATFORM_LABELS) as Platform[]).map((platform) => (
              <button
                key={platform}
                onClick={() => setTargetPlatform(platform)}
                className={`relative overflow-hidden rounded-[22px] border px-3 py-3 text-left transition ${targetPlatform === platform
                  ? "border-orange-300/40 bg-orange-500/10 text-white shadow-[0_10px_30px_rgba(251,146,60,0.16)]"
                  : "border-orange-200/10 bg-white/[0.03] text-orange-100/80 hover:border-orange-300/25 hover:bg-white/[0.05]"
                  }`}
              >
                <div
                  className={`absolute inset-0 bg-gradient-to-br ${PLATFORM_TONES[platform]
                    } opacity-90`}
                />
                <div className="relative flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-[0.24em] text-orange-100/45">
                      Target
                    </div>
                    <div className="mt-1 text-sm font-semibold">
                      {PLATFORM_LABELS[platform]}
                    </div>
                  </div>
                  <span className="rounded-full border border-orange-200/15 bg-black/20 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]">
                    {targetPlatform === platform ? "armed" : "idle"}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="flex-1 px-5 pb-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-[0.28em] text-orange-200/45">
              Captured Context
            </div>
            <div className="text-[11px] text-orange-100/55">{filteredSessions.length} visible</div>
          </div>

          <div className="mb-4 rounded-[22px] border border-orange-200/10 bg-white/[0.03] px-3 py-3">
            <div className="mb-2 text-[10px] uppercase tracking-[0.22em] text-orange-200/45">
              Search Captured Context
            </div>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search by title, source agent, or recent messages"
              className="w-full rounded-2xl border border-orange-200/10 bg-black/25 px-3 py-2 text-sm text-orange-50 outline-none placeholder:text-orange-100/30 focus:border-orange-300/30"
            />
          </div>

          <div className="space-y-3">
            {filteredSessions.length === 0 ? (
              <div className="rounded-[30px] border border-dashed border-orange-300/20 bg-white/[0.03] px-5 py-10 text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-orange-300/15 bg-orange-500/10 text-xl text-orange-300 shadow-[0_0_40px_rgba(251,146,60,0.18)]">
                  C
                </div>
                <h2 className="text-lg font-semibold text-white">
                  {sessions.length === 0 ? "No context captured yet" : "No results for this search"}
                </h2>
                <p className="mx-auto mt-2 max-w-[270px] text-sm leading-6 text-orange-100/60">
                  {sessions.length === 0
                    ? "Open ChatGPT, Claude, Gemini, or Grok. The extension will turn those conversations into migration-ready context cards here."
                    : "Try another search phrase or clear the query to reveal the full archive."}
                </p>
              </div>
            ) : (
              filteredSessions.slice(0, 6).map((session) => {
                const latestMessage =
                  session.messages[session.messages.length - 1]?.content ?? "";
                const sourceLabel = PLATFORM_LABELS[session.platform];
                const isExpanded = expandedSessionId === session.id;
                const previewText = isExpanded
                  ? session.messages
                    .slice(-3)
                    .map(
                      (message) =>
                        `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`
                    )
                    .join("\n\n")
                  : latestMessage;

                return (
                  <article
                    key={session.id}
                    className="group relative overflow-hidden rounded-[28px] border border-orange-200/10 bg-white/[0.035] p-4 shadow-[0_22px_50px_rgba(0,0,0,0.28)] transition hover:border-orange-300/25 hover:bg-white/[0.05]"
                  >
                    <div
                      className={`absolute inset-0 bg-gradient-to-br ${PLATFORM_TONES[session.platform]} opacity-80`}
                    />
                    <div className="relative">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center rounded-full border border-orange-300/20 bg-black/20 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-100">
                              Source: {sourceLabel}
                            </span>
                            <span className="rounded-full bg-orange-400/10 px-2.5 py-1 text-[10px] font-medium text-orange-200/80">
                              migrating into {PLATFORM_LABELS[targetPlatform]}
                            </span>
                          </div>
                          <h3 className="mt-3 line-clamp-2 text-[16px] font-semibold leading-5 text-white">
                            {session.title}
                          </h3>
                          <p className="mt-2 text-xs text-orange-100/60">
                            {session.messages.length} turns captured • updated {formatRelativeTime(session.updatedAt)}
                          </p>
                        </div>

                        <button
                          onClick={() => deleteSession(session.id)}
                          className="rounded-full border border-orange-300/15 bg-black/20 px-2.5 py-1 text-[11px] font-semibold text-orange-100/75 transition hover:border-red-300/30 hover:bg-red-400/10 hover:text-red-100"
                          title="Delete session"
                        >
                          Delete
                        </button>
                      </div>

                      <div className="mt-4 rounded-[22px] border border-orange-200/10 bg-black/30 px-3 py-3">
                        <div className="mb-2 text-[10px] uppercase tracking-[0.22em] text-orange-200/45">
                          {isExpanded ? "Recent Transcript" : "Latest Snapshot"}
                        </div>
                        {previewText ? (
                          <p
                            className={`text-sm leading-6 text-orange-50/88 ${isExpanded ? "whitespace-pre-wrap" : "line-clamp-3"
                              }`}
                          >
                            {previewText}
                          </p>
                        ) : (
                          <p className="text-sm text-orange-100/50">No preview available yet.</p>
                        )}
                      </div>

                      <div className="mt-4 flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.22em] text-orange-200/45">
                            Route
                          </div>
                          <div className="mt-1 text-sm font-medium text-white">
                            {`${sourceLabel} -> ${PLATFORM_LABELS[targetPlatform]}`}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() =>
                              setExpandedSessionId((current) =>
                                current === session.id ? null : session.id
                              )
                            }
                            className="rounded-full border border-orange-300/15 bg-black/20 px-3 py-2 text-[11px] font-semibold text-orange-100/80 transition hover:border-orange-300/30 hover:bg-white/[0.05]"
                          >
                            {isExpanded ? "Collapse" : "Expand"}
                          </button>
                          <button
                            onClick={() => migrateSession(session.id)}
                            disabled={migrating === session.id}
                            className="rounded-full bg-orange-400 px-4 py-2 text-[12px] font-semibold text-black transition hover:bg-orange-300 disabled:cursor-wait disabled:opacity-60"
                          >
                            {migrating === session.id ? "Routing..." : "Launch Migration"}
                          </button>
                        </div>
                      </div>

                      {migrating === session.id && (
                        <div className="mt-3 overflow-hidden rounded-full bg-black/20">
                          <div className="h-1.5 w-full animate-pulse bg-gradient-to-r from-orange-500 via-orange-300 to-orange-500" />
                        </div>
                      )}
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>
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
