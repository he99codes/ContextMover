import { useEffect, useMemo, useState } from "react";
import { findTargetPlatformTab, focusTab } from "@/lib/platform-tabs";
import type { ContextSession, Platform } from "@/lib/types";
import ExportMenu from "@/components/ExportMenu";

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

const PLATFORM_COLORS: Record<Platform, string> = {
  claude:  "#D97706",
  chatgpt: "#10B981",
  gemini:  "#6366F1",
  grok:    "#F5F5F5",
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
    <div className="w-[390px] overflow-hidden bg-[#0A0A0A] text-[#F5F5F5]">
      <div className="flex min-h-[600px] flex-col">
        {/* Header */}
        <header className="border-b border-[#2A2A2A] px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-[6px] bg-[#00FF88]">
                <span className="text-xs font-bold text-black">CF</span>
              </div>
              <span className="text-sm font-semibold text-[#F5F5F5] tracking-tight">ContextForge</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={openSidebar}
                className="rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-2.5 py-1 text-[11px] font-medium text-[#F5F5F5] transition hover:border-[#00FF88]/30 hover:text-[#00FF88]"
              >
                Sidebar
              </button>
              <button
                onClick={() => { void loadSessions(); void checkBridge(); }}
                className="rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-2.5 py-1 text-[11px] font-medium text-[#6B6B6B] transition hover:border-[#00FF88]/30 hover:text-[#00FF88]"
              >
                ↻
              </button>
            </div>
          </div>

          <p className="mt-2 text-xs text-[#6B6B6B]">
            {sourceHeadline}
          </p>

          {/* Stats row */}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-[#6B6B6B]">Sessions</div>
              <div className="mt-1 text-2xl font-semibold text-[#F5F5F5] tabular-nums">{sessions.length}</div>
            </div>
            <div className="rounded-[8px] border border-[#00FF88]/20 bg-[#00FF88]/5 px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-[#6B6B6B]">Messages</div>
              <div className="mt-1 text-2xl font-semibold text-[#F5F5F5] tabular-nums">{totalMessages}</div>
            </div>
          </div>

          {/* Bridge status */}
          <div className="mt-2 rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-[#6B6B6B]">VS Code</div>
                <div className="mt-0.5 text-xs font-medium text-[#F5F5F5] truncate">{bridgeSummary}</div>
                {bridgeStatus.state === "ok" && (
                  <div className="mt-1 text-[10px] text-[#6B6B6B]">
                    {bridgeStatus.workspaceFilesCount} files · {bridgeStatus.openFilesCount} open · {bridgeStatus.diagnosticsCount} diag
                  </div>
                )}
              </div>
              <span className={`shrink-0 rounded-[4px] px-2 py-1 text-[10px] font-medium ${
                bridgeStatus.state === "ok"
                  ? "bg-[#00FF88]/10 text-[#00FF88] border border-[#00FF88]/20"
                  : "bg-[#1A1A1A] text-[#6B6B6B] border border-[#2A2A2A]"
              }`}>
                {bridgeStatus.state === "ok" ? "●  Online" : bridgeStatus.state === "offline" ? "○  Offline" : "Checking"}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {sourceBreakdown.map(({ platform, count }) => (
                <div key={platform} className="rounded-[4px] border border-[#2A2A2A] bg-[#0A0A0A] px-1 py-1.5 text-center">
                  <div className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: PLATFORM_COLORS[platform] }}>
                    {PLATFORM_SHORT[platform]}
                  </div>
                  <div className="mt-0.5 text-sm font-semibold text-[#F5F5F5]">{count}</div>
                </div>
              ))}
            </div>
          </div>
        </header>

        {/* Route target */}
        <section className="border-b border-[#2A2A2A] px-4 py-3">
          {statusMessage && (
            <div className={`mb-3 rounded-[8px] border px-3 py-2 text-xs ${
              statusMessage.tone === "success"
                ? "border-[#00FF88]/20 bg-[#00FF88]/10 text-[#00FF88]"
                : statusMessage.tone === "error"
                ? "border-red-500/20 bg-red-500/10 text-red-400"
                : "border-[#2A2A2A] bg-[#1A1A1A] text-[#6B6B6B]"
            }`}>
              <div className="flex items-start justify-between gap-2">
                <div>{statusMessage.text}</div>
                <button onClick={() => setStatusMessage(null)} className="shrink-0 opacity-60 hover:opacity-100">×</button>
              </div>
            </div>
          )}

          <div className="mb-2 text-[10px] uppercase tracking-wider text-[#6B6B6B]">Route context to</div>
          <div className="grid grid-cols-2 gap-1.5">
            {(Object.keys(PLATFORM_LABELS) as Platform[]).map((platform) => (
              <button
                key={platform}
                onClick={() => setTargetPlatform(platform)}
                className="rounded-[4px] border px-3 py-2 text-left transition-all"
                style={targetPlatform === platform ? {
                  borderColor: `${PLATFORM_COLORS[platform]}40`,
                  background: `${PLATFORM_COLORS[platform]}15`,
                } : {
                  borderColor: "#2A2A2A",
                  background: "#1A1A1A",
                }}
              >
                <div className="flex items-center justify-between gap-1">
                  <span
                    className="text-xs font-semibold"
                    style={{ color: targetPlatform === platform ? PLATFORM_COLORS[platform] : "#F5F5F5" }}
                  >
                    {PLATFORM_LABELS[platform]}
                  </span>
                  {targetPlatform === platform && (
                    <span className="text-[9px] uppercase tracking-wider" style={{ color: PLATFORM_COLORS[platform] }}>armed</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Sessions */}
        <section className="flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-[#6B6B6B]">Captured context</div>
            <div className="text-[10px] text-[#6B6B6B]">{filteredSessions.length} visible</div>
          </div>

          <div className="mb-3">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search sessions…"
              className="w-full rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-3 py-1.5 text-xs text-[#F5F5F5] outline-none placeholder:text-[#6B6B6B] focus:border-[#00FF88]"
            />
          </div>

          <div className="space-y-2">
            {filteredSessions.length === 0 ? (
              <div className="rounded-[8px] border border-dashed border-[#2A2A2A] px-4 py-8 text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[8px] border border-[#00FF88]/20 bg-[#00FF88]/10">
                  <span className="text-lg font-bold text-[#00FF88]">CF</span>
                </div>
                <p className="text-sm font-medium text-[#F5F5F5]">
                  {sessions.length === 0 ? "No context captured yet" : "No results"}
                </p>
                <p className="mt-1 text-xs text-[#6B6B6B]">
                  {sessions.length === 0
                    ? "Open ChatGPT, Claude, Gemini, or Grok."
                    : "Try a different search."}
                </p>
              </div>
            ) : (
              filteredSessions.slice(0, 6).map((session) => {
                const latestMessage = session.messages[session.messages.length - 1]?.content ?? "";
                const sourceLabel = PLATFORM_LABELS[session.platform];
                const isExpanded = expandedSessionId === session.id;
                const previewText = isExpanded
                  ? session.messages.slice(-3).map((m) => `${m.role === "user" ? "You" : "AI"}: ${m.content}`).join("\n\n")
                  : latestMessage;
                const pColor = PLATFORM_COLORS[session.platform];

                return (
                  <article
                    key={session.id}
                    className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-3 transition-all hover:border-[#00FF88]/20 hover:shadow-[0_0_12px_rgba(0,255,136,0.04)]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className="rounded-[4px] border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                            style={{ color: pColor, borderColor: `${pColor}35`, background: `${pColor}12` }}
                          >
                            {sourceLabel}
                          </span>
                          <span className="rounded-[4px] border border-[#2A2A2A] bg-[#0A0A0A] px-1.5 py-0.5 text-[10px] text-[#6B6B6B]">
                            → {PLATFORM_LABELS[targetPlatform]}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs font-medium text-[#F5F5F5] line-clamp-1">{session.title}</p>
                        <p className="mt-0.5 text-[10px] text-[#6B6B6B]">
                          {session.messages.length} turns · {formatRelativeTime(session.updatedAt)}
                        </p>
                      </div>
                      <button
                        onClick={() => deleteSession(session.id)}
                        className="shrink-0 rounded-[4px] border border-[#2A2A2A] px-2 py-1 text-[10px] text-[#6B6B6B] transition hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
                      >
                        Del
                      </button>
                    </div>

                    {previewText && (
                      <div className="mt-2 rounded-[4px] border border-[#2A2A2A] bg-[#0A0A0A] px-2.5 py-2">
                        <div className="mb-1 text-[9px] uppercase tracking-wider text-[#6B6B6B]">
                          {isExpanded ? "Transcript" : "Latest"}
                        </div>
                        <p className={`text-xs text-[#F5F5F5]/80 leading-5 ${isExpanded ? "whitespace-pre-wrap" : "line-clamp-2"}`}>
                          {previewText}
                        </p>
                      </div>
                    )}

                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      <span className="text-[10px] text-[#6B6B6B]">
                        {sourceLabel} → {PLATFORM_LABELS[targetPlatform]}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setExpandedSessionId((c) => c === session.id ? null : session.id)}
                          className="rounded-[4px] border border-[#2A2A2A] px-2 py-1 text-[10px] text-[#6B6B6B] hover:border-[#3A3A3A] hover:text-[#F5F5F5] transition-colors"
                        >
                          {isExpanded ? "Less" : "More"}
                        </button>
                        <ExportMenu
                          session={session}
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
                          onClick={() => migrateSession(session.id)}
                          disabled={migrating === session.id}
                          className="rounded-[4px] bg-[#00FF88] px-3 py-1 text-[11px] font-semibold text-black transition hover:bg-[#00CC6A] hover:shadow-[0_0_8px_rgba(0,255,136,0.3)] disabled:opacity-50"
                        >
                          {migrating === session.id ? "Routing…" : "Migrate"}
                        </button>
                      </div>
                    </div>

                    {migrating === session.id && (
                      <div className="mt-2 overflow-hidden rounded-full bg-[#0A0A0A]">
                        <div className="h-0.5 w-full animate-pulse bg-[#00FF88]" />
                      </div>
                    )}
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
