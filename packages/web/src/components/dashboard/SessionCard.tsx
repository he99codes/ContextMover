"use client";

import Link from "next/link";
import { MessageSquare, Clock, ArrowRight } from "lucide-react";
import { cn, formatRelativeTime, truncate } from "@/lib/utils";
import type { Session } from "@/types";

const PLATFORM_STYLES: Record<
  string,
  { label: string; bg: string; text: string; dot: string }
> = {
  claude:   { label: "Claude",  bg: "bg-amber-50",   text: "text-amber-700",  dot: "bg-amber-500"  },
  chatgpt:  { label: "ChatGPT", bg: "bg-emerald-50",  text: "text-emerald-700",dot: "bg-emerald-500"},
  gemini:   { label: "Gemini",  bg: "bg-indigo-50",  text: "text-indigo-700", dot: "bg-indigo-500" },
  grok:     { label: "Grok",    bg: "bg-zinc-100",   text: "text-zinc-800",   dot: "bg-zinc-700"   },
};

function getPlatformStyle(platform: string) {
  return (
    PLATFORM_STYLES[platform.toLowerCase()] ?? {
      label: platform,
      bg: "bg-slate-50",
      text: "text-slate-700",
      dot: "bg-slate-500",
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

  return (
    <Link
      href={`/session/${session.id}`}
      className="group flex items-start gap-4 rounded-xl border border-[#E8E8E4] bg-white px-5 py-4 transition-all hover:border-[#2563EB]/30 hover:shadow-sm"
    >
      {/* Platform dot */}
      <div className="mt-1 shrink-0">
        <span className={cn("inline-block h-2 w-2 rounded-full", style.dot)} />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[#1A1A1A]">
              {session.title ?? "Untitled session"}
            </p>
            {preview && (
              <p className="mt-0.5 text-xs text-[#6B6B6B] line-clamp-1">
                {truncate(preview, 100)}
              </p>
            )}
          </div>
          <ArrowRight
            size={14}
            className="mt-0.5 shrink-0 text-[#E8E8E4] transition-colors group-hover:text-[#2563EB]"
          />
        </div>

        <div className="mt-2.5 flex items-center gap-3">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
              style.bg,
              style.text
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
    </Link>
  );
}
