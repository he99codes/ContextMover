// packages/browser-extension/src/content/floating-bubble/BubblePanel.tsx
import React, { useEffect, useRef, useState } from "react";
import type { ContextSession, Platform } from "@/lib/types";

type BubbleStatus = "idle" | "capturing" | "error";
type SnapZone = "top-right" | "bottom-right" | "top-left" | "bottom-left";

interface Props {
  captureStatus: BubbleStatus;
  snapZone:      SnapZone;
  onMinimize:    () => void;
  onClose:       () => void;
}

// ── Constants ──────────────────────────────────────────────────────────────────
const PLATFORM_COLORS: Record<string, string> = {
  claude:     "#D97706",
  chatgpt:    "#10B981",
  gemini:     "#6366F1",
  grok:       "#E5E5E5",
  perplexity: "#20B2AA",
  deepseek:   "#4C8BF5",
};
const PLATFORM_SHORT: Record<string, string> = {
  claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini",
  grok: "Grok", perplexity: "Perplexity", deepseek: "DeepSeek",
};
const ALL_PLATFORMS: Platform[] = ["claude", "chatgpt", "gemini", "grok", "perplexity", "deepseek"];
const PAGE_SIZE = 8;

// ── Helpers ────────────────────────────────────────────────────────────────────
function relativeTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000)       return "just now";
  if (d < 3_600_000)    return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000)   return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

// ── Component ──────────────────────────────────────────────────────────────────
export function BubblePanel({ captureStatus, onMinimize, onClose }: Props) {
  const [sessions, setSessions] = useState<ContextSession[]>([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState<Platform | "all">("all");
  const [search, setSearch]     = useState("");
  const [page, setPage]         = useState(0);
  const listenerRef = useRef<((msg: { type: string }) => void) | null>(null);

  // ── Load sessions ────────────────────────────────────────────────────────
  function loadSessions() {
    chrome.runtime.sendMessage({ type: "GET_SESSIONS" }, (res: ContextSession[] | null) => {
      if (!chrome.runtime.lastError) {
        setSessions(Array.isArray(res) ? res : []);
      }
      setLoading(false);
    });
  }

  useEffect(() => {
    loadSessions();

    const onMsg = (msg: { type: string }) => {
      if (msg.type === "SESSIONS_UPDATED") loadSessions();
    };
    listenerRef.current = onMsg;
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      if (listenerRef.current) chrome.runtime.onMessage.removeListener(listenerRef.current);
    };
  }, []);

  // ── Filter + sort ────────────────────────────────────────────────────────
  const filtered = sessions
    .filter((s) => filter === "all" || s.platform === filter)
    .filter((s) => !search.trim() || s.title?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages - 1);
  const paginated  = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const usedPlatforms = ALL_PLATFORMS.filter((p) => sessions.some((s) => s.platform === p));

  // ── Open sidebar via SW ──────────────────────────────────────────────────
  function openSidebar() {
    chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" }, () => {
      void chrome.runtime.lastError; // suppress "no listener" warning
    });
    onMinimize();
  }

  // ── Status dot class ─────────────────────────────────────────────────────
  const dotCls = captureStatus === "capturing"
    ? "cf-dot cf-dot--active cf-dot--pulse"
    : captureStatus === "error"
    ? "cf-dot cf-dot--error"
    : "cf-dot cf-dot--idle";

  return (
    <div className="cf-panel">

      {/* ── Header ── */}
      <div className="cf-panel-header">
        <div className="cf-panel-brand">
          <span className={dotCls} />
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 2L3 6.5V13.5L10 18L17 13.5V6.5L10 2Z" fill="#00D26A" opacity="0.9"/>
            <path d="M10 5.5L5.5 8V12L10 14.5L14.5 12V8L10 5.5Z" fill="#0A0A0A"/>
            <circle cx="10" cy="10" r="2.2" fill="#00D26A"/>
          </svg>
          <span className="cf-panel-title">ContextForge</span>
          <span className="cf-panel-badge">🔒 Local only</span>
        </div>
        <div className="cf-panel-actions">
          <button
            className="cf-icon-btn"
            onClick={onMinimize}
            title="Minimise to bubble"
            aria-label="Minimise"
          >
            {/* Dash / minimise icon */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
          <button
            className="cf-icon-btn"
            onClick={onClose}
            title="Close panel"
            aria-label="Close"
          >
            {/* × icon */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Search ── */}
      <div className="cf-panel-search-wrap">
        <svg
          width="12" height="12" viewBox="0 0 16 16" fill="none"
          className="cf-search-icon" aria-hidden="true"
        >
          <circle cx="6.5" cy="6.5" r="4.5" stroke="#6B6B6B" strokeWidth="1.5"/>
          <path d="m10 10 3.5 3.5" stroke="#6B6B6B" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <input
          className="cf-panel-search"
          placeholder="Search sessions…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          aria-label="Search sessions"
        />
      </div>

      {/* ── Platform filter ── */}
      {usedPlatforms.length > 0 && (
        <div className="cf-platform-tabs" role="tablist" aria-label="Filter by platform">
          <button
            className={`cf-ptab${filter === "all" ? " cf-ptab--active" : ""}`}
            role="tab"
            aria-selected={filter === "all"}
            onClick={() => { setFilter("all"); setPage(0); }}
          >All</button>
          {usedPlatforms.map((p) => (
            <button
              key={p}
              className={`cf-ptab${filter === p ? " cf-ptab--active" : ""}`}
              role="tab"
              aria-selected={filter === p}
              style={filter === p ? { borderColor: PLATFORM_COLORS[p], color: PLATFORM_COLORS[p] } : undefined}
              onClick={() => { setFilter(p); setPage(0); }}
            >
              {PLATFORM_SHORT[p]}
            </button>
          ))}
        </div>
      )}

      {/* ── Session list ── */}
      <div className="cf-session-list" role="list">
        {loading ? (
          <div className="cf-empty" aria-live="polite" aria-label="Loading sessions">
            <div className="cf-spinner" />
          </div>
        ) : paginated.length === 0 ? (
          <div className="cf-empty">
            <p className="cf-empty-text">No sessions yet.</p>
            <p className="cf-empty-sub">Open an AI platform and start a conversation.</p>
          </div>
        ) : (
          paginated.map((s) => (
            <div
              key={s.id}
              className="cf-session-card"
              role="listitem"
              title={s.title}
            >
              <span
                className="cf-session-dot"
                style={{ background: PLATFORM_COLORS[s.platform] ?? "#6B6B6B" }}
                aria-hidden="true"
              />
              <div className="cf-session-info">
                <span className="cf-session-title">{s.title || "Untitled session"}</span>
                <span className="cf-session-meta">
                  {PLATFORM_SHORT[s.platform] ?? s.platform}
                  &nbsp;·&nbsp;{s.messages.length}&nbsp;msg{s.messages.length !== 1 ? "s" : ""}
                  &nbsp;·&nbsp;{relativeTime(s.updatedAt)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="cf-pagination" role="navigation" aria-label="Session pages">
          <button
            className="cf-page-btn"
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >← Prev</button>
          <span className="cf-page-info">{safePage + 1} / {totalPages}</span>
          <button
            className="cf-page-btn"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >Next →</button>
        </div>
      )}

      {/* ── Footer ── */}
      <div className="cf-panel-footer">
        <button
          className="cf-open-sidebar-btn"
          onClick={openSidebar}
          aria-label="Open full sidebar panel"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M6 2v12" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
          Open in Sidebar
        </button>
        <span className="cf-session-count" aria-live="polite">
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </span>
      </div>

    </div>
  );
}
