"use client";

import { useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeftRight, Copy, Check, Search } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useRealtimeSessions } from "@/hooks/useRealtimeSessions";
import { PlatformBadge, PlatformLogo, PLATFORM_COLORS, PLATFORM_FULL_NAMES } from "@/components/ui/PlatformLogo";
import type { Session, Platform } from "@/types";

const TARGETS: { id: Platform; label: string; color: string }[] = [
  { id: "claude",     label: "Claude",        color: "#D97706" },
  { id: "chatgpt",    label: "ChatGPT",        color: "#10B981" },
  { id: "gemini",     label: "Google Gemini",  color: "#6366F1" },
  { id: "grok",       label: "xAI Grok",       color: "#E5E5E5" },
  { id: "perplexity", label: "Perplexity",     color: "#20B2AA" },
  { id: "deepseek",   label: "DeepSeek",       color: "#4C8BF5" },
];

interface Props {
  initialSessions: Session[];
  userId: string;
}

function buildMigrationPrompt(session: Session, target: Platform, caveman = false, task = ""): string {
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
    ...(task ? [
      "## Attention Focus",
      "",
      `> 🎯 **Task:** ${task}`,
      "",
      "Focus exclusively on content relevant to this task. Skip unrelated exchanges.",
      "",
    ] : []),
    "## Transcript",
    "",
    transcript,
    "",
    "---",
    "",
    `Please continue this conversation in ${targetLabel}. Acknowledge the context, identify anything ambiguous, and ask before making large changes.`,
    ...(caveman ? [`Caveman mode: no filler, no pleasantries, answer then stop, code write normal, technical terms keep exact.`] : []),
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
  const [caveman, setCaveman] = useState(false);
  const [copied, setCopied] = useState(false);
  const [task, setTask] = useState("");

  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    if (!search) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(
      (s) =>
        (s.title ?? "").toLowerCase().includes(q) ||
        s.platform.toLowerCase().includes(q) ||
        s.messages.slice(-4).some((m) => m.content.toLowerCase().includes(q))
    );
  }, [sessions, search]);

  const prompt = useMemo(() => {
    if (!selected) return "";
    return buildMigrationPrompt(selected, target, caveman, task);
  }, [selected, target, caveman, task]);

  async function copyPrompt() {
    if (!prompt) return;
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="max-w-6xl mx-auto p-8 animate-slide-up">
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          <ArrowLeftRight size={18} className="text-[#00FF88]" />
          <h1 className="text-2xl font-semibold text-[#F5F5F5]">Migrate</h1>
        </div>
        <p className="text-sm text-[#6B6B6B]">
          Generate a paste-ready prompt that transfers a conversation from one AI to another.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
        {/* ── Session picker ── */}
        <div className="rounded-[6px] border border-[#2A2A2A] bg-[#111111] overflow-hidden">
          <div className="p-3 border-b border-[#2A2A2A]">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6B6B6B]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sessions by meaning…"
                className="w-full h-9 pl-8 pr-2 rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] text-sm text-[#F5F5F5] placeholder:text-[#6B6B6B] outline-none focus:border-[#00FF88] transition-colors"
              />
            </div>
          </div>
          <div className="max-h-[560px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#6B6B6B]">
                No sessions yet. Capture one from the extension first.
              </div>
            ) : (
              filtered.map((s) => {
                const isSelected = selectedId === s.id;
                const pColor = PLATFORM_COLORS[s.platform] ?? "#6B6B6B";
                return (
                  <button
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    className={cn(
                      "group relative w-full text-left px-3 py-3 border-b border-[#2A2A2A] last:border-b-0 transition-colors overflow-hidden",
                      isSelected ? "bg-[#1A1A1A]" : "hover:bg-[#141414]"
                    )}
                  >
                    <span
                      className="absolute inset-y-0 left-0 w-[2px] transition-opacity"
                      style={{ background: pColor, opacity: isSelected ? 1 : 0.3 }}
                    />
                    <div className="flex items-center gap-2 mb-0.5">
                      <PlatformBadge platform={s.platform} logoSize={10} />
                    </div>
                    <p className={cn(
                      "text-sm font-medium truncate transition-colors",
                      isSelected ? "text-[#00FF88]" : "text-[#F5F5F5] group-hover:text-[#00FF88]"
                    )}>
                      {s.title ?? "Untitled session"}
                    </p>
                    <p className="mt-0.5 text-[11px] text-[#6B6B6B]">
                      {s.messages.length} msgs · {formatRelativeTime(s.updated_at)}
                    </p>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ── Prompt builder ── */}
        <div className="rounded-[6px] border border-[#2A2A2A] bg-[#111111] p-6">
          {!selected ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A]">
                <ArrowLeftRight size={22} className="text-[#3A3A3A]" />
              </div>
              <p className="text-sm font-medium text-[#6B6B6B]">Select a session on the left to begin</p>
            </div>
          ) : (
            <div className="space-y-5">
              {/* From */}
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-[#6B6B6B]">From</p>
                <div className="flex items-start gap-3 rounded-[6px] border border-[#2A2A2A] bg-[#1A1A1A] px-4 py-3">
                  <PlatformLogo platform={selected.platform} size={20} className="mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[#F5F5F5] truncate">{selected.title ?? "Untitled session"}</p>
                    <p className="text-[11px] text-[#6B6B6B] mt-0.5">
                      {PLATFORM_FULL_NAMES[selected.platform] ?? selected.platform} · {selected.messages.length} messages
                    </p>
                  </div>
                </div>
              </div>

              {/* Target platform — large cards */}
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-[#6B6B6B]">To</p>
                <div className="grid grid-cols-3 gap-2">
                  {TARGETS.map((t) => {
                    const isActive = target === t.id;
                    const isSame  = t.id === selected.platform;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setTarget(t.id)}
                        disabled={isSame}
                        className={cn(
                          "group relative flex flex-col items-center gap-2 rounded-[6px] border p-3 transition-all duration-150",
                          isSame && "opacity-30 cursor-not-allowed",
                          isActive
                            ? "bg-[#1A1A1A]"
                            : "border-[#2A2A2A] bg-[#0F0F0F] hover:bg-[#141414] hover:border-[#3A3A3A]"
                        )}
                        style={isActive ? {
                          borderColor: `${t.color}50`,
                          boxShadow: `0 0 16px ${t.color}14`,
                        } : {}}
                        title={isSame ? "Same as source" : undefined}
                      >
                        <PlatformLogo platform={t.id} size={24} />
                        <span
                          className="text-xs font-medium transition-colors"
                          style={{ color: isActive ? t.color : "#6B6B6B" }}
                        >
                          {t.label}
                        </span>
                        {isActive && (
                          <span
                            className="absolute top-2 right-2 text-[9px] font-bold"
                            style={{ color: t.color }}
                          >✓</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Attention task focus */}
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-[#6B6B6B]">
                  Task focus <span className="normal-case font-normal text-[#3A3A3A]">(optional)</span>
                </p>
                <input
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder="What are you trying to accomplish? Improves context focus."
                  className="w-full rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-3 py-2 text-sm text-[#F5F5F5] placeholder:text-[#6B6B6B] outline-none focus:border-[#6366f1] transition-colors"
                />
              </div>

              {/* Caveman toggle */}
              <button
                onClick={() => setCaveman((v) => !v)}
                className="flex w-full items-center justify-between rounded-[6px] border px-4 py-2.5 text-xs transition-all duration-150"
                style={caveman
                  ? { borderColor: "#F59E0B40", background: "#F59E0B0C", color: "#F59E0B" }
                  : { borderColor: "#2A2A2A", background: "#1A1A1A", color: "#6B6B6B" }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">🪨</span>
                  <span className="font-semibold uppercase tracking-[0.15em] text-[10px]">Caveman mode</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] opacity-70">
                    {caveman ? "ON — aggressive compress + blunt" : "OFF"}
                  </span>
                  <div
                    className="relative h-4 w-7 rounded-full transition-colors"
                    style={{ background: caveman ? "#F59E0B" : "#2A2A2A" }}
                  >
                    <div
                      className="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform duration-200"
                      style={{ transform: caveman ? "translateX(14px)" : "translateX(2px)" }}
                    />
                  </div>
                </div>
              </button>

              {/* Prompt output */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-[#6B6B6B]">Migration prompt</p>
                  <button
                    onClick={copyPrompt}
                    className="btn-primary inline-flex items-center gap-1.5 rounded-[4px] bg-[#00FF88] px-3 py-1.5 text-xs font-semibold text-black"
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
                <pre className="rounded-[4px] border border-[#2A2A2A] bg-[#0A0A0A] p-4 text-xs font-mono text-[#F5F5F5]/80 whitespace-pre-wrap break-words max-h-[380px] overflow-y-auto">
                  {prompt}
                </pre>
                <p className="mt-2 text-xs text-[#6B6B6B]">
                  Paste into a new chat on{" "}
                  <strong className="text-[#F5F5F5]">{TARGETS.find((t) => t.id === target)?.label}</strong>.
                  The browser extension injects this automatically from the sidebar.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
