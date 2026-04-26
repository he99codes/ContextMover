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
import { SessionExportPanel } from "./SessionExportPanel";

const PLATFORM_STYLES: Record<string, { label: string; dot: string; badge: string; color: string }> = {
  claude:     { label: "Claude",     dot: "bg-[#D97706]", badge: "text-[#D97706] border-[#D97706]/25 bg-[#D97706]/10", color: "#D97706" },
  chatgpt:    { label: "ChatGPT",    dot: "bg-[#10B981]", badge: "text-[#10B981] border-[#10B981]/25 bg-[#10B981]/10", color: "#10B981" },
  gemini:     { label: "Gemini",     dot: "bg-[#6366F1]", badge: "text-[#6366F1] border-[#6366F1]/25 bg-[#6366F1]/10", color: "#6366F1" },
  grok:       { label: "Grok",       dot: "bg-[#F5F5F5]", badge: "text-[#F5F5F5] border-[#F5F5F5]/25 bg-[#F5F5F5]/10", color: "#F5F5F5" },
  perplexity: { label: "Perplexity", dot: "bg-[#20B2AA]", badge: "text-[#20B2AA] border-[#20B2AA]/25 bg-[#20B2AA]/10", color: "#20B2AA" },
  deepseek:   { label: "DeepSeek",   dot: "bg-[#4C8BF5]", badge: "text-[#4C8BF5] border-[#4C8BF5]/25 bg-[#4C8BF5]/10", color: "#4C8BF5" },
};

function getStyle(platform: string) {
  return PLATFORM_STYLES[platform.toLowerCase()] ?? {
    label: platform,
    dot: "bg-[#6B6B6B]",
    badge: "text-[#6B6B6B] border-[#6B6B6B]/25 bg-[#6B6B6B]/10",
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
    <div className="max-w-7xl mx-auto p-8">
      {/* Back */}
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors mb-6"
      >
        <ArrowLeft size={14} />
        All sessions
      </Link>

      {/* Header */}
      <div className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-6 mb-6">
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
                  className="flex-1 rounded-[4px] border border-[#00FF88]/30 bg-[#0A0A0A] px-3 py-1.5 text-xl font-semibold text-[#F5F5F5] outline-none focus:border-[#00FF88]"
                />
                <button
                  onClick={handleSave}
                  disabled={busy === "save"}
                  className="inline-flex h-8 px-3 items-center gap-1 rounded-[4px] bg-[#00FF88] text-black text-sm font-semibold hover:bg-[#00CC6A] disabled:opacity-50 transition-colors"
                >
                  {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  Save
                </button>
              </div>
            ) : (
              <h1 className="text-xl font-semibold text-[#F5F5F5] flex items-center gap-2 group">
                {title}
                <button
                  onClick={() => setIsEditing(true)}
                  className="opacity-0 group-hover:opacity-100 text-[#6B6B6B] hover:text-[#F5F5F5] transition-all"
                  title="Rename"
                >
                  <Pencil size={14} />
                </button>
              </h1>
            )}

            <div className="mt-2 flex items-center gap-3 flex-wrap">
              <span className={cn("inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-0.5 text-[11px] font-medium", style.badge)}>
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
              className="inline-flex h-9 px-3 items-center gap-1.5 rounded-[4px] border border-[#2A2A2A] text-sm font-medium text-[#F5F5F5] hover:bg-[#2A2A2A] transition-colors"
            >
              {copiedIdx === -1 ? <Check size={14} className="text-[#00FF88]" /> : <Copy size={14} />}
              {copiedIdx === -1 ? "Copied" : "Copy all"}
            </button>
            <Link
              href={`/migrate?session=${session.id}`}
              className="inline-flex h-9 px-3 items-center gap-1.5 rounded-[4px] bg-[#00FF88] text-black text-sm font-semibold hover:bg-[#00CC6A] transition-all hover:shadow-[0_0_12px_rgba(0,255,136,0.3)]"
            >
              <ArrowLeftRight size={14} />
              Migrate
            </Link>
            <button
              onClick={handleDelete}
              disabled={busy === "delete"}
              className="inline-flex h-9 w-9 items-center justify-center rounded-[4px] border border-[#2A2A2A] text-[#6B6B6B] hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 disabled:opacity-50 transition-colors"
              title="Delete session"
            >
              {busy === "delete" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            </button>
          </div>
        </div>
      </div>

      {/* Body: messages (left) + export panel (right) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div>
      {/* Messages */}
      {session.messages.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-[#2A2A2A] bg-[#111111] p-12 text-center text-sm text-[#6B6B6B]">
          No messages in this session yet.
        </div>
      ) : (
        <div className="space-y-3">
          {session.messages.map((msg, idx) => (
            <div
              key={idx}
              className={cn(
                "rounded-[8px] border p-5 group relative transition-all",
                msg.role === "user"
                  ? "bg-[#1A1A1A] border-[#2A2A2A] hover:border-[#3A3A3A]"
                  : "bg-[#111111] border-[#2A2A2A] hover:border-[#00FF88]/15"
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span className={cn(
                  "text-[11px] font-semibold uppercase tracking-wider",
                  msg.role === "user" ? "text-[#6B6B6B]" : "text-[#00FF88]"
                )}>
                  {msg.role === "user" ? "You" : "Assistant"}
                </span>
                <button
                  onClick={() => copyMessage(msg.content, idx)}
                  className="opacity-0 group-hover:opacity-100 text-[#6B6B6B] hover:text-[#F5F5F5] transition-all"
                  title="Copy message"
                >
                  {copiedIdx === idx ? <Check size={13} className="text-[#00FF88]" /> : <Copy size={13} />}
                </button>
              </div>
              <div className="text-sm text-[#F5F5F5]/90 whitespace-pre-wrap break-words leading-relaxed">
                {msg.content}
              </div>
            </div>
          ))}
        </div>
      )}
      </div>
      <aside className="lg:sticky lg:top-8 lg:self-start">
        <SessionExportPanel session={session} />
      </aside>
      </div>
    </div>
  );
}
