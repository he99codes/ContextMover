"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Copy,
  Check,
  Trash2,
  Pencil,
  ArrowLeftRight,
  Clock,
  MessageSquare,
  Loader2,
} from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useSessionMutations } from "@/hooks/useSessionMutations";
import type { Session } from "@/types";

const PLATFORM_STYLES: Record<string, { label: string; bg: string; text: string; dot: string }> = {
  claude:   { label: "Claude",  bg: "bg-amber-50",    text: "text-amber-700",   dot: "bg-amber-500"   },
  chatgpt:  { label: "ChatGPT", bg: "bg-emerald-50",  text: "text-emerald-700", dot: "bg-emerald-500" },
  gemini:   { label: "Gemini",  bg: "bg-indigo-50",   text: "text-indigo-700",  dot: "bg-indigo-500"  },
  grok:     { label: "Grok",    bg: "bg-zinc-100",    text: "text-zinc-800",    dot: "bg-zinc-700"    },
};

function getStyle(platform: string) {
  return PLATFORM_STYLES[platform.toLowerCase()] ?? {
    label: platform,
    bg: "bg-slate-50",
    text: "text-slate-700",
    dot: "bg-slate-500",
  };
}

interface Props {
  session: Session;
}

export function SessionDetailView({ session }: Props) {
  const router = useRouter();
  const style = getStyle(session.platform);
  const { deleteSession, renameSession } = useSessionMutations();

  const [title, setTitle] = useState(session.title ?? "Untitled session");
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === title) {
      setIsEditing(false);
      setDraft(title);
      return;
    }
    setBusy("save");
    try {
      await renameSession(session.id, trimmed);
      setTitle(trimmed);
      setIsEditing(false);
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this session? This cannot be undone.")) return;
    setBusy("delete");
    try {
      await deleteSession(session.id);
      router.push("/dashboard");
    } catch {
      setBusy(null);
    }
  }

  async function copyMessage(content: string, idx: number) {
    await navigator.clipboard.writeText(content);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
  }

  async function copyAll() {
    const md = session.messages
      .map((m) => `**${m.role === "user" ? "User" : "Assistant"}:**\n\n${m.content}`)
      .join("\n\n---\n\n");
    await navigator.clipboard.writeText(md);
    setCopiedIdx(-1);
    setTimeout(() => setCopiedIdx(null), 1500);
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      {/* Back */}
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-sm text-[#6B6B6B] hover:text-[#1A1A1A] mb-6"
      >
        <ArrowLeft size={14} />
        All sessions
      </Link>

      {/* Header */}
      <div className="rounded-xl border border-[#E8E8E4] bg-white p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave();
                    if (e.key === "Escape") { setIsEditing(false); setDraft(title); }
                  }}
                  className="flex-1 rounded-md border border-[#2563EB]/40 px-3 py-1.5 text-xl font-semibold text-[#1A1A1A] outline-none focus:border-[#2563EB]"
                />
                <button
                  onClick={handleSave}
                  disabled={busy === "save"}
                  className="inline-flex h-8 px-3 items-center gap-1 rounded-md bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8] disabled:opacity-50"
                >
                  {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  Save
                </button>
              </div>
            ) : (
              <h1 className="text-xl font-semibold text-[#1A1A1A] flex items-center gap-2">
                {title}
                <button
                  onClick={() => setIsEditing(true)}
                  className="opacity-0 group-hover:opacity-100 hover:opacity-100 text-[#6B6B6B] hover:text-[#1A1A1A] transition-opacity"
                  title="Rename"
                >
                  <Pencil size={14} />
                </button>
              </h1>
            )}

            <div className="mt-2 flex items-center gap-3 flex-wrap">
              <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", style.bg, style.text)}>
                <span className={cn("inline-block h-1.5 w-1.5 rounded-full", style.dot)} />
                {style.label}
              </span>
              <span className="flex items-center gap-1 text-xs text-[#6B6B6B]">
                <MessageSquare size={11} />
                {session.messages.length} messages
              </span>
              <span className="flex items-center gap-1 text-xs text-[#6B6B6B]">
                <Clock size={11} />
                Updated {formatRelativeTime(session.updated_at)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={copyAll}
              className="inline-flex h-9 px-3 items-center gap-1.5 rounded-md border border-[#E8E8E4] text-sm font-medium text-[#1A1A1A] hover:bg-[#F7F7F5]"
            >
              {copiedIdx === -1 ? <Check size={14} /> : <Copy size={14} />}
              {copiedIdx === -1 ? "Copied" : "Copy all"}
            </button>
            <Link
              href={`/migrate?session=${session.id}`}
              className="inline-flex h-9 px-3 items-center gap-1.5 rounded-md bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8]"
            >
              <ArrowLeftRight size={14} />
              Migrate
            </Link>
            <button
              onClick={handleDelete}
              disabled={busy === "delete"}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[#E8E8E4] text-[#6B6B6B] hover:bg-red-50 hover:text-red-600 hover:border-red-200 disabled:opacity-50"
              title="Delete session"
            >
              {busy === "delete" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            </button>
          </div>
        </div>
      </div>

      {/* Messages */}
      {session.messages.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#E8E8E4] bg-white p-12 text-center text-sm text-[#6B6B6B]">
          No messages in this session yet.
        </div>
      ) : (
        <div className="space-y-3">
          {session.messages.map((msg, idx) => (
            <div
              key={idx}
              className={cn(
                "rounded-xl border bg-white p-5 group relative",
                msg.role === "user"
                  ? "border-[#E8E8E4]"
                  : "border-[#EFF6FF] bg-[#FAFBFF]"
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span className={cn(
                  "text-[11px] font-semibold uppercase tracking-wider",
                  msg.role === "user" ? "text-[#6B6B6B]" : "text-[#2563EB]"
                )}>
                  {msg.role === "user" ? "You" : "Assistant"}
                </span>
                <button
                  onClick={() => copyMessage(msg.content, idx)}
                  className="opacity-0 group-hover:opacity-100 text-[#6B6B6B] hover:text-[#1A1A1A] transition-opacity"
                  title="Copy message"
                >
                  {copiedIdx === idx ? <Check size={13} className="text-green-600" /> : <Copy size={13} />}
                </button>
              </div>
              <div className="text-sm text-[#1A1A1A] whitespace-pre-wrap break-words leading-relaxed">
                {msg.content}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
