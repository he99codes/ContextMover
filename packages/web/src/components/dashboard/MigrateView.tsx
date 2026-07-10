"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

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

const TIER_CONFIG = [
  { t: 1 as const, icon: "📄", label: "Full Context",  speed: "Fastest", desc: "Complete conversation" },
  { t: 2 as const, icon: "🧠", label: "Smart Summary", speed: "Fast",    desc: "Auto-extracted"       },
  { t: 3 as const, icon: "⚡", label: "Attention",     speed: "Smart",   desc: "Task-focused"         },
] as const;

const TASK_CHIPS = [
  "Fix the current bug",
  "Continue implementing the feature",
  "Refactor the code",
  "Write tests",
];

interface Props {
  initialSessions: Session[];
  userId: string;
}

function buildMigrationPrompt(session: Session, target: Platform, tier: 1 | 2 | 3, caveman = false, task = ""): string {
  const sourceLabel = session.platform.charAt(0).toUpperCase() + session.platform.slice(1);
  const targetLabel = TARGETS.find((t) => t.id === target)?.label ?? target;
  const firstUser =
    session.messages.find((m) => m.role === "user")?.content.trim() ?? "";
  const goal = firstUser.slice(0, 400) || "(no explicit goal captured)";
  const tierLabel = tier === 3 ? "attention_engine" : tier === 2 ? "smart_summary" : "tier1";

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
    `> **Migration tier:** ${tierLabel}  `,
    `> **Exported:** ${new Date().toISOString()}`,
    "",
    "## Original goal",
    "",
    goal,
    "",
    ...(tier === 3 && task ? [
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
    ...(caveman ? [`\nCaveman mode: no filler, no pleasantries, answer then stop, code write normal, technical terms keep exact.`] : []),
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
  const [tier, setTier] = useState<1 | 2 | 3>(2);
  const [caveman, setCaveman] = useState(false);
  const [copied, setCopied] = useState(false);
  const [task, setTask] = useState("");
  const [copyStats, setCopyStats] = useState<{ chars: number; tier: 1 | 2 | 3 } | null>(null);

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
    return buildMigrationPrompt(selected, target, tier, caveman, task);
  }, [selected, target, tier, caveman, task]);

  async function copyPrompt() {
    if (!prompt) return;
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setCopyStats({ chars: prompt.length, tier });
    setTimeout(() => setCopied(false), 1500);
    setTimeout(() => setCopyStats(null), 4000);
  }

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 md:p-10 animate-slide-up">
      <div className="mb-10">
        <div className="flex items-center gap-2 mb-1">
          <ArrowLeftRight size={18} className="text-[#00FF88]" style={{ filter: "drop-shadow(0 0 8px rgba(0,255,136,0.6))" }} />
          <h1 className="text-2xl font-black uppercase text-[#00FF88]" style={{ letterSpacing: "0.14em", textShadow: "0 0 24px rgba(0,255,136,0.35)" }}>Migrate</h1>
        </div>
        <p className="text-xs font-mono uppercase text-[#2A6A2A]" style={{ letterSpacing: "0.1em" }}>
          Generate a paste-ready prompt that transfers a conversation from one AI to another.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-8">
        {/* ── Session picker ── */}
        <div className="rounded-[6px] border border-[#0D2A0D] bg-[#060606] overflow-hidden" style={{ boxShadow: "0 0 20px rgba(0,255,136,0.04)" }}>
          <div className="p-4 border-b border-[#0D1A0D]">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6B6B6B]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sessions by meaning…"
                className="w-full h-10 pl-8 pr-2 rounded-[5px] border border-[#1A2A1A] bg-[#050505] text-sm font-mono text-[#F5F5F5] placeholder:text-[#1A3A1A] outline-none focus:border-[#00FF88] focus:shadow-[0_0_8px_rgba(0,255,136,0.15)] transition-all"
              />
            </div>
          </div>
          <div className="max-h-[50vh] sm:max-h-[560px] overflow-y-auto">
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
                      "group relative w-full text-left px-4 py-4 border-b border-[#0D1A0D] last:border-b-0 transition-all overflow-hidden",
                      isSelected ? "bg-[#0D1A0D]" : "hover:bg-[#090E09]"
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
                      "text-sm font-medium truncate transition-all",
                      isSelected ? "text-[#00FF88] typing-glow" : "text-[#F5F5F5] group-hover:text-[#00FF88]"
                    )}>
                      {s.title ?? "Untitled session"}
                    </p>
                    <p className="mt-0.5 text-[10px] font-mono text-[#1A3A1A]">
                      {s.messages.length} msgs · {formatRelativeTime(s.updated_at)}
                    </p>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ── Prompt builder ── */}
        <div className="rounded-[6px] border border-[#0D2A0D] bg-[#060606] p-4 sm:p-6 md:p-8" style={{ boxShadow: "0 0 20px rgba(0,255,136,0.03)" }}>
          {!selected ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-[8px] border border-[#1A2A1A] bg-[#080808] neon-border-pulse">
                <ArrowLeftRight size={22} className="text-[#2A6A2A]" />
              </div>
              <p className="text-sm font-mono font-medium uppercase tracking-wider text-[#2A4A2A]">Select a session on the left to begin</p>
            </div>
          ) : (
            <div className="space-y-7">
              {/* From */}
              <div>
                <p className="mb-2 text-[9px] font-black uppercase tracking-[0.3em] text-[#2A6A2A]">◈ From</p>
                <div className="flex items-start gap-4 rounded-[6px] border border-[#1A2A1A] bg-[#080808] px-5 py-4" style={{ boxShadow: "inset 0 0 0 1px rgba(0,255,136,0.04)" }}>
                  <PlatformLogo platform={selected.platform} size={20} className="mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[#F5F5F5] truncate">{selected.title ?? "Untitled session"}</p>
                    <p className="text-[10px] font-mono text-[#1A3A1A] mt-0.5">
                      {PLATFORM_FULL_NAMES[selected.platform] ?? selected.platform} · {selected.messages.length} messages
                    </p>
                  </div>
                </div>
              </div>

              {/* Target platform — large cards */}
              <div>
                <p className="mb-2 text-[9px] font-black uppercase tracking-[0.3em] text-[#2A6A2A]">◈ To</p>
                <div className="grid grid-cols-3 gap-2 sm:gap-3">
                  {TARGETS.map((t) => {
                    const isActive = target === t.id;
                    const isSame  = t.id === selected.platform;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setTarget(t.id)}
                        disabled={isSame}
                        className={cn(
                          "group relative flex flex-col items-center gap-2.5 rounded-[6px] border p-2 sm:p-4 transition-all duration-200 overflow-hidden",
                          isSame && "opacity-20 cursor-not-allowed",
                          isActive
                            ? "bg-[#0A0A0A] scale-[1.02]"
                            : "border-[#0D1A0D] bg-[#060606] hover:bg-[#090E09] hover:-translate-y-[2px] hover:scale-[1.02]"
                        )}
                        style={isActive ? {
                          borderColor: `${t.color}55`,
                          boxShadow: `0 0 22px ${t.color}30, inset 0 0 14px ${t.color}08`,
                        } : {}}
                        title={isSame ? "Same as source" : undefined}
                      >
                        <PlatformLogo platform={t.id} size={24} />
                        <span
                          className="text-[10px] font-black uppercase tracking-wider transition-colors"
                          style={{ color: isActive ? t.color : "#2A4A2A" }}
                        >
                          {t.label}
                        </span>
                        {isActive && (
                          <span
                            className="absolute top-2 right-2 text-[9px] font-black"
                            style={{ color: t.color, textShadow: `0 0 6px ${t.color}` }}
                          >✓</span>
                        )}
                        {/* XP strip */}
                        <span className="absolute bottom-0 left-0 right-0 h-[2px] transition-all duration-200" style={{
                          background: isActive ? `linear-gradient(to right, transparent, ${t.color}, transparent)` : `linear-gradient(to right, transparent, ${t.color}25, transparent)`,
                          boxShadow: isActive ? `0 0 8px ${t.color}80` : "none",
                          opacity: isActive ? 1 : 0.3,
                        }} />
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Migration tier selector */}
              <div>
                <p className="mb-2 text-[9px] font-black uppercase tracking-[0.3em] text-[#2A6A2A]">◈ Migration tier</p>
                <div className="grid grid-cols-3 gap-2 sm:gap-3">
                  {TIER_CONFIG.map(({ t, icon, label, speed, desc }) => {
                    const active = tier === t;
                    return (
                      <button
                        key={t}
                        onClick={() => setTier(t)}
                        className="flex flex-col items-center gap-1.5 rounded-[6px] border p-2 sm:p-4 text-center transition-all duration-150 outline-none"
                        style={{
                          background: "#111",
                          borderColor: active ? "#00FF88" : "#1E1E1E",
                          boxShadow: active ? "0 0 12px rgba(0,255,136,0.18), inset 0 0 8px rgba(0,255,136,0.04)" : "none",
                        }}
                      >
                        <span className="text-xl">{icon}</span>
                        <span className="text-[9px] font-black uppercase tracking-wider" style={{ color: active ? "#00FF88" : "#888" }}>{label}</span>
                        <span className="text-[9px] font-semibold" style={{ color: active ? "#00CC6A" : "#444" }}>{speed}</span>
                        <span className="text-[8px]" style={{ color: "#333" }}>{desc}</span>
                      </button>
                    );
                  })}
                </div>
                {tier === 2 && (
                  <p className="mt-2 text-[10px] text-[#555] leading-relaxed">
                    Automatically extracts goals, decisions, bugs and code into a structured summary.
                  </p>
                )}
              </div>

              {/* Task focus — tier 3 only */}
              {tier === 3 && (
                <div>
                  <p className="mb-2 text-[9px] font-black uppercase tracking-[0.3em] text-[#2A6A2A]">
                    Task focus <span className="normal-case font-normal text-[#1A2A1A]">(optional)</span>
                  </p>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {TASK_CHIPS.map((chip) => (
                      <button
                        key={chip}
                        onClick={() => setTask(task === chip ? "" : chip)}
                        className="rounded-[4px] border px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide transition-all"
                        style={{
                          background: task === chip ? "rgba(0,255,136,0.1)" : "#0A0A0A",
                          borderColor: task === chip ? "rgba(0,255,136,0.35)" : "#1A1A1A",
                          color: task === chip ? "#00FF88" : "#555",
                        }}
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                  <input
                    value={task}
                    onChange={(e) => setTask(e.target.value)}
                    placeholder="Or describe your task…"
                    className="w-full rounded-[5px] border border-[#1A1A1A] bg-[#060606] px-4 py-3 text-sm font-mono text-[#F5F5F5] placeholder:text-[#333] outline-none focus:border-[#00FF88] focus:shadow-[0_0_8px_rgba(0,255,136,0.15)] transition-all"
                  />
                </div>
              )}

              {/* Caveman toggle */}
              <button
                onClick={() => setCaveman((v) => !v)}
                className="flex w-full items-center justify-between rounded-[6px] border px-5 py-3.5 text-xs transition-all duration-200 hover:-translate-y-px"
                style={caveman
                  ? { borderColor: "rgba(0,255,136,0.35)", background: "rgba(0,255,136,0.07)", color: "#00FF88", boxShadow: "0 0 12px rgba(0,255,136,0.15)" }
                  : { borderColor: "#1A2A1A", background: "#060606", color: "#2A4A2A" }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">🪨</span>
                  <div className="text-left">
                    <div className="font-semibold uppercase tracking-[0.15em] text-[10px]">Caveman mode</div>
                    <div className="text-[9px] opacity-60 mt-0.5">Removes filler from AI responses</div>
                  </div>
                </div>
                <div
                  className="relative h-4 w-7 rounded-full transition-colors"
                  style={{ background: caveman ? "#00FF88" : "#1A1A1A" }}
                >
                  <div
                    className="absolute top-0.5 h-3 w-3 rounded-full transition-transform duration-200"
                    style={{ background: caveman ? "#0A0A0A" : "#555", transform: caveman ? "translateX(14px)" : "translateX(2px)" }}
                  />
                </div>
              </button>

              {/* Prompt output */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[9px] font-black uppercase tracking-[0.3em] text-[#2A6A2A]">◈ Migration prompt</p>
                  <button
                    onClick={copyPrompt}
                    className="btn-primary inline-flex items-center gap-1.5 rounded-[4px] bg-[#00FF88] px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-black"
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
                {copyStats && (
                  <div className="mb-2 flex items-center gap-3 rounded-[5px] border border-[#00FF88]/20 bg-[#060F07] px-4 py-2.5 text-[10px]">
                    <span className="text-lg">✅</span>
                    <div>
                      <span className="font-semibold text-[#00FF88]">Copied!</span>
                      <span className="ml-2 text-[#2A6A2A]">
                        {copyStats.chars.toLocaleString()} chars
                        {" · "}
                        Tier: <span className="text-[#F5F5F5]">{copyStats.tier === 1 ? "Full Context" : copyStats.tier === 2 ? "Smart Summary" : "Attention Engine"}</span>
                      </span>
                    </div>
                  </div>
                )}
                <pre className="rounded-[5px] border border-[#1A2A1A] bg-[#050505] p-5 text-xs font-mono text-[#8AFF8A]/80 whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto" style={{ boxShadow: "inset 0 0 20px rgba(0,255,136,0.025)" }}>
                  {prompt}
                </pre>
                <p className="mt-2 text-[10px] font-mono text-[#1A3A1A]">
                  Paste into a new chat on{" "}
                  <strong className="text-[#F5F5F5]">{TARGETS.find((t) => t.id === target)?.label}</strong>.
                  The browser extension injects this automatically from the sidebar.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── THE CRUCIBLE ── */}
      <div className="mt-8">
        <div
          className="crucible-pulse flex cursor-default flex-col items-center justify-center rounded-[8px] border border-dashed py-8 transition-all hover:scale-[1.002]"
          style={{ borderColor: "rgba(0,255,136,0.16)", background: "rgba(0,255,136,0.012)" }}
        >
          <div className="text-[12px] font-black uppercase tracking-[0.4em] text-[#00FF88]" style={{ textShadow: "0 0 12px rgba(0,255,136,0.5)" }}>
            ⚗ The Crucible
          </div>
          <div className="mt-2 text-[10px] font-mono uppercase tracking-[0.2em] text-[#1A3A1A]">
            Merge sessions · Forge Super Memory
          </div>
          <div className="mt-1.5 text-[8px] font-black uppercase tracking-[0.3em] text-[#00FF88]/40">
            Coming in v3
          </div>
        </div>
      </div>
    </div>
  );
}
