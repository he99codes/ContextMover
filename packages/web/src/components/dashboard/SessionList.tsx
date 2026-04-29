"use client";

import { useState, useMemo } from "react";
import { Search, Layers, RefreshCw } from "lucide-react";
import { useRealtimeSessions } from "@/hooks/useRealtimeSessions";
import { SessionCard } from "./SessionCard";
import { PlatformLogo, PLATFORM_COLORS as PCOLORS } from "@/components/ui/PlatformLogo";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

const PLATFORMS = [
  { key: "All",        label: "All",          logoKey: null },
  { key: "Claude",     label: "Claude",        logoKey: "claude" },
  { key: "ChatGPT",    label: "ChatGPT",       logoKey: "chatgpt" },
  { key: "Gemini",     label: "Google Gemini", logoKey: "gemini" },
  { key: "Grok",       label: "xAI Grok",      logoKey: "grok" },
  { key: "Perplexity", label: "Perplexity",    logoKey: "perplexity" },
  { key: "DeepSeek",   label: "DeepSeek",      logoKey: "deepseek" },
] as const;

interface SessionListProps {
  initialSessions: Session[];
  userId: string;
}

export function SessionList({ initialSessions, userId }: SessionListProps) {
  const { sessions } = useRealtimeSessions(userId, initialSessions);
  const [filter, setFilter] = useState<string>("All");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      const matchesPlatform =
        filter === "All" ||
        s.platform.toLowerCase() === filter.toLowerCase().replace("google ", "").replace("xai ", "");
      const matchesSearch =
        !search ||
        (s.title ?? "").toLowerCase().includes(search.toLowerCase()) ||
        s.messages.some((m) =>
          m.content.toLowerCase().includes(search.toLowerCase())
        );
      return matchesPlatform && matchesSearch;
    });
  }, [sessions, filter, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: sessions.length };
    for (const p of PLATFORMS.slice(1)) {
      c[p.key] = sessions.filter(
        (s) => s.platform.toLowerCase() === p.key.toLowerCase()
      ).length;
    }
    return c;
  }, [sessions]);

  const [searchFocused, setSearchFocused] = useState(false);

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-5 flex flex-col gap-3">
        {/* Platform filter tabs with sliding underline */}
        <div className="flex items-center gap-0 border-b border-[#0D2A0D] overflow-x-auto" style={{ background: "linear-gradient(to right, #050505, #081208, #050505)" }}>
          {PLATFORMS.map((p) => {
            const isActive = filter === p.key;
            const color = p.logoKey ? (PCOLORS[p.logoKey] ?? "#6B6B6B") : "#00FF88";
            return (
              <button
                key={p.key}
                onClick={() => setFilter(p.key)}
                className={cn(
                  "relative flex shrink-0 items-center gap-1.5 px-3 pb-2.5 pt-1 text-[10px] font-black uppercase tracking-[0.14em] transition-all duration-150 whitespace-nowrap",
                  isActive ? "text-[#F5F5F5]" : "text-[#2A4A2A] hover:text-[#4A8A4A]"
                )}
                style={isActive ? { color } : {}}
              >
                {p.logoKey && (
                  <PlatformLogo platform={p.logoKey} size={12} />
                )}
                {p.label}
                {counts[p.key] > 0 && (
                  <span className="tabular-nums opacity-55 text-[10px]">{counts[p.key]}</span>
                )}
                {/* Sliding underline */}
                <span
                  className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full transition-all duration-300"
                  style={{
                    background: color,
                    opacity: isActive ? 1 : 0,
                    transform: isActive ? "scaleX(1)" : "scaleX(0)",
                    transformOrigin: "left",
                    boxShadow: isActive ? `0 0 8px ${color}` : "none",
                  }}
                />
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="relative">
          <Search
            size={13}
            className={cn(
              "absolute left-3 top-1/2 -translate-y-1/2 transition-colors duration-150",
              searchFocused ? "text-[#00FF88]" : "text-[#6B6B6B]"
            )}
          />
          <input
            placeholder="Search sessions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className={cn(
              "w-full rounded-[4px] border bg-[#080808] py-2 pl-9 pr-3 text-sm font-mono text-[#F5F5F5] placeholder:text-[#1A3A1A] outline-none transition-all duration-150",
              searchFocused
                ? "border-[#00FF88] shadow-[0_0_0_2px_rgba(0,255,136,0.1),0_0_20px_rgba(0,255,136,0.05)]"
                : "border-[#1A2A1A] hover:border-[#2A4A2A]"
            )}
          />
        </div>
      </div>

      {/* Empty states */}
      {filtered.length === 0 && sessions.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-[6px] border border-dashed py-20 text-center animate-fade-in neon-border-pulse" style={{ background: "#070707" }}>
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] bg-[#00FF88]/5 border border-[#00FF88]/25" style={{ boxShadow: "0 0 18px rgba(0,255,136,0.14)" }}>
            <Layers size={20} className="text-[#00FF88]" />
          </div>
          <h3 className="text-sm font-black uppercase tracking-widest text-[#F5F5F5]">No sessions captured yet</h3>
          <p className="mt-1.5 max-w-xs text-xs font-mono text-[#2A4A2A]">
            Install the ContextForge extension and visit Claude, ChatGPT, Google Gemini,
            xAI Grok, Perplexity, or DeepSeek to start capturing context.
          </p>
        </div>
      )}

      {filtered.length === 0 && sessions.length > 0 && (
        <div className="flex flex-col items-center justify-center rounded-[6px] border border-dashed py-16 text-center animate-fade-in neon-border-pulse" style={{ background: "#070707" }}>
          <RefreshCw size={18} className="mb-3 text-[#2A6A2A]" />
          <p className="text-xs font-mono uppercase tracking-wider text-[#2A4A2A]">No sessions match your filter.</p>
          <button
            onClick={() => { setFilter("All"); setSearch(""); }}
            className="mt-2 text-xs text-[#00FF88] transition-opacity hover:opacity-70"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Staggered card list */}
      {filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      )}

      {/* ── THE CRUCIBLE ── */}
      <div className="mt-4">
        <div
          className="crucible-pulse flex cursor-default flex-col items-center justify-center rounded-[6px] border border-dashed py-4 transition-all hover:scale-[1.004]"
          style={{ borderColor: "rgba(0,255,136,0.16)", background: "rgba(0,255,136,0.014)" }}
        >
          <div className="text-[9px] font-black uppercase tracking-[0.4em] text-[#00FF88]" style={{ textShadow: "0 0 10px rgba(0,255,136,0.45)" }}>
            ⚗ The Crucible
          </div>
          <div className="mt-1 text-[8px] font-mono uppercase tracking-[0.2em] text-[#1A3A1A]">
            Merge sessions · Forge Super Memory
          </div>
        </div>
      </div>
    </div>
  );
}
