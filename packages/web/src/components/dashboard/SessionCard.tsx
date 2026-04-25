"use client";

import { useState, useRef, useEffect, type KeyboardEvent, type MouseEvent } from "react";
import Link from "next/link";
import { MessageSquare, Clock, ArrowRight, Pencil, Trash2, Check, X, Loader2 } from "lucide-react";
import { cn, formatRelativeTime, truncate } from "@/lib/utils";
import { useSessionMutations } from "@/hooks/useSessionMutations";
import type { Session } from "@/types";

const PLATFORM_STYLES: Record<
  string,
  { label: string; color: string; dot: string; badge: string }
> = {
  claude:  { label: "Claude",  color: "#D97706", dot: "bg-[#D97706]",  badge: "text-[#D97706] border-[#D97706]/25 bg-[#D97706]/10"  },
  chatgpt: { label: "ChatGPT", color: "#10B981", dot: "bg-[#10B981]",  badge: "text-[#10B981] border-[#10B981]/25 bg-[#10B981]/10" },
  gemini:  { label: "Gemini",  color: "#6366F1", dot: "bg-[#6366F1]",  badge: "text-[#6366F1] border-[#6366F1]/25 bg-[#6366F1]/10"  },
  grok:    { label: "Grok",    color: "#F5F5F5", dot: "bg-[#F5F5F5]",  badge: "text-[#F5F5F5] border-[#F5F5F5]/25 bg-[#F5F5F5]/10"  },
};

function getPlatformStyle(platform: string) {
  return (
    PLATFORM_STYLES[platform.toLowerCase()] ?? {
      label: platform,
      color: "#6B6B6B",
      dot: "bg-[#6B6B6B]",
      badge: "text-[#6B6B6B] border-[#6B6B6B]/25 bg-[#6B6B6B]/10",
    }
  );
}

interface SessionCardProps {
  session: Session;
}

export function SessionCard({ session }: SessionCardProps) {
  const style = getPlatformStyle(session.platform);
  const msgCount = session.messages.length;
  const preview =
    session.messages.findLast?.((m) => m.role === "assistant")?.content ??
    session.messages[session.messages.length - 1]?.content ??
    "";

  const { deleteSession, renameSession } = useSessionMutations();

  const [isEditing, setIsEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session.title ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  // Keep draft in sync if the session title changes from realtime.
  useEffect(() => {
    if (!isEditing) setTitleDraft(session.title ?? "");
  }, [session.title, isEditing]);

  function stopLink(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  async function handleSaveRename(e?: MouseEvent) {
    if (e) stopLink(e);
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === (session.title ?? "")) {
      setIsEditing(false);
      setTitleDraft(session.title ?? "");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      await renameSession(session.id, trimmed);
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setBusy(null);
    }
  }

  function handleCancelRename(e?: MouseEvent) {
    if (e) stopLink(e);
    setTitleDraft(session.title ?? "");
    setIsEditing(false);
    setError(null);
  }

  async function handleDelete(e: MouseEvent) {
    stopLink(e);
    const ok = window.confirm(
      `Delete this ${style.label} session? This cannot be undone and will also remove it from the extension.`
    );
    if (!ok) return;
    setBusy("delete");
    setError(null);
    try {
      await deleteSession(session.id);
      // Realtime DELETE event will remove it from the list automatically.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(null);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSaveRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelRename();
    }
  }

  return (
    <div
      className={cn(
        "group relative flex items-start gap-4 rounded-[8px] border px-5 py-4 transition-all",
        busy === "delete"
          ? "border-red-500/30 bg-red-500/5 opacity-50"
          : "bg-[#1A1A1A] border-[#2A2A2A] hover:border-[#00FF88]/25 hover:shadow-[0_0_16px_rgba(0,255,136,0.06)]"
      )}
    >
      {/* Platform dot */}
      <div className="mt-1 shrink-0">
        <span className={cn("inline-block h-2 w-2 rounded-full", style.dot)} />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <div className="flex items-center gap-1.5" onClick={stopLink}>
                <input
                  ref={inputRef}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={busy === "save"}
                  className="flex-1 rounded-[4px] border border-[#00FF88]/30 bg-[#0A0A0A] px-2 py-1 text-sm font-medium text-[#F5F5F5] outline-none focus:border-[#00FF88]"
                  placeholder="Session title"
                />
                <button
                  type="button"
                  onClick={handleSaveRename}
                  disabled={busy === "save"}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[#00FF88] hover:bg-[#00FF88]/10 disabled:opacity-50"
                  aria-label="Save title"
                >
                  {busy === "save" ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Check size={14} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleCancelRename}
                  disabled={busy === "save"}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[#6B6B6B] hover:bg-[#2A2A2A] disabled:opacity-50"
                  aria-label="Cancel rename"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <Link
                href={`/session/${session.id}`}
                className="block min-w-0"
              >
                <p className="truncate text-sm font-medium text-[#F5F5F5] group-hover:text-[#00FF88] transition-colors">
                  {session.title ?? "Untitled session"}
                </p>
                {preview && (
                  <p className="mt-0.5 text-xs text-[#6B6B6B] line-clamp-1">
                    {truncate(preview, 100)}
                  </p>
                )}
              </Link>
            )}
            {error && (
              <p className="mt-1 text-[11px] text-red-400">{error}</p>
            )}
          </div>

          {/* Action buttons — revealed on hover */}
          <div
            className={cn(
              "flex items-center gap-1 transition-opacity",
              isEditing ? "opacity-0 pointer-events-none" : "opacity-0 group-hover:opacity-100"
            )}
          >
            <button
              type="button"
              onClick={(e) => {
                stopLink(e);
                setIsEditing(true);
              }}
              disabled={busy !== null}
              title="Rename session"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[#6B6B6B] hover:bg-[#2A2A2A] hover:text-[#F5F5F5] disabled:opacity-50"
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy !== null}
              title="Delete session"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[#6B6B6B] hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
            >
              {busy === "delete" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} />
              )}
            </button>
          </div>

          {!isEditing && (
            <Link
              href={`/session/${session.id}`}
              className="mt-0.5 shrink-0"
              aria-label="Open session"
            >
              <ArrowRight
                size={14}
                className="text-[#2A2A2A] transition-colors group-hover:text-[#00FF88]"
              />
            </Link>
          )}
        </div>

        <div className="mt-2.5 flex items-center gap-3">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-[4px] border px-2 py-0.5 text-[11px] font-medium",
              style.badge
            )}
          >
            {style.label}
          </span>

          <span className="flex items-center gap-1 text-[11px] text-[#6B6B6B]">
            <MessageSquare size={11} />
            {msgCount} {msgCount === 1 ? "message" : "messages"}
          </span>

          <span className="flex items-center gap-1 text-[11px] text-[#6B6B6B]">
            <Clock size={11} />
            {formatRelativeTime(session.updated_at)}
          </span>
        </div>
      </div>
    </div>
  );
}
