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

type PlatformKey = typeof PLATFORMS[number]["key"];

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
        <div className="flex items-center gap-0 border-b border-[#2A2A2A] overflow-x-auto">
          {PLATFORMS.map((p) => {
            const isActive = filter === p.key;
            const color = p.logoKey ? (PCOLORS[p.logoKey] ?? "#6B6B6B") : "#00FF88";
            return (
              <button
                key={p.key}
                onClick={() => setFilter(p.key)}
                className={cn(
                  "relative flex shrink-0 items-center gap-1.5 px-3 pb-2.5 pt-1 text-xs font-medium transition-colors duration-150 whitespace-nowrap",
                  isActive ? "text-[#F5F5F5]" : "text-[#6B6B6B] hover:text-[#A0A0A0]"
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
              "w-full rounded-[4px] border bg-[#111111] py-2 pl-9 pr-3 text-sm text-[#F5F5F5] placeholder:text-[#6B6B6B] outline-none transition-all duration-150",
              searchFocused
                ? "border-[#00FF88] shadow-[0_0_0_3px_rgba(0,255,136,0.08)]"
                : "border-[#2A2A2A] hover:border-[#3A3A3A]"
            )}
          />
        </div>
      </div>

      {/* Empty states */}
      {filtered.length === 0 && sessions.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-[6px] border border-dashed border-[#2A2A2A] bg-[#111111] py-20 text-center animate-fade-in">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] bg-[#00FF88]/10 border border-[#00FF88]/20">
            <Layers size={20} className="text-[#00FF88]" />
          </div>
          <h3 className="text-sm font-medium text-[#F5F5F5]">No sessions captured yet</h3>
          <p className="mt-1.5 max-w-xs text-sm text-[#6B6B6B]">
            Install the ContextForge extension and visit Claude, ChatGPT, Google Gemini,
            xAI Grok, Perplexity, or DeepSeek to start capturing context.
          </p>
        </div>
      )}

      {filtered.length === 0 && sessions.length > 0 && (
        <div className="flex flex-col items-center justify-center rounded-[6px] border border-dashed border-[#2A2A2A] bg-[#111111] py-16 text-center animate-fade-in">
          <RefreshCw size={18} className="mb-3 text-[#6B6B6B]" />
          <p className="text-sm text-[#6B6B6B]">No sessions match your filter.</p>
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
    </div>
  );
}
