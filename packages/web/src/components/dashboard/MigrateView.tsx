"use client";

import { useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeftRight, Copy, Check, Search } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useRealtimeSessions } from "@/hooks/useRealtimeSessions";
import type { Session, Platform } from "@/types";

const TARGETS: { id: Platform; label: string; color: string; active: string }[] = [
  { id: "claude",  label: "Claude",  color: "#D97706", active: "border-[#D97706]/40 bg-[#D97706]/10 text-[#D97706]"  },
  { id: "chatgpt", label: "ChatGPT", color: "#10B981", active: "border-[#10B981]/40 bg-[#10B981]/10 text-[#10B981]" },
  { id: "gemini",  label: "Gemini",  color: "#6366F1", active: "border-[#6366F1]/40 bg-[#6366F1]/10 text-[#6366F1]"  },
  { id: "grok",    label: "Grok",    color: "#F5F5F5", active: "border-[#F5F5F5]/40 bg-[#F5F5F5]/10 text-[#F5F5F5]"  },
];

interface Props {
  initialSessions: Session[];
  userId: string;
}

function buildMigrationPrompt(session: Session, target: Platform): string {
  const sourceLabel = session.platform.charAt(0).toUpperCase() + session.platform.slice(1);
  const targetLabel = TARGETS.find((t) => t.id === target)?.label ?? target;
  const firstUser =
    session.messages.find((m) => m.role === "user")?.content.trim() ?? "";
  const goal = firstUser.slice(0, 400) || "(no explicit goal captured)";

  const transcript = session.messages
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      return `**${role}:**\n\n${m.content.trim()}`;
    })
    .join("\n\n---\n\n");

  return [
    `# Context import into ${targetLabel}`,
    "",
    `> **Source:** ${sourceLabel}  `,
    `> **Session:** ${session.title ?? "Untitled"}  `,
    `> **Messages:** ${session.messages.length}  `,
    `> **Exported:** ${new Date().toISOString()}`,
    "",
    "## Original goal",
    "",
    goal,
    "",
    "## Transcript",
    "",
    transcript,
    "",
    "---",
    "",
    `Please continue this conversation in ${targetLabel}. Acknowledge the context, identify anything ambiguous, and ask before making large changes.`,
  ].join("\n");
}

export function MigrateView({ initialSessions, userId }: Props) {
  const { sessions } = useRealtimeSessions(userId, initialSessions);
  const params = useSearchParams();
  const prefilledId = params.get("session");

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    prefilledId ?? initialSessions[0]?.id ?? null
  );
  const [target, setTarget] = useState<Platform>("grok");
  const [copied, setCopied] = useState(false);

  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    if (!search) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(
      (s) =>
        (s.title ?? "").toLowerCase().includes(q) ||
        s.platform.toLowerCase().includes(q)
    );
  }, [sessions, search]);

  const prompt = useMemo(() => {
    if (!selected) return "";
    return buildMigrationPrompt(selected, target);
  }, [selected, target]);

  async function copyPrompt() {
    if (!prompt) return;
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="max-w-6xl mx-auto p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[#F5F5F5]">Migrate</h1>
        <p className="mt-1 text-sm text-[#6B6B6B]">
          Generate a paste-ready prompt that transfers a conversation from one AI to another.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        {/* Session picker */}
        <div className="rounded-[8px] border border-[#2A2A2A] bg-[#111111] overflow-hidden">
          <div className="p-3 border-b border-[#2A2A2A]">
            <div className="relative">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6B6B6B]"
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sessions…"
                className="w-full h-8 pl-8 pr-2 rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] text-sm text-[#F5F5F5] placeholder:text-[#6B6B6B] outline-none focus:border-[#00FF88]"
              />
            </div>
          </div>
          <div className="max-h-[540px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#6B6B6B]">
                No sessions yet. Capture one from the extension first.
              </div>
            ) : (
              filtered.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 border-b border-[#2A2A2A] last:border-b-0 transition-colors",
                    selectedId === s.id
                      ? "bg-[#00FF88]/5 hover:bg-[#00FF88]/5"
                      : "hover:bg-[#1A1A1A]"
                  )}
                >
                  <p className={cn(
                    "text-sm font-medium truncate",
                    selectedId === s.id ? "text-[#00FF88]" : "text-[#F5F5F5]"
                  )}>
                    {s.title ?? "Untitled session"}
                  </p>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[#6B6B6B]">
                    <span className="uppercase tracking-wider">{s.platform}</span>
                    <span>·</span>
                    <span>{s.messages.length} msgs</span>
                    <span>·</span>
                    <span>{formatRelativeTime(s.updated_at)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Prompt builder */}
        <div className="rounded-[8px] border border-[#2A2A2A] bg-[#111111] p-5">
          {!selected ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <ArrowLeftRight size={24} className="text-[#6B6B6B] mb-3" />
              <p className="text-sm text-[#6B6B6B]">
                Select a session on the left to begin.
              </p>
            </div>
          ) : (
            <>
              <div className="mb-4">
                <p className="text-xs font-semibold text-[#6B6B6B] uppercase tracking-wider mb-2">
                  From
                </p>
                <div className="rounded-[4px] bg-[#1A1A1A] border border-[#2A2A2A] px-3 py-2">
                  <p className="text-sm font-medium text-[#F5F5F5] truncate">
                    {selected.title ?? "Untitled session"}
                  </p>
                  <p className="text-[11px] text-[#6B6B6B] mt-0.5 uppercase tracking-wider">
                    {selected.platform} · {selected.messages.length} messages
                  </p>
                </div>
              </div>

              <div className="mb-4">
                <p className="text-xs font-semibold text-[#6B6B6B] uppercase tracking-wider mb-2">
                  To
                </p>
                <div className="flex flex-wrap gap-2">
                  {TARGETS.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTarget(t.id)}
                      disabled={t.id === selected.platform}
                      className={cn(
                        "px-3 py-1.5 rounded-[4px] border text-sm font-medium transition-all",
                        target === t.id
                          ? t.active
                          : "border-[#2A2A2A] bg-[#1A1A1A] text-[#6B6B6B] hover:border-[#3A3A3A] hover:text-[#F5F5F5]",
                        t.id === selected.platform && "opacity-30 cursor-not-allowed"
                      )}
                      title={
                        t.id === selected.platform
                          ? "Same as source platform"
                          : undefined
                      }
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-3 flex items-center justify-between">
                <p className="text-xs font-semibold text-[#6B6B6B] uppercase tracking-wider">
                  Migration prompt
                </p>
                <button
                  onClick={copyPrompt}
                  className="inline-flex items-center gap-1.5 rounded-[4px] bg-[#00FF88] px-3 py-1.5 text-xs font-semibold text-black hover:bg-[#00CC6A] transition-all hover:shadow-[0_0_10px_rgba(0,255,136,0.25)]"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? "Copied!" : "Copy to clipboard"}
                </button>
              </div>

              <pre className="rounded-[4px] border border-[#2A2A2A] bg-[#0A0A0A] p-4 text-xs font-mono text-[#F5F5F5]/80 whitespace-pre-wrap break-words max-h-[420px] overflow-y-auto">
                {prompt}
              </pre>

              <p className="mt-3 text-xs text-[#6B6B6B]">
                Copy this and paste it into a new chat on <strong className="text-[#F5F5F5]">{TARGETS.find((t) => t.id === target)?.label}</strong>.
                The browser extension will do this automatically from the sidebar.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
