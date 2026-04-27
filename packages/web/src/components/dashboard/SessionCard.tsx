"use client";

import { useState, useRef, useEffect, type KeyboardEvent, type MouseEvent } from "react";
import Link from "next/link";
import { MessageSquare, Clock, ArrowRight, Pencil, Trash2, Check, X, Loader2 } from "lucide-react";
import { cn, formatRelativeTime, truncate } from "@/lib/utils";
import { useSessionMutations } from "@/hooks/useSessionMutations";
import { PlatformBadge, PLATFORM_COLORS } from "@/components/ui/PlatformLogo";
import type { Session } from "@/types";

function getPlatformColor(platform: string): string {
  return PLATFORM_COLORS[platform.toLowerCase()] ?? "#6B6B6B";
}

interface SessionCardProps {
  session: Session;
}

export function SessionCard({ session }: SessionCardProps) {
  const color = getPlatformColor(session.platform);
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
      `Delete this ${session.platform} session? This cannot be undone and will also remove it from the extension.`
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
        "stagger-item group relative flex items-start gap-4 overflow-hidden rounded-[6px] border px-5 py-4",
        busy === "delete"
          ? "border-red-500/30 bg-red-500/5 opacity-50"
          : "bg-[#1A1A1A] border-[#2A2A2A] card-hover"
      )}
    >
      {/* Always-visible platform left border */}
      <div
        className="absolute inset-y-0 left-0 w-[3px] rounded-l-[6px] transition-opacity duration-200"
        style={{ backgroundColor: color, opacity: 0.6 }}
      />
      {/* Hover: brighten border */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-[3px] rounded-l-[6px] opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        style={{ backgroundColor: color }}
      />

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
                  className="flex-1 rounded-[4px] border border-[#00FF88]/30 bg-[#0A0A0A] px-2 py-1 text-sm font-medium text-[#F5F5F5] outline-none focus:border-[#00FF88] transition-colors"
                  placeholder="Session title"
                />
                <button
                  type="button"
                  onClick={handleSaveRename}
                  disabled={busy === "save"}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[#00FF88] hover:bg-[#00FF88]/10 disabled:opacity-50 transition-colors"
                  aria-label="Save title"
                >
                  {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                </button>
                <button
                  type="button"
                  onClick={handleCancelRename}
                  disabled={busy === "save"}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[#6B6B6B] hover:bg-[#2A2A2A] disabled:opacity-50 transition-colors"
                  aria-label="Cancel rename"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <Link href={`/session/${session.id}`} className="block min-w-0">
                <p className="truncate text-sm font-medium text-[#F5F5F5] transition-colors duration-150 group-hover:text-[#00FF88]">
                  {session.title ?? "Untitled session"}
                </p>
                {preview && (
                  <p className="mt-0.5 text-xs text-[#6B6B6B] line-clamp-1">
                    {truncate(preview, 100)}
                  </p>
                )}
              </Link>
            )}
            {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
          </div>

          {/* Actions: always visible on hover */}
          <div className={cn(
            "flex items-center gap-1 transition-all duration-150",
            isEditing ? "opacity-0 pointer-events-none" : "opacity-0 group-hover:opacity-100"
          )}>
            {/* Migrate quick-action */}
            <Link
              href={`/migrate?session=${session.id}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex h-7 items-center gap-1 rounded-[4px] border border-[#00FF88]/30 bg-[#00FF88]/8 px-2 text-[11px] font-medium text-[#00FF88] transition-all hover:bg-[#00FF88]/15"
            >
              <ArrowRight size={11} />
              Migrate
            </Link>
            <button
              type="button"
              onClick={(e) => { stopLink(e); setIsEditing(true); }}
              disabled={busy !== null}
              title="Rename session"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[#6B6B6B] transition-colors hover:bg-[#2A2A2A] hover:text-[#F5F5F5] disabled:opacity-50"
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy !== null}
              title="Delete session"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[#6B6B6B] transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
            >
              {busy === "delete" ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            </button>
          </div>

          {!isEditing && (
            <Link href={`/session/${session.id}`} className="mt-0.5 shrink-0" aria-label="Open session">
              <ArrowRight size={14} className="text-[#2A2A2A] transition-colors duration-150 group-hover:text-[#00FF88]" />
            </Link>
          )}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <PlatformBadge platform={session.platform} logoSize={11} />
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
